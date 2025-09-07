const { contextBridge, ipcRenderer } = require('electron');
try {
  // 从 URL 参数读取 pluginId，兜底使用 document.baseURI 查询
  const q = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
  const pluginId = q.get('id') || (function(){ try { const u=new URL(document.baseURI); return u.searchParams.get('id'); } catch { return null; } })();

  const api = {
    pin: (id, v) => ipcRenderer.send('mt.plugin.pin', { pluginId: id || pluginId, pinned: !!v }),
    win: (id, action) => ipcRenderer.send('mt.plugin.win', { pluginId: id || pluginId, action }),
    devtools: (id, mode) => ipcRenderer.send('mt.plugin.devtools', { pluginId: id || pluginId, open: mode === 'open', toggle: mode === 'toggle' })
  };
  contextBridge.exposeInMainWorld('MTChrome', api);
} catch {
  contextBridge.exposeInMainWorld('MTChrome', {
    pin: () => {}, win: () => {}, devtools: () => {}
  });
}

