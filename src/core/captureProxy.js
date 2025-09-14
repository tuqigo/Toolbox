const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { Proxy } = require('http-mitm-proxy/dist');

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

    this.proxy = new Proxy();

    // 核心钩子：请求/响应
    this.proxy.onError((ctx, err, kind) => {
      try { if (!this.isQuiet) console.error('[CAPTURE][onError]', kind, err && err.message); } catch {}
    });

    // 仅当命中过滤时才进入详细记录
    const shouldCapture = (ctx) => {
      try {
        const host = this._getHost(ctx);
        if (!host) return false;
        if (!this.targetHosts || this.targetHosts.size === 0) return true;
        const h = host.toLowerCase();
        for (const t of this.targetHosts) {
          if (!t) continue;
          if (t.startsWith('*.')) {
            const bare = t.slice(2); // example.com
            if (h === bare || h.endsWith('.' + bare)) return true;
          } else {
            if (h === t) return true;
            if (h.endsWith('.' + t)) return true; // example.com 匹配其子域
          }
        }
        return false;
      } catch { return false; }
    };

    this.proxy.onRequest((ctx, next) => {
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
      if (!ctx.__mtRecord) return next();
      try {
        ctx.__mtRecord.status = (ctx.serverToProxyResponse && ctx.serverToProxyResponse.statusCode) || 0;
        ctx.__mtRecord.respHeaders = { ...(ctx.serverToProxyResponse && ctx.serverToProxyResponse.headers || {}) };
        // 记录 mime
        const ct = ctx.__mtRecord.respHeaders['content-type'] || ctx.__mtRecord.respHeaders['Content-Type'];
        if (ct) ctx.__mtRecord.mime = String(ct).split(';')[0].trim();
      } catch {}
      next();
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
    await new Promise((resolve, reject) => {
      try {
        const tmp = new Proxy();
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
}

module.exports = { CaptureProxyService };
