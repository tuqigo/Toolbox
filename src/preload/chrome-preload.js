const { contextBridge, ipcRenderer } = require('electron');
try {
  // 从 URL 参数读取 pluginId，兜底使用 document.baseURI 查询
  const q = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
  const pluginId = q.get('id') || (function(){ try { const u=new URL(document.baseURI); return u.searchParams.get('id'); } catch { return null; } })();
  const instanceId = q.get('instanceId') || 'default';

  const api = {
    pin: (id, inst, v) => ipcRenderer.send('mt.plugin.pin', { pluginId: id || pluginId, instanceId: inst || instanceId, pinned: !!v }),
    win: (id, inst, action) => ipcRenderer.send('mt.plugin.win', { pluginId: id || pluginId, instanceId: inst || instanceId, action }),
    devtools: (id, inst, mode) => ipcRenderer.send('mt.plugin.devtools', { pluginId: id || pluginId, instanceId: inst || instanceId, open: mode === 'open', toggle: mode === 'toggle' })
  };
  contextBridge.exposeInMainWorld('MTChrome', api);
} catch {
  contextBridge.exposeInMainWorld('MTChrome', {
    pin: () => {}, win: () => {}, devtools: () => {}
  });
}

