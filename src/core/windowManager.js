const path = require('path');
const fs = require('fs-extra');
const { BrowserWindow } = require('electron');

class WindowManager {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    // 统一改为按实例键存储；单例时实例键即为 pluginId
    this.windows = new Map(); // key -> BrowserWindow
    this.pluginIdToInstanceKeys = new Map(); // pluginId -> Set(key)
    this.webContentsToPluginId = new Map(); // wc.id -> pluginId
    this.webContentsToInstanceKey = new Map(); // wc.id -> key
    this.contentViews = new Map(); // key -> BrowserView (content)
    this.chromeViews = new Map(); // key -> BrowserView (titlebar)
    this.chromeHeights = new Map(); // key -> number
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
            this.centerWindowOnScreen(win, targetScreen);
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

    // 如果指定了目标屏幕，在该屏幕上创建窗口
    if (targetScreen) {
      const { bounds } = targetScreen;
      const x = Math.round(bounds.x + (bounds.width - windowOptions.width) / 2);
      const y = Math.round(bounds.y + (bounds.height - windowOptions.height) / 2);
      windowOptions.x = x;
      windowOptions.y = y;
    }

    // 注入实例参数
    if (Array.isArray(windowOptions.webPreferences.additionalArguments)) {
      if (!windowOptions.webPreferences.additionalArguments.find(s => String(s||'').startsWith('--mt-instance-id='))) {
        windowOptions.webPreferences.additionalArguments.push(`--mt-instance-id=${instanceId}`);
      }
    }

    const win = new BrowserWindow(windowOptions);
    // 标记实例信息
    try {
      win.__mtPluginId = pluginMeta.id;
      win.__mtInstanceId = instanceId;
      win.__mtInstanceKey = key;
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
            `--mt-instance-id=${instanceId}`
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
      url.searchParams.set('instanceId', instanceId);
      url.searchParams.set('name', pluginMeta.name || pluginMeta.id);
      url.searchParams.set('icon', pluginMeta.icon || '🔧');
      url.searchParams.set('theme', this.defaultTheme);
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
      try { const cv = this.contentViews.get(key); if (cv) { this.webContentsToPluginId.delete(cv.webContents.id); this.webContentsToInstanceKey.delete(cv.webContents.id); } } catch {}
      try { this.contentViews.delete(key); } catch {}
      try { this.chromeViews.delete(key); } catch {}
    });
    // 失去焦点时自动隐藏（被钉住则不隐藏）
    win.on('blur', () => {
      try {
        if (!win.isDestroyed() && !win.__mtPinned) win.hide();
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
      for (const [, v] of this.contentViews.entries()) {
        try { v.webContents.send('ui-theme', payload); } catch {}
      }
    } catch {}
  }

  // 在指定屏幕上居中显示窗口
  centerWindowOnScreen(window, display) {
    if (!window || !display || window.isDestroyed()) return;
    
    const windowBounds = window.getBounds();
    const { bounds } = display;
    
    const x = Math.round(bounds.x + (bounds.width - windowBounds.width) / 2);
    const y = Math.round(bounds.y + (bounds.height - windowBounds.height) / 2);
    
    window.setPosition(x, y);
  }
}

module.exports = { WindowManager };


