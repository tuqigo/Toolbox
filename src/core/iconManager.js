// 图标管理器 - 负责系统图标获取和缓存
const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs').promises;

class IconManager {
  constructor() {
    this.cache = new Map();
    this.maxCacheSize = 50; // 最大缓存50个图标
    this.pendingRequests = new Map(); // 防止重复请求
  }

  // 获取文件图标（主要入口）
  async getFileIcon(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return this.getDefaultIcon('unknown');
    }

    // 检查是否为文件夹 - 直接使用默认图标
    if (await this.isDirectory(filePath)) {
      return this.getDefaultIcon('folder');
    }

    const ext = this.getFileExtension(filePath);
    const cacheKey = ext || 'no-ext';

    // 检查缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // 检查是否有正在进行的请求
    if (this.pendingRequests.has(cacheKey)) {
      return this.pendingRequests.get(cacheKey);
    }

    // 创建新的请求
    const iconPromise = this.fetchSystemIcon(filePath, ext);
    this.pendingRequests.set(cacheKey, iconPromise);

    try {
      const iconData = await iconPromise;
      
      // 缓存图标
      this.setCachedIcon(cacheKey, iconData);
      
      return iconData;
    } catch (error) {
      console.error('获取系统图标失败:', error);
      // 返回默认图标
      const category = ext === 'lnk' ? 'shortcut' : this.detectFileCategory(ext);
      const defaultIcon = this.getDefaultIcon(category);
      this.setCachedIcon(cacheKey, defaultIcon);
      return defaultIcon;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  // 获取系统图标
  async fetchSystemIcon(filePath, ext) {
    try {
      // Windows平台优先处理
      if (process.platform === 'win32') {
        return await this.getWindowsIcon(filePath, ext);
      } else if (process.platform === 'darwin') {
        return await this.getMacIcon(filePath, ext);
      } else {
        return await this.getLinuxIcon(filePath, ext);
      }
    } catch (error) {
      console.error(`获取${process.platform}系统图标失败:`, error);
      throw error;
    }
  }

  // Windows图标获取
  async getWindowsIcon(filePath, ext) {
    try {
      // 直接尝试获取文件图标（包括.lnk文件）
      if (await this.fileExists(filePath)) {
        const icon = await app.getFileIcon(filePath, { size: 'normal' });
        if (icon && !icon.isEmpty()) {
          return {
            type: 'native',
            data: icon.toDataURL(),
            size: { width: 36, height: 36 }
          };
        }
      }

      // 通过创建临时文件获取扩展名图标
      if (ext) {
        const tempFileName = `temp_icon_file.${ext}`;
        const tempPath = path.join(app.getPath('temp'), tempFileName);
        
        try {
          await fs.writeFile(tempPath, '');
          const icon = await app.getFileIcon(tempPath, { size: 'normal' });
          
          // 清理临时文件
          try {
            await fs.unlink(tempPath);
          } catch {}

          if (icon && !icon.isEmpty()) {
            return {
              type: 'native',
              data: icon.toDataURL(),
              size: { width: 32, height: 32 }
            };
          }
        } catch (tempError) {
          console.warn('临时文件方法失败:', tempError);
        }
      }

      throw new Error('无法获取Windows图标');
    } catch (error) {
      throw new Error(`Windows图标获取失败: ${error.message}`);
    }
  }

  // macOS图标获取
  async getMacIcon(filePath, ext) {
    try {
      // macOS使用app.getFileIcon
      if (await this.fileExists(filePath)) {
        const icon = await app.getFileIcon(filePath, { size: 'normal' });
        if (icon && !icon.isEmpty()) {
          return {
            type: 'native',
            data: icon.toDataURL(),
            size: { width: 32, height: 32 }
          };
        }
      }

      throw new Error('无法获取macOS图标');
    } catch (error) {
      throw new Error(`macOS图标获取失败: ${error.message}`);
    }
  }

  // Linux图标获取
  async getLinuxIcon(filePath, ext) {
    try {
      // Linux平台的图标获取比较复杂，暂时返回默认图标
      // TODO: 实现Linux图标主题支持
      throw new Error('Linux图标获取暂未实现');
    } catch (error) {
      throw new Error(`Linux图标获取失败: ${error.message}`);
    }
  }

  // 检查文件是否存在
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // 检查是否为目录
  async isDirectory(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  // 获取默认图标（Unicode Emoji）
  getDefaultIcon(category) {
    const defaultIcons = {
      document: '📄',
      spreadsheet: '📊', 
      presentation: '📽️',
      archive: '🗜️',
      image: '🖼️',
      video: '🎬',
      audio: '🎵',
      code: '💻',
      data: '📋',
      executable: '⚙️',
      font: '🔤',
      folder: '📁',
      shortcut: '🔗',
      unknown: '📄'
    };

    const icon = defaultIcons[category] || defaultIcons.unknown;
    
    return {
      type: 'emoji',
      data: icon,
      size: { width: 16, height: 16 }
    };
  }

  // 缓存图标
  setCachedIcon(key, iconData) {
    // 如果缓存已满，删除最旧的项
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, iconData);
  }

  // 清除缓存
  clearCache() {
    this.cache.clear();
    this.pendingRequests.clear();
  }

  // 获取缓存统计
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      keys: Array.from(this.cache.keys())
    };
  }

  // 工具方法
  getFileExtension(filePath) {
    const match = filePath.match(/\.([a-zA-Z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  detectFileCategory(ext) {
    // 特殊文件类型
    if (ext === 'lnk') return 'shortcut';
    
    const fileTypes = {
      document: ['doc', 'docx', 'pdf', 'txt', 'rtf', 'odt', 'pages'],
      spreadsheet: ['xls', 'xlsx', 'csv', 'ods', 'numbers'],
      presentation: ['ppt', 'pptx', 'odp', 'key'],
      archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
      image: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'bmp', 'webp'],
      video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv'],
      audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'],
      code: ['js', 'ts', 'py', 'java', 'cpp', 'c', 'html', 'css'],
      data: ['json', 'xml', 'yaml', 'yml', 'toml', 'ini'],
      executable: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm'],
      font: ['ttf', 'otf', 'woff', 'woff2']
    };

    for (const [category, extensions] of Object.entries(fileTypes)) {
      if (extensions.includes(ext)) {
        return category;
      }
    }
    return 'unknown';
  }
}

module.exports = { IconManager };
