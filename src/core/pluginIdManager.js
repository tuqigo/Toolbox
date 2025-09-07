/**
 * 插件ID管理器
 * 负责生成和管理插件的唯一标识符
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

class PluginIdManager {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    this.registry = options.registry; // 注册中心实例（可选）
  }

  /**
   * 获取插件ID（根据上下文自动选择合适的ID类型）
   * @param {string} pluginPath - 插件路径
   * @param {Object} manifest - 插件清单
   * @param {string} context - 上下文：'local' | 'package' | 'registry'
   * @returns {string} 插件ID
   */
  getPluginId(pluginPath, manifest, context = 'local') {
    switch (context) {
      case 'local':
        return this.getLocalId(pluginPath);
      case 'package':
        return this.getPackageId(pluginPath, manifest);
      case 'registry':
        return manifest.registryId || this.getPackageId(pluginPath, manifest);
      default:
        return this.getLocalId(pluginPath);
    }
  }

  /**
   * 本地开发ID（使用目录名）
   * @param {string} pluginPath - 插件路径
   * @returns {string} 本地ID
   */
  getLocalId(pluginPath) {
    return path.basename(pluginPath);
  }

  /**
   * 打包ID（目录名 + 内容哈希）
   * @param {string} pluginPath - 插件路径
   * @param {Object} manifest - 插件清单
   * @returns {string} 打包ID
   */
  getPackageId(pluginPath, manifest) {
    const dirName = path.basename(pluginPath);
    const contentHash = this.generateContentHash(manifest);
    return `${dirName}-${contentHash}`;
  }

  /**
   * 生成基于内容的哈希
   * @param {Object} manifest - 插件清单
   * @returns {string} 内容哈希（8位）
   */
  generateContentHash(manifest) {
    // 使用插件的核心信息生成稳定哈希
    const coreContent = {
      name: manifest.name || '',
      author: manifest.author || '',
      description: manifest.description || '',
      version: manifest.version || '1.0.0'
    };

    const content = JSON.stringify(coreContent, Object.keys(coreContent).sort());
    
    return crypto.createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * 生成完全随机的唯一ID（用于注册中心分配）
   * @returns {string} 随机唯一ID
   */
  generateUniqueId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `reg_${timestamp}_${random}`;
  }

  /**
   * 验证ID格式是否有效
   * @param {string} id - 要验证的ID
   * @returns {boolean} 是否有效
   */
  isValidId(id) {
    if (!id || typeof id !== 'string') return false;
    
    // 允许的ID格式：
    // 1. 本地ID：字母数字和连字符
    // 2. 打包ID：本地ID + 连字符 + 8位哈希
    // 3. 注册中心ID：reg_ 开头
    const patterns = [
      /^[a-zA-Z0-9-]+$/, // 本地ID
      /^[a-zA-Z0-9-]+-[a-f0-9]{8}$/, // 打包ID
      /^reg_[a-z0-9]+_[a-f0-9]+$/ // 注册中心ID
    ];

    return patterns.some(pattern => pattern.test(id));
  }

  /**
   * 从插件路径推断插件类型
   * @param {string} pluginPath - 插件路径
   * @returns {Object} 插件类型信息
   */
  async analyzePlugin(pluginPath) {
    const manifestPath = path.join(pluginPath, 'plugin.json');
    const installInfoPath = path.join(pluginPath, '.mtpkg-info.json');
    
    let manifest = {};
    let installInfo = {};
    
    try {
      if (await fs.pathExists(manifestPath)) {
        manifest = await fs.readJson(manifestPath);
      }
      
      if (await fs.pathExists(installInfoPath)) {
        installInfo = await fs.readJson(installInfoPath);
      }
    } catch (error) {
      if (!this.isQuiet) {
        console.warn(`分析插件失败 ${pluginPath}:`, error.message);
      }
    }

    return {
      manifest,
      installInfo,
      isLocal: !installInfo.source, // 没有安装信息的是本地开发插件
      isFromRegistry: installInfo.source === 'registry'
    };
  }

  /**
   * 为插件生成合适的运行时ID
   * @param {string} pluginPath - 插件路径
   * @param {Object} manifest - 插件清单
   * @param {Object} installInfo - 安装信息
   * @returns {string} 运行时ID
   */
  generateRuntimeId(pluginPath, manifest, installInfo = {}) {
    // 优先级：注册中心ID > 安装时ID > 打包ID > 本地ID
    
    if (installInfo.registryId) {
      return installInfo.registryId;
    }
    
    if (installInfo.packageId) {
      return installInfo.packageId;
    }
    
    if (installInfo.source) {
      // 已安装的插件使用打包ID
      return this.getPackageId(pluginPath, manifest);
    }
    
    // 本地开发插件使用目录名
    return this.getLocalId(pluginPath);
  }

  /**
   * 规范化插件清单（移除废弃的id字段）
   * @param {Object} manifest - 原始清单
   * @returns {Object} 规范化后的清单
   */
  normalizeManifest(manifest) {
    const normalized = { ...manifest };
    
    // 移除废弃的id字段
    if (normalized.id) {
      if (!this.isQuiet) {
        console.warn(`插件清单中的 id 字段已废弃，将被忽略: ${normalized.id}`);
      }
      delete normalized.id;
    }
    
    // 确保必需字段存在
    if (!normalized.name) {
      throw new Error('插件清单缺少必需的 name 字段');
    }
    
    if (!normalized.version) {
      normalized.version = '1.0.0';
    }
    
    return normalized;
  }

  /**
   * 批量处理插件目录，生成ID映射
   * @param {string} pluginsDir - 插件目录
   * @returns {Map} 插件ID到路径的映射
   */
  async scanPluginsDirectory(pluginsDir) {
    const pluginMap = new Map();
    
    try {
      const entries = await fs.readdir(pluginsDir);
      
      for (const entry of entries) {
        const pluginPath = path.join(pluginsDir, entry);
        const stat = await fs.stat(pluginPath);
        
        if (stat.isDirectory()) {
          try {
            const analysis = await this.analyzePlugin(pluginPath);
            const runtimeId = this.generateRuntimeId(
              pluginPath, 
              analysis.manifest, 
              analysis.installInfo
            );
            
            pluginMap.set(runtimeId, {
              path: pluginPath,
              manifest: analysis.manifest,
              installInfo: analysis.installInfo,
              isLocal: analysis.isLocal
            });
            
          } catch (error) {
            if (!this.isQuiet) {
              console.warn(`处理插件失败 ${entry}:`, error.message);
            }
          }
        }
      }
    } catch (error) {
      if (!this.isQuiet) {
        console.error('扫描插件目录失败:', error.message);
      }
    }
    
    return pluginMap;
  }

  /**
   * 检查ID冲突
   * @param {Map} pluginMap - 插件映射
   * @returns {Array} 冲突报告
   */
  checkIdConflicts(pluginMap) {
    const conflicts = [];
    const idCounts = new Map();
    
    // 统计ID使用次数
    for (const [id, info] of pluginMap) {
      if (!idCounts.has(id)) {
        idCounts.set(id, []);
      }
      idCounts.get(id).push(info);
    }
    
    // 找出冲突
    for (const [id, infos] of idCounts) {
      if (infos.length > 1) {
        conflicts.push({
          id,
          count: infos.length,
          plugins: infos.map(info => ({
            path: info.path,
            name: info.manifest.name
          }))
        });
      }
    }
    
    return conflicts;
  }

  /**
   * 日志输出
   */
  log(...args) {
    if (!this.isQuiet) {
      console.log('[PluginIdManager]', ...args);
    }
  }
}

module.exports = { PluginIdManager };
