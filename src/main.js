// 在 Windows 下设置控制台编码（必须在其他模块加载前）
if (process.platform === 'win32') {
  try {
    // 设置控制台代码页为 UTF-8
    const { spawn } = require('child_process');
    spawn('chcp', ['65001'], { stdio: 'ignore', shell: true });
    
    // 设置环境变量
    process.env.PYTHONIOENCODING = 'utf-8';
    process.env.LANG = 'zh_CN.UTF-8';
  } catch (error) {
    // 忽略错误
  }
}

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, clipboard, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { PluginManager } = require('./core/pluginManager');
const { InputAnalyzer } = require('./core/inputAnalyzer');
const { WindowManager } = require('./core/windowManager');
const { ClipboardStore } = require('./core/clipboardStore');
const { Matcher } = require('./core/matcher');
const { UsageStore } = require('./core/usageStore');
const { ConfigStore } = require('./core/configStore');
const { PluginInstaller } = require('./core/pluginInstaller');
const { IconManager } = require('./core/iconManager');

class MiniToolbox {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.isDev = process.argv.includes('--dev');
    this.isEditingMode = false; // 是否处于编辑模式
    this.isQuiet = process.argv.includes('--no-console');
    this.lastClipboardContent = '';
    this.clipboardTimer = null;
    
    // 屏幕信息缓存（启动时检测一次）
    this.screenInfo = null;
    this.windowSizes = null;
    
    // 新核心
    this.configStore = new ConfigStore({ isQuiet: this.isQuiet });
    this.pluginManager = new PluginManager({ isQuiet: this.isQuiet });
    this.inputAnalyzer = new InputAnalyzer({ isQuiet: this.isQuiet });
    this.windowManager = new WindowManager({ isQuiet: this.isQuiet });
    this.clipboardStore = new ClipboardStore({ isQuiet: this.isQuiet, maxItems: 500 });
    this.usageStore = new UsageStore({ isQuiet: this.isQuiet });
    this.matcher = new Matcher({ isQuiet: this.isQuiet, usageStore: this.usageStore });
    this.pluginInstaller = new PluginInstaller({ isQuiet: this.isQuiet });
    this.iconManager = new IconManager();
    this.devLoggingInitialized = false;
    
    // 剪贴板忽略相关
    this.ignoreNextClipboardChange = false;
    this.clipboardIgnoreTimeout = null;

    // 统一拦截主进程内的剪贴板写入，自动抑制一次自动填充
    try {
      const originalWriteText = clipboard.writeText.bind(clipboard);
      clipboard.writeText = (text) => {
        try { this.setIgnoreNextClipboardChange(); } catch {}
        try { originalWriteText(String(text || '')); } catch {}
      };
    } catch {}
  }

  // 基础内容分析器 - 只做最基本的分类
  analyzeContent(content) { 
    const analysis = this.inputAnalyzer.analyze(content);
    
    // 对于非文本文件，标记为不参与内容分析
    if (analysis.type === 'file' || analysis.type === 'image' || analysis.type === 'video' || analysis.type === 'audio') {
      const isNonTextFile = this.inputAnalyzer.isNonTextFile(content);
      analysis.skipContentAnalysis = isNonTextFile;
    }
    
    return analysis;
  }

  // 智能插件匹配器
  // 使用预建索引与偏好分排序：
  // - 文本类输入(text/json/url)：仅当命中特征规则(Regex/Keyword/Prefix)时展示
  // - 非文本类(file/image等)：类型或规则命中皆可展示
  matchPlugins(contentAnalysis) {
    return this.matcher.match(contentAnalysis);
  }


  // 系统托盘
  createTrayIcon() {
    const { nativeImage } = require('electron');
    const iconData = Buffer.alloc(16 * 16 * 4);
    
    for (let i = 0; i < iconData.length; i += 4) {
      iconData[i] = 70;     // R
      iconData[i + 1] = 130; // G  
      iconData[i + 2] = 180; // B
      iconData[i + 3] = 255; // A
    }
    
    return nativeImage.createFromBuffer(iconData, { width: 16, height: 16 });
  }

  createTray() {
    this.updateTrayMenu();
  }

  updateTrayMenu() {
    // 幂等保护，避免重复创建多个托盘图标
    if (this.tray) {
      try { this.tray.destroy(); } catch {}
      this.tray = null;
    }
    // 获取系统托盘icon路径
    const iconPath = path.join(__dirname, '../build/icon.ico');
    let trayIcon;
    
    try {
      if (fs.existsSync(iconPath)) {
        trayIcon = iconPath;
      } else {
        trayIcon = this.createTrayIcon();
      }
    } catch (error) {
      trayIcon = this.createTrayIcon();
    }

    this.tray = new Tray(trayIcon);
    
    // 从配置中获取当前设置
    const uiConfig = this.configStore.getUIConfig();
    const clipboardConfig = this.configStore.getClipboardConfig();
    
    const contextMenu = Menu.buildFromTemplate([
      { label: '切换输入框', click: () => this.toggleInputWindow() },
      { label: '重新加载插件', click: () => this.reloadPlugins() },
      { 
        label: '标题栏高度', 
        submenu: [
          { label: '32px', type: 'radio', checked: uiConfig.titlebarHeight === 32, click: () => this.setTitlebarHeight(32) },
          { label: '40px', type: 'radio', checked: uiConfig.titlebarHeight === 40, click: () => this.setTitlebarHeight(40) },
          { label: '48px', type: 'radio', checked: uiConfig.titlebarHeight === 48, click: () => this.setTitlebarHeight(48) },
          { label: '56px', type: 'radio', checked: uiConfig.titlebarHeight === 56, click: () => this.setTitlebarHeight(56) }
        ]
      },
      {
        label: '主题',
        submenu: [
          { label: '跟随系统', type: 'radio', checked: uiConfig.theme === 'system', click: () => this.setTheme('system') },
          { label: '明亮', type: 'radio', checked: uiConfig.theme === 'light', click: () => this.setTheme('light') },
          { label: '暗黑', type: 'radio', checked: uiConfig.theme === 'dark', click: () => this.setTheme('dark') }
        ]
      },
      { 
        label: '剪贴板设置', 
        submenu: [
          { 
            label: '启用自动填充', 
            type: 'checkbox', 
            checked: clipboardConfig.enabled,
            click: () => this.toggleClipboardAutoFill()
          },
          { type: 'separator' },
          { 
            label: '有效时间: 3秒', 
            type: 'radio',
            checked: clipboardConfig.autoFillMaxAge === 3,
            click: () => this.setClipboardMaxAge(3)
          },
          { 
            label: '有效时间: 5秒', 
            type: 'radio',
            checked: clipboardConfig.autoFillMaxAge === 5,
            click: () => this.setClipboardMaxAge(5)
          },
          { 
            label: '有效时间: 10秒', 
            type: 'radio',
            checked: clipboardConfig.autoFillMaxAge === 10,
            click: () => this.setClipboardMaxAge(10)
          },
          { 
            label: '有效时间: 30秒', 
            type: 'radio',
            checked: clipboardConfig.autoFillMaxAge === 30,
            click: () => this.setClipboardMaxAge(30)
          }
        ]
      },
      { label: '设置', click: () => this.openSettings() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]);
    
    this.tray.setToolTip('MiniToolbox - 轻量级插件工具箱');
    this.tray.setContextMenu(contextMenu);
    
    this.tray.on('click', () => {
      this.toggleInputWindow();
    });
  }
  async setTitlebarHeight(px) {
    try {
      this.windowManager.setDefaultChromeHeight(px);
      // 保存到配置文件
      await this.configStore.setTitlebarHeight(px);
      this.updateTrayMenu();
    } catch {}
  }

  async setTheme(theme) {
    try {
      const { nativeTheme } = require('electron');
      this.currentTheme = theme; // 'system' | 'light' | 'dark'
      let effective = theme;
      if (theme === 'system') {
        effective = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      }
      
      // 设置窗口管理器的主题
      this.windowManager.defaultTheme = theme;
      
      // 应用主题到所有窗口
      await this.applyThemeToWindows(theme, effective);
      
      // 跟随系统时，监听系统主题变化
      try {
        if (!this._nativeThemeHooked) {
          nativeTheme.on('updated', () => {
            if (this.currentTheme === 'system') {
              const eff = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
              this.applyThemeToWindows('system', eff);
            }
          });
          this._nativeThemeHooked = true;
        }
      } catch {}
      
      // 保存到配置文件
      await this.configStore.setTheme(theme);
      this.updateTrayMenu();
    } catch (e) {
      console.error('设置主题失败:', e && e.message || e);
    }
  }

  // 主窗口
  createMainWindow() {
    // 获取计算好的窗口尺寸
    const sizes = this.getWindowSizes();
    
    this.mainWindow = new BrowserWindow({
      width: sizes.windowWidth,
      height: sizes.windowHeight,
      minWidth: sizes.windowWidth,
      maxWidth: sizes.windowWidth,
      minHeight: sizes.windowHeight,
      maxHeight: sizes.windowHeight,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true, // 启用窗口移动
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true
      }
    });

    this.mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

    // 设置拖拽区域
    this.setupWindowDragging();

    this.mainWindow.on('blur', () => {
      if (!this.isDev && !this.isEditingMode && !this._isDragging) {
        // 添加短暂延迟，避免快速焦点切换时误触发
        setTimeout(() => {
          // 再次检查窗口状态，如果窗口仍然失去焦点且不在编辑模式且不在拖拽中，则隐藏
          if (this.mainWindow && !this.mainWindow.isFocused() && !this.isEditingMode && !this._isDragging) {
            this.hideMainWindow();
          }
        }, 100);
      }
    });

    if (this.isDev) {
      this.mainWindow.webContents.openDevTools();
    }
  }

  // 设置窗口拖拽功能
  setupWindowDragging() {
    let isDragging = false;
    let dragStartPosition = { x: 0, y: 0 };
    let windowStartPosition = { x: 0, y: 0 };

    // 监听渲染进程的拖拽事件
    ipcMain.on('window-drag-start', (event, { x, y }) => {
      if (!this.mainWindow) return;
      
      isDragging = true;
      this._isDragging = true;
      dragStartPosition = { x, y };
      const windowBounds = this.mainWindow.getBounds();
      windowStartPosition = { x: windowBounds.x, y: windowBounds.y };
    });

    ipcMain.on('window-drag-move', (event, { x, y }) => {
      if (!this.mainWindow || !isDragging) return;
      
      const deltaX = x - dragStartPosition.x;
      const deltaY = y - dragStartPosition.y;
      
      const newX = windowStartPosition.x + deltaX;
      const newY = windowStartPosition.y + deltaY;
      
      this.mainWindow.setPosition(newX, newY);
    });

    ipcMain.on('window-drag-end', () => {
      isDragging = false;
      // 延迟重置拖拽状态，避免立即触发blur事件隐藏窗口
      setTimeout(() => {
        this._isDragging = false;
      }, 100);
    });
  }

  async toggleInputWindow() {
    // 防重复调用保护
    const timestamp = Date.now();
    if (this._lastToggleTime && (timestamp - this._lastToggleTime) < 300) {
      return;
    }
    this._lastToggleTime = timestamp;
    
    // 防止并发操作
    if (this._isToggling) {
      return;
    }
    this._isToggling = true;
    
    try {
      if (!this.mainWindow) {
        return;
      }

      const currentScreen = this.getCurrentScreen();
      if (!currentScreen) {
        console.warn('无法获取当前屏幕信息');
        return;
      }

      const isOnCurrentScreen = this.isWindowOnScreen(currentScreen);
      
      // 如果窗口在当前屏幕显示，则隐藏
      if (this.mainWindow.isVisible() && isOnCurrentScreen) {
        this.hideMainWindow();
        return;
      }
      
      // 如果窗口在其他屏幕显示，先隐藏再在当前屏幕显示
      if (this.mainWindow.isVisible() && !isOnCurrentScreen) {
        this.hideMainWindow();
        // 等待隐藏动画完成后再显示，使用Promise避免竞态条件
        await new Promise(resolve => setTimeout(resolve, 100));
        // 再次检查屏幕，防止用户在等待期间移动鼠标
        const finalScreen = this.getCurrentScreen();
        if (finalScreen) {
          await this.showInputWindow();
        }
        return;
      }
      
      // 窗口未显示，直接在当前屏幕显示
      await this.showInputWindow();
    } catch (error) {
      if (!this.isQuiet) {
        console.error('切换输入窗口失败:', error);
      }
    } finally {
      this._isToggling = false;
    }
  }

  async showInputWindow() {
    if (this.mainWindow) {
      // 获取当前鼠标所在的屏幕
      const currentScreen = this.getCurrentScreen();
      
      // 先设置窗口位置和透明度，避免闪烁
      this.mainWindow.setOpacity(0);
      
      // 在当前屏幕居中显示
      this.centerWindowOnScreen(currentScreen);
      this.mainWindow.show();
      
      // 使用平滑的淡入动画
      const fadeSteps = 10;
      const fadeDelay = 15; // 总动画时间 150ms
      
      for (let i = 1; i <= fadeSteps; i++) {
        setTimeout(() => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.setOpacity(i / fadeSteps);
            if (i === fadeSteps) {
              // 动画完成后聚焦
              this.mainWindow.focus();
            }
          }
        }, i * fadeDelay);
      }
      
      // 确保主题正确应用（异步进行，不阻塞动画）
      setTimeout(async () => {
        try {
          const uiConfig = this.configStore.getUIConfig();
          const { nativeTheme } = require('electron');
          let effective = uiConfig.theme;
          if (uiConfig.theme === 'system') {
            effective = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
          }
          await this.applyThemeToWindows(uiConfig.theme, effective);
        } catch (error) {
          if (!this.isQuiet) {
            console.warn('显示主窗口时应用主题失败:', error);
          }
        }
      }, 50);
    }
  }

  hideMainWindow() {
    if (this.mainWindow && this.mainWindow.isVisible()) {
      // 使用平滑的淡出动画
      const fadeSteps = 8;
      const fadeDelay = 12; // 总动画时间 96ms，比淡入稍快
      
      for (let i = fadeSteps - 1; i >= 0; i--) {
        setTimeout(() => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.setOpacity(i / fadeSteps);
            if (i === 0) {
              // 动画完成后隐藏窗口并恢复透明度
              this.mainWindow.hide();
              this.mainWindow.setOpacity(1);
            }
          }
        }, (fadeSteps - i) * fadeDelay);
      }
    }
  }

  // 获取当前鼠标所在的屏幕
  getCurrentScreen() {
    try {
      const { screen } = require('electron');
      const cursorPoint = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(cursorPoint);
    } catch (error) {
      if (!this.isQuiet) {
        console.error('获取当前屏幕失败:', error);
      }
      // 返回主显示器作为备选
      try {
        const { screen } = require('electron');
        return screen.getPrimaryDisplay();
      } catch (fallbackError) {
        if (!this.isQuiet) {
          console.error('获取主显示器失败:', fallbackError);
        }
        return null;
      }
    }
  }

  // 在指定屏幕上居中显示窗口
  centerWindowOnScreen(display) {
    if (!this.mainWindow || !display) return;
    
    const windowBounds = this.mainWindow.getBounds();
    const { bounds } = display;
    
    const x = Math.round(bounds.x + (bounds.width - windowBounds.width) / 2);
    const y = Math.round(bounds.y + (bounds.height - windowBounds.height) / 2);
    
    this.mainWindow.setPosition(x, y);
  }

  // 检测窗口是否在指定屏幕上
  isWindowOnScreen(display) {
    if (!this.mainWindow || !display || !this.mainWindow.isVisible()) {
      return false;
    }
    
    const windowBounds = this.mainWindow.getBounds();
    const { bounds } = display;
    
    // 检查窗口中心点是否在屏幕范围内
    const windowCenterX = windowBounds.x + windowBounds.width / 2;
    const windowCenterY = windowBounds.y + windowBounds.height / 2;
    
    return (
      windowCenterX >= bounds.x &&
      windowCenterX <= bounds.x + bounds.width &&
      windowCenterY >= bounds.y &&
      windowCenterY <= bounds.y + bounds.height
    );
  }

  // 插件管理
  async loadPlugins() { await this.pluginManager.loadAll(); }

  async reloadPlugins() {
    await this.loadPlugins();
    this.matcher.rebuild(this.pluginManager.list());
    
    // 通知渲染进程重新加载插件列表
    if (this.mainWindow) {
      this.mainWindow.webContents.send('plugins-reloaded');
    }
  }

  // 插件执行
  async executePlugin(pluginId, inputData) {
    const plugin = this.pluginManager.get(pluginId);
    if (!plugin) {
      console.error('插件未找到:', pluginId);
      return;
    }

    try {
      // 检查是否是无UI插件
      if (!plugin.ui) {
        await this.executeHeadlessPlugin(plugin, inputData);
      } else {
        const pluginWindow = await this.createPluginWindow(plugin);
        
        // 清除主输入框内容（有UI插件执行时）
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('clear-input');
        }
        
        // 使用内容视图的 webContents 发送数据（避免发送到顶栏）
        setTimeout(() => {
          try {
            const targetWc = this.windowManager.getContentWebContentsForWindow(pluginWindow) || this.windowManager.getContentWebContents(plugin.id) || (pluginWindow && pluginWindow.webContents);
            if (targetWc && !targetWc.isDestroyed()) {
              const safeInputData = {
                content: inputData.content,
                type: inputData.type,
                length: inputData.length,
                lines: inputData.lines,
                timestamp: inputData.timestamp,
                featureCode: inputData.featureCode
              };
              targetWc.send('plugin-input', safeInputData);
            }
          } catch {}
        }, 300);
      }
      
      // 使用偏好计数
      try { await this.usageStore.increment(plugin.id); } catch {}

    } catch (error) {
      console.error('执行插件失败:', error);
    }
  }

  // 执行无UI插件
  async executeHeadlessPlugin(plugin, inputData) {
    try {
      // 统一默认：无 UI 插件入口为 script.js（不再兼容其他文件名）
      const jsPath = path.join(plugin.path, 'script.js');
      if (await fs.pathExists(jsPath)) {
        await this.executeNewStylePlugin(plugin, inputData, jsPath);
        return;
      }
      // 兜底：URL 直接打开
      if (inputData.type === 'url' || inputData.features?.includes('url')) {
        await this.openUrlDirectly(inputData.content);
      }
    } catch (error) {
      console.error('执行无UI插件失败:', error);
    }
  }


  // 执行新风格插件
  async executeNewStylePlugin(plugin, inputData, jsPath) {
    const pluginModule = require(jsPath);
    
    // 根据 featureCode 找到对应的处理器
    const featureCode = inputData.featureCode;
    if (!featureCode) {
      console.error('缺少 featureCode');
      return;
    }
    
    const featureHandler = pluginModule[featureCode];
    if (!featureHandler || typeof featureHandler !== 'object') {
      console.error('找不到 feature 处理器:', featureCode);
      return;
    }
    
    // 获取进入事件处理器
    if (typeof featureHandler.handleEnter === 'function') {
      // 创建回调函数
      const callbackSetList = (items) => {
        this.sendListResults(plugin.id, items, inputData);
      };
      
      // 创建重定向函数
      const redirect = (targetPluginId, content) => {
        this.redirectToPlugin(targetPluginId, content);
      };
      
      // 构造action对象
      const action = {
        payload: inputData.content,
        type: inputData.type,
        featureCode: inputData.featureCode,
        redirect: redirect
      };
      
      try {
        await featureHandler.handleEnter(action, callbackSetList);
      } catch (error) {
        console.error('执行插件进入事件失败:', error);
        callbackSetList([{
          title: '插件执行出错',
          description: error.message || '未知错误',
          data: null
        }]);
      }
    }
  }

  // 发送列表结果到渲染进程
  sendListResults(pluginId, items, inputData) {
    if (this.mainWindow) {
      if (this.isDev) {
        console.log(`[${pluginId}] 发送列表结果:`, {
          itemCount: items.length
        });
        console.log(`[DEBUG] 完整的 items 数据:`, JSON.stringify(items, null, 2));
      }
      
      this.mainWindow.webContents.send('plugin-list-results', {
        pluginId,
        items,
        inputData
      });
    }
  }

  // 重定向到其他插件（直接执行目标插件，避免回填输入框导致的二次匹配闪烁）
  async redirectToPlugin(targetPluginId, content) {
    try {
      // 规范化输入
      const payload = String(content == null ? '' : content);
      const ca = this.analyzeContent(payload) || { type: 'text' };
      const inputData = {
        content: payload,
        type: ca.type || 'text',
        length: payload.length,
        lines: String(payload).split('\n').length,
        timestamp: Date.now(),
        inputMode: 'redirect',
        featureCode: ''
      };
      // 重定向时立即隐藏主输入窗口，避免与目标插件窗口重叠/闪烁
      try { this.hideMainWindow(); } catch {}
      await this.executePlugin(targetPluginId, inputData);
    } catch (e) {
      // 退回渲染进程兜底
      if (this.mainWindow) {
        this.mainWindow.webContents.send('plugin-redirect', { targetPluginId, content });
      }
    }
  }

  // 处理无UI插件的结果
  async handleHeadlessPluginResult(plugin, result, inputData) {
    try {
      // 支持不同的结果格式
      let resultData = result;
      
      // 如果结果是字符串，转换为标准格式
      if (typeof result === 'string') {
        resultData = {
          success: true,
          result: result,
          message: '处理完成'
        };
      }
      
      // 检查插件的 onResult 配置
      const onResult = plugin.onResult || {};
      const mode = onResult.mode || 'inline'; // 默认内联显示
      
      if (mode === 'inline' && this.mainWindow) {
        // 发送结果到渲染进程进行内联显示
        this.mainWindow.webContents.send('headless-plugin-result', {
          fromPluginId: plugin.id,
          result: resultData,
          route: {
            mode: 'inline'
          }
        });
      }
      
      if (this.isDev && !this.isQuiet) {
        console.log('无UI插件结果:', plugin.id, resultData);
      }
      
    } catch (error) {
      console.error('处理无UI插件结果失败:', error);
    }
  }

  // 直接打开URL
  async openUrlDirectly(content) {
    let urlToOpen = content.trim();
    
    // 处理不同类型的URL
    if (!urlToOpen.startsWith('http://') && !urlToOpen.startsWith('https://')) {
      // 如果是域名，添加https://
      if (/^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/.test(urlToOpen)) {
        urlToOpen = 'https://' + urlToOpen;
      }
      // 如果是本地地址，添加http://
      else if (/^(localhost|127\.0\.0\.1)/.test(urlToOpen)) {
        urlToOpen = 'http://' + urlToOpen;
      }
      // 如果是IP地址，添加http://
      else if (/^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/.test(urlToOpen)) {
        urlToOpen = 'http://' + urlToOpen;
      }
    }

    if (this.isDev && !this.isQuiet) {
      console.log('打开链接:', urlToOpen);
    }

    try {
      await shell.openExternal(urlToOpen);
      return true;
    } catch (error) {
      console.error('打开链接失败:', error);
      return false;
    }
  }

  async createPluginWindow(plugin) { 
    // 获取主输入框所在的屏幕
    const mainWindowScreen = this.getMainWindowScreen();
    const created = await this.windowManager.createForPlugin(plugin, mainWindowScreen);
    // 兼容旧调用方：既支持返回 win，也支持返回对象
    return created && created.win ? created.win : created; 
  }

  // 获取主输入框所在的屏幕
  getMainWindowScreen() {
    if (!this.mainWindow || !this.mainWindow.isVisible()) {
      // 如果主窗口不可见，使用当前鼠标所在屏幕
      return this.getCurrentScreen();
    }
    
    const { screen } = require('electron');
    const windowBounds = this.mainWindow.getBounds();
    const windowCenterX = windowBounds.x + windowBounds.width / 2;
    const windowCenterY = windowBounds.y + windowBounds.height / 2;
    
    return screen.getDisplayNearestPoint({ x: windowCenterX, y: windowCenterY });
  }

  // 在主进程发起 HTTP/HTTPS 请求，避免渲染进程的跨域与权限限制
  async performRequest(reqOptions) {
    return await new Promise((resolve) => {
      try {
        const isHttps = String(reqOptions.protocol || '').toLowerCase().startsWith('https') || (!reqOptions.protocol && reqOptions.port === 443);
        const mod = isHttps ? require('https') : require('http');
        const options = {
          hostname: reqOptions.hostname,
          port: reqOptions.port || (isHttps ? 443 : 80),
          path: reqOptions.path || '/',
          method: reqOptions.method || 'GET',
          headers: reqOptions.headers || {}
        };

        const req = mod.request(options, (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(Buffer.from(d)));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({ ok: true, status: res.statusCode, headers: res.headers, data: buf.toString('utf8') });
          });
        });

        req.on('error', (err) => resolve({ ok: false, error: err.message }));

        if (reqOptions.body) {
          const bodyStr = typeof reqOptions.body === 'string' ? reqOptions.body : JSON.stringify(reqOptions.body);
          if (!options.headers['Content-Type'] && !options.headers['content-type']) req.setHeader('Content-Type', 'application/json');
          req.write(bodyStr);
        }
        req.end();
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // IPC 处理器
  setupIpcHandlers() {
    const getPluginIdFromEvent = (event) => {
      try {
        const wc = event && event.sender;
        return this.windowManager.getPluginIdForWebContents(wc);
      } catch { return null; }
    };

    // 安全调用网关
    ipcMain.handle('mt.secure-call', async (event, { pluginId, instanceId, channel, payload } = {}) => {
      const pid = pluginId || getPluginIdFromEvent(event);
      const meta = pid && this.pluginManager.get(pid);
      
      // 对于配置API，允许所有插件访问，不进行严格的插件ID验证
      const isConfigAPI = channel && channel.startsWith('config.');
      
      
      if (!meta && !isConfigAPI) {
        return { ok: false, error: 'unknown plugin' };
      }

      try {
        switch (channel) {
          case 'clipboard.readText':
            return { ok: true, data: clipboard.readText() };
          case 'clipboard.writeText':
            this.setIgnoreNextClipboardChange();
            clipboard.writeText(String(payload || ''));
            return { ok: true };
          case 'write-clipboard':
            clipboard.writeText(String(payload || ''));
            return { ok: true };
          case 'openExternal':
            await shell.openExternal(String(payload || ''));
            return { ok: true };
          case 'net.request':
            return await this.performRequest(payload);
          case 'ui.getTheme': {
            try {
              const { nativeTheme } = require('electron');
              const cur = this.currentTheme || 'system';
              const eff = cur === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : cur;
              return { ok: true, data: { theme: cur, effective: eff } };
            } catch (e) {
              return { ok: true, data: { theme: 'system', effective: 'light' } };
            }
          }
          case 'plugin.list': {
            const list = this.pluginManager.list().map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              icon: p.icon,
              ui: !!p.ui,
              instanceMode: p.instanceMode || 'single'
            }));
            return { ok: true, data: list };
          }
          case 'plugin.reload': {
            await this.reloadPlugins();
            const list = this.pluginManager.list().map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              icon: p.icon,
              ui: !!p.ui,
              instanceMode: p.instanceMode || 'single'
            }));
            return { ok: true, data: list };
          }
          case 'clip.query':
            return { ok: true, data: await this.clipboardStore.query(payload) };
          case 'clip.delete':
            return { ok: true, data: await this.clipboardStore.delete(payload) };
          case 'clip.clear':
            return { ok: true, data: await this.clipboardStore.clear() };
          case 'clip.copy':
            clipboard.writeText(String(payload || ''));
            return { ok: true };
          case 'installer.search':
            return { ok: true, data: await this.pluginInstaller.searchPlugins(payload.keyword, payload.options) };
          case 'installer.getInfo':
            return { ok: true, data: await this.pluginInstaller.getPluginInfo(payload) };
          case 'installer.getInstalled':
            return { ok: true, data: await this.pluginInstaller.getInstalledPlugins() };
          case 'installer.install':
            await this.pluginInstaller.installPlugin(payload.pluginId, payload.version);
            return { ok: true };
          case 'installer.uninstall':
            await this.pluginInstaller.uninstallPlugin(payload);
            return { ok: true };
          case 'installer.update':
            return { ok: true, data: await this.pluginInstaller.updatePlugin(payload.pluginId, payload.version) };
          case 'installer.checkUpdates':
            return { ok: true, data: await this.pluginInstaller.checkUpdates() };
          case 'installer.installFromFile':
            await this.pluginInstaller.installFromFile(payload);
            return { ok: true };
          case 'config.get':
            try {
              const result = payload ? this.configStore.get(payload) : this.configStore.exportConfig();
              return { ok: true, data: result };
            } catch (error) {
              return { ok: false, error: error.message };
            }
          case 'config.set':
            if (payload && payload.path && payload.value !== undefined) {
              try {
                await this.configStore.set(payload.path, payload.value);
                return { ok: true };
              } catch (error) {
                return { ok: false, error: error.message };
              }
            }
            return { ok: false, error: 'invalid config set payload' };
          case 'config.getUI':
            return { ok: true, data: this.configStore.getUIConfig() };
          case 'config.setTheme':
            const theme = await this.configStore.setTheme(payload);
            await this.setTheme(theme);
            return { ok: true, data: theme };
          case 'config.setTitlebarHeight':
            const height = await this.configStore.setTitlebarHeight(payload);
            this.windowManager.setDefaultChromeHeight(height);
            this.updateTrayMenu();
            return { ok: true, data: height };
          case 'config.reset':
            await this.configStore.resetToDefault();
            await this.applyConfigOnStartup();
            this.updateTrayMenu();
            return { ok: true };
          case 'config.export':
            return { ok: true, data: this.configStore.exportConfig() };
          case 'config.import':
            const result = await this.configStore.importConfig(payload);
            if (result) {
              await this.applyConfigOnStartup();
              this.updateTrayMenu();
            }
            return { ok: result };
          default:
            return { ok: false, error: 'unknown channel' };
        }
      } catch (e) {
        return { ok: false, error: e && e.message || String(e) };
      }
    });
    // 返回插件权限（供插件自查）
    // 权限不再由 manifest 声明（保留接口但返回空数组）
    ipcMain.handle('mt.get-permissions', async () => []);
    // 获取剪贴板内容（原始方法，保持兼容性）
    ipcMain.handle('get-clipboard', () => {
      return clipboard.readText();
    });

    // 获取最近的剪贴板内容（根据配置的时间限制）
    ipcMain.handle('get-recent-clipboard', () => {
      const clipboardConfig = this.configStore.getClipboardConfig();
      if (!clipboardConfig.enabled) {
        return null;
      }
      
      const recentItem = this.clipboardStore.getRecentClipboard(clipboardConfig.autoFillMaxAge);
      return recentItem ? recentItem.text : null;
    });

    // 获取剪贴板配置
    ipcMain.handle('get-clipboard-config', () => {
      return this.configStore.getClipboardConfig();
    });

    // 设置剪贴板配置
    ipcMain.handle('set-clipboard-config', async (event, config) => {
      if (config.autoFillMaxAge !== undefined) {
        await this.configStore.setClipboardMaxAge(config.autoFillMaxAge);
      }
      if (config.enabled !== undefined) {
        await this.configStore.set('clipboard.enabled', config.enabled);
      }
      return this.configStore.getClipboardConfig();
    });

    // 设置剪贴板内容
    ipcMain.handle('write-clipboard', (event, text) => {
      try {
        this.setIgnoreNextClipboardChange();
        clipboard.writeText(String(text || ''));
        return true;
      } catch (error) {
        console.error('写入剪贴板失败:', error);
        return false;
      }
    });

    // 打开 URL
    ipcMain.handle('open-url', async (event, url) => {
      try {
        await shell.openExternal(url);
        return true;
      } catch (error) {
        console.error('打开 URL 失败:', error);
        return false;
      }
    });

    // 隐藏主窗口
    ipcMain.on('hide-main-window', () => {
      this.hideMainWindow();
    });

    // 设置编辑模式状态
    ipcMain.on('set-editing-mode', (event, isEditing) => {
      this.isEditingMode = !!isEditing;
    });

    // 插件窗口钉住控制
    ipcMain.on('mt.plugin.pin', (_e, { pluginId, instanceId, pinned } = {}) => {
      try {
        if (!pluginId) return;
        const win = this.windowManager.getWindow(pluginId, instanceId);
        if (win && !win.isDestroyed()) {
          win.__mtPinned = !!pinned;
          try { win.setAlwaysOnTop(!!pinned, 'screen-saver'); } catch {}
        }
      } catch {}
    });

    // 插件窗口 DevTools 控制
    ipcMain.on('mt.plugin.devtools', (_e, { pluginId, instanceId, open, toggle } = {}) => {
      try {
        const win = this.windowManager.getWindow(pluginId, instanceId);
        if (!win || win.isDestroyed()) return;
        const wc = win.webContents;
        if (toggle) {
          if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: 'detach' });
          return;
        }
        if (open) wc.openDevTools({ mode: 'detach' }); else wc.closeDevTools();
      } catch {}
    });

    // 插件窗口标准控制（用于自定义美化后的按钮）
    ipcMain.on('mt.plugin.win', (_e, { pluginId, instanceId, action } = {}) => {
      try {
        if (!pluginId) return;
        const win = this.windowManager.getWindow(pluginId, instanceId);
        if (!win || win.isDestroyed()) return;
        switch (action) {
          case 'minimize':
            win.minimize();
            break;
          case 'maximize':
            win.maximize();
            break;
          case 'toggle-maximize':
            if (win.isMaximized()) win.unmaximize(); else win.maximize();
            break;
          case 'close':
            win.close();
            break;
          default:
            // 动态设置顶栏高度：action 形如 set-chrome-height:64
            if (String(action||'').startsWith('set-chrome-height:')) {
              const h = parseInt(String(action).split(':')[1], 10);
              try { this.windowManager.setChromeHeight(pluginId, h, instanceId); } catch {}
            }
        }
      } catch {}
    });

    // 查询插件元信息（用于标题栏显示图标与名称）
    ipcMain.handle('mt.get-plugin-meta', (event) => {
      try {
        const wc = event && event.sender;
        const pid = this.windowManager.getPluginIdForWebContents(wc);
        const meta = pid && this.pluginManager.get(pid);
        if (!meta) return null;
        return { id: meta.id, name: meta.name, icon: meta.icon };
      } catch { return null; }
    });

    // 执行插件
    ipcMain.on('execute-plugin', (event, pluginId, inputData) => {
      this.executePlugin(pluginId, inputData).catch(error => {
        console.error('插件执行出错:', error);
      });
    });

    // 插件内搜索（search 模式按回车）
    ipcMain.on('plugin-search', async (_e, payload) => {
      try {
        const { pluginId, featureCode, query, inputData } = payload || {};
        const plugin = this.pluginManager.get(pluginId);
        if (!plugin) return;
        const jsPath = path.join(plugin.path, 'script.js');
        if (!fs.existsSync(jsPath)) return;
        const pluginModule = require(jsPath);
        const featureHandler = pluginModule[featureCode];
        if (!featureHandler || typeof featureHandler !== 'object') return;

        if (typeof featureHandler.handleSearch === 'function') {
          const callbackSetList = (items) => {
            this.sendListResults(pluginId, items, inputData);
          };
          const redirect = (targetPluginId, content) => {
            this.redirectToPlugin(targetPluginId, content);
          };
          const action = {
            payload: inputData && inputData.content,
            type: inputData && inputData.type,
            featureCode: featureCode,
            redirect: redirect
          };
          await featureHandler.handleSearch(action, String(query || ''), callbackSetList);
        }
      } catch (error) {
        console.error('处理插件搜索事件失败:', error);
      }
    });

    // 处理列表项选择事件
    ipcMain.on('plugin-list-select', async (event, pluginId, itemData, inputData) => {
      try {
        const plugin = this.pluginManager.get(pluginId);
        if (!plugin) return;

        const jsPath = path.join(plugin.path, 'script.js');
        if (!fs.existsSync(jsPath)) return;
        const pluginModule = require(jsPath);
        const featureCode = inputData.featureCode;
        
        if (!featureCode) return;
        
        const featureHandler = pluginModule[featureCode];
        if (!featureHandler || typeof featureHandler !== 'object') return;

        if (typeof featureHandler.handleSelect === 'function') {
          // 创建回调函数
          const callbackSetList = (items) => {
            this.sendListResults(pluginId, items, inputData);
          };

          // 创建重定向函数
          const redirect = (targetPluginId, content) => {
            this.redirectToPlugin(targetPluginId, content);
          };

          // 构造action对象
          const action = {
            payload: inputData.content,
            type: inputData.type,
            featureCode: inputData.featureCode,
            redirect: redirect
          };

          if (this.isDev) console.log(`[DEBUG] 调用 ${featureCode} 的 handleSelect`);
          await featureHandler.handleSelect(action, itemData, callbackSetList);
          if (this.isDev) console.log(`[DEBUG] ${featureCode} 的 handleSelect 执行完成`);
        }
        
        // 保持默认 blur 行为
      } catch (error) {
        console.error('处理列表选择事件失败:', error);
        // 不修改 blur 行为
      }
    });

    // 分析内容
    ipcMain.handle('analyze-content', (event, content) => {
      return this.analyzeContent(content);
    });

    // 匹配插件
    ipcMain.handle('match-plugins', (event, contentAnalysis) => {
      return this.matchPlugins(contentAnalysis);
    });

    // 获取文件图标
    ipcMain.handle('get-file-icon', async (event, filePath) => {
      try {
        return await this.iconManager.getFileIcon(filePath);
      } catch (error) {
        console.error('获取文件图标失败:', error);
        return this.iconManager.getDefaultIcon('unknown');
      }
    });

    // 获取文件统计信息
    ipcMain.handle('get-file-stats', async (event, filePath) => {
      try {
        const stats = await fs.stat(filePath);
        return {
          exists: true,
          size: stats.size,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          mtime: stats.mtime
        };
      } catch (error) {
        return {
          exists: false,
          size: 0,
          isFile: false,
          isDirectory: false,
          mtime: null
        };
      }
    });

    // 获取响应式尺寸信息
    ipcMain.handle('get-responsive-sizes', () => {
      return this.getWindowSizes();
    });

    // 获取屏幕信息
    ipcMain.handle('get-screen-info', () => {
      return this.getScreenInfo();
    });

    // 通用网络请求（主进程代发）
    ipcMain.handle('net.request', async (event, reqOptions) => {
      return this.performRequest(reqOptions);
    });

    // 剪贴板历史接口
    ipcMain.handle('clip.query', (event, params) => {
      return this.clipboardStore.query(params);
    });
    ipcMain.handle('clip.delete', async (event, id) => {
      return this.clipboardStore.delete(id);
    });
    ipcMain.handle('clip.clear', async () => {
      return this.clipboardStore.clear();
    });
    ipcMain.handle('clip.copy', async (event, text) => {
      try { clipboard.writeText(String(text || '')); return true; } catch { return false; }
    });
  }

  // 剪贴板监听
  startClipboardMonitoring() {
    this.lastClipboardContent = clipboard.readText();
    this.lastFileContent = ''; // 添加文件内容缓存
    
    this.clipboardTimer = setInterval(() => {
      // 检查文本内容
      const currentTextContent = clipboard.readText();
      
      // 检查是否有文件
      let currentContent = currentTextContent;
      let currentFileContent = '';
      
      try {
        // 尝试读取文件路径（Windows）
        if (process.platform === 'win32') {
          const buffer = clipboard.readBuffer('FileNameW');
          if (buffer && buffer.length > 2) { // 至少要有有效内容
            // 解析Windows文件路径
            const filePath = buffer.toString('ucs2').replace(/\0/g, '').trim();
            // 验证是否是有效的文件路径
            if (filePath && 
                filePath.length > 3 && 
                (filePath.includes('\\') || filePath.includes('/')) &&
                filePath.includes('.')) {
              currentFileContent = filePath;
              currentContent = currentFileContent;
            }
          }
        }

        // 检查是否有图片数据（图片优先级高于文件路径）
        const image = clipboard.readImage();
        if (!image.isEmpty()) {
          // 有图片数据，生成临时文件路径标识
          const imageDataUrl = image.toDataURL();
          if (imageDataUrl && imageDataUrl !== 'data:image/png;base64,') {
            // 创建一个特殊的标识，表示这是剪贴板图片数据
            currentContent = `[CLIPBOARD-IMAGE]${imageDataUrl}`;
            currentFileContent = ''; // 图片数据优先，清除文件路径
          }
        }
      } catch (error) {
        // 文件读取失败，静默处理
      }
      
      // 检查内容是否真的变化了（避免重复检测）
      const contentChanged = currentContent !== this.lastClipboardContent;
      const fileChanged = currentFileContent !== this.lastFileContent;
      
      if (contentChanged || (currentFileContent && fileChanged)) {
        // 内容变化处理
        
        this.lastClipboardContent = currentContent;
        this.lastFileContent = currentFileContent;
        this.onClipboardChange(currentContent);
        
        // 记录到历史（只记录文本内容）
        if (currentTextContent && currentTextContent.trim() && currentTextContent !== currentFileContent) {
          this.clipboardStore.add(currentTextContent).catch(() => {});
        }
      }
    }, 500);
  }

  stopClipboardMonitoring() {
    if (this.clipboardTimer) {
      clearInterval(this.clipboardTimer);
      this.clipboardTimer = null;
    }
  }

  onClipboardChange(content) {
    if (this.mainWindow) {
      // 如果设置了忽略标记，则跳过这次剪贴板变化
      if (this.ignoreNextClipboardChange) {
        this.ignoreNextClipboardChange = false;
        if (this.clipboardIgnoreTimeout) {
          clearTimeout(this.clipboardIgnoreTimeout);
          this.clipboardIgnoreTimeout = null;
        }
        console.log('🚫 主进程忽略剪贴板变化（插件复制）');
        return;
      }
      
      this.mainWindow.webContents.send('clipboard-changed', content);
    }
  }

  // 设置忽略下一次剪贴板变化（用于插件复制操作）
  setIgnoreNextClipboardChange() {
    this.ignoreNextClipboardChange = true;
    console.log('📌 主进程设置剪贴板忽略标记');
    
    if (this.clipboardIgnoreTimeout) {
      clearTimeout(this.clipboardIgnoreTimeout);
    }
    this.clipboardIgnoreTimeout = setTimeout(() => {
      this.ignoreNextClipboardChange = false;
      this.clipboardIgnoreTimeout = null;
      console.log('⏰ 主进程忽略标记超时清除');
    }, 2000);
  }

  // 全局快捷键
  registerGlobalShortcuts() {
    try {
      // 从配置中获取快捷键设置
      const shortcutConfig = this.configStore.getShortcutConfig();
      const mainWindowShortcut = shortcutConfig.mainWindow || 'Ctrl+Space';
      
      const ret = globalShortcut.register(mainWindowShortcut, () => {
        this.toggleInputWindow();
      });

      if (!ret) {
        console.error('全局快捷键注册失败:', mainWindowShortcut);
        // 如果自定义快捷键失败，尝试默认的
        if (mainWindowShortcut !== 'Ctrl+Space') {
          const fallback = globalShortcut.register('Ctrl+Space', () => {
            this.toggleInputWindow();
          });
          if (fallback) {
            console.log('使用默认快捷键 Ctrl+Space');
          }
        }
      } else {
        if (!this.isQuiet) {
          console.log('全局快捷键已注册:', mainWindowShortcut);
        }
      }
    } catch (error) {
      console.error('注册快捷键时出错:', error);
    }
  }

  async toggleClipboardAutoFill() {
    const newState = await this.configStore.toggleClipboardAutoFill();
    console.log(`剪贴板自动填充已${newState ? '启用' : '禁用'}`);
    
    // 重新创建托盘菜单以更新选中状态
    this.updateTrayMenu();
  }

  async setClipboardMaxAge(seconds) {
    await this.configStore.setClipboardMaxAge(seconds);
    console.log(`剪贴板有效时间已设置为 ${seconds} 秒`);
    
    // 重新创建托盘菜单以更新选中状态
    this.updateTrayMenu();
  }

  // 在启动时应用配置文件中的设置
  async applyConfigOnStartup() {
    try {
      const uiConfig = this.configStore.getUIConfig();
      
      // 应用主题设置（不保存，只应用）
      this.currentTheme = uiConfig.theme;
      const { nativeTheme } = require('electron');
      let effective = uiConfig.theme;
      if (uiConfig.theme === 'system') {
        effective = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      }
      
      // 设置窗口管理器的主题和标题栏高度
      this.windowManager.defaultTheme = uiConfig.theme;
      this.windowManager.setDefaultChromeHeight(uiConfig.titlebarHeight);
      
      // 应用主题到所有窗口（包括主窗口）
      await this.applyThemeToWindows(uiConfig.theme, effective);
      
      if (!this.isQuiet) {
        console.log('已应用配置:', {
          theme: uiConfig.theme,
          effective: effective,
          titlebarHeight: uiConfig.titlebarHeight,
          windowOpacity: uiConfig.windowOpacity
        });
      }
    } catch (error) {
      if (!this.isQuiet) {
        console.warn('应用配置时出错:', error.message);
      }
    }
  }

  // 应用主题到所有窗口
  async applyThemeToWindows(theme, effective) {
    try {
      // 主题调色板
      const palettes = {
        light: {
          fg: '#222222',
          fgMuted: '#666666',
          panel: '#ffffff',
          border: 'rgba(0,0,0,0.08)',
          hover: 'rgba(0,0,0,0.06)',
          selected: 'rgba(0,122,255,0.12)',
          iconBg: '#f1f1f3'
        },
        dark: {
          fg: '#e6e7ea',
          fgMuted: '#a1a1aa',
          panel: '#2b2d31',
          border: '#3a3b41',
          hover: 'rgba(255,255,255,0.06)',
          selected: 'rgba(0,122,255,0.22)',
          iconBg: '#3a3b41'
        }
      };
      
      const palette = palettes[effective] || palettes.light;
      const themeData = { theme, effective, palette };
      
      // 广播给插件窗口
      this.windowManager.broadcastTheme(themeData);
      
      // 发送给主输入窗口
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('ui-theme', themeData);
      } else {
        if (!this.isQuiet) {
          console.log('主窗口未准备好，无法发送主题');
        }
      }
      
    } catch (error) {
      if (!this.isQuiet) {
        console.error('应用主题失败:', error);
      }
    }
  }

  async openSettings() {
    try {
      // 查找设置插件
      const settingsPlugin = this.pluginManager.get('settings');
      if (settingsPlugin) {
        // 创建虚拟输入数据
        const inputData = {
          content: '设置',
          type: 'text',
          length: 2,
          lines: 1,
          timestamp: Date.now(),
          featureCode: 'settings.open'
        };
        
        // 执行设置插件
        await this.executePlugin('settings', inputData);
      } else {
        console.warn('未找到设置插件');
      }
    } catch (error) {
      console.error('打开设置界面失败:', error);
    }
  }

  async init() {
    this.setupConsoleEncoding();
    // DEV: 将渲染进程日志输出到终端
    if (this.isDev && !this.devLoggingInitialized) {
      try { app.commandLine.appendSwitch('enable-logging'); } catch {}
      this.setupDevLogging();
      this.devLoggingInitialized = true;
    }

    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      this.toggleInputWindow();
    });

    app.on('window-all-closed', (event) => {
      event.preventDefault();
    });

    app.on('before-quit', () => {
      this.stopClipboardMonitoring();
      globalShortcut.unregisterAll();
      try { if (this.tray) { this.tray.destroy(); this.tray = null; } } catch {}
    });

    try {
      await app.whenReady();
      
      await this.configStore.load();
      await this.usageStore.load();
      await this.clipboardStore.load();
      
      // 配置加载完成后检测屏幕信息（启动时检测一次）
      this.detectScreenAndCalculateSizes();
      
      this.createTray();
      this.createMainWindow();
      this.registerGlobalShortcuts();
      await this.loadPlugins();
      this.matcher.rebuild(this.pluginManager.list());
      this.setupIpcHandlers();
      
      // 在主窗口创建后应用配置中的设置
      await this.applyConfigOnStartup();
      
      this.startClipboardMonitoring();
      
      if (!this.isQuiet) {
        console.log('MiniToolbox 启动成功');
      }
    } catch (error) {
      console.error('应用启动失败:', error);
      app.quit();
    }
  }

  setupConsoleEncoding() {
    if (!this.isQuiet && this.isDev) {
      console.log('控制台编码: UTF-8');
    }
  }

  setupDevLogging() {
    const logErr = (...args) => { try { console.error('[DEV]', ...args); } catch {} };
    process.on('uncaughtException', (err) => logErr('uncaughtException', err && err.stack || err));
    process.on('unhandledRejection', (reason) => logErr('unhandledRejection', reason));

    app.on('render-process-gone', (event, webContents, details) => {
      logErr('render-process-gone', details);
    });

    const hookWebContents = (wc) => {
      try {
        wc.on('console-message', (_e, level, message, line, sourceId) => {
          const lvl = ['LOG','WARN','ERROR','INFO','DEBUG'][level] || level;
          console.log(`[Renderer:${lvl}]`, message, sourceId ? `${sourceId}:${line}` : '');
        });
        wc.on('crashed', () => logErr('webContents crashed'));
        wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
          logErr('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame });
        });
      } catch {}
    };

    app.on('browser-window-created', (_e, win) => {
      try { hookWebContents(win.webContents); } catch {}
    });
  }

  // 检测屏幕信息并计算窗口尺寸（启动时调用一次）
  detectScreenAndCalculateSizes() {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
      
      // 确定屏幕类型
      let screenType = 'medium';
      if (screenWidth < 1366) {
        screenType = 'small';
      } else if (screenWidth >= 1920) {
        screenType = 'large';
      }
      
      // 缓存屏幕信息
      this.screenInfo = {
        width: screenWidth,
        height: screenHeight,
        type: screenType,
        dpi: primaryDisplay.scaleFactor
      };
      
      // 获取配置
      const config = this.configStore.exportConfig ? this.configStore.exportConfig() : (this.configStore.config || {});
      const responsiveConfig = config.ui.responsive;
      const sizeRatio = responsiveConfig.windowSizeRatio[screenType];
      const sizeLimit = responsiveConfig.windowSizeLimit;
      
      // 计算窗口尺寸
      let windowWidth = Math.floor(screenWidth * sizeRatio.width);
      let windowHeight = Math.floor(screenHeight * sizeRatio.height);
      
      // 应用尺寸限制
      windowWidth = Math.max(sizeLimit.minWidth, Math.min(sizeLimit.maxWidth, windowWidth));
      windowHeight = Math.max(sizeLimit.minHeight, Math.min(sizeLimit.maxHeight, windowHeight));
      
      // 计算插件列表宽度
      const pluginListWidth = Math.floor(windowWidth * responsiveConfig.pluginListWidthRatio);
      
      // 层级计算：窗口 → 输入框 → 胶囊 → 缩略图
      const inputHeight = Math.floor(windowHeight * responsiveConfig.inputHeightRatio);
      const capsuleHeight = Math.floor(inputHeight * responsiveConfig.capsuleRatio.height);
      const thumbnailSize = Math.floor(capsuleHeight * responsiveConfig.thumbnailRatio);
      
      // 缓存计算结果
      this.windowSizes = {
        windowWidth,
        windowHeight,
        pluginListWidth,
        inputHeight,
        capsuleHeight,
        thumbnailSize,
        maxImageSizeMB: responsiveConfig.maxImageSizeMB
      };
      
      console.log('屏幕检测完成:', JSON.stringify({
        screen: this.screenInfo,
        sizes: this.windowSizes
      }, null, 2));
      
      return this.windowSizes;
    } catch (error) {
      console.error('屏幕检测失败:', error);
      
      // 降级到默认尺寸
      this.screenInfo = { width: 1920, height: 1080, type: 'medium', dpi: 1 };
      this.windowSizes = {
        windowWidth: 700,
        windowHeight: 450,
        pluginListWidth: 680,
        inputHeight: 54,
        capsuleHeight: 46,  // 54 × 0.85
        thumbnailSize: 41,  // 46 × 0.9
        maxImageSizeMB: 2
      };
      
      return this.windowSizes;
    }
  }

  // 获取屏幕信息
  getScreenInfo() {
    if (!this.screenInfo) {
      this.detectScreenAndCalculateSizes();
    }
    return this.screenInfo;
  }

  // 获取窗口尺寸
  getWindowSizes() {
    if (!this.windowSizes) {
      this.detectScreenAndCalculateSizes();
    }
    return this.windowSizes;
  }
}

// 启动应用
const miniToolbox = new MiniToolbox();
miniToolbox.init().catch(console.error);

