// MiniToolbox 插件 API
// 提供给插件使用的通用功能接口

class MiniToolboxAPI {
  constructor() {
    this.version = '1.0.0';
    this.initElectronAPIs();
  }

  initElectronAPIs() {
    if (typeof require !== 'undefined') {
      try {
        this.electron = require('electron');
        this.ipcRenderer = this.electron.ipcRenderer;
        this.shell = this.electron.shell;
        this.clipboard = this.electron.clipboard;
        this.fs = require('fs');
        this.path = require('path');
      } catch (error) {
        console.warn('Electron APIs 不可用:', error);
      }
    }
  }

  // ==================== 输入输出 API ====================

  /**
   * 监听来自主程序的输入数据
   * @param {Function} callback - 回调函数，接收 inputData 参数
   */
  onInput(callback) {
    if (this.ipcRenderer) {
      this.ipcRenderer.on('plugin-input', (event, inputData) => {
        callback(inputData);
      });
    }
    
    // 备用方案
    window.addEventListener('message', (event) => {
      if (event.data.type === 'plugin-input') {
        callback(event.data.payload);
      }
    });
  }

  /**
   * 向主程序发送数据
   * @param {string} channel - 频道名
   * @param {*} data - 要发送的数据
   */
  sendToMain(channel, data) {
    if (this.ipcRenderer) {
      this.ipcRenderer.send(channel, data);
    }
  }

  /**
   * 调用主程序方法并等待返回
   * @param {string} channel - 频道名
   * @param {*} data - 要发送的数据
   * @returns {Promise} 返回结果
   */
  async invokeMain(channel, data) {
    if (this.ipcRenderer) {
      return await this.ipcRenderer.invoke(channel, data);
    }
    throw new Error('IPC 不可用');
  }

  // ==================== 剪贴板 API ====================

  /**
   * 读取剪贴板文本
   * @returns {Promise<string>} 剪贴板文本
   */
  async readClipboardText() {
    try {
      if (navigator.clipboard) {
        return await navigator.clipboard.readText();
      }
      if (this.clipboard) {
        return this.clipboard.readText();
      }
    } catch (error) {
      console.error('读取剪贴板失败:', error);
    }
    return '';
  }

  /**
   * 写入剪贴板文本
   * @param {string} text - 要写入的文本
   * @returns {Promise<boolean>} 是否成功
   */
  async writeClipboardText(text) {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      if (this.clipboard) {
        this.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      console.error('写入剪贴板失败:', error);
    }
    return false;
  }

  /**
   * 读取剪贴板图片
   * @returns {Promise<string|null>} 图片的 data URL 或 null
   */
  async readClipboardImage() {
    try {
      if (this.clipboard) {
        const image = this.clipboard.readImage();
        return image.isEmpty() ? null : image.toDataURL();
      }
    } catch (error) {
      console.error('读取剪贴板图片失败:', error);
    }
    return null;
  }

  // ==================== 文件系统 API ====================

  /**
   * 检查文件是否存在
   * @param {string} filePath - 文件路径
   * @returns {boolean} 是否存在
   */
  fileExists(filePath) {
    try {
      if (this.fs) {
        return this.fs.existsSync(filePath);
      }
    } catch (error) {
      console.error('检查文件失败:', error);
    }
    return false;
  }

  /**
   * 读取文件内容
   * @param {string} filePath - 文件路径
   * @param {string} encoding - 编码格式，默认 'utf8'
   * @returns {Promise<string>} 文件内容
   */
  async readFile(filePath, encoding = 'utf8') {
    try {
      if (this.fs) {
        return this.fs.readFileSync(filePath, encoding);
      }
    } catch (error) {
      console.error('读取文件失败:', error);
    }
    return '';
  }

  /**
   * 写入文件内容
   * @param {string} filePath - 文件路径
   * @param {string} content - 文件内容
   * @param {string} encoding - 编码格式，默认 'utf8'
   * @returns {boolean} 是否成功
   */
  writeFile(filePath, content, encoding = 'utf8') {
    try {
      if (this.fs) {
        this.fs.writeFileSync(filePath, content, encoding);
        return true;
      }
    } catch (error) {
      console.error('写入文件失败:', error);
    }
    return false;
  }

  /**
   * 获取文件信息
   * @param {string} filePath - 文件路径
   * @returns {Object|null} 文件信息对象
   */
  getFileStats(filePath) {
    try {
      if (this.fs && this.fs.existsSync(filePath)) {
        const stats = this.fs.statSync(filePath);
        return {
          size: stats.size,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          birthtime: stats.birthtime,
          mtime: stats.mtime,
          atime: stats.atime
        };
      }
    } catch (error) {
      console.error('获取文件信息失败:', error);
    }
    return null;
  }

  // ==================== 系统交互 API ====================

  /**
   * 在默认应用中打开文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>} 是否成功
   */
  async openFile(filePath) {
    try {
      if (this.shell) {
        await this.shell.openPath(filePath);
        return true;
      }
    } catch (error) {
      console.error('打开文件失败:', error);
    }
    return false;
  }

  /**
   * 在文件管理器中显示文件
   * @param {string} filePath - 文件路径
   * @returns {boolean} 是否成功
   */
  showInFolder(filePath) {
    try {
      if (this.shell) {
        this.shell.showItemInFolder(filePath);
        return true;
      }
    } catch (error) {
      console.error('显示文件失败:', error);
    }
    return false;
  }

  /**
   * 在浏览器中打开 URL
   * @param {string} url - 网址
   * @returns {Promise<boolean>} 是否成功
   */
  async openURL(url) {
    try {
      if (this.shell) {
        await this.shell.openExternal(url);
        return true;
      }
    } catch (error) {
      console.error('打开网址失败:', error);
    }
    return false;
  }

  // ==================== 通知 API ====================

  /**
   * 显示系统通知
   * @param {string} title - 通知标题
   * @param {string} body - 通知内容
   * @param {string} icon - 图标路径（可选）
   * @returns {boolean} 是否成功
   */
  showNotification(title, body, icon = null) {
    try {
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification(title, { body, icon });
          return true;
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
              new Notification(title, { body, icon });
            }
          });
        }
      }
    } catch (error) {
      console.error('显示通知失败:', error);
    }
    return false;
  }

  // ==================== 工具方法 ====================

  /**
   * 格式化文件大小
   * @param {number} bytes - 字节数
   * @returns {string} 格式化后的大小
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 检测内容类型
   * @param {string} content - 内容
   * @returns {string} 类型 (text|url|file|image)
   */
  detectContentType(content) {
    // 优先检测文件路径
    if (this.isFilePath(content)) {
      if (this.isImageFile(content)) {
        return 'image';
      }
      return 'file';
    }

    // URL 检测（排除文件路径）
    if (this.isValidUrl(content)) {
      return 'url';
    }

    // 图片 base64 检测
    if (content.startsWith('data:image/')) {
      return 'image';
    }

    return 'text';
  }

  isFilePath(str) {
    // Windows 路径
    const winPath = /^[a-zA-Z]:[\\\/]/.test(str);
    // Unix 路径
    const unixPath = /^\//.test(str);
    // 相对路径
    const relativePath = /^\.{1,2}[\\\/]/.test(str);
    // UNC 路径
    const uncPath = /^\\\\/.test(str);
    
    // 包含路径分隔符
    const hasPathSeparator = str.includes('\\') || str.includes('/');
    const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(str);
    
    return winPath || unixPath || relativePath || uncPath || 
           (hasPathSeparator && hasExtension) ||
           (hasPathSeparator && str.length > 3);
  }

  isImageFile(str) {
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff|ico|psd|raw|cr2|nef|orf|sr2)$/i;
    return imageExtensions.test(str);
  }

  isValidUrl(str) {
    try {
      const url = new URL(str);
      const protocol = url.protocol;
      
      // 有效的网络协议
      const validProtocols = ['http:', 'https:', 'ftp:', 'ftps:', 'file:', 'mailto:', 'tel:'];
      
      // 排除 Windows 驱动器路径
      if (protocol.match(/^[a-zA-Z]:$/)) {
        return false;
      }
      
      return validProtocols.includes(protocol);
    } catch {
      return false;
    }
  }

  /**
   * 防抖函数
   * @param {Function} func - 要防抖的函数
   * @param {number} delay - 延迟时间（毫秒）
   * @returns {Function} 防抖后的函数
   */
  debounce(func, delay) {
    let timeoutId;
    return function (...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
  }

  /**
   * 节流函数
   * @param {Function} func - 要节流的函数
   * @param {number} delay - 延迟时间（毫秒）
   * @returns {Function} 节流后的函数
   */
  throttle(func, delay) {
    let lastCall = 0;
    return function (...args) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        return func.apply(this, args);
      }
    };
  }
}

// 创建全局 API 实例
window.MiniToolboxAPI = new MiniToolboxAPI();

// 兼容性别名
window.MTAPI = window.MiniToolboxAPI;
