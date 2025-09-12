const { contextBridge, ipcRenderer } = require('electron');

// 从命令行参数读取插件ID与实例ID
const argv = (process && process.argv) || [];
const pluginIdArg = argv.find(a => String(a||'').startsWith('--mt-plugin-id='));
const pluginId = pluginIdArg ? pluginIdArg.split('=')[1] : null;
const instanceIdArg = argv.find(a => String(a||'').startsWith('--mt-instance-id='));
const instanceId = instanceIdArg ? instanceIdArg.split('=')[1] : 'default';
const featureArg = argv.find(a => String(a||'').startsWith('--mt-feature-code='));
let currentFeatureCode = featureArg ? featureArg.split('=')[1] : '';


async function secureInvoke(channel, payload) {
  const res = await ipcRenderer.invoke('mt.secure-call', { pluginId, instanceId, channel, payload });
  // 统一解包：成功返回 data（或 true），失败抛错，便于插件直接使用
  if (res && res.ok) return (typeof res.data === 'undefined') ? true : res.data;
  const msg = (res && res.error) || 'Unknown error';
  throw new Error(msg);
}

const api = {
  version: '1.0.0',
  onInput(callback) {
    ipcRenderer.on('plugin-input', (_e, payload) => callback(payload));
    ipcRenderer.on('plugin-input', (_e, payload) => {
      try { if (payload && payload.featureCode) currentFeatureCode = String(payload.featureCode || ''); } catch {}
    });
  },
  // 统一网关
  invoke: secureInvoke,
  // 窗口控制
  window: {
    pin: (pinned = true) => ipcRenderer.send('mt.plugin.pin', { pluginId, instanceId, pinned: !!pinned }),
    // 标准窗口按钮：最小化/最大化/关闭
    controls: {
      minimize: () => ipcRenderer.send('mt.plugin.win', { pluginId, instanceId, action: 'minimize' }),
      maximize: () => ipcRenderer.send('mt.plugin.win', { pluginId, instanceId, action: 'maximize' }),
      close: () => ipcRenderer.send('mt.plugin.win', { pluginId, instanceId, action: 'close' }),
      toggleMaximize: () => ipcRenderer.send('mt.plugin.win', { pluginId, instanceId, action: 'toggle-maximize' })
    },
    devtools: {
      open: () => ipcRenderer.send('mt.plugin.devtools', { pluginId, instanceId, open: true }),
      close: () => ipcRenderer.send('mt.plugin.devtools', { pluginId, instanceId, open: false }),
      toggle: () => ipcRenderer.send('mt.plugin.devtools', { pluginId, instanceId, toggle: true })
    }
  },
  // 友好封装：API 即权限（由主进程实现与限制）
  clipboard: {
    readText: () => secureInvoke('clipboard.readText'),
    writeText: (text) => secureInvoke('clipboard.writeText', String(text || ''))
  },
  shell: {
    openExternal: (url) => secureInvoke('openExternal', String(url || ''))
  },
  net: {
    request: (options) => secureInvoke('net.request', options || {})
  },
  clip: {
    query: (params) => secureInvoke('clip.query', params || {}),
    delete: (id) => secureInvoke('clip.delete', id),
    clear: () => secureInvoke('clip.clear'),
    copy: (text) => secureInvoke('clip.copy', String(text || ''))
  },
  // 工具（预留占位，无权限查询接口）
  utils: {},
  // SQLite KV & 统计
  db: {
    // 最简 API：后台以当前 featureCode 作为 collection
    put: (key, value) => secureInvoke('db.put', { featureCode: currentFeatureCode, key: String(key), value }),
    get: (key) => secureInvoke('db.get', { featureCode: currentFeatureCode, key: String(key) }),
    del: (key) => secureInvoke('db.del', { featureCode: currentFeatureCode, key: String(key) }),
    list: (opts) => secureInvoke('db.list', { ...(opts||{}), featureCode: currentFeatureCode }),
    count: (opts) => secureInvoke('db.count', { ...(opts||{}), featureCode: currentFeatureCode })
  },
  stats: {
    // 最简 API：将 featureCode 作为 metric 前缀，便于区分各 feature
    inc: (metric, value) => secureInvoke('stats.inc', { metric: `${currentFeatureCode}.${String(metric)}`, value }),
    range: (metric, opts) => secureInvoke('stats.range', { metric: `${currentFeatureCode}.${String(metric)}`, ...(opts || {}) })
  }
};

contextBridge.exposeInMainWorld('MT', api);

// 不再向插件发送主题变更事件；插件下次打开即可应用最新主题

