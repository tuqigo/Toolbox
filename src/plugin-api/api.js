// MiniToolbox 插件 API（兼容适配）
// 统一 API 出口改为由 plugin-preload.js 通过 contextBridge 暴露的 window.MT
// 此文件仅做老代码兼容：将 MiniToolboxAPI/MTAPI 指向 window.MT

(function () {
  try {
    const api = window.MT;
    if (api) {
      window.MiniToolboxAPI = api;
      window.MTAPI = api;
      return;
    }
    // 兜底占位，避免老插件直接访问报错
    const placeholder = {};
    window.MiniToolboxAPI = placeholder;
    window.MTAPI = placeholder;
    try { console && console.warn && console.warn('[MiniToolbox] MT 未注入，api.js 提供空对象占位'); } catch { }
  } catch (e) {
    try { console && console.warn && console.warn('[MiniToolbox] 初始化 MTAPI 失败:', e); } catch { }
  }
})();
