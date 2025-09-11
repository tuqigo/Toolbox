const { contextBridge, ipcRenderer } = require('electron');

// 从命令行参数读取插件ID与实例ID
const argv = (process && process.argv) || [];
const pluginIdArg = argv.find(a => String(a||'').startsWith('--mt-plugin-id='));
const pluginId = pluginIdArg ? pluginIdArg.split('=')[1] : null;
const instanceIdArg = argv.find(a => String(a||'').startsWith('--mt-instance-id='));
const instanceId = instanceIdArg ? instanceIdArg.split('=')[1] : 'default';

// 兼容 API：权限改为统一控制，此接口返回空数组（不再基于 manifest）
function getPermissions() {
  return ipcRenderer.invoke('mt.get-permissions').catch(() => []);
}

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
  // 工具
  utils: {
    getPermissions
  }
};

contextBridge.exposeInMainWorld('MT', api);

// 监听主题变化，向插件页发送自定义事件，供插件选择性响应
try {
  const applyTheme = (payload) => {
    try {
      const evt = new CustomEvent('mt-theme-change', { detail: payload });
      window.dispatchEvent(evt);
      // 也注入一个 CSS 变量，方便简单适配
      const eff = (payload && payload.effective) || 'light';
      const root = document.documentElement;
      if (eff === 'dark') {
        root.style.setProperty('--mt-bg', '#1f2023');
        root.style.setProperty('--mt-fg', '#e6e7ea');
      } else {
        root.style.setProperty('--mt-bg', '#ffffff');
        root.style.setProperty('--mt-fg', '#333333');
      }
    } catch {}
  };
  const { ipcRenderer } = require('electron');
  ipcRenderer.on('ui-theme', (_e, payload) => applyTheme(payload));
} catch {}

