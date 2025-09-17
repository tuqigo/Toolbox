const path = require('path');
const fs = require('fs-extra');
const { BrowserWindow } = require('electron');

class WindowManager {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    this.isDev = !!options.isDev;
    // 统一改为按实例键存储；单例时实例键即为 pluginId
    this.windows = new Map(); // key -> BrowserWindow
    this.pluginIdToInstanceKeys = new Map(); // pluginId -> Set(key)
    this.webContentsToPluginId = new Map(); // wc.id -> pluginId
    this.webContentsToInstanceKey = new Map(); // wc.id -> key
    this.contentViews = new Map(); // key -> BrowserView (content)
    this.chromeViews = new Map(); // key -> BrowserView (titlebar)
    this.chromeHeights = new Map(); // key -> number
    this.webContentsToFeatureCode = new Map(); // wc.id -> last featureCode
    this.defaultChromeHeight = Math.max(32, Math.min(96, Number(options.titlebarHeight || 48)));
    this.defaultTheme = (options.defaultTheme || 'system'); // 'system' | 'light' | 'dark'
    this.instanceCounters = new Map(); // pluginId -> number
  }

  generateInstanceId(pluginId) {
    const next = (this.instanceCounters.get(pluginId) || 0) + 1;
    this.instanceCounters.set(pluginId, next);
    return `${Date.now().toString(36)}-${next}`;
  }

  getAnyInstanceKey(pluginId) {
    const set = this.pluginIdToInstanceKeys.get(pluginId);
    if (!set || set.size === 0) return null;
    for (const k of set.values()) return k;
    return null;
  }

  async createForPlugin(pluginMeta, targetScreen = null) {
    const isMulti = String(pluginMeta.instanceMode || 'single') === 'multi';
    let instanceId = null;
    let key = null;
    // 单例复用
    if (!isMulti) {
      const existingKey = this.getAnyInstanceKey(pluginMeta.id) || pluginMeta.id;
      if (this.windows.has(existingKey)) {
        const win = this.windows.get(existingKey);
        if (win && !win.isDestroyed()) {
          if (targetScreen) {
            try {
              this.positionWindowByConfig(win, pluginMeta.window || {}, targetScreen);
            } catch { this.centerWindowOnScreen(win, targetScreen); }
          }
          win.show();
          win.focus();
          return win;
        }
        this.windows.delete(existingKey);
      }
      instanceId = 'default';
      key = pluginMeta.id; // 单例直接使用插件ID作为键
    } else {
      instanceId = this.generateInstanceId(pluginMeta.id);
      key = `${pluginMeta.id}#${instanceId}`;
    }

    const cfg = pluginMeta.window || {};
    const windowOptions = {
      width: cfg.width || 900,
      height: cfg.height || 640,
      show: false,
      frame: false,
      autoHideMenuBar: true,
      resizable: cfg.resizable !== false,
      maximizable: cfg.resizable !== false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        enableRemoteModule: false,
        webSecurity: true,
        preload: path.join(__dirname, '../preload/plugin-preload.js'),
        additionalArguments: [
          `--mt-plugin-id=${pluginMeta.id}`,
          `--mt-titlebar-mode=overlay`
        ]
      }
    };

    // 计算初始位置（基于 workArea，考虑任务栏）
    try {
      const computed = this.computePositionByConfig(cfg, targetScreen, { width: windowOptions.width, height: windowOptions.height });
      if (computed) { windowOptions.x = computed.x; windowOptions.y = computed.y; }
    } catch {}

    // 注入实例参数
    if (Array.isArray(windowOptions.webPreferences.additionalArguments)) {
      if (!windowOptions.webPreferences.additionalArguments.find(s => String(s||'').startsWith('--mt-instance-id='))) {
        windowOptions.webPreferences.additionalArguments.push(`--mt-instance-id=${instanceId}`);
      }
    }

    // 尝试为窗口应用插件自定义任务栏图标（仅支持位图/ico）
    if (pluginMeta.iconPath && /\.(png|jpg|jpeg|gif|ico)$/i.test(pluginMeta.iconPath)) {
      try {
        const { nativeImage } = require('electron');
        const img = nativeImage.createFromPath(pluginMeta.iconPath);
        if (img && !img.isEmpty()) {
          windowOptions.icon = img;
        }
      } catch {}
    }

    const win = new BrowserWindow(windowOptions);
    // 标记实例信息
    try {
      win.__mtPluginId = pluginMeta.id;
      win.__mtInstanceId = instanceId;
      win.__mtInstanceKey = key;
      // 失焦自动隐藏配置：默认 false，可在 plugin.json 的 window.hideOnBlur:true 开启
      win.__mtHideOnBlur = !!(pluginMeta.window && pluginMeta.window.hideOnBlur === true);
    } catch {}

    // 先登记映射（主窗口可选）
    try {
      this.webContentsToPluginId.set(win.webContents.id, pluginMeta.id);
      this.webContentsToInstanceKey.set(win.webContents.id, key);
    } catch {}
    await win.loadURL('about:blank');

    // 叠加顶栏 + 内容 BrowserView，不侵入插件 DOM，且不遮挡内容
    try {
      const { BrowserView } = require('electron');
      // 内容视图：承载插件页面
      const contentView = new BrowserView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          enableRemoteModule: false,
          webSecurity: true,
          preload: path.join(__dirname, '../preload/plugin-preload.js'),
          additionalArguments: [
            `--mt-plugin-id=${pluginMeta.id}`,
            `--mt-instance-id=${instanceId}`,
            `--mt-feature-code=__unknown__`
          ]
        }
      });
      const setContentBounds = () => {
        try {
          const [w, h] = win.getContentSize();
          const ch = this.chromeHeights.get(key) || this.defaultChromeHeight;
          contentView.setBounds({ x: 0, y: ch, width: Math.max(0, w), height: Math.max(0, h - ch) });
          contentView.setAutoResize({ width: true, height: true });
        } catch {}
      };
      win.addBrowserView(contentView);
      setContentBounds();
      win.on('resize', setContentBounds);
      try {
        this.webContentsToPluginId.set(contentView.webContents.id, pluginMeta.id);
        this.webContentsToInstanceKey.set(contentView.webContents.id, key);
      } catch {}
      const htmlPath = path.join(pluginMeta.path, pluginMeta.main || 'index.html');
      await contentView.webContents.loadFile(htmlPath);

      // 顶栏视图：覆盖顶部 48px
      const view = new BrowserView({
        webPreferences: {
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
          webSecurity: true,
          preload: path.join(__dirname, '../preload/chrome-preload.js')
        }
      });
      const setViewBounds = () => {
        try {
          const [w] = win.getContentSize();
          const ch = this.chromeHeights.get(key) || this.defaultChromeHeight;
          view.setBounds({ x: 0, y: 0, width: Math.max(0, w), height: ch });
          view.setAutoResize({ width: true });
        } catch {}
      };
      win.addBrowserView(view);
      setViewBounds();
      win.on('resize', setViewBounds);
      const url = new URL('file://' + path.join(__dirname, '../ui/chrome.html'));
      url.searchParams.set('id', pluginMeta.id);
      url.searchParams.set('dev', this.isDev ? '1' : '0');
      url.searchParams.set('instanceId', instanceId);
      url.searchParams.set('name', pluginMeta.name || pluginMeta.id);
      url.searchParams.set('icon', pluginMeta.icon || '🔧');
      try { if (pluginMeta.iconUrl) url.searchParams.set('iconUrl', pluginMeta.iconUrl); } catch {}
      url.searchParams.set('theme', this.defaultTheme);
      try { url.searchParams.set('resizable', windowOptions.resizable ? '1' : '0'); } catch {}
      await view.webContents.loadURL(url.toString());
      // 存储引用
      win.__mtChromeView = view;
      this.contentViews.set(key, contentView);
      this.chromeViews.set(key, view);
      this.chromeHeights.set(key, this.defaultChromeHeight);
      try { this.webContentsToInstanceKey.set(view.webContents.id, key); } catch {}
    } catch {}

    try {
      // 移除菜单栏
      win.setMenuBarVisibility(false);
      win.setMenu(null);
    } catch {}

    // 置入钉住状态标记
    win.__mtPinned = false;
    win.on('closed', () => {
      try { this.windows.delete(key); } catch {}
      try {
        const set = this.pluginIdToInstanceKeys.get(pluginMeta.id);
        if (set) { set.delete(key); if (set.size === 0) this.pluginIdToInstanceKeys.delete(pluginMeta.id); }
      } catch {}
      try { this.webContentsToPluginId.delete(win.webContents.id); } catch {}
      try { this.webContentsToInstanceKey.delete(win.webContents.id); } catch {}
      try { const cv = this.contentViews.get(key); if (cv) { this.webContentsToPluginId.delete(cv.webContents.id); this.webContentsToInstanceKey.delete(cv.webContents.id); this.webContentsToFeatureCode.delete(cv.webContents.id); } } catch {}
      try { this.contentViews.delete(key); } catch {}
      try { this.chromeViews.delete(key); } catch {}
    });
    // 失去焦点时自动隐藏（被钉住则不隐藏）
    win.on('blur', () => {
      try {
        if (!win.isDestroyed() && !win.__mtPinned && win.__mtHideOnBlur) win.hide();
      } catch {}
    });
    this.windows.set(key, win);
    // 反向索引
    if (!this.pluginIdToInstanceKeys.has(pluginMeta.id)) this.pluginIdToInstanceKeys.set(pluginMeta.id, new Set());
    this.pluginIdToInstanceKeys.get(pluginMeta.id).add(key);
    win.show();
    return win;
  }

  getWindow(pluginId, instanceId = null) {
    try {
      if (instanceId && instanceId !== 'default') {
        const key = `${pluginId}#${instanceId}`;
        return this.windows.get(key) || null;
      }
      // 单例或未指定实例时，返回任一实例
      const anyKey = this.getAnyInstanceKey(pluginId) || pluginId;
      return this.windows.get(anyKey) || null;
    } catch { return null; }
  }

  getPluginIdForWebContents(wc) {
    try {
      const id = wc && wc.id;
      return this.webContentsToPluginId.get(id) || null;
    } catch {
      return null;
    }
  }

  getInstanceKeyForWebContents(wc) {
    try {
      const id = wc && wc.id;
      return this.webContentsToInstanceKey.get(id) || null;
    } catch { return null; }
  }

  getContentWebContentsForWindow(win) {
    try {
      const key = win && win.__mtInstanceKey;
      if (!key) return null;
      const v = this.contentViews.get(key);
      return v && v.webContents || null;
    } catch { return null; }
  }

  // 记录/查询插件内容视图最近一次的 featureCode（用于 DB 默认 collection 推断）
  setFeatureCodeForWebContents(wcOrId, featureCode) {
    try {
      const id = (wcOrId && wcOrId.id) || wcOrId;
      if (!id) return;
      this.webContentsToFeatureCode.set(id, String(featureCode || ''));
    } catch {}
  }

  getFeatureCodeForWebContents(wcOrId) {
    try {
      const id = (wcOrId && wcOrId.id) || wcOrId;
      if (!id) return null;
      return this.webContentsToFeatureCode.get(id) || null;
    } catch { return null; }
  }

  getContentWebContents(pluginId, instanceId = null) {
    try {
      if (instanceId && instanceId !== 'default') {
        const key = `${pluginId}#${instanceId}`;
        const v = this.contentViews.get(key);
        return v && v.webContents || null;
      }
      // 任一实例
      const anyKey = this.getAnyInstanceKey(pluginId) || pluginId;
      const v = this.contentViews.get(anyKey);
      return v && v.webContents || null;
    } catch { return null; }
  }

  setChromeHeight(pluginId, height, instanceId = null) {
    try {
      const h = Math.max(32, Math.min(96, Math.floor(height || 48)));
      if (instanceId && instanceId !== 'default') {
        const key = `${pluginId}#${instanceId}`;
        this.chromeHeights.set(key, h);
        const win = this.windows.get(key);
        const chrome = this.chromeViews.get(key);
        const content = this.contentViews.get(key);
        if (win && !win.isDestroyed() && chrome) {
          const [w, totalH] = win.getContentSize();
          try { chrome.setBounds({ x: 0, y: 0, width: Math.max(0, w), height: h }); } catch {}
          if (content) {
            try { content.setBounds({ x: 0, y: h, width: Math.max(0, w), height: Math.max(0, totalH - h) }); } catch {}
          }
        }
        return;
      }
      // 未指定实例：应用到该插件的所有实例（或单例）
      const keys = this.pluginIdToInstanceKeys.get(pluginId) || new Set([pluginId]);
      for (const key of keys) {
        this.chromeHeights.set(key, h);
        const win = this.windows.get(key);
        const chrome = this.chromeViews.get(key);
        const content = this.contentViews.get(key);
        if (win && !win.isDestroyed() && chrome) {
          const [w, totalH] = win.getContentSize();
          try { chrome.setBounds({ x: 0, y: 0, width: Math.max(0, w), height: h }); } catch {}
          if (content) {
            try { content.setBounds({ x: 0, y: h, width: Math.max(0, w), height: Math.max(0, totalH - h) }); } catch {}
          }
        }
      }
    } catch {}
  }

  setDefaultChromeHeight(height) {
    try {
      const h = Math.max(32, Math.min(96, Math.floor(Number(height) || 48)));
      this.defaultChromeHeight = h;
      // 实时应用到已打开窗口（未被单独设置过的）
      for (const [key, win] of this.windows.entries()) {
        if (!win || win.isDestroyed()) continue;
        if (!this.chromeHeights.has(key)) this.chromeHeights.set(key, h);
        const [pluginId, instanceId] = String(key).includes('#') ? String(key).split('#') : [key, 'default'];
        this.setChromeHeight(pluginId, this.chromeHeights.get(key), instanceId);
      }
    } catch {}
  }

  broadcastTheme(payload) {
    try {
      for (const [, v] of this.chromeViews.entries()) {
        try { v.webContents.send('ui-theme', payload); } catch {}
      }
      // 按新策略：不再向插件内容视图发送主题事件
    } catch {}
  }

  // 在指定屏幕上居中显示窗口（基于 workArea，考虑任务栏）
  centerWindowOnScreen(window, display) {
    if (!window || !display || window.isDestroyed()) return;
    try {
      const b = window.getBounds();
      const computed = this.computePositionByConfig({ position: 'center', edgeMargin: 0 }, display, { width: b.width, height: b.height });
      if (computed) window.setPosition(computed.x, computed.y);
    } catch {}
  }

  // 计算指定配置与屏幕上的目标窗口位置（基于 workArea，考虑任务栏）
  computePositionByConfig(cfg, display, size) {
    try {
      const { screen } = require('electron');
      const disp = display || (screen && screen.getPrimaryDisplay && screen.getPrimaryDisplay());
      if (!disp) return null;
      const area = disp.workArea || disp.bounds;
      const work = { x: area.x || 0, y: area.y || 0, width: area.width, height: area.height };
      const wndW = Math.max(0, (size && size.width) || 0);
      const wndH = Math.max(0, (size && size.height) || 0);
      const edgeMargin = Math.max(0, Math.floor(Number((cfg && cfg.edgeMargin) || 0)));

      const normalizePosition = (p) => {
        const s = String((cfg && cfg.position) || p || 'center').toLowerCase();
        const map = {
          'center': 'center',
          'top-left': 'top-left', 'tl': 'top-left', '左上': 'top-left', '左上角': 'top-left',
          'top-right': 'top-right', 'tr': 'top-right', '右上': 'top-right', '右上角': 'top-right',
          'bottom-left': 'bottom-left', 'bl': 'bottom-left', '左下': 'bottom-left', '左下角': 'bottom-left',
          'bottom-right': 'bottom-right', 'br': 'bottom-right', '右下': 'bottom-right', '右下角': 'bottom-right'
        };
        return map[s] || 'center';
      };

      const pos = normalizePosition((cfg && cfg.position) || 'center');
      let x = work.x + Math.max(0, Math.floor((work.width - wndW) / 2));
      let y = work.y + Math.max(0, Math.floor((work.height - wndH) / 2));
      if (pos === 'top-left') {
        x = work.x + edgeMargin;
        y = work.y + edgeMargin;
      } else if (pos === 'top-right') {
        x = work.x + Math.max(0, work.width - wndW - edgeMargin);
        y = work.y + edgeMargin;
      } else if (pos === 'bottom-left') {
        x = work.x + edgeMargin;
        y = work.y + Math.max(0, work.height - wndH - edgeMargin);
      } else if (pos === 'bottom-right') {
        x = work.x + Math.max(0, work.width - wndW - edgeMargin);
        y = work.y + Math.max(0, work.height - wndH - edgeMargin);
      }
      // 夹紧在工作区域内，避免越界
      x = Math.min(Math.max(work.x, x), work.x + Math.max(0, work.width - wndW));
      y = Math.min(Math.max(work.y, y), work.y + Math.max(0, work.height - wndH));
      return { x: Math.round(x), y: Math.round(y) };
    } catch { return null; }
  }

  // 按插件 window 配置定位已存在窗口（支持 position 与 edgeMargin；基于 workArea）
  positionWindowByConfig(window, cfg, display) {
    try {
      if (!window || window.isDestroyed()) return;
      const b = window.getBounds();
      const computed = this.computePositionByConfig(cfg, (function(){
        try {
          const { screen } = require('electron');
          if (!display && screen && screen.getDisplayNearestPoint) {
            const center = { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) };
            return screen.getDisplayNearestPoint(center);
          }
        } catch {}
        return display;
      })(), { width: Math.max(0, b.width), height: Math.max(0, b.height) });
      if (computed) window.setPosition(computed.x, computed.y);
    } catch {}
  }
}

module.exports = { WindowManager };


