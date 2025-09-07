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
      
      // 插件相关配置
      plugins: {
        autoReload: false, // 是否自动重载插件
        maxResults: 10     // 最大搜索结果数量
      },
      
      // 快捷键配置
      shortcuts: {
        mainWindow: 'Alt+Space' // 主窗口快捷键
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
}

module.exports = { ConfigStore };
