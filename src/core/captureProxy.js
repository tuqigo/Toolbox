const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const zlib = require('zlib');
// 延迟加载 http-mitm-proxy，避免冷启动硬依赖

let __CachedProxyClass = null;

async function __loadProxyClass(isQuiet) {
  if (__CachedProxyClass) return __CachedProxyClass;
  try {
    const mod = require('http-mitm-proxy/dist');
    __CachedProxyClass = mod && (mod.Proxy || mod.default || mod);
    if (!__CachedProxyClass) throw new Error('invalid http-mitm-proxy export');
    return __CachedProxyClass;
  } catch (e) {
    try { if (!isQuiet) console.error('[CAPTURE] load http-mitm-proxy failed:', e && e.message); } catch {}
    throw e;
  }
}

class CaptureProxyService {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    this.baseDir = options.baseDir || path.join((options.getDataDir && options.getDataDir()) || (process.env.APPDATA || os.homedir()), 'MiniToolbox', 'data');
    this.captureDir = path.join(this.baseDir, 'capture');
    this.caDir = path.join(this.captureDir, 'ca');
    this.maxEntries = 1000;
    this.keepBodies = true;
    this.bodyInlineLimit = 256 * 1024; // 256KB 内联，超出落盘
    this.active = false;
    this.port = null;
    this.targetHosts = null; // 过滤集合；null 表示不过滤
    this.records = []; // 环形缓存
    this.idCounter = 0;
    this.startedAt = null;
    this.__ProxyClass = null;

    // 抓包层过滤与延迟规则（新增）
    this.filters = null;     // { pathPrefixes: string[]|null }
    this.delayRules = null;  // Array<{ method?:string, prefix:string, delayMs:number }> | string pattern

    // 内部：第三方库调试输出抑制
    this._origConsoleDebug = null;
    this._suppressingMitmLogs = false;
  }

  async ensureDirs() {
    await fs.ensureDir(this.captureDir);
    await fs.ensureDir(this.caDir);
    await fs.ensureDir(path.join(this.captureDir, 'bodies'));
  }

  // 启动代理
  async start(opts = {}) {
    await this.ensureDirs();
    if (this.active) {
      return { ok: true, port: this.port };
    }

    const port = Number(opts.port || 8888);
    const host = String(opts.host || '127.0.0.1');
    this.maxEntries = Math.max(100, Number(opts.maxEntries || 2000));
    this.keepBodies = opts.recordBody !== false;
    this.targetHosts = this._normalizeTargetHosts(opts.targets); // string|array|null
    this.filters = this._normalizeFilters(opts.filters || null);
    this.delayRules = this._normalizeDelayRules(opts.delayRules || null);

    if (!this.__ProxyClass) this.__ProxyClass = await __loadProxyClass(this.isQuiet);
    // 仅在非开发环境抑制 http-mitm-proxy 的噪声日志
    const isDev = String(process.env.NODE_ENV || '').toLowerCase() === 'development' || process.env.MT_DEV === '1';
    if (!isDev) this._silenceMitmDebug();
    this.proxy = new this.__ProxyClass();

    // 核心钩子：请求/响应
    this.proxy.onError((ctx, err, kind) => {
      try { if (!this.isQuiet) console.error('[CAPTURE][onError]', kind, err && err.message); } catch {}
    });

    // 仅当命中过滤时才进入详细记录
    const shouldCapture = (ctx) => this._shouldCaptureCtx(ctx);

    this.proxy.onRequest((ctx, next) => {
      // 无论是否记录，先计算是否需要延迟
      try { if (ctx.__mtDelayMs == null) ctx.__mtDelayMs = this._matchDelay(ctx) || 0; } catch {}
      if (!shouldCapture(ctx)) return next();
      try {
        const id = ++this.idCounter;
        const now = Date.now();
        ctx.__mtId = id;
        ctx.__mtReqChunks = [];
        ctx.__mtRespChunks = [];
        ctx.__mtStart = now;
        const { method, url } = ctx.clientToProxyRequest;
        const host = this._getHost(ctx) || '';
        const scheme = ctx.isSSL ? 'https' : 'http';
        const item = {
          id,
          tsStart: now,
          tsEnd: 0,
          method: String(method || '').toUpperCase(),
          scheme,
          host,
          path: url || '/',
          status: 0,
          mime: '',
          reqSize: 0,
          respSize: 0,
          duration: 0,
          reqHeaders: { ...(ctx.clientToProxyRequest.headers || {}) },
          respHeaders: {},
          reqBodyPath: null,
          respBodyPath: null,
          reqBodyInline: null,
          respBodyInline: null
        };
        ctx.__mtRecord = item;
        this._pushRecord(item);
      } catch {}
      next();
    });

    if (this.keepBodies) {
      this.proxy.onRequestData((ctx, chunk, callback) => {
        try {
          if (ctx.__mtReqChunks) ctx.__mtReqChunks.push(Buffer.from(chunk));
        } catch {}
        callback(null, chunk);
      });
    }

    this.proxy.onResponse((ctx, next) => {
      const proceed = () => {
        if (!ctx.__mtRecord) return next();
        try {
          ctx.__mtRecord.status = (ctx.serverToProxyResponse && ctx.serverToProxyResponse.statusCode) || 0;
          ctx.__mtRecord.respHeaders = { ...(ctx.serverToProxyResponse && ctx.serverToProxyResponse.headers || {}) };
          // 记录 mime
          const ct = ctx.__mtRecord.respHeaders['content-type'] || ctx.__mtRecord.respHeaders['Content-Type'];
          if (ct) ctx.__mtRecord.mime = String(ct).split(';')[0].trim();
        } catch {}
        next();
      };
      const d = Number(ctx.__mtDelayMs || 0);
      if (d > 0) {
        try { if (!this.isQuiet) console.log('[CAPTURE][DELAY]', d, (ctx.__mtRecord && ctx.__mtRecord.path) || (ctx && ctx.clientToProxyRequest && ctx.clientToProxyRequest.url) || ''); } catch {}
        return setTimeout(proceed, d);
      }
      proceed();
    });

    if (this.keepBodies) {
      this.proxy.onResponseData((ctx, chunk, callback) => {
        try { if (ctx.__mtRespChunks) ctx.__mtRespChunks.push(Buffer.from(chunk)); } catch {}
        callback(null, chunk);
      });
    }

    this.proxy.onResponseEnd(async (ctx, next) => {
      if (!ctx.__mtRecord) return next();
      try {
        const rec = ctx.__mtRecord;
        rec.tsEnd = Date.now();
        rec.duration = Math.max(0, rec.tsEnd - (ctx.__mtStart || rec.tsStart));
        // 组装 body
        await this._finalizeBodies(rec, ctx.__mtReqChunks, ctx.__mtRespChunks);
      } catch (e) {
        try { if (!this.isQuiet) console.warn('[CAPTURE][finalizeBodies][err]', e && e.message); } catch {}
      } finally {
        // 清理内存
        try { ctx.__mtReqChunks = null; ctx.__mtRespChunks = null; } catch {}
      }
      next();
    });

    // 启动监听
    await new Promise((resolve, reject) => {
      try {
        this.proxy.listen({ port, host, sslCaDir: this.caDir }, (err) => {
          if (err) return reject(err);
          this.port = this.proxy.httpPort;
          this.host = host;
          this.active = true;
          this.startedAt = Date.now();
          if (!this.isQuiet) console.log('[CAPTURE] proxy started', `${host}:${this.port}`, 'caDir=', this.caDir);
          resolve();
        });
      } catch (e) { reject(e); }
    });

    return { ok: true, port: this.port };
  }

  async stop() {
    if (!this.active) return { ok: true };
    try {
      this.proxy && this.proxy.close();
    } catch {}
    this.active = false;
    this.port = null;
    this.startedAt = null;
    // 恢复 console.debug
    this._restoreMitmDebug();
    return { ok: true };
  }

  status() {
    return {
      running: this.active,
      port: this.port,
      host: this.host || '127.0.0.1',
      certInstalled: false,
      total: this.records.length,
      since: this.startedAt
    };
  }

  async getStatus() {
    const base = this.status();
    try {
      const sp = await this.querySystemProxy();
      base.proxyState = sp;
    } catch {}
    try {
      base.certInstalled = await this.isCertInstalled();
    } catch { base.certInstalled = false; }
    return base;
  }

  list({ offset = 0, limit = 100, query = {} } = {}) {
    const start = Math.max(0, Number(offset));
    const end = Math.min(this.records.length, start + Math.max(1, Number(limit)));
    const q = this._normalizeQuery(query);

    const data = [];
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (!r) continue;
      if (q.host && !String(r.host || '').includes(q.host)) continue;
      if (q.path && !String(r.path || '').includes(q.path)) continue;
      if (q.method && String(r.method).toUpperCase() !== q.method) continue;
      if (q.status && Number(r.status) !== Number(q.status)) continue;
      data.push({
        id: r.id,
        tsStart: r.tsStart,
        tsEnd: r.tsEnd,
        method: r.method,
        scheme: r.scheme,
        host: r.host,
        path: r.path,
        status: r.status,
        mime: r.mime,
        reqSize: r.reqSize,
        respSize: r.respSize,
        duration: r.duration
      });
      if (data.length >= end - start) break;
    }

    return { items: data.slice(0, end - start), total: this.records.length };
  }

  detail(id) {
    const r = this.records.find(x => x && x.id === Number(id));
    if (!r) return null;
    return {
      ...r,
      // 为避免 UI 卡顿，body inline 仅返回文本预览；二进制不返回 inline
      reqBody: this._bodyPreview(r.reqBodyInline, r.reqBodyPath),
      respBody: this._bodyPreview(r.respBodyInline, r.respBodyPath)
    };
  }

  clear() {
    this.records = [];
    this.idCounter = 0;
    try { fs.emptyDirSync(path.join(this.captureDir, 'bodies')); } catch {}
    return true;
  }

  async exportHar({ ids = null, range = null } = {}) {
    // 最简单的 HAR 导出实现（必要字段）
    const pick = (rec) => ({
      startedDateTime: new Date(rec.tsStart).toISOString(),
      time: rec.duration,
      request: {
        method: rec.method,
        url: `${rec.scheme}://${rec.host}${rec.path}`,
        httpVersion: 'HTTP/1.1',
        headers: this._headersToArray(rec.reqHeaders),
        queryString: [],
        headersSize: -1,
        bodySize: rec.reqSize,
        postData: rec.reqBodyInline ? { mimeType: rec.reqHeaders && (rec.reqHeaders['content-type'] || rec.reqHeaders['Content-Type']) || 'application/octet-stream', text: String(rec.reqBodyInline) } : undefined
      },
      response: {
        status: rec.status,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: this._headersToArray(rec.respHeaders),
        content: { size: rec.respSize, mimeType: rec.mime || 'application/octet-stream', text: this._safeText(rec.respBodyInline) },
        headersSize: -1,
        bodySize: rec.respSize
      },
      cache: {},
      timings: { send: 0, wait: rec.duration, receive: 0 },
      serverIPAddress: '',
      connection: ''
    });

    let selected = this.records;
    if (Array.isArray(ids) && ids.length > 0) {
      const set = new Set(ids.map(Number));
      selected = this.records.filter(r => r && set.has(r.id));
    }
    // TODO: range 支持可扩展（时间区间/索引区间）

    const log = {
      log: {
        version: '1.2',
        creator: { name: 'MiniToolbox Capture', version: '1.0' },
        entries: selected.filter(Boolean).map(pick)
      }
    };

    return JSON.stringify(log, null, 2);
  }

  // 启用系统代理（Windows，当前用户范围）
  async enableSystemProxy({ host = '127.0.0.1', port = null } = {}) {
    if (process.platform !== 'win32') return { ok: false, error: 'only supported on windows' };
    const p = Number(port || this.port || 8888);
    const server = `${host}:${p}`;
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][enable] target =', server); } catch {}
    const regExe = this._getRegExePath();
    const steps = [
      { args: ['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'] },
      { args: ['add', base, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f'] },
      { args: ['add', base, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f'] }
    ];
    for (const step of steps) {
      const r = await this._spawnCapture(regExe, step.args);
      const ok = r && r.code === 0;
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][reg]', regExe, step.args.join(' '), '=> code=', r.code, 'stdout=', (r.stdout||'').trim(), 'stderr=', (r.stderr||'').trim()); } catch {}
      if (!ok) {
        // 尝试 PowerShell 兜底
        const psOk = await this._setProxyViaPowerShell({ host, port: p });
        if (!psOk) return { ok: false, error: 'reg add failed', details: r };
        break;
      }
    }
    await this._notifyInternetSettingsChanged();
    const state = await this.querySystemProxy();
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][enable][state]', state); } catch {}
    return { ok: true, server, state };
  }

  async disableSystemProxy() {
    if (process.platform !== 'win32') return { ok: false, error: 'only supported on windows' };
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable]'); } catch {}
    const regExe = this._getRegExePath();
    let r = await this._spawnCapture(regExe, ['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
    let ok = r && r.code === 0;
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][reg]', regExe, 'add ProxyEnable=0 => code=', r.code, 'stdout=', (r.stdout||'').trim(), 'stderr=', (r.stderr||'').trim()); } catch {}
    if (!ok) {
      const psOk = await this._unsetProxyViaPowerShell();
      ok = psOk;
    }
    await this._notifyInternetSettingsChanged();
    const state = await this.querySystemProxy();
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable][state]', state); } catch {}
    return { ok, state };
  }

  // 安装根证书（当前用户）
  async installCert() {
    // windows: 使用 certutil -user -addstore "Root" ca.pem
    const caPem = path.join(this.caDir, 'certs', 'ca.pem');
    await this._ensureCaGenerated();
    if (process.platform === 'win32') {
      const args = ['-user', '-addstore', 'Root', caPem];
      const ok = await this._runCertutil(args);
      return { ok, path: caPem };
    }
    // 其他平台暂时仅返回路径，让用户手动安装
    return { ok: true, path: caPem };
  }

  async isCertInstalled() {
    try {
      if (process.platform !== 'win32') return false;
      // 优先 PowerShell 查询当前用户根存储 CN 包含 NodeMITMProxyCA
      const ps = "@(Get-ChildItem -Path Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -like '*Node MITM Proxy CA*' -or $_.Subject -like '*NodeMITMProxyCA*' }).Count";
      const r = await this._spawnCapture('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
      const n = parseInt(String((r.stdout||'').trim()), 10);
      if (!isNaN(n)) return n > 0;
      // 兜底用 certutil 枚举
      const cu = await this._spawnCapture('certutil', ['-user', '-store', 'Root']);
      return /Node\s*MITM\s*Proxy\s*CA|NodeMITMProxyCA/i.test(cu.stdout || '');
    } catch { return false; }
  }

  async _spawnOk(command, args) {
    return await new Promise((resolve) => {
      try {
        const p = spawn(command, args, { windowsHide: true, shell: true, stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('exit', (code) => resolve(code === 0));
      } catch { resolve(false); }
    });
  }

  async _notifyInternetSettingsChanged() {
    if (process.platform !== 'win32') return;
    const ps = "$sig='[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'; Add-Type -MemberDefinition $sig -Name I -Namespace Win32; [Win32.I]::InternetSetOption([IntPtr]::Zero,95,[IntPtr]::Zero,0)|Out-Null; [Win32.I]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null";
    const ok = await this._spawnOk('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY] InternetSetOption broadcast =>', ok ? 'OK' : 'FAIL'); } catch {}
  }

  async querySystemProxy() {
    if (process.platform !== 'win32') return { supported: false };
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const qEnable = await this._spawnCapture('reg', ['query', base, '/v', 'ProxyEnable']);
    const qServer = await this._spawnCapture('reg', ['query', base, '/v', 'ProxyServer']);
    const enable = /REG_DWORD\s+0x1/i.test(qEnable.stdout || '') ? 1 : 0;
    const serverMatch = (qServer.stdout || '').match(/ProxyServer\s+REG_SZ\s+(.+)$/mi);
    const server = serverMatch ? serverMatch[1].trim() : '';
    return { supported: true, enable, server, raw: { enable: qEnable, server: qServer } };
  }

  async _spawnCapture(command, args) {
    return await new Promise((resolve) => {
      try {
        const p = spawn(command, args, { windowsHide: true, shell: false });
        let out = '', err = '';
        p.stdout && p.stdout.on('data', d => { try { out += d.toString(); } catch {} });
        p.stderr && p.stderr.on('data', d => { try { err += d.toString(); } catch {} });
        p.on('error', (e) => resolve({ code: -1, stdout: out, stderr: (err + (e && e.message || '')).trim() }));
        p.on('exit', (code) => resolve({ code, stdout: out, stderr: err }));
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: e && e.message || String(e) });
      }
    });
  }

  _getRegExePath() {
    try {
      const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\\Windows';
      const sysnative = path.join(windir, 'Sysnative', 'reg.exe');
      const system32 = path.join(windir, 'System32', 'reg.exe');
      if (fs.existsSync(sysnative)) return sysnative;
      if (fs.existsSync(system32)) return system32;
    } catch {}
    return 'reg';
  }

  async _setProxyViaPowerShell({ host = '127.0.0.1', port }) {
    const server = `${host}:${port}`;
    const ps = `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Type DWord -Value 1; ` +
               `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyServer -Type String -Value '${server}'; ` +
               `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyOverride -Type String -Value '<local>'`;
    const ok = await this._spawnOk('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][ps] set =>', ok ? 'OK' : 'FAIL'); } catch {}
    return ok;
  }

  async _unsetProxyViaPowerShell() {
    const ps = `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Type DWord -Value 0`;
    const ok = await this._spawnOk('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][ps] unset =>', ok ? 'OK' : 'FAIL'); } catch {}
    return ok;
  }

  async uninstallCert() {
    const caPem = path.join(this.caDir, 'certs', 'ca.pem');
    if (process.platform === 'win32') {
      // certutil -user -delstore "Root" <SerialNumber or SHA1> 无法直接用文件
      // 简化：尝试从根存储删除 CN=NodeMITMProxyCA（可能会有多个副本）
      const name = 'NodeMITMProxyCA';
      const ok = await this._runCertutil(['-user', '-delstore', 'Root', name]);
      return { ok };
    }
    return { ok: true };
  }

  // 内部：最终化 body 存储
  async _finalizeBodies(rec, reqChunks, respChunks) {
    try {
      const reqBuf = Array.isArray(reqChunks) && reqChunks.length ? Buffer.concat(reqChunks) : null;
      let respBuf = Array.isArray(respChunks) && respChunks.length ? Buffer.concat(respChunks) : null;
      rec.reqSize = reqBuf ? reqBuf.length : 0;
      rec.respSize = respBuf ? respBuf.length : 0;

      const bodiesDir = path.join(this.captureDir, 'bodies');
      const writeIfTooLarge = async (buf, suffix, mimeHint) => {
        if (!buf) return { inline: null, file: null };
        const isText = this._isProbablyText(mimeHint) || this._isTextLike(buf);
        if (buf.length <= this.bodyInlineLimit && isText) {
          let text = buf.toString('utf8');
          if (this._isJsonLike(mimeHint)) {
            try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
          }
          return { inline: text, file: null };
        }
        const filename = `${rec.id}_${suffix}`;
        const filepath = path.join(bodiesDir, filename);
        await fs.writeFile(filepath, buf);
        return { inline: null, file: filepath };
      };

      // 尝试解压响应体
      try {
        const enc = (rec.respHeaders && (rec.respHeaders['content-encoding'] || rec.respHeaders['Content-Encoding'])) || '';
        const ce = String(enc).toLowerCase();
        if (respBuf && ce) {
          if (ce.includes('gzip')) {
            respBuf = zlib.gunzipSync(respBuf);
          } else if (ce.includes('deflate')) {
            try { respBuf = zlib.inflateSync(respBuf); } catch { respBuf = zlib.inflateRawSync(respBuf); }
          } else if (ce.includes('br')) {
            try { respBuf = zlib.brotliDecompressSync(respBuf); } catch {}
          }
        }
      } catch {}

      const req = await writeIfTooLarge(reqBuf, 'req.bin', (rec.reqHeaders && (rec.reqHeaders['content-type'] || rec.reqHeaders['Content-Type'])) || '');
      const resp = await writeIfTooLarge(respBuf, 'resp.bin', rec.mime || '');
      rec.reqBodyInline = req.inline;
      rec.reqBodyPath = req.file;
      rec.respBodyInline = resp.inline;
      rec.respBodyPath = resp.file;
    } catch {}
  }

  _pushRecord(item) {
    this.records.push(item);
    if (this.records.length > this.maxEntries) {
      this.records.shift();
    }
  }

  _normalizeTargetHosts(targets) {
    if (!targets) return null;
    const list = Array.isArray(targets) ? targets : String(targets).split(',');
    const set = new Set();
    for (const t of list) {
      const v = String(t || '').trim().toLowerCase();
      if (!v) continue;
      set.add(v);
    }
    return set;
  }

  // -------- 新增：抓包层过滤与延迟 --------
  _normalizeFilters(filters) {
    if (!filters) return null;
    const out = { pathPrefixes: null };
    try {
      if (filters.pathPrefixes) {
        const list = Array.isArray(filters.pathPrefixes) ? filters.pathPrefixes : String(filters.pathPrefixes).split(',');
        const arr = list.map(x => String(x || '').trim()).filter(Boolean);
        if (arr.length) out.pathPrefixes = arr;
      }
    } catch {}
    if (!out.pathPrefixes) return null;
    return out;
  }

  _shouldCaptureCtx(ctx) {
    try {
      const needHostFilter = !!(this.targetHosts && this.targetHosts.size > 0);
      const host = this._getHost(ctx) || '';
      // host 过滤（仅当配置了目标域时才启用）
      if (needHostFilter) {
        if (!host) return false;
        const h = host.toLowerCase();
        let hostOk = false;
        for (const t of this.targetHosts) {
          if (!t) continue;
          if (t.startsWith('*.')) {
            const bare = t.slice(2);
            if (h === bare || h.endsWith('.' + bare)) { hostOk = true; break; }
          } else {
            if (h === t || h.endsWith('.' + t)) { hostOk = true; break; }
          }
        }
        if (!hostOk) return false;
      }

      const f = this.filters;
      if (!f) return true;

      const req = ctx && ctx.clientToProxyRequest || {};
      const urlRaw = req.url || '/';
      let pathOnly = '/';
      try {
        if (String(urlRaw).startsWith('/')) {
          pathOnly = urlRaw;
        } else if (/^https?:/i.test(String(urlRaw))) {
          const u = new URL(urlRaw);
          pathOnly = u.pathname + (u.search || '');
        } else {
          // 例如 CONNECT 或 host:port，直接使用原值（此时大概率不会命中 path 前缀）
          pathOnly = urlRaw;
        }
      } catch { pathOnly = urlRaw; }

      if (f.pathPrefixes && f.pathPrefixes.length) {
        let ok = f.pathPrefixes.some(p => pathOnly.startsWith(p));
        if (!ok) return false;
      }

      return true;
    } catch { return false; }
  }

  // 已移除来源判定

  _normalizeDelayRules(rules) {
    if (!rules) return null;
    if (Array.isArray(rules)) {
      const out = [];
      for (const r of rules) {
        if (!r) continue;
        const prefix = String(r.prefix || '').trim();
        const delayMs = Math.max(0, Number(r.delayMs || r.delay || 0));
        const method = r.method ? String(r.method).toUpperCase() : null;
        if (prefix && delayMs >= 0) out.push({ prefix, delayMs, method });
      }
      return out.length ? out : null;
    }
    const s = String(rules).trim();
    if (!s) return null;
    const out = [];
    const parts = s.split(';');
    for (const part of parts) {
      const seg = String(part || '').trim();
      if (!seg) continue;
      const [lhs, rhs] = seg.split('=');
      const delayMs = Math.max(0, Number(rhs || 0));
      let method = null, prefix = String(lhs || '').trim();
      const colonIdx = prefix.indexOf(':');
      if (colonIdx > 0) {
        method = String(prefix.slice(0, colonIdx)).toUpperCase();
        prefix = prefix.slice(colonIdx + 1);
      }
      if (prefix) out.push({ prefix, delayMs, method });
    }
    return out.length ? out : null;
  }

  _matchDelay(ctx) {
    try {
      if (!this.delayRules || !this.delayRules.length) return 0;
      const req = ctx.clientToProxyRequest || {};
      const method = String(req.method || '').toUpperCase();
      const host = this._getHost(ctx) || '';
      const urlRaw = req.url || '/';
      let path = '/';
      try { path = new URL(urlRaw, (ctx.isSSL ? 'https://' : 'http://') + host).pathname + (new URL(urlRaw, 'http://x').search || ''); } catch { path = urlRaw; }
      for (const r of this.delayRules) {
        if (r.method && r.method !== method) continue;
        if (path.startsWith(r.prefix)) return Number(r.delayMs || 0);
      }
      return 0;
    } catch { return 0; }
  }

  _silenceMitmDebug() {
    try {
      if (this._suppressingMitmLogs) return;
      const orig = console.debug;
      const self = this;
      console.debug = function() {
        try {
          const msg = arguments && arguments[0];
          if (typeof msg === 'string' && /^(creating SNI context for|starting server for|https server started for)/i.test(msg)) {
            return; // 忽略 http-mitm-proxy 的 HTTPS 子服务器噪声日志
          }
        } catch {}
        try { return orig.apply(console, arguments); } catch {}
      };
      this._origConsoleDebug = orig;
      this._suppressingMitmLogs = true;
    } catch {}
  }

  _restoreMitmDebug() {
    try {
      if (!this._suppressingMitmLogs) return;
      if (this._origConsoleDebug) {
        console.debug = this._origConsoleDebug;
      }
    } catch {}
    this._origConsoleDebug = null;
    this._suppressingMitmLogs = false;
  }

  _normalizeQuery(query) {
    const q = query || {};
    const r = {};
    if (q.host) r.host = String(q.host);
    if (q.path) r.path = String(q.path);
    if (q.method) r.method = String(q.method).toUpperCase();
    if (q.status) r.status = Number(q.status);
    return r;
  }

  _getHost(ctx) {
    try {
      const req = ctx && ctx.clientToProxyRequest;
      const hdr = req && (req.headers || {});
      const hostHeader = hdr.host || hdr.Host;
      if (hostHeader) return String(hostHeader).split(':')[0];
      // 兜底：从 connect 请求
      const cr = ctx && ctx.connectRequest;
      if (cr && cr.url) return String(cr.url).split(':')[0];
      return '';
    } catch { return ''; }
  }

  _isTextLike(buf) {
    // 简易判定：有 0 字节则按二进制处理
    const max = Math.min(buf.length, 2000);
    for (let i = 0; i < max; i++) {
      if (buf[i] === 0) return false;
    }
    return true;
  }

  _isProbablyText(mime) {
    try {
      const m = String(mime || '').toLowerCase();
      if (!m) return false;
      if (m.startsWith('text/')) return true;
      if (m.includes('json') || m.includes('xml') || m.includes('x-www-form-urlencoded') || m.includes('javascript')) return true;
      return false;
    } catch { return false; }
  }

  _isJsonLike(mime) {
    try { return String(mime || '').toLowerCase().includes('json'); } catch { return false; }
  }

  _bodyPreview(inline, filePath) {
    if (inline != null) {
      const s = String(inline);
      return s.length > 1024 * 1024 ? s.slice(0, 1024 * 1024) : s;
    }
    if (filePath) {
      return `(saved) ${path.basename(filePath)} (${filePath})`;
    }
    return '';
  }

  async _ensureCaGenerated() {
    // 启动过 proxy.listen 才会生成 CA；如果未启动过，手动触发一次创建
    const caPem = path.join(this.caDir, 'certs', 'ca.pem');
    if (await fs.pathExists(caPem)) return;
    const ProxyClass = await __loadProxyClass(this.isQuiet);
    await new Promise((resolve, reject) => {
      try {
        const tmp = new ProxyClass();
        tmp.listen({ port: 0, sslCaDir: this.caDir }, (err) => {
          try { tmp.close(); } catch {}
          if (err) return reject(err);
          resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  async _runCertutil(args) {
    return await new Promise((resolve) => {
      try {
        const p = spawn('certutil', args, { windowsHide: true, stdio: 'ignore', shell: true });
        p.on('error', () => resolve(false));
        p.on('exit', (code) => resolve(code === 0));
      } catch { resolve(false); }
    });
  }

  // ---------- M1/M2: cURL 生成与请求重放 ----------
  getRecordById(id) {
    const rec = this.records.find(x => x && x.id === Number(id));
    return rec || null;
  }

  async _readReqBodyBuffer(rec, overrideText) {
    try {
      if (overrideText != null) return Buffer.from(String(overrideText), 'utf8');
      if (rec.reqBodyInline != null) return Buffer.from(String(rec.reqBodyInline), 'utf8');
      if (rec.reqBodyPath) {
        try { return await fs.readFile(rec.reqBodyPath); } catch {}
      }
      return null;
    } catch { return null; }
  }

  _buildUrl(rec, urlOverride) {
    if (urlOverride) return String(urlOverride);
    const host = rec.host || 'localhost';
    const path = rec.path || '/';
    const scheme = rec.scheme || 'http';
    return `${scheme}://${host}${path}`;
  }

  _applyHeaderOverrides(original, overrides) {
    const headers = { ...(original || {}) };
    const lower = {};
    Object.keys(headers).forEach(k => { lower[k.toLowerCase()] = k; });
    const set = overrides && overrides.set || overrides || {};
    const remove = (overrides && overrides.remove) || [];
    // set
    Object.keys(set).forEach(k => {
      const v = set[k];
      const lk = k.toLowerCase();
      const existed = lower[lk];
      if (existed) delete headers[existed];
      headers[k] = v;
    });
    // remove
    remove.forEach(k => {
      const lk = String(k).toLowerCase();
      const existed = lower[lk] || k;
      try { delete headers[existed]; } catch {}
    });
    // content-length 会自动计算
    delete headers['Content-Length']; delete headers['content-length'];
    return headers;
  }

  async toCurl({ id, overrides } = {}) {
    const rec = this.getRecordById(id);
    if (!rec) return '';
    const method = String((overrides && overrides.method) || rec.method || 'GET').toUpperCase();
    const url = this._buildUrl(rec, overrides && overrides.url);
    const headers = this._applyHeaderOverrides(rec.reqHeaders, overrides && overrides.headers);
    const bodyBuf = await this._readReqBodyBuffer(rec, overrides && overrides.bodyText);

    const parts = ['curl'];
    parts.push('-X', this._shQuote(method));
    parts.push(this._shQuote(url));
    Object.keys(headers || {}).forEach(k => {
      const v = headers[k];
      parts.push('-H', this._shQuote(`${k}: ${v}`));
    });
    if (bodyBuf && bodyBuf.length > 0) {
      if (bodyBuf.length <= 256 * 1024) {
        const text = bodyBuf.toString('utf8');
        parts.push('--data-binary', this._shQuote(text));
      } else if (rec.reqBodyPath) {
        // 使用文件引用（路径可能包含空格）
        parts.push('--data-binary', this._shQuote(`@${rec.reqBodyPath}`));
      }
    }
    const cmd = parts.join(' ');
    try { if (!this.isQuiet) console.log('[CAPTURE][CURL]', { id: rec.id, method, url }); } catch {}
    return cmd;
  }

  // 生成适配 PowerShell 的 curl 命令（使用 curl.exe，过滤易冲突头，启用 -L 与 --compressed）
  async toCurlPS({ id, overrides } = {}) {
    const rec = this.getRecordById(id);
    if (!rec) return '';
    const method = String((overrides && overrides.method) || rec.method || 'GET').toUpperCase();
    const url = this._buildUrl(rec, overrides && overrides.url);
    const rawHeaders = this._applyHeaderOverrides(rec.reqHeaders, overrides && overrides.headers);
    const headers = this._sanitizeHeadersForCurlPS(rawHeaders);
    const bodyBuf = await this._readReqBodyBuffer(rec, overrides && overrides.bodyText);

    const parts = ['curl.exe', '-L'];
    parts.push('-X', method);
    parts.push(`"${url}"`);
    // 强制避免压缩，兼容旧版 curl.exe 无 --compressed
    try {
      const hasAccept = headers['Accept'] || headers['accept'];
      if (!hasAccept) headers['Accept'] = 'text/plain,*/*';
      headers['Accept-Encoding'] = 'identity';
    } catch {}
    Object.keys(headers || {}).forEach(k => {
      const v = headers[k];
      parts.push('-H', this._psQuote(`${k}: ${v}`));
    });
    if (bodyBuf && bodyBuf.length > 0) {
      if (bodyBuf.length <= 256 * 1024) {
        const text = bodyBuf.toString('utf8');
        parts.push('--data-binary', this._psQuote(text));
      } else if (rec.reqBodyPath) {
        parts.push('--data-binary', this._psQuote(`@${rec.reqBodyPath}`));
      }
    }
    const cmd = parts.join(' ');
    try { if (!this.isQuiet) console.log('[CAPTURE][CURL][PS]', { id: rec.id, method, url }); } catch {}
    return cmd;
  }

  _sanitizeHeadersForCurlPS(headers) {
    try {
      const h = { ...(headers || {}) };
      const remove = ['host', 'Host', 'connection', 'Connection', 'accept-encoding', 'Accept-Encoding', 'content-length', 'Content-Length'];
      remove.forEach(k => { try { delete h[k]; } catch {} });
      return h;
    } catch { return headers || {}; }
  }

  _psQuote(s) {
    // PowerShell 单引号字符串：内部单引号用两个单引号表示
    const str = String(s == null ? '' : s);
    return `'${str.replace(/'/g, "''")}'`;
  }

  _shQuote(s) {
    const str = String(s == null ? '' : s);
    if (str === '') return "''";
    // 简化：用单引号并转义单引号
    return `'${str.replace(/'/g, "'\\''")}'`;
  }

  async replay({ id, overrides, insecure = false, followRedirects = true, timeoutMs = 20000 } = {}) {
    const rec = this.getRecordById(id);
    if (!rec) return { ok: false, error: 'not found' };
    let urlStr = this._buildUrl(rec, overrides && overrides.url);
    let method = String((overrides && overrides.method) || rec.method || 'GET').toUpperCase();
    let headers = this._applyHeaderOverrides(rec.reqHeaders, overrides && overrides.headers);
    const bodyBuf = await this._readReqBodyBuffer(rec, overrides && overrides.bodyText);
    const startTs = Date.now();

    try { if (!this.isQuiet) console.log('[CAPTURE][REPLAY][start]', { id: rec.id, url: urlStr, method, bodyBytes: bodyBuf ? bodyBuf.length : 0 }); } catch {}

    const doOne = (targetUrl, curMethod, curHeaders, curBody) => new Promise((resolve) => {
      try {
        const u = new URL(targetUrl);
        const isHttps = u.protocol === 'https:';
        const mod = isHttps ? require('https') : require('http');
        // 复制并清洗请求头，避免强制压缩与不必要头部
        const hdrs = { ...(curHeaders || {}) };
        try { delete hdrs['accept-encoding']; delete hdrs['Accept-Encoding']; } catch {}
        try { delete hdrs['content-length']; delete hdrs['Content-Length']; } catch {}
        try { delete hdrs['connection']; delete hdrs['Connection']; } catch {}
        const options = {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
          path: u.pathname + (u.search || ''),
          method: curMethod,
          headers: hdrs,
          rejectUnauthorized: !insecure,
          timeout: Math.max(1, Number(timeoutMs || 20000))
        };
        // content-length
        if (curBody && curBody.length > 0) {
          options.headers['Content-Length'] = Buffer.byteLength(curBody);
        }
        try { if (!this.isQuiet) console.log('[CAPTURE][REPLAY][request]', { url: targetUrl, method: curMethod, headers: curHeaders, insecure, timeoutMs }); } catch {}
        const req = mod.request(options, (res) => {
          const chunks = [];
          res.on('data', d => chunks.push(Buffer.from(d)));
          res.on('end', () => {
            let buf = Buffer.concat(chunks);
            // 尝试按响应头解压
            try {
              const encHeader = res.headers && (res.headers['content-encoding'] || res.headers['Content-Encoding']);
              const ce = String(encHeader || '').toLowerCase();
              if (ce) {
                if (ce.includes('br') && typeof zlib.brotliDecompressSync === 'function') {
                  try { buf = zlib.brotliDecompressSync(buf); } catch {}
                } else if (ce.includes('gzip')) {
                  try { buf = zlib.gunzipSync(buf); } catch {}
                } else if (ce.includes('deflate')) {
                  try { buf = zlib.inflateSync(buf); } catch { try { buf = zlib.inflateRawSync(buf); } catch {} }
                }
              }
            } catch {}
            try { if (!this.isQuiet) console.log('[CAPTURE][REPLAY][response]', { url: targetUrl, status: res.statusCode, bytes: buf.length }); } catch {}
            resolve({
              ok: true,
              status: res.statusCode,
              headers: res.headers,
              body: buf,
              url: targetUrl
            });
          });
        });
        req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
        req.on('error', (e) => {
          try { console.error('[CAPTURE][REPLAY][error]', e && e.message || e); } catch {}
          resolve({ ok: false, error: e && e.message || String(e) });
        });
        if (curBody && curBody.length > 0) req.write(curBody);
        req.end();
      } catch (e) { resolve({ ok: false, error: e && e.message || String(e) }); }
    });

    let curUrl = urlStr, curMethod = method, curHeaders = headers, curBody = bodyBuf;
    let resp = await doOne(curUrl, curMethod, curHeaders, curBody);
    let redirects = 0;
    while (followRedirects && resp && resp.ok && resp.status && [301,302,303,307,308].includes(resp.status) && redirects < 5) {
      const loc = resp.headers && (resp.headers.location || resp.headers.Location);
      if (!loc) break;
      let nextUrl = String(loc);
      try { if (!/^https?:/i.test(nextUrl)) nextUrl = new URL(nextUrl, curUrl).toString(); } catch {}
      try { if (!this.isQuiet) console.log('[CAPTURE][REPLAY][redirect]', { from: curUrl, to: nextUrl, status: resp.status }); } catch {}
      if (resp.status === 303 || (resp.status === 302 && curMethod === 'POST')) {
        curMethod = 'GET';
        curBody = null;
        // 删除可能不适用的实体头
        delete curHeaders['Content-Length']; delete curHeaders['content-length'];
        delete curHeaders['Content-Type']; delete curHeaders['content-type'];
      }
      curUrl = nextUrl;
      redirects += 1;
      resp = await doOne(curUrl, curMethod, curHeaders, curBody);
    }

    const duration = Date.now() - startTs;
    if (!resp || !resp.ok) {
      try { console.error('[CAPTURE][REPLAY][fail]', (resp && resp.error) || 'unknown'); } catch {}
      return { ok: false, error: (resp && resp.error) || 'replay failed' };
    }
    // 预览正文（尝试按文本输出）
    let preview = '';
    try {
      const ct = resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type']) || '';
      const isText = this._isProbablyText(ct);
      if (isText) {
        preview = resp.body.toString('utf8');
        if (this._isJsonLike(ct)) {
          try { preview = JSON.stringify(JSON.parse(preview), null, 2); } catch {}
        }
        if (preview.length > 1024 * 1024) preview = preview.slice(0, 1024 * 1024);
      } else {
        preview = `(binary ${resp.body.length} bytes)`;
      }
    } catch { preview = ''; }

    const result = {
      ok: true,
      data: {
        status: resp.status,
        headers: resp.headers,
        bodyPreview: preview,
        url: curUrl,
        method: curMethod,
        duration
      }
    };
    try { if (!this.isQuiet) console.log('[CAPTURE][REPLAY][done]', { status: result.data.status, duration: result.data.duration, url: result.data.url }); } catch {}
    return result;
  }
}

module.exports = { CaptureProxyService };
