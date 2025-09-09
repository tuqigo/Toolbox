const path = require('path');
const fs = require('fs-extra');
const { BrowserWindow } = require('electron');

class WindowManager {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    this.windows = new Map(); // pluginId -> BrowserWindow
    this.webContentsToPluginId = new Map(); // wc.id -> pluginId
    this.contentViews = new Map(); // pluginId -> BrowserView (content)
    this.chromeViews = new Map(); // pluginId -> BrowserView (titlebar)
    this.chromeHeights = new Map(); // pluginId -> number
    this.defaultChromeHeight = Math.max(32, Math.min(96, Number(options.titlebarHeight || 48)));
    this.defaultTheme = (options.defaultTheme || 'system'); // 'system' | 'light' | 'dark'
  }

  async createForPlugin(pluginMeta, targetScreen = null) {
    if (this.windows.has(pluginMeta.id)) {
      const win = this.windows.get(pluginMeta.id);
      if (!win.isDestroyed()) {
        // 如果指定了目标屏幕，将窗口移动到该屏幕
        if (targetScreen) {
          this.centerWindowOnScreen(win, targetScreen);
        }
        win.show();
        win.focus();
        return win;
      }
      this.windows.delete(pluginMeta.id);
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

    const win = new BrowserWindow(windowOptions);

    // 先登记映射（主窗口可选）
    try { this.webContentsToPluginId.set(win.webContents.id, pluginMeta.id); } catch {}
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
            `--mt-plugin-id=${pluginMeta.id}`
          ]
        }
      });
      const setContentBounds = () => {
        try {
          const [w, h] = win.getContentSize();
          const ch = this.chromeHeights.get(pluginMeta.id) || this.defaultChromeHeight;
          contentView.setBounds({ x: 0, y: ch, width: Math.max(0, w), height: Math.max(0, h - ch) });
          contentView.setAutoResize({ width: true, height: true });
        } catch {}
      };
      win.addBrowserView(contentView);
      setContentBounds();
      win.on('resize', setContentBounds);
      try { this.webContentsToPluginId.set(contentView.webContents.id, pluginMeta.id); } catch {}
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
          const ch = this.chromeHeights.get(pluginMeta.id) || this.defaultChromeHeight;
          view.setBounds({ x: 0, y: 0, width: Math.max(0, w), height: ch });
          view.setAutoResize({ width: true });
        } catch {}
      };
      win.addBrowserView(view);
      setViewBounds();
      win.on('resize', setViewBounds);
      const url = new URL('file://' + path.join(__dirname, '../ui/chrome.html'));
      url.searchParams.set('id', pluginMeta.id);
      url.searchParams.set('name', pluginMeta.name || pluginMeta.id);
      url.searchParams.set('icon', pluginMeta.icon || '🔧');
      url.searchParams.set('theme', this.defaultTheme);
      await view.webContents.loadURL(url.toString());
      // 存储引用
      win.__mtChromeView = view;
      this.contentViews.set(pluginMeta.id, contentView);
      this.chromeViews.set(pluginMeta.id, view);
      this.chromeHeights.set(pluginMeta.id, this.defaultChromeHeight);
    } catch {}

    try {
      // 移除菜单栏
      win.setMenuBarVisibility(false);
      win.setMenu(null);
    } catch {}

    // 置入钉住状态标记
    win.__mtPinned = false;
    win.on('closed', () => {
      this.windows.delete(pluginMeta.id);
      try { this.webContentsToPluginId.delete(win.webContents.id); } catch {}
      try { const cv = this.contentViews.get(pluginMeta.id); if (cv) this.webContentsToPluginId.delete(cv.webContents.id); } catch {}
      try { this.contentViews.delete(pluginMeta.id); } catch {}
      try { this.chromeViews.delete(pluginMeta.id); } catch {}
    });
    // 失去焦点时自动隐藏（被钉住则不隐藏）
    win.on('blur', () => {
      try {
        if (!win.isDestroyed() && !win.__mtPinned) win.hide();
      } catch {}
    });
    this.windows.set(pluginMeta.id, win);
    win.show();
    return win;
  }

  getWindow(pluginId) {
    try { return this.windows.get(pluginId) || null; } catch { return null; }
  }

  getPluginIdForWebContents(wc) {
    try {
      const id = wc && wc.id;
      return this.webContentsToPluginId.get(id) || null;
    } catch {
      return null;
    }
  }

  getContentWebContents(pluginId) {
    try {
      const v = this.contentViews.get(pluginId);
      return v && v.webContents || null;
    } catch {
      return null;
    }
  }

  setChromeHeight(pluginId, height) {
    try {
      const h = Math.max(32, Math.min(96, Math.floor(height || 48)));
      this.chromeHeights.set(pluginId, h);
      const win = this.getWindow(pluginId);
      const chrome = this.chromeViews.get(pluginId);
      const content = this.contentViews.get(pluginId);
      if (win && !win.isDestroyed() && chrome) {
        const [w, totalH] = win.getContentSize();
        try { chrome.setBounds({ x: 0, y: 0, width: Math.max(0, w), height: h }); } catch {}
        if (content) {
          try { content.setBounds({ x: 0, y: h, width: Math.max(0, w), height: Math.max(0, totalH - h) }); } catch {}
        }
      }
    } catch {}
  }

  setDefaultChromeHeight(height) {
    try {
      const h = Math.max(32, Math.min(96, Math.floor(Number(height) || 48)));
      this.defaultChromeHeight = h;
      // 实时应用到已打开窗口（未被单独设置过的）
      for (const [pluginId, win] of this.windows.entries()) {
        if (!win || win.isDestroyed()) continue;
        if (!this.chromeHeights.has(pluginId)) this.chromeHeights.set(pluginId, h);
        this.setChromeHeight(pluginId, this.chromeHeights.get(pluginId));
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


