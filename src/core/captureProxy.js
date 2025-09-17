const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
// 延迟加载 http-mitm-proxy，避免冷启动硬依赖

let __CachedProxyClass = null;
// 上游代理依赖（按需使用）
let __HttpProxyAgentClass = null;
let __HttpsProxyAgentClass = null;
let __SocksProxyAgentClass = null;

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
    // 修复：若传入 getDataDir()（已含 data），不再重复拼接 MiniToolbox/data
    try {
      const fromGetter = options.getDataDir && options.getDataDir();
      this.baseDir = options.baseDir || (fromGetter ? fromGetter : path.join((process.env.APPDATA || os.homedir()), 'MiniToolbox', 'data'));
    } catch {
      this.baseDir = options.baseDir || path.join((process.env.APPDATA || os.homedir()), 'MiniToolbox', 'data');
    }
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

    // 系统代理备份文件
    this.proxyBackupFile = path.join(this.captureDir, 'proxy-backup.json');

    // 目录配额（MB）与配额检查节流
    this.maxBodyDirMB = Number(options.maxBodyDirMB || 512);
    this._lastQuotaCheckTs = 0;

    // 改写/断点规则
    this.rewriteRules = null;

    // 链式上游代理
    this._httpUpstreamAgent = null;
    this._httpsUpstreamAgent = null;
    this._upstreamBypass = [];
    this._ourServer = null; // 形如 host:port
    this._upstreamHttpUrl = null;
    this._upstreamHttpsUrl = null;
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

    let port = Number(opts.port || 8888);
    const host = String(opts.host || '127.0.0.1');
    this.maxEntries = Math.max(100, Number(opts.maxEntries || 2000));
    this.keepBodies = opts.recordBody !== false;
    this.targetHosts = this._normalizeTargetHosts(opts.targets); // string|array|null
    this.filters = this._normalizeFilters(opts.filters || null);
    this.delayRules = this._normalizeDelayRules(opts.delayRules || null);
    this.maxBodyDirMB = Math.max(64, Number(opts.maxBodyDirMB || this.maxBodyDirMB || 512));
    // 允许外部配置内联阈值（KB），超过则落盘，默认保持原 256KB
    try {
      if (opts.bodyInlineLimit != null) {
        this.bodyInlineLimit = Math.max(1024, Number(opts.bodyInlineLimit));
      } else if (opts.bodyInlineLimitKB != null) {
        this.bodyInlineLimit = Math.max(1024, Number(opts.bodyInlineLimitKB) * 1024);
      }
    } catch {}
    this.rewriteRules = this._normalizeRewriteRules(opts.rewriteRules || null);
    // 预生成一次（可能端口稍后会变更，监听完成后再二次确认）
    try { this._ourServer = `${host}:${port}`; } catch {}
    try { await this._prepareUpstream(opts.upstream); } catch {}

    if (!this.__ProxyClass) this.__ProxyClass = await __loadProxyClass(this.isQuiet);
    // 仅在非开发环境抑制 http-mitm-proxy 的噪声日志
    const isDev = String(process.env.NODE_ENV || '').toLowerCase() === 'development' || process.env.MT_DEV === '1';
    if (!isDev) this._silenceMitmDebug();
    this.proxy = new this.__ProxyClass();

    // 核心钩子：请求/响应
    this.proxy.onError((ctx, err, kind) => {
      try { if (!this.isQuiet && process.argv.includes('--dev')) console.error('[CAPTURE][onError]', kind, err && err.message); } catch {}
      // 移除自动熔断机制，让用户手动控制链式代理
      try {
        const msg = (err && err.message) || '';
        const usedUpstream = !!(ctx && ctx.__mtUsedUpstream);
        const host = this._getHost(ctx) || '';
        if (usedUpstream && !this.isQuiet) {
          console.log('[CAPTURE][UPSTREAM][error]', 'host=', host, 'error=', msg);
        }
      } catch {}
    });

    // 仅当命中过滤时才进入详细记录
    const shouldCapture = (ctx) => this._shouldCaptureCtx(ctx);

    this.proxy.onRequest((ctx, next) => {
      // 链式上游代理：为每个出站请求按需设置 agent（绕过列表不套用）
      try {
        const upstreamOk = (this._httpUpstreamAgent || this._httpsUpstreamAgent);
        if (upstreamOk) {
          const host = this._getHost(ctx) || '';
          if (!this._isBypassedHost(host)) {
            ctx.proxyToServerRequestOptions = ctx.proxyToServerRequestOptions || {};
            ctx.proxyToServerRequestOptions.agent = ctx.isSSL ? (this._httpsUpstreamAgent || this._httpUpstreamAgent) : (this._httpUpstreamAgent || this._httpsUpstreamAgent);
            ctx.__mtUsedUpstream = true;
            // 已使用上游代理（日志已简化）
          } else {
            ctx.__mtUsedUpstream = false;
            // 已绕过上游代理（日志已简化）
          }
        }
      } catch {}
      // 改写/阻断/Mock：优先处理
      try {
        const rule = this._matchRewrite(ctx);
        if (rule) ctx.__mtRewrite = rule; else ctx.__mtRewrite = null;
        if (rule && (rule.action === 'block' || rule.action === 'mock')) {
          try {
            const now = Date.now();
            const id = ++this.idCounter;
            ctx.__mtId = id;
            ctx.__mtStart = now;
            const { method, url } = ctx.clientToProxyRequest;
            const host = this._getHost(ctx) || '';
            const scheme = ctx.isSSL ? 'https' : 'http';
            const item = {
              id,
              tsStart: now,
              tsEnd: now,
              method: String(method || '').toUpperCase(),
              scheme,
              host,
              path: url || '/',
              status: (rule.mock && Number(rule.mock.status)) || 403,
              mime: (rule.mock && rule.mock.headers && (rule.mock.headers['Content-Type'] || rule.mock.headers['content-type'])) || 'text/plain',
              reqSize: 0,
              respSize: (rule.mock && rule.mock.bodyText ? Buffer.byteLength(String(rule.mock.bodyText), 'utf8') : 0),
              duration: 0,
              reqHeaders: { ...(ctx.clientToProxyRequest.headers || {}) },
              respHeaders: { ...(rule.mock && rule.mock.headers || {}) },
              reqBodyPath: null,
              respBodyPath: null,
              reqBodyInline: null,
              respBodyInline: (rule.mock && rule.mock.bodyText != null) ? String(rule.mock.bodyText) : 'Blocked by rule'
            };
            this._pushRecord(item);
          } catch {}
          try {
            const status = (rule.mock && Number(rule.mock.status)) || 403;
            const headers = { 'Content-Type': 'text/plain; charset=utf-8', ...(rule.mock && rule.mock.headers || {}) };
            const body = (rule.mock && rule.mock.bodyText != null) ? String(rule.mock.bodyText) : 'Blocked by rule';
            ctx.proxyToClientResponse.writeHead(status, headers);
            ctx.proxyToClientResponse.end(body);
          } catch {}
          return; // 不再透传到上游
        }
        // 仅设置请求头改写
        if (rule && rule.setReqHeaders) {
          try {
            ctx.proxyToServerRequestOptions = ctx.proxyToServerRequestOptions || {};
            ctx.proxyToServerRequestOptions.headers = { ...(ctx.proxyToServerRequestOptions.headers || {}), ...rule.setReqHeaders };
          } catch {}
        }
      } catch {}
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
          // 响应头改写（若规则存在）
          try {
            const rr = ctx.__mtRewrite;
            if (rr && rr.setRespHeaders && ctx.serverToProxyResponse && ctx.serverToProxyResponse.headers) {
              Object.assign(ctx.serverToProxyResponse.headers, rr.setRespHeaders);
              Object.assign(ctx.__mtRecord.respHeaders, rr.setRespHeaders);
            }
          } catch {}
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
        // 请求完成（日志已简化）
      } catch (e) {
        try { if (!this.isQuiet) console.warn('[CAPTURE][finalizeBodies][err]', e && e.message); } catch {}
      } finally {
        // 清理内存
        try { ctx.__mtReqChunks = null; ctx.__mtRespChunks = null; } catch {}
      }
      next();
    });

    // 启动监听
    // 端口占用自动重试（先探测可用端口，再启动）
    try {
      const chosen = await this._findAvailablePort(host, port, 30);
      if (chosen !== port) { try { if (!this.isQuiet) console.log('[CAPTURE] port busy, switch to', chosen); } catch {} }
      port = chosen;
    } catch {}

    await new Promise((resolve, reject) => {
      try {
        this.proxy.listen({ port, host, sslCaDir: this.caDir }, (err) => {
          if (err) return reject(err);
          this.port = this.proxy.httpPort;
          this.host = host;
          this.active = true;
          this.startedAt = Date.now();
          if (!this.isQuiet) console.log('[CAPTURE] proxy started', `${host}:${this.port}`, 'baseDir=', this.baseDir, 'caDir=', this.caDir);
          // 端口可能改变，启动后再根据实际端口重置自连保护与上游代理
          try { this._ourServer = `${this.host}:${this.port}`; } catch {}
          try { this._prepareUpstream(opts.upstream); } catch {}
          resolve();
        });
      } catch (e) { reject(e); }
    });

    return { ok: true, port: this.port };
  }

  async stop() {
    try { if (!this.isQuiet) console.log('[CAPTURE][STOP] stopping proxy service...'); } catch {}
    
    if (!this.active) {
      try { if (!this.isQuiet) console.log('[CAPTURE][STOP] service already stopped'); } catch {}
      return { ok: true };
    }
    
    try {
      this.proxy && this.proxy.close();
    } catch {}
    
    this.active = false;
    this.port = null;
    this.startedAt = null;
    
    // 恢复 console.debug
    this._restoreMitmDebug();
    
    // 强制尝试恢复系统代理（无论当前状态如何）
    try {
      const st = await this.querySystemProxy();
      const our = this._ourServer;
      
      if (!this.isQuiet) console.log('[CAPTURE][STOP] current proxy state:', {
        enabled: st && st.enable, 
        server: st && st.server, 
        ourServer: our
      });
      
      // 如果系统代理指向我们，或者有备份存在，都尝试恢复
      let shouldRestore = false;
      if (st && st.enable === 1 && our && st.server === our) {
        shouldRestore = true;
        if (!this.isQuiet) console.log('[CAPTURE][STOP] system proxy points to us, restoring...');
      } else {
        // 检查是否有备份文件，有的话也尝试恢复
        const backup = await this._loadProxyBackup();
        if (backup && backup.last && backup.last.setBy === 'MiniToolbox') {
          shouldRestore = true;
          if (!this.isQuiet) console.log('[CAPTURE][STOP] found backup from us, restoring...');
        }
      }
      
      if (shouldRestore) {
        const restored = await this._restoreProxyBackup();
        await this._notifyInternetSettingsChanged();
        if (!this.isQuiet) console.log('[CAPTURE][STOP] proxy backup restored:', restored);
      } else {
        if (!this.isQuiet) console.log('[CAPTURE][STOP] no restore needed');
      }
    } catch (e) {
      if (!this.isQuiet) console.error('[CAPTURE][STOP] failed to restore proxy:', e.message);
    }
    
    try { if (!this.isQuiet) console.log('[CAPTURE][STOP] proxy service stopped successfully'); } catch {}
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
    try {
      base.caPath = path.join(this.caDir, 'certs', 'ca.pem');
      base.caThumbprint = await this._calcCaThumbprint();
    } catch {}
    try {
      const st = await this.querySystemProxy();
      base.pacUrl = st && st.autoConfigURL || '';
    } catch {}
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

  // 将 headers 对象转换为 HAR 所需的数组形式
  _headersToArray(obj) {
    try {
      const arr = [];
      const src = obj || {};
      Object.keys(src).forEach((k) => {
        arr.push({ name: k, value: String(src[k]) });
      });
      return arr;
    } catch { return []; }
  }

  _safeText(s) {
    try { return s == null ? '' : String(s); } catch { return ''; }
  }

  // 读取完整请求/响应体（不截断），用于前端复制
  async getBody({ id, which = 'resp', prettyJson = true } = {}) {
    try {
      const rec = this.getRecordById(id);
      if (!rec) return { ok: false, error: 'not found' };
      const isResp = String(which || 'resp') !== 'req' ;
      const inline = isResp ? rec.respBodyInline : rec.reqBodyInline;
      const filePath = isResp ? rec.respBodyPath : rec.reqBodyPath;
      const mime = isResp ? (rec.mime || (rec.respHeaders && (rec.respHeaders['content-type'] || rec.respHeaders['Content-Type']) || ''))
                          : ((rec.reqHeaders && (rec.reqHeaders['content-type'] || rec.reqHeaders['Content-Type'])) || '');
      let buf = null;
      if (inline != null) {
        buf = Buffer.from(String(inline), 'utf8');
      } else if (filePath) {
        try { buf = await fs.readFile(filePath); } catch {}
      }
      if (!buf) return { ok: true, data: { text: '', bytes: 0, isJson: false } };
      let text = '';
      let isJson = false;
      try {
        text = buf.toString('utf8');
      } catch { text = ''; }
      try {
        if (prettyJson && (this._isJsonLike(mime) || (text && /^[\s\r\n]*[\[{]/.test(text)))) {
          const obj = JSON.parse(text);
          text = JSON.stringify(obj, null, 2);
          isJson = true;
        }
      } catch {}
      return { ok: true, data: { text, bytes: buf.length, isJson } };
    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  }



  // 启用系统代理（Windows，当前用户范围）
  async enableSystemProxy({ host = '127.0.0.1', port = null } = {}) {
    if (process.platform !== 'win32') return { ok: false, error: 'only supported on windows' };
    const p = Number(port || this.port || 8888);
    const server = `${host}:${p}`;
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][enable] target =', server); } catch {}
    const regExe = this._getRegExePath();
    // 备份当前系统代理
    try {
      const st = await this.querySystemProxy();
      const prev = { enable: st.enable, server: st.server, override: st.override, autoConfigURL: st.autoConfigURL, autoDetect: st.autoDetect };
      await this._saveProxyBackup(prev, { ourServer: server });
    } catch {}
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
    
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] starting system proxy restore...'); } catch {}
    
    // 检查当前状态
    const currentState = await this.querySystemProxy();
    if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] current state:', {
      enabled: currentState && currentState.enable,
      server: currentState && currentState.server
    });
    
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const regExe = this._getRegExePath();
    
    // 优先尝试恢复备份
    try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] attempting backup restore...'); } catch {}
    const backup = await this._loadProxyBackup();
    const original = backup && backup.original;
    const ourFromBackup = backup && backup.last && backup.last.ourServer;
    const our = this._ourServer || ourFromBackup || '';
    let ok = await this._restoreProxyBackup();
    
    if (ok) {
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] backup restored successfully'); } catch {}
      // 通知系统设置变更并比对是否与 original 一致
      await this._notifyInternetSettingsChanged();
      let finalState = await this.querySystemProxy();
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] state after reg-restore:', finalState); } catch {}
      if (original && !this._proxyStateEquals(finalState, original)) {
        // 用 PowerShell 再次强制写入 original
        await this._setProxyRegistryViaPowerShell({
          enable: original.enable,
          server: original.server,
          override: original.override,
          autoConfigURL: original.autoConfigURL,
          autoDetect: original.autoDetect
        });
        await this._notifyInternetSettingsChanged();
        finalState = await this.querySystemProxy();
        try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] state after ps-restore:', finalState); } catch {}
      }
      // 若仍指向我们自身，则作为最后兜底禁用（避免遗留指向自身导致断网）
      const stillOurs = finalState && finalState.enable === 1 && our && finalState.server === our;
      if (stillOurs) {
        try { if (!this.isQuiet) console.warn('[CAPTURE][SYS-PROXY][disable] still points to us, disabling as last resort'); } catch {}
        let r = await this._spawnCapture(regExe, ['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
        let disabled = r && r.code === 0;
        if (!disabled) disabled = await this._unsetProxyViaPowerShell();
        await this._notifyInternetSettingsChanged();
        finalState = await this.querySystemProxy();
        ok = ok && !!disabled;
      }
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] final state:', finalState); } catch {}
      return { ok, state: finalState };
    } else {
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] backup restore failed, using fallback...'); } catch {}
      
      // 兜底：直接禁用代理
      let r = await this._spawnCapture(regExe, ['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
      ok = r && r.code === 0;
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][reg] ProxyEnable=0 => code=', r && r.code, 'stdout=', (r && r.stdout||'').trim(), 'stderr=', (r && r.stderr||'').trim()); } catch {}
      
      if (!ok) {
        try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] registry method failed, trying PowerShell...'); } catch {}
        const psOk = await this._unsetProxyViaPowerShell();
        ok = psOk;
        if (psOk) {
          try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] PowerShell method succeeded'); } catch {}
        } else {
          try { if (!this.isQuiet) console.error('[CAPTURE][SYS-PROXY][disable] all methods failed'); } catch {}
        }
      }
      // 通知并返回最终状态
      await this._notifyInternetSettingsChanged();
      const finalState = await this.querySystemProxy();
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][disable] final state:', finalState); } catch {}
      return { ok, state: finalState };
    }
  }

  // 安装根证书（当前用户）
  async installCert() {
    // windows: 使用 certutil -user -addstore "Root" ca.pem
    const caPem = path.join(this.caDir, 'certs', 'ca.pem');
    await this._ensureCaGenerated();
    if (process.platform === 'win32') {
      // 优先尝试当前用户根存储，其次尝试本机根存储（需要管理员权限）
      // 先卸载旧的同名 CA，避免存在过期/旧指纹的冲突
      try { await this._runCertutil(['-user', '-delstore', 'Root', 'NodeMITMProxyCA']); } catch {}
      try { await this._runCertutil(['-delstore', 'Root', 'NodeMITMProxyCA']); } catch {}
      const okUser = await this._runCertutil(['-user', '-addstore', 'Root', caPem]);
      if (okUser) {
        try { if (!this.isQuiet) console.log('[CAPTURE][CERT][install] user Root => OK'); } catch {}
        return { ok: true, scope: 'user', path: caPem };
      }
      const okMachine = await this._runCertutil(['-addstore', 'Root', caPem]);
      try { if (!this.isQuiet) console.log('[CAPTURE][CERT][install]', { okUser, okMachine }); } catch {}
      return { ok: !!okMachine, scope: okMachine ? 'machine' : 'none', path: caPem };
    }
    // 其他平台暂时仅返回路径，让用户手动安装
    return { ok: true, path: caPem };
  }

  async isCertInstalled() {
    try {
      if (process.platform !== 'win32') return false;
      await this._ensureCaGenerated();
      // 计算 CA 指纹，优先用指纹匹配，兜底用主题名匹配
      const fp = await this._calcCaThumbprint();
      const checkByCertutil = async (args) => {
        const r = await this._spawnCapture('certutil', args);
        const out = (r && r.stdout) || '';
        if (fp) {
          // 归一化输出，只保留十六进制字符
          const normalized = out.replace(/[^0-9A-F]/gi, '').toUpperCase();
          if (normalized.includes(fp)) return true;
          // 指纹不匹配则视为未安装（避免误判已安装旧版 CA）
          return false;
        }
        // 无法获取指纹时，降级按主题名粗略匹配
        return /Node\s*MITM\s*Proxy\s*CA|NodeMITMProxyCA/i.test(out);
      };
      const userOk = await checkByCertutil(['-user', '-store', 'Root']);
      const machineOk = userOk ? false : await checkByCertutil(['-store', 'Root']);
      const ok = !!(userOk || machineOk);
      try { if (!this.isQuiet) console.log('[CAPTURE][CERT][check]', { userOk, machineOk, fp: fp ? (fp.slice(0, 8) + '...') : null }); } catch {}
      return ok;
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
    const qOverride = await this._spawnCapture('reg', ['query', base, '/v', 'ProxyOverride']);
    const qAuto = await this._spawnCapture('reg', ['query', base, '/v', 'AutoConfigURL']);
    const qAutoDetect = await this._spawnCapture('reg', ['query', base, '/v', 'AutoDetect']);
    const enable = /REG_DWORD\s+0x1/i.test(qEnable.stdout || '') ? 1 : 0;
    const serverMatch = (qServer.stdout || '').match(/ProxyServer\s+REG_SZ\s+(.+)$/mi);
    const server = serverMatch ? serverMatch[1].trim() : '';
    const overrideMatch = (qOverride.stdout || '').match(/ProxyOverride\s+REG_SZ\s+(.+)$/mi);
    const override = overrideMatch ? overrideMatch[1].trim() : '';
    const autoMatch = (qAuto.stdout || '').match(/AutoConfigURL\s+REG_SZ\s+(.+)$/mi);
    const autoConfigURL = autoMatch ? autoMatch[1].trim() : '';
    const autoDetect = /REG_DWORD\s+0x1/i.test(qAutoDetect.stdout || '') ? 1 : 0;
    return { supported: true, enable, server, override, autoConfigURL, autoDetect, raw: { enable: qEnable, server: qServer, override: qOverride, auto: qAuto, autoDetect: qAutoDetect } };
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

  // -------- 备份/恢复系统代理 --------
  async initSystemProxyGuard() {
    try {
      await this.ensureDirs();
      const st = await this.querySystemProxy();
      await this._maybeSnapshotBackup(st);
      // 若系统代理指向我们但服务未运行，尝试恢复
      if (!this.active) {
        const backup = await this._loadProxyBackup();
        const our = backup && backup.last && backup.last.ourServer;
        if (st && st.enable === 1 && our && st.server === our) {
          const ok = await this._restoreProxyBackup();
          try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][startup-repair]', { ok, from: st.server }); } catch {}
          if (!ok) {
            await this._unsetProxyViaPowerShell();
            await this._notifyInternetSettingsChanged();
          }
        }
      }
    } catch (e) {
      try { if (!this.isQuiet) console.warn('[CAPTURE][SYS-PROXY][guard][err]', e && e.message); } catch {}
    }
  }

  async _maybeSnapshotBackup(state) {
    try {
      const exists = await fs.pathExists(this.proxyBackupFile);
      if (exists) return;
      if (!state) state = await this.querySystemProxy();
      const original = { enable: state.enable, server: state.server, override: state.override, autoConfigURL: state.autoConfigURL, autoDetect: state.autoDetect };
      const data = { original, last: null };
      await fs.writeJson(this.proxyBackupFile, data, { spaces: 2 });
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][backup][snapshot]', data); } catch {}
    } catch {}
  }

  async _saveProxyBackup(originalState, { ourServer } = {}) {
    try {
      const exists = await fs.pathExists(this.proxyBackupFile);
      let data = exists ? await fs.readJson(this.proxyBackupFile) : null;
      if (!data) data = { original: null, last: null };
      // 始终以“当前真实状态”覆盖 original，避免历史遗留导致误恢复
      data.original = {
        enable: originalState && originalState.enable,
        server: originalState && originalState.server,
        override: originalState && originalState.override,
        autoConfigURL: originalState && originalState.autoConfigURL,
        autoDetect: originalState && originalState.autoDetect
      };
      data.last = { setBy: 'MiniToolbox', ourServer: String(ourServer || ''), at: Date.now() };
      await fs.writeJson(this.proxyBackupFile, data, { spaces: 2 });
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][backup][save]', data); } catch {}
    } catch {}
  }

  async _loadProxyBackup() {
    try { if (await fs.pathExists(this.proxyBackupFile)) return await fs.readJson(this.proxyBackupFile); } catch {}
    return null;
  }

  async _restoreProxyBackup() {
    try {
      const data = await this._loadProxyBackup();
      if (!data || !data.original) return false;
      const orig = data.original;
      // 先恢复开关，再恢复其它键，避免写入 server 时隐式开启
      const okEnable = await this._setProxyRegistry({ enable: orig.enable });
      const okRest = await this._setProxyRegistry({ server: orig.server, override: orig.override, autoConfigURL: orig.autoConfigURL, autoDetect: orig.autoDetect });
      await this._notifyInternetSettingsChanged();
      let ok = !!(okEnable && okRest);
      try {
        const after = await this.querySystemProxy();
        const matched = this._proxyStateEquals(after, orig);
        if (!matched) {
          if (!this.isQuiet) console.warn('[CAPTURE][SYS-PROXY][restore] registry restore mismatch, trying PowerShell fallback...', { after, orig });
          const psOk = await this._setProxyRegistryViaPowerShell({ enable: orig.enable, server: orig.server, override: orig.override, autoConfigURL: orig.autoConfigURL, autoDetect: orig.autoDetect });
          await this._notifyInternetSettingsChanged();
          const after2 = await this.querySystemProxy();
          ok = psOk && this._proxyStateEquals(after2, orig);
          if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][restore] PowerShell fallback =>', ok ? 'OK' : 'FAIL');
        } else {
          ok = true;
        }
      } catch {}
      return !!ok;
    } catch { return false; }
  }

  async _setProxyRegistry({ enable, server, override, autoConfigURL, autoDetect }) {
    try {
      const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const regExe = this._getRegExePath();
      const steps = [];
      if (enable != null) steps.push(['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', String(Number(!!enable)), '/f']);
      if (server != null) steps.push(['add', base, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', String(server), '/f']);
      if (override != null) steps.push(['add', base, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', String(override), '/f']);
      if (autoConfigURL != null) steps.push(['add', base, '/v', 'AutoConfigURL', '/t', 'REG_SZ', '/d', String(autoConfigURL), '/f']);
      if (autoDetect != null) steps.push(['add', base, '/v', 'AutoDetect', '/t', 'REG_DWORD', '/d', String(Number(!!autoDetect)), '/f']);
      for (const args of steps) {
        const r = await this._spawnCapture(regExe, args);
        if (!(r && r.code === 0)) return false;
      }
      return true;
    } catch { return false; }
  }

  _proxyStateEquals(a, b) {
    try {
      if (!a || !b) return false;
      const num = (v) => Number(v || 0);
      const trim = (s) => (s == null ? '' : String(s).trim());
      const canonServer = (s) => {
        const p = this._parseWinProxyServer(s);
        const http = trim(p.http);
        const https = trim(p.https);
        const socks = trim(p.socks);
        return `http=${http};https=${https};socks=${socks}`;
      };
      const eq = (x, y) => trim(x) === trim(y);
      const enableOk = num(a.enable) === num(b.enable);
      const serverOk = canonServer(a.server) === canonServer(b.server);
      const overrideOk = eq(a.override, b.override);
      const pacOk = eq(a.autoConfigURL, b.autoConfigURL);
      const autoDetectOk = num(a.autoDetect) === num(b.autoDetect);
      return !!(enableOk && serverOk && overrideOk && pacOk && autoDetectOk);
    } catch { return false; }
  }

  async _setProxyRegistryViaPowerShell({ enable, server, override, autoConfigURL, autoDetect }) {
    try {
      const kv = [];
      const setDword = (name, val) => kv.push(`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ${name} -Type DWord -Value ${String(Number(!!val))}`);
      const setString = (name, val) => kv.push(`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ${name} -Type String -Value ${this._psQuote(String(val))}`);
      if (enable != null) setDword('ProxyEnable', enable);
      if (server != null) setString('ProxyServer', server);
      if (override != null) setString('ProxyOverride', override);
      if (autoConfigURL != null) setString('AutoConfigURL', autoConfigURL);
      if (autoDetect != null) setDword('AutoDetect', autoDetect);
      if (!kv.length) return true;
      const ps = kv.join('; ');
      const ok = await this._spawnOk('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
      try { if (!this.isQuiet) console.log('[CAPTURE][SYS-PROXY][ps][set]', ok ? 'OK' : 'FAIL'); } catch {}
      return ok;
    } catch { return false; }
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
      let okUser = await this._runCertutil(['-user', '-delstore', 'Root', name]);
      let okMachine = await this._runCertutil(['-delstore', 'Root', name]);
      // 额外清理：可能存在新的 Issuer 名称（不同版本库有差异）
      if (!okUser) okUser = await this._runCertutil(['-user', '-delstore', 'Root', 'Node MITM Proxy CA']);
      if (!okMachine) okMachine = await this._runCertutil(['-delstore', 'Root', 'Node MITM Proxy CA']);
      try { if (!this.isQuiet) console.log('[CAPTURE][CERT][uninstall]', { okUser, okMachine }); } catch {}
      return { ok: !!(okUser || okMachine) };
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
    // 目录配额控制（节流执行）
    try { await this._enforceBodiesQuota(); } catch {}
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

  // -------- 改写/断点 --------
  _normalizeRewriteRules(rules) {
    if (!rules) return null;
    let arr = Array.isArray(rules) ? rules : null;
    if (!arr) {
      try { arr = JSON.parse(String(rules)); } catch { arr = null; }
    }
    if (!Array.isArray(arr) || !arr.length) return null;
    const out = [];
    for (const r of arr) {
      if (!r || !r.action) continue;
      const action = String(r.action).toLowerCase();
      if (!['block','mock','setheaders'].includes(action)) continue;
      const match = r.match || {};
      const method = match.method ? String(match.method).toUpperCase() : null;
      const pathPrefix = match.pathPrefix ? String(match.pathPrefix) : null;
      const hostIncludes = match.hostIncludes ? String(match.hostIncludes) : null;
      const headerEquals = match.headerEquals && typeof match.headerEquals === 'object' ? match.headerEquals : null;
      const rule = { action, method, pathPrefix, hostIncludes, headerEquals };
      if (action === 'mock') {
        rule.mock = {
          status: (r.mock && r.mock.status) || 200,
          headers: (r.mock && r.mock.headers) || { 'Content-Type': 'application/json; charset=utf-8' },
          bodyText: (r.mock && r.mock.bodyText != null) ? String(r.mock.bodyText) : ''
        };
      }
      if (r.setReqHeaders && typeof r.setReqHeaders === 'object') rule.setReqHeaders = r.setReqHeaders;
      if (r.setRespHeaders && typeof r.setRespHeaders === 'object') rule.setRespHeaders = r.setRespHeaders;
      out.push(rule);
    }
    return out.length ? out : null;
  }

  _matchRewrite(ctx) {
    try {
      if (!this.rewriteRules || !this.rewriteRules.length) return null;
      const req = ctx && ctx.clientToProxyRequest || {};
      const method = String(req.method || '').toUpperCase();
      const host = this._getHost(ctx) || '';
      const urlRaw = req.url || '/';
      let path = '/';
      try { path = new URL(urlRaw, (ctx.isSSL ? 'https://' : 'http://') + host).pathname + (new URL(urlRaw, 'http://x').search || ''); } catch { path = urlRaw; }
      for (const r of this.rewriteRules) {
        if (r.method && r.method !== method) continue;
        if (r.hostIncludes && !host.includes(r.hostIncludes)) continue;
        if (r.pathPrefix && !path.startsWith(r.pathPrefix)) continue;
        if (r.headerEquals) {
          const hdrs = req.headers || {};
          let allOk = true;
          for (const k of Object.keys(r.headerEquals)) {
            const v = r.headerEquals[k];
            const hv = hdrs[k] || hdrs[k.toLowerCase()] || hdrs[k.toUpperCase()];
            if (String(hv) !== String(v)) { allOk = false; break; }
          }
          if (!allOk) continue;
        }
        return r;
      }
      return null;
    } catch { return null; }
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

  async _calcCaThumbprint() {
    try {
      const caPem = path.join(this.caDir, 'certs', 'ca.pem');
      if (!(await fs.pathExists(caPem))) return null;
      const pem = await fs.readFile(caPem, 'utf8');
      const b64 = pem.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s+/g, '');
      const der = Buffer.from(b64, 'base64');
      const sha1 = crypto.createHash('sha1').update(der).digest('hex').toUpperCase();
      return sha1;
    } catch { return null; }
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

  async replay({ id, overrides, insecure = false, followRedirects = true, timeoutMs = 20000, via = 'direct' } = {}) {
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
        // 走上游：根据协议注入对应 agent
        if (String(via) === 'upstream') {
          try {
            let agent = null;
            if (isHttps) {
              agent = this._httpsUpstreamAgent || this._httpUpstreamAgent || null;
            } else {
              agent = this._httpUpstreamAgent || this._httpsUpstreamAgent || null;
            }
            if (agent) options.agent = agent;
          } catch {}
        }
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

  // ---------- 手动测试上游连通性 ----------
  async testUpstreamConnectivity({ upstream = null, testUrl = null } = {}) {
    try {
      // 仅支持显式传入的上游；未传入则判为未配置
      let testUpstream = upstream;
      if (!testUpstream) {
        return { ok: false, error: '未配置上游代理' };
      }
      // 规范化：host:port -> http://host:port；常见 socks 端口推断为 socks5
      if (testUpstream) {
        if (!/^(https?|socks)/i.test(testUpstream)) {
          // 根据端口号推断协议类型
          if (/:\d+$/.test(testUpstream)) {
            const port = parseInt(testUpstream.split(':').pop(), 10);
            if (port === 1080 || port === 10808 || port === 1086) {
              testUpstream = `socks5://${testUpstream}`;
            } else {
              testUpstream = `http://${testUpstream}`;
            }
          } else {
            testUpstream = `http://${testUpstream}`;
          }
        }
      }

      const startTime = Date.now();
      
      // 基础TCP连接测试
      if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] starting test for:', testUpstream);
      const tcpOk = await this._basicTcpProbe(testUpstream);
      if (!tcpOk) {
        return { 
          ok: false, 
          error: 'TCP连接失败',
          details: { tcp: false, http: false, duration: Date.now() - startTime, upstream: testUpstream }
        };
      }

      // 功能性HTTP测试
      let httpOk;
      if (testUrl) {
        // 如果指定了测试URL，直接测试该URL
        if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] using specified test URL:', testUrl);
        httpOk = await this._testSingleUrl(testUpstream, testUrl);
      } else {
        // 没有指定URL时，不进行HTTP测试，只进行TCP测试
        if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] no test URL specified, skipping HTTP test');
        httpOk = true; // TCP连接成功就认为代理可用
      }
      const duration = Date.now() - startTime;
      
      if (httpOk) {
        return { 
          ok: true, 
          message: '上游代理连通正常',
          details: { tcp: true, http: true, duration, upstream: testUpstream }
        };
      } else {
        return { 
          ok: false, 
          error: '代理功能测试失败',
          details: { tcp: true, http: false, duration, upstream: testUpstream }
        };
      }
    } catch (e) {
      return { 
        ok: false, 
        error: e && e.message || '测试失败',
        details: { exception: true }
      };
    }
  }

  // ---------- 辅助：端口探测与目录配额 ----------
  async _findAvailablePort(host, startPort, maxSteps = 20) {
    const tryOne = (p) => new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', (err) => { try { srv.close(); } catch {} resolve(null); });
      srv.once('listening', () => { const pp = srv.address() && srv.address().port; srv.close(() => resolve(pp || p)); });
      try { srv.listen(p, host); } catch (e) { resolve(null); }
    });
    let p = Number(startPort);
    for (let i = 0; i <= maxSteps; i++) {
      const got = await tryOne(p);
      if (got != null) return p; // p 可用
      p += 1;
    }
    return startPort; // 兜底返回原端口
  }

  async _enforceBodiesQuota() {
    try {
      const now = Date.now();
      if (now - (this._lastQuotaCheckTs || 0) < 5000) return; // 5s 节流
      this._lastQuotaCheckTs = now;
      const dir = path.join(this.captureDir, 'bodies');
      const files = await fs.readdir(dir);
      let total = 0;
      const stats = [];
      for (const f of files) {
        const fp = path.join(dir, f);
        try {
          const st = await fs.stat(fp);
          if (!st.isFile()) continue;
          total += st.size;
          stats.push({ path: fp, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
      const quotaBytes = Math.max(64, this.maxBodyDirMB || 512) * 1024 * 1024;
      if (total <= quotaBytes) return;
      stats.sort((a, b) => a.mtime - b.mtime); // 旧的在前
      let removed = 0;
      for (const s of stats) {
        if (total <= quotaBytes * 0.9) break; // 回落至 90%
        try { await fs.remove(s.path); total -= s.size; removed += 1; } catch {}
      }
      try { if (!this.isQuiet) console.log('[CAPTURE][GC]', { beforeMB: (total/1024/1024).toFixed(1), quotaMB: this.maxBodyDirMB, removed }); } catch {}
    } catch {}
  }




  // ---------- 上游代理：准备/解析/绕过 ----------
  async _prepareUpstream(upstream) {
    try {
      this._httpUpstreamAgent = null;
      this._httpsUpstreamAgent = null;
      this._upstreamBypass = [];
      if (!upstream) return;

      // 动态按需加载依赖
      try {
        if (!__HttpProxyAgentClass) {
          const mod = require('http-proxy-agent');
          __HttpProxyAgentClass = (mod && (mod.HttpProxyAgent || mod.default)) || mod;
        }
      } catch {}
      try {
        if (!__HttpsProxyAgentClass) {
          const mod = require('https-proxy-agent');
          __HttpsProxyAgentClass = (mod && (mod.HttpsProxyAgent || mod.default)) || mod;
        }
      } catch {}
      try {
        if (!__SocksProxyAgentClass) {
          const mod = require('socks-proxy-agent');
          __SocksProxyAgentClass = (mod && (mod.SocksProxyAgent || mod.default)) || mod;
        }
      } catch {}
      if (!__HttpProxyAgentClass || !__HttpsProxyAgentClass) {
        try { if (!this.isQuiet) console.warn('[CAPTURE][UPSTREAM] agent modules not found'); } catch {}
        return;
      }

      let httpUrl = null, httpsUrl = null, bypassRaw = '';
      if (typeof upstream === 'object') {
        const u = upstream || {};
        httpUrl = u.http || u.https || u.url || null;
        httpsUrl = u.https || u.http || u.url || null;
        bypassRaw = u.bypass || '';
      } else if (typeof upstream === 'string') {
        const s = String(upstream || '').trim();
        httpUrl = s; httpsUrl = s;
      }

      const norm = (u) => {
        if (!u) return null;
        const str = String(u).trim();
        if (/^socks/i.test(str)) return str; // 支持 socks://, socks5://
        return /^https?:\/\//i.test(str) ? str : ('http://' + str);
      };
      httpUrl = norm(httpUrl);
      httpsUrl = norm(httpsUrl) || httpUrl;

      // 自连保护：如果上游地址就是我们自己，忽略
      const isSelf = (u) => {
        try { return u && this._ourServer && u.replace(/^https?:\/\//i,'') === this._ourServer; } catch { return false; }
      };
      if (isSelf(httpUrl)) httpUrl = null;
      if (isSelf(httpsUrl)) httpsUrl = null;

      // 根据协议分别创建 Agent
      const makeAgent = (url) => {
        if (!url) return null;
        if (/^socks/i.test(url)) return __SocksProxyAgentClass ? new __SocksProxyAgentClass(url) : null;
        if (/^https:/i.test(url)) return new __HttpsProxyAgentClass(url);
        return new __HttpProxyAgentClass(url);
      };
      // 直接创建 Agent，不做启动时探测（用户可手动测试）
      this._httpUpstreamAgent = makeAgent(httpUrl);
      this._httpsUpstreamAgent = makeAgent(httpsUrl) || makeAgent(httpUrl);
      this._upstreamHttpUrl = httpUrl;
      this._upstreamHttpsUrl = httpsUrl;
      this._upstreamBypass = this._parseBypassList(bypassRaw);

      try { if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM] http=%s https=%s bypass=%j', httpUrl, httpsUrl, this._upstreamBypass); } catch {}
    } catch (e) {
      try { if (!this.isQuiet) console.warn('[CAPTURE][UPSTREAM][prepare][err]', e && e.message); } catch {}
    }
  }

  async _probeUpstreamReachable(url) {
    try {
      if (!url) return false;
      // 先做基础TCP连接测试
      const basicReachable = await this._basicTcpProbe(url);
      if (!basicReachable) {
        try { if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][probe] TCP connection failed:', url); } catch {}
        return false;
      }
      // 通过实际HTTP请求测试代理功能
      const functionalTest = await this._functionalProxyTest(url);
      try { if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][probe]', url, 'TCP:', basicReachable, 'HTTP:', functionalTest); } catch {}
      return functionalTest;
    } catch { return false; }
  }

  async _basicTcpProbe(url) {
    try {
      const u = new URL(/^socks/i.test(url) ? url.replace(/^socks5?/i, 'http') : url);
      const host = u.hostname;
      const port = u.port ? Number(u.port) : (/^https:/i.test(url) ? 443 : 80);
      if (!host || !port) return false;
      return await new Promise((resolve) => {
        try {
          const socket = net.connect({ host, port, timeout: 800 }, () => { try { socket.destroy(); } catch {}; resolve(true); });
          socket.on('error', () => { try { socket.destroy(); } catch {}; resolve(false); });
          socket.on('timeout', () => { try { socket.destroy(); } catch {}; resolve(false); });
        } catch { resolve(false); }
      });
    } catch { return false; }
  }

  async _functionalProxyTest(proxyUrl) {
    try {
      // 动态加载代理agent
      let Agent = null;
      if (/^socks/i.test(proxyUrl)) {
        if (!__SocksProxyAgentClass) {
          const mod = require('socks-proxy-agent');
          __SocksProxyAgentClass = (mod && (mod.SocksProxyAgent || mod.default)) || mod;
        }
        Agent = __SocksProxyAgentClass;
      } else if (/^https:/i.test(proxyUrl)) {
        if (!__HttpsProxyAgentClass) {
          const mod = require('https-proxy-agent');
          __HttpsProxyAgentClass = (mod && (mod.HttpsProxyAgent || mod.default)) || mod;
        }
        Agent = __HttpsProxyAgentClass;
      } else {
        if (!__HttpProxyAgentClass) {
          const mod = require('http-proxy-agent');
          __HttpProxyAgentClass = (mod && (mod.HttpProxyAgent || mod.default)) || mod;
        }
        Agent = __HttpProxyAgentClass;
      }
      
      if (!Agent) return false;
      
      const agent = new Agent(proxyUrl);
      // 内置测试URL已移除，现在由UI层控制测试端点
      const testUrls = []; // 空数组，不再使用内置URL
      
      // 内置测试URL已移除，现在需要通过UI层指定测试URL
      if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][probe] ✗ no built-in test URLs, use UI selection:', proxyUrl);
      return false;
    } catch { return false; }
  }

  async _testSingleUrl(proxyUrl, testUrl) {
    try {
      // 动态加载代理agent
      let Agent = null;
      if (/^socks/i.test(proxyUrl)) {
        if (!__SocksProxyAgentClass) {
          const mod = require('socks-proxy-agent');
          __SocksProxyAgentClass = (mod && (mod.SocksProxyAgent || mod.default)) || mod;
        }
        Agent = __SocksProxyAgentClass;
      } else if (/^https:/i.test(proxyUrl)) {
        if (!__HttpsProxyAgentClass) {
          const mod = require('https-proxy-agent');
          __HttpsProxyAgentClass = (mod && (mod.HttpsProxyAgent || mod.default)) || mod;
        }
        Agent = __HttpsProxyAgentClass;
      } else {
        if (!__HttpProxyAgentClass) {
          const mod = require('http-proxy-agent');
          __HttpProxyAgentClass = (mod && (mod.HttpProxyAgent || mod.default)) || mod;
        }
        Agent = __HttpProxyAgentClass;
      }
      
      if (!Agent) return false;
      
      const agent = new Agent(proxyUrl);
      if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] testing single URL:', testUrl, 'via proxy:', proxyUrl);
      
      const result = await this._makeTestRequest(testUrl, agent);
      if (result) {
        if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] ✓ single URL test SUCCESS:', testUrl);
        return true;
      } else {
        if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] ✗ single URL test FAILED:', testUrl);
        return false;
      }
    } catch (e) {
      if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] ✗ single URL test exception:', testUrl, e.message);
      return false;
    }
  }

  async _makeTestRequest(url, agent) {
    return new Promise((resolve) => {
      try {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? require('https') : require('http');
        
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + (urlObj.search || ''),
          method: 'HEAD', // 使用HEAD减少流量，generate_204专门支持HEAD
          agent: agent,
          timeout: 8000, // 增加超时时间
          rejectUnauthorized: false, // 忽略SSL证书错误，测试代理连通性
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': '*/*',
            'Connection': 'close'
          }
        };
        
        const req = httpModule.request(options, (res) => {
          try {
            // 任何2xx和3xx状态码都认为是成功（包括200,204,301,302等）
            const success = res.statusCode >= 200 && res.statusCode < 400;
            if (!this.isQuiet) {
              console.log('[CAPTURE][UPSTREAM][test]', success ? 'success' : 'failed', ':', url, 'status:', res.statusCode);
            }
            resolve(success);
          } catch { resolve(false); }
        });
        
        req.on('timeout', () => { 
          try { req.destroy(); } catch {}; 
          if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] timeout:', url);
          resolve(false); 
        });
        
        req.on('error', (err) => {
          if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] error:', url, err.code || err.message);
          resolve(false);
        });
        
        req.end();
      } catch (e) { 
        if (!this.isQuiet) console.log('[CAPTURE][UPSTREAM][test] exception:', url, e.message);
        resolve(false); 
      }
    });
  }

  _parseWinProxyServer(s) {
    const out = { http: null, https: null, socks: null };
    try {
      const raw = String(s || '').trim();
      if (!raw) return out;
      if (raw.includes('=')) {
        raw.split(';').forEach(p => {
          const seg = String(p || '').trim();
          if (!seg) return;
          const i = seg.indexOf('=');
          if (i <= 0) return;
          const k = seg.slice(0, i).toLowerCase();
          const v = seg.slice(i + 1).trim();
          if (k === 'http') out.http = v; else if (k === 'https') out.https = v; else if (k === 'socks') out.socks = v;
        });
      } else {
        out.http = raw; out.https = raw;
      }
    } catch {}
    return out;
  }

  _parseBypassList(s) {
    try {
      const items = String(s || '').split(';').map(x => x.trim()).filter(Boolean);
      // 默认绕过内网地址和本地地址
      const defaultBypass = [
        'localhost', '127.0.0.1', '::1', '<local>',
        '*.local', '*.lan', '*.intranet',
        '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*',
        '172.20.*', '172.21.*', '172.22.*', '172.23.*', '172.24.*',
        '172.25.*', '172.26.*', '172.27.*', '172.28.*', '172.29.*',
        '172.30.*', '172.31.*', '192.168.*', '169.254.*'
      ];
      const set = new Set(items.concat(defaultBypass));
      return Array.from(set);
    } catch { 
      return ['localhost','127.0.0.1','::1','<local>', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.20.*', '172.21.*', '172.22.*', '172.23.*', '172.24.*', '172.25.*', '172.26.*', '172.27.*', '172.28.*', '172.29.*', '172.30.*', '172.31.*', '192.168.*', '169.254.*']; 
    }
  }

  _isBypassedHost(host) {
    try {
      const h = String(host || '').toLowerCase();
      if (!h) return true;
      if (!this._upstreamBypass || !this._upstreamBypass.length) return false;
      
      // 先检查是否是IP地址
      const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(h);
      
      for (const patRaw of this._upstreamBypass) {
        const pat = String(patRaw || '').toLowerCase();
        
        if (pat === '<local>') { 
          if (!h.includes('.')) return true; 
          continue; 
        }
        
        if (pat.startsWith('*.')) {
          const bare = pat.slice(2);
          if (h === bare || h.endsWith('.' + bare)) return true;
          continue;
        }
        
        // IP地址模式匹配，支持前缀通配（如 10.*、172.16.*、192.168.*）
        if (pat.includes('*') && isIPv4) {
          const patParts = pat.split('.');
          const hostParts = h.split('.');
          let match = true;
          const len = Math.min(patParts.length, hostParts.length);
          for (let i = 0; i < len; i++) {
            if (patParts[i] === '*') continue;
            if (patParts[i] !== hostParts[i]) { match = false; break; }
          }
          if (match) return true;
          continue;
        }
        
        // 精确匹配或域名后缀匹配
        if (h === pat || h.endsWith('.' + pat)) return true;
      }
      return false;
    } catch { return false; }
  }
}

module.exports = { CaptureProxyService };
