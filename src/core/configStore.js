const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

class ConfigStore {
  constructor(options = {}) {
    const userData = app.getPath('userData');
    this.filePath = path.join(userData, 'config.json');
    this.config = this.getDefaultConfig();
    this.loaded = false;
    this.isQuiet = !!options.isQuiet;
  }

  getDefaultConfig() {
    return {
      // 剪贴板相关配置
      clipboard: {
        autoFillMaxAge: 5, // 自动填充剪贴板内容的最大时间（秒）
        enabled: true,     // 是否启用自动填充
        maxHistoryItems: 500 // 最大历史记录数量
      },
      
      // 窗口相关配置
      window: {
        hideOnBlur: true,  // 失去焦点时自动隐藏
        centerOnShow: true // 显示时居中
      },
      
      // UI界面配置
      ui: {
        theme: 'system',           // 主题: 'system' | 'light' | 'dark'
        titlebarHeight: 48,        // 标题栏高度(px): 32, 40, 48, 56
        windowOpacity: 0.95,       // 窗口透明度: 0.8-1.0
        accentColor: '#007AFF',    // 主色调
        fontSize: 'medium',        // 字体大小: 'small' | 'medium' | 'large'
        animations: true,          // 是否启用动画效果
        compactMode: false,        // 紧凑模式
        showTypeIndicator: false   // 是否显示内容类型指示器
      },
      
      // 插件相关配置
      plugins: {
        autoReload: false, // 是否自动重载插件
        maxResults: 10,    // 最大搜索结果数量
        enableHeadless: true, // 是否启用无UI插件
        showFeatureCodes: false // 是否显示功能代码
      },
      
      // 快捷键配置
      shortcuts: {
        mainWindow: 'Ctrl+Space',  // 主窗口快捷键
        hideWindow: 'Escape',      // 隐藏窗口
        nextResult: 'ArrowDown',   // 下一个结果
        prevResult: 'ArrowUp',     // 上一个结果
        executePlugin: 'Enter'     // 执行插件
      },

      // 搜索配置
      search: {
        instantSearch: true,       // 即时搜索
        searchHistory: true,       // 保存搜索历史
        maxHistoryItems: 100,      // 最大历史记录数
        fuzzyMatch: true,          // 模糊匹配
        caseSensitive: false       // 大小写敏感
      },

      // 性能配置
      performance: {
        debounceDelay: 150,        // 搜索防抖延迟(ms)
        maxConcurrentPlugins: 5,   // 最大并发插件数
        cacheResults: true,        // 缓存搜索结果
        enableLogging: false       // 启用详细日志
      }
    };
  }

  async load() {
    try {
      if (await fs.pathExists(this.filePath)) {
        const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        // 合并默认配置和用户配置
        this.config = this.mergeConfig(this.getDefaultConfig(), data);
      }
      this.loaded = true;
      if (!this.isQuiet) {
        console.log('配置加载完成:', {
          clipboardMaxAge: this.config.clipboard.autoFillMaxAge,
          clipboardEnabled: this.config.clipboard.enabled
        });
      }
    } catch (e) {
      if (!this.isQuiet) console.warn('加载配置失败，使用默认配置:', e.message);
      this.config = this.getDefaultConfig();
      this.loaded = true;
    }
  }

  async save() {
    try {
      await fs.outputFile(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
      if (!this.isQuiet) console.log('配置已保存');
    } catch (e) {
      if (!this.isQuiet) console.warn('保存配置失败:', e.message);
    }
  }

  // 深度合并配置对象
  mergeConfig(defaultConfig, userConfig) {
    const result = { ...defaultConfig };
    
    for (const key in userConfig) {
      if (typeof userConfig[key] === 'object' && userConfig[key] !== null && !Array.isArray(userConfig[key])) {
        result[key] = this.mergeConfig(defaultConfig[key] || {}, userConfig[key]);
      } else {
        result[key] = userConfig[key];
      }
    }
    
    return result;
  }

  // 获取配置值
  get(path, defaultValue = null) {
    const keys = path.split('.');
    let current = this.config;
    
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return defaultValue;
      }
    }
    
    return current;
  }

  // 设置配置值
  async set(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let current = this.config;
    
    // 创建嵌套对象路径
    for (const key of keys) {
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    
    current[lastKey] = value;
    await this.save();
    
    if (!this.isQuiet) {
      console.log(`配置已更新: ${path} = ${JSON.stringify(value)}`);
    }
  }

  // 获取剪贴板相关配置
  getClipboardConfig() {
    return {
      autoFillMaxAge: this.get('clipboard.autoFillMaxAge', 5),
      enabled: this.get('clipboard.enabled', true),
      maxHistoryItems: this.get('clipboard.maxHistoryItems', 500)
    };
  }

  // 设置剪贴板自动填充时间
  async setClipboardMaxAge(seconds) {
    await this.set('clipboard.autoFillMaxAge', Math.max(1, Math.min(60, seconds)));
  }

  // 切换剪贴板自动填充功能
  async toggleClipboardAutoFill() {
    const current = this.get('clipboard.enabled', true);
    await this.set('clipboard.enabled', !current);
    return !current;
  }

  // 获取UI配置
  getUIConfig() {
    return {
      theme: this.get('ui.theme', 'system'),
      titlebarHeight: this.get('ui.titlebarHeight', 48),
      windowOpacity: this.get('ui.windowOpacity', 0.95),
      accentColor: this.get('ui.accentColor', '#007AFF'),
      fontSize: this.get('ui.fontSize', 'medium'),
      animations: this.get('ui.animations', true),
      compactMode: this.get('ui.compactMode', false),
      showTypeIndicator: this.get('ui.showTypeIndicator', false)
    };
  }

  // 设置主题
  async setTheme(theme) {
    const validThemes = ['system', 'light', 'dark'];
    if (validThemes.includes(theme)) {
      await this.set('ui.theme', theme);
      return theme;
    }
    return this.get('ui.theme', 'system');
  }

  // 设置标题栏高度
  async setTitlebarHeight(height) {
    const validHeights = [32, 40, 48, 56];
    if (validHeights.includes(height)) {
      await this.set('ui.titlebarHeight', height);
      return height;
    }
    return this.get('ui.titlebarHeight', 48);
  }

  // 设置窗口透明度
  async setWindowOpacity(opacity) {
    const validOpacity = Math.max(0.8, Math.min(1.0, opacity));
    await this.set('ui.windowOpacity', validOpacity);
    return validOpacity;
  }

  // 设置字体大小
  async setFontSize(size) {
    const validSizes = ['small', 'medium', 'large'];
    if (validSizes.includes(size)) {
      await this.set('ui.fontSize', size);
      return size;
    }
    return this.get('ui.fontSize', 'medium');
  }

  // 切换动画效果
  async toggleAnimations() {
    const current = this.get('ui.animations', true);
    await this.set('ui.animations', !current);
    return !current;
  }

  // 切换紧凑模式
  async toggleCompactMode() {
    const current = this.get('ui.compactMode', false);
    await this.set('ui.compactMode', !current);
    return !current;
  }

  // 获取插件配置
  getPluginConfig() {
    return {
      autoReload: this.get('plugins.autoReload', false),
      maxResults: this.get('plugins.maxResults', 10),
      enableHeadless: this.get('plugins.enableHeadless', true),
      showFeatureCodes: this.get('plugins.showFeatureCodes', false)
    };
  }

  // 获取快捷键配置
  getShortcutConfig() {
    return {
      mainWindow: this.get('shortcuts.mainWindow', 'Ctrl+Space'),
      hideWindow: this.get('shortcuts.hideWindow', 'Escape'),
      nextResult: this.get('shortcuts.nextResult', 'ArrowDown'),
      prevResult: this.get('shortcuts.prevResult', 'ArrowUp'),
      executePlugin: this.get('shortcuts.executePlugin', 'Enter')
    };
  }

  // 获取搜索配置
  getSearchConfig() {
    return {
      instantSearch: this.get('search.instantSearch', true),
      searchHistory: this.get('search.searchHistory', true),
      maxHistoryItems: this.get('search.maxHistoryItems', 100),
      fuzzyMatch: this.get('search.fuzzyMatch', true),
      caseSensitive: this.get('search.caseSensitive', false)
    };
  }

  // 获取性能配置
  getPerformanceConfig() {
    return {
      debounceDelay: this.get('performance.debounceDelay', 150),
      maxConcurrentPlugins: this.get('performance.maxConcurrentPlugins', 5),
      cacheResults: this.get('performance.cacheResults', true),
      enableLogging: this.get('performance.enableLogging', false)
    };
  }

  // 重置配置为默认值
  async resetToDefault() {
    this.config = this.getDefaultConfig();
    await this.save();
    if (!this.isQuiet) {
      console.log('配置已重置为默认值');
    }
  }

  // 导出配置
  exportConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  // 导入配置
  async importConfig(configData) {
    if (typeof configData === 'object' && configData !== null) {
      this.config = this.mergeConfig(this.getDefaultConfig(), configData);
      await this.save();
      if (!this.isQuiet) {
        console.log('配置导入成功');
      }
      return true;
    }
    return false;
  }
}

module.exports = { ConfigStore };
