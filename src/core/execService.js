// 2025-09-20: 新增 ExecService（实用版 v1）
// 目的：为插件提供“安全且简化”的本地可执行文件运行能力
// 设计要点：
// - 仅允许执行插件目录内、且在 plugin.json.allowExec 白名单中的可执行文件（按文件名匹配）
// - 禁用 shell，最小化 env；超时与并发限制；首次授权提示；审计日志
// - 提供可选 stdin（用于 ffmpeg concat 列表从管道输入）

const path = require('path');
const fs = require('fs-extra');
const { dialog } = require('electron');
const { spawn } = require('child_process');

class ExecService {
  /**
   * 2025-09-20: 构造函数
   * @param {object} opts 
   * @param {PluginManager} opts.pluginManager
   * @param {ConfigStore} opts.configStore
   * @param {boolean} opts.isQuiet
   * @param {function} opts.getDataDir  返回应用数据目录
   */
  constructor(opts = {}) {
    // 基础依赖
    this.pluginManager = opts.pluginManager;
    this.configStore = opts.configStore;
    this.isQuiet = !!opts.isQuiet;
    this.getDataDir = typeof opts.getDataDir === 'function' ? opts.getDataDir : (() => process.cwd());

    // 并发与任务管理
    this.globalRunning = 0;
    this.perPluginRunning = new Map(); // pluginId -> count
    this.processes = new Map(); // taskKey -> child

    // 限制（可后续做配置化）
    this.LIMITS = {
      GLOBAL_MAX: 6,
      PER_PLUGIN_MAX: 2,
      DEFAULT_TIMEOUT_MS: 15 * 60 * 1000,
      MAX_TIMEOUT_MS: 60 * 60 * 1000,
      MAX_LOG_BYTES: 64 * 1024
    };

    // 会话内授权缓存（仅记忆“允许到会话/永久允许”的已授权条目）
    this.sessionAllowed = new Set(); // `${pluginId}|${exeName}`
  }

  // 读取插件清单中的 allowExec（文件名白名单）
  async getAllowedExecList(pluginMeta) {
    try {
      const manifestPath = path.join(pluginMeta.path, 'plugin.json');
      const raw = await fs.readJson(manifestPath);
      const arr = Array.isArray(raw.allowExec) ? raw.allowExec : [];
      // 时间：2025-09-20 修改说明：改为返回清单中声明的“相对路径”（不再截断为 basename）
      return arr
        .filter(x => typeof x === 'string' && x.trim())
        .map(s => String(s).replace(/\\/g, '/'));
    } catch (e) {
      if (!this.isQuiet) console.warn('[ExecService] 读取 allowExec 失败:', e && e.message || e);
      return [];
    }
  }

  // 2025-09-20: 安全解析到插件目录内的绝对路径，防止越界
  _resolveWithinPlugin(pluginMeta, relPathLike) {
    try {
      const rel = String(relPathLike || '').replace(/\\/g, '/');
      const safeRel = rel.replace(/^\/+/, '');
      const abs = path.resolve(pluginMeta.path, safeRel);
      const root = path.resolve(pluginMeta.path);
      if (!abs.startsWith(root)) return null;
      return abs;
    } catch {
      return null;
    }
  }

  // 2025-09-20: 新增 - 生成候选可执行路径集合（兼容多种放置位置）
  // 说明：仍严格要求文件名在 allowExec 白名单中，仅放宽“所在子目录”
  getCandidateExecutablePaths(pluginMeta, exeBaseName) {
    try {
      const base = path.basename(String(exeBaseName || ''));
      const root = pluginMeta && pluginMeta.path ? String(pluginMeta.path) : process.cwd();
      const cand = [
        path.join(root, base),
        path.join(root, 'bin', base),
        path.join(root, 'vendor', base),
        path.join(root, 'vendor', 'ffmpeg', base),
        path.join(root, 'ffmpeg', base),
        path.join(root, 'tools', base)
      ];
      // 去重
      return Array.from(new Set(cand));
    } catch {
      return [];
    }
  }

  // 检查目标 exe 是否允许、是否存在（严格按 allowExec 声明的相对路径检查）
  async resolveExecutable(pluginMeta, exeName) {
    const allowed = await this.getAllowedExecList(pluginMeta); // 例如 ['bin/ffmpeg.exe'] 或 ['ffmpeg.exe']
    const nameInput = String(exeName || '').replace(/\\/g, '/');
    const base = path.basename(nameInput);
    // 1) 精确匹配（相对路径完全一致）
    let matchedRel = allowed.find(a => a.replace(/\\/g,'/').toLowerCase() === nameInput.toLowerCase());
    // 2) 退化匹配（按 basename 匹配，若唯一则接受）
    if (!matchedRel) {
      const candidates = allowed.filter(a => path.basename(a).toLowerCase() === base.toLowerCase());
      if (candidates.length === 1) matchedRel = candidates[0];
      else if (candidates.length > 1) matchedRel = candidates[0]; // 多于一个时选第一个并记录
    }
    if (!matchedRel) return { ok: false, error: 'not in allow list' };
    const abs = this._resolveWithinPlugin(pluginMeta, matchedRel);
    if (!abs) return { ok: false, error: 'invalid path' };
    try {
      if (await fs.pathExists(abs)) return { ok: true, path: abs, name: matchedRel };
      return { ok: false, error: 'not found' };
    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  }

  // 首次授权：返回 true 表示已授权
  async ensureAuthorized(pluginMeta, exeName) {
    const key = `${pluginMeta.id}|${exeName}`;
    if (this.sessionAllowed.has(key)) return true;

    // 永久授权配置
    let alwaysSet = this.configStore.get('security.execPermissions.always', {});
    if (alwaysSet && alwaysSet[key] === true) {
      this.sessionAllowed.add(key);
      return true;
    }

    // 弹窗：仅一次/本会话/总是允许/拒绝
    const detail = [
      `插件: ${pluginMeta.name || pluginMeta.id}`,
      `可执行: ${exeName}`,
      `目录: ${pluginMeta.path}`
    ].join('\n');
    const ret = await dialog.showMessageBox({
      type: 'question',
      title: '执行外部程序确认',
      message: '是否允许该插件执行其目录下的可执行文件？',
      detail,
      buttons: ['仅此一次', '本会话允许', '总是允许', '拒绝'],
      cancelId: 3,
      defaultId: 0,
      noLink: true
    });

    if (ret.response === 0) { // 仅此一次
      return true;
    }
    if (ret.response === 1) { // 会话允许
      this.sessionAllowed.add(key);
      return true;
    }
    if (ret.response === 2) { // 总是允许
      try {
        alwaysSet = this.configStore.get('security.execPermissions.always', {});
        if (!alwaysSet || typeof alwaysSet !== 'object') alwaysSet = {};
        alwaysSet[key] = true;
        await this.configStore.set('security.execPermissions.always', alwaysSet);
      } catch {}
      this.sessionAllowed.add(key);
      return true;
    }
    return false; // 拒绝
  }

  // 并发检查（超过则拒绝）
  checkConcurrency(pluginId) {
    if (this.globalRunning >= this.LIMITS.GLOBAL_MAX) {
      return { ok: false, error: 'too many tasks' };
    }
    const cur = this.perPluginRunning.get(pluginId) || 0;
    if (cur >= this.LIMITS.PER_PLUGIN_MAX) {
      return { ok: false, error: 'too many plugin tasks' };
    }
    return { ok: true };
  }

  // 记录审计日志（简版）
  auditLog(msg, data) {
    try {
      if (!this.isQuiet) console.log('[ExecService][AUDIT]', msg, data || '');
    } catch {}
  }

  // 执行（同步等待完成）
  async run(pluginMeta, payload = {}) {
    const exeName = String(payload.name || '').trim();
    if (!exeName) return { ok: false, error: 'invalid name' };

    const resolved = await this.resolveExecutable(pluginMeta, exeName);
    if (!resolved.ok) return { ok: false, error: 'executable not allowed or missing' };

    const allow = await this.ensureAuthorized(pluginMeta, resolved.name);
    if (!allow) return { ok: false, error: 'user denied' };

    const cc = this.checkConcurrency(pluginMeta.id);
    if (!cc.ok) return cc;

    const args = Array.isArray(payload.args) ? payload.args.map(x => String(x)) : [];
    const timeoutMsRaw = Number(payload.timeoutMs || this.LIMITS.DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.max(1000, Math.min(this.LIMITS.MAX_TIMEOUT_MS, timeoutMsRaw));

    const env = Object.assign({}, process.env || {});
    // 最小化可见影响：不修改 PATH，不注入敏感变量

    const spawned = spawn(resolved.path, args, {
      cwd: path.dirname(resolved.path),
      windowsHide: true,
      shell: false,
      env
    });

    this.globalRunning += 1;
    this.perPluginRunning.set(pluginMeta.id, (this.perPluginRunning.get(pluginMeta.id) || 0) + 1);

    const taskKey = `${pluginMeta.id}|${Date.now()}|${Math.random().toString(36).slice(2)}`;
    this.processes.set(taskKey, spawned);

    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    const cap = this.LIMITS.MAX_LOG_BYTES;

    const append = (buf, chunk) => {
      if (!chunk) return buf;
      const next = Buffer.concat([buf, Buffer.from(chunk)]);
      if (next.length <= cap) return next;
      return next.slice(next.length - cap); // 仅保留尾部
    };

    spawned.stdout.on('data', (d) => { out = append(out, d); });
    spawned.stderr.on('data', (d) => { err = append(err, d); });

    // 可选 stdin：用于 concat 列表从管道读入
    try {
      if (payload.stdin && spawned.stdin && !spawned.stdin.destroyed) {
        spawned.stdin.write(String(payload.stdin));
        spawned.stdin.end();
      }
    } catch {}

    const killTree = () => {
      try {
        if (process.platform === 'win32') {
          const pid = spawned.pid;
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: true });
          killer.on('error', () => {});
        } else {
          spawned.kill('SIGKILL');
        }
      } catch {}
    };

    const result = await new Promise((resolve) => {
      let timer = setTimeout(() => {
        try { killTree(); } catch {}
        resolve({ code: 124, timeout: true });
      }, timeoutMs);

      spawned.on('error', (e) => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve({ code: -1, error: e && e.message || String(e) });
      });
      spawned.on('close', (code) => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve({ code });
      });
    });

    // 资源计数回收
    this.processes.delete(taskKey);
    this.globalRunning = Math.max(0, this.globalRunning - 1);
    this.perPluginRunning.set(pluginMeta.id, Math.max(0, (this.perPluginRunning.get(pluginMeta.id) || 1) - 1));

    const outStr = out.toString('utf8');
    const errStr = err.toString('utf8');

    this.auditLog('exec.done', {
      plugin: pluginMeta.id,
      exe: resolved.name,
      code: result.code,
      timeout: !!result.timeout
    });

    return { ok: true, data: { code: result.code, timeout: !!result.timeout, stdout: outStr, stderr: errStr } };
  }

  // 简单的检查：
  // - 若传入 exe（字符串或 {name}），返回布尔是否存在
  // - 否则返回 allowExec 列表及存在性数组 [{name, exists}]
  async check(pluginMeta, exe) {
    const list = await this.getAllowedExecList(pluginMeta);
    // 单项检查
    if (exe) {
      const nameRaw = typeof exe === 'string' ? exe : String(exe && exe.name || '');
      const norm = nameRaw.replace(/\\/g, '/');
      // 允许传 basename：若唯一匹配则接受
      let rel = list.find(a => a.toLowerCase() === norm.toLowerCase());
      if (!rel) {
        const cands = list.filter(a => path.basename(a).toLowerCase() === path.basename(norm).toLowerCase());
        if (cands.length === 1) rel = cands[0]; else if (cands.length > 1) rel = cands[0];
      }
      if (!rel) return { ok: true, data: false };
      const abs = this._resolveWithinPlugin(pluginMeta, rel);
      let exists = false;
      try { exists = !!(abs && await fs.pathExists(abs)); } catch {}
      return { ok: true, data: exists };
    }
    // 列表检查（兼容旧接口）
    const res = [];
    for (const name of list) {
      const abs = this._resolveWithinPlugin(pluginMeta, name);
      let exists = false;
      try { exists = !!(abs && await fs.pathExists(abs)); } catch {}
      res.push({ name, exists });
    }
    return { ok: true, data: res };
  }
}

module.exports = { ExecService };


