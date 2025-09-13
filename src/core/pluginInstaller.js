/**
 * 插件安装器
 * 负责插件的安装、卸载、更新等操作
 */

const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');
const https = require('https');
const { EventEmitter } = require('events');
const yauzl = require('yauzl');
const { PluginIdManager } = require('./pluginIdManager');

class PluginInstaller extends EventEmitter {
  constructor(options = {}) {
    super();
    const resolvedBaseDir = (function(){
      try {
        if (options.baseDir) return options.baseDir;
        return app.getPath('userData');
      } catch (e) {
        return path.join(process.cwd(), 'MiniToolboxData');
      }
    })();

    this.pluginsDir = options.pluginsDir || path.join(resolvedBaseDir, 'plugins');
    this.cacheDir = options.cacheDir || path.join(resolvedBaseDir, 'cache');
    this.registryUrl = options.registryUrl || 'https://registry.minitoolbox.com';
    this.isQuiet = !!options.isQuiet;
    this.tempDir = path.join(this.cacheDir, 'temp');
    this.idManager = new PluginIdManager({ isQuiet: this.isQuiet });

    // 目录初始化在构造时即可执行（指向用户目录，避免写入 asar）
    this.setupDirectories();
  }

  async setupDirectories() {
    await fs.ensureDir(this.pluginsDir);
    await fs.ensureDir(this.cacheDir);
    await fs.ensureDir(this.tempDir);
  }

  /**
   * 从注册中心搜索插件
   */
  async searchPlugins(keyword, options = {}) {
    try {
      const params = new URLSearchParams({
        q: keyword,
        limit: options.limit || 20,
        offset: options.offset || 0,
        category: options.category || '',
        sort: options.sort || 'relevance'
      });

      const response = await this.makeRequest(`/api/plugins/search?${params}`);
      return response.data;
    } catch (error) {
      this.log('搜索插件失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取插件详情
   */
  async getPluginInfo(pluginId) {
    try {
      const response = await this.makeRequest(`/api/plugins/${pluginId}`);
      return response.data;
    } catch (error) {
      this.log('获取插件信息失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取已安装插件列表
   */
  async getInstalledPlugins() {
    const installed = [];
    
    try {
      const pluginMap = await this.idManager.scanPluginsDirectory(this.pluginsDir);
      
      for (const [id, info] of pluginMap) {
        try {
          // 规范化清单
          const normalizedManifest = this.idManager.normalizeManifest(info.manifest);
          
          installed.push({
            id,
            ...normalizedManifest,
            installPath: info.path,
            installInfo: info.installInfo,
            isLocal: info.isLocal
          });
        } catch (error) {
          this.log(`处理插件失败 ${id}:`, error.message);
        }
      }
      
      // 检查ID冲突
      const conflicts = this.idManager.checkIdConflicts(pluginMap);
      if (conflicts.length > 0) {
        this.log('检测到插件ID冲突:', conflicts);
      }
      
    } catch (error) {
      this.log('获取已安装插件列表失败:', error.message);
    }
    
    return installed;
  }

  /**
   * 检查插件是否已安装
   */
  async isPluginInstalled(pluginId) {
    const pluginPath = path.join(this.pluginsDir, pluginId);
    const manifestPath = path.join(pluginPath, 'plugin.json');
    return await fs.pathExists(manifestPath);
  }

  /**
   * 安装插件
   */
  async installPlugin(pluginId, version = 'latest') {
    this.emit('install-start', { pluginId, version });
    
    try {
      // 检查是否已安装
      if (await this.isPluginInstalled(pluginId)) {
        throw new Error(`插件 ${pluginId} 已安装`);
      }

      // 获取插件信息
      const pluginInfo = await this.getPluginInfo(pluginId);
      
      // 确定要安装的版本
      const targetVersion = version === 'latest' ? pluginInfo.latestVersion : version;
      const versionInfo = pluginInfo.versions.find(v => v.version === targetVersion);
      
      if (!versionInfo) {
        throw new Error(`版本 ${targetVersion} 不存在`);
      }

      this.emit('install-progress', { pluginId, stage: 'downloading', progress: 0 });

      // 下载插件包
      const packagePath = await this.downloadPackage(versionInfo.downloadUrl, pluginId, targetVersion);
      
      this.emit('install-progress', { pluginId, stage: 'extracting', progress: 50 });

      // 验证包完整性
      await this.verifyPackage(packagePath, versionInfo.hash);

      // 解压安装
      await this.extractPackage(packagePath, pluginId);

      // 写入安装信息
      await this.writeInstallInfo(pluginId, {
        source: 'registry',
        pluginId,
        version: targetVersion,
        installedAt: new Date().toISOString(),
        downloadUrl: versionInfo.downloadUrl,
        hash: versionInfo.hash
      });

      this.emit('install-progress', { pluginId, stage: 'completed', progress: 100 });
      this.emit('install-success', { pluginId, version: targetVersion });

      this.log(`✅ 插件 ${pluginId} v${targetVersion} 安装成功`);
      return true;

    } catch (error) {
      this.emit('install-error', { pluginId, error: error.message });
      this.log(`❌ 插件 ${pluginId} 安装失败:`, error.message);
      throw error;
    }
  }

  /**
   * 从本地文件安装插件
   */
  async installFromFile(packagePath) {
    const tempId = `temp_${Date.now()}`;
    this.emit('install-start', { pluginId: tempId, source: 'file' });
    
    try {
      // 解压到临时目录进行检查
      const tempExtractPath = path.join(this.tempDir, tempId);
      await fs.ensureDir(tempExtractPath);
      
      await this.extractPackageToPath(packagePath, tempExtractPath);
      
      // 读取插件信息
      const manifestPath = path.join(tempExtractPath, 'plugin.json');
      if (!await fs.pathExists(manifestPath)) {
        throw new Error('无效的插件包：缺少 plugin.json');
      }
      
      const rawManifest = await fs.readJson(manifestPath);
      // 规范化清单并进行基本校验（name、version 等）
      const manifest = this.idManager.normalizeManifest(rawManifest);
      const version = manifest.version || '1.0.0';

      // 优先从包文件名解析 packageId（与打包器一致：<packageId>-<version>.mtpkg）
      const base = path.basename(packagePath, path.extname(packagePath));
      let packageId = '';
      const idx = base.lastIndexOf('-');
      if (idx > 0) {
        const verPart = base.substring(idx + 1);
        const idPart = base.substring(0, idx);
        if (/^\d+\.\d+\.\d+$/.test(verPart)) {
          packageId = idPart; // e.g. json-formatter-abcdef12
        }
      }

      // 若文件名无法解析，则根据 manifest.name 生成稳定 ID：<slug>-<hash>
      if (!packageId) {
        const nameSlug = String(manifest.name || 'plugin').replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
        const contentHash = this.idManager.generateContentHash(manifest);
        packageId = `${nameSlug}-${contentHash}`;
      }

      // 检查是否已安装（按最终目录名判断）
      const finalPath = path.join(this.pluginsDir, packageId);
      if (await fs.pathExists(finalPath)) {
        throw new Error(`插件已安装: ${packageId}`);
      }

      // 移动到正式安装目录
      await fs.move(tempExtractPath, finalPath);

      // 写入安装信息
      await this.writeInstallInfo(packageId, {
        source: 'file',
        packageId,
        version: version,
        installedAt: new Date().toISOString(),
        originalFile: path.basename(packagePath)
      });

      this.emit('install-success', { pluginId: packageId, version: version });
      this.log(`✅ 插件 ${packageId} 从文件安装成功`);
      return true;

    } catch (error) {
      // 清理临时文件
      await fs.remove(path.join(this.tempDir, tempId)).catch(() => {});
      
      this.emit('install-error', { pluginId: tempId, error: error.message });
      this.log(`❌ 从文件安装插件失败:`, error.message);
      throw error;
    }
  }

  /**
   * 卸载插件
   */
  async uninstallPlugin(pluginId) {
    this.emit('uninstall-start', { pluginId });
    
    try {
      const pluginPath = path.join(this.pluginsDir, pluginId);
      
      if (!await fs.pathExists(pluginPath)) {
        throw new Error(`插件 ${pluginId} 未安装`);
      }

      // 检查是否为本地开发插件
      const installInfoPath = path.join(pluginPath, '.mtpkg-info.json');
      if (await fs.pathExists(installInfoPath)) {
        const installInfo = await fs.readJson(installInfoPath);
        if (!installInfo.source) {
          throw new Error('无法卸载本地开发插件');
        }
      }

      // 删除插件目录
      await fs.remove(pluginPath);

      this.emit('uninstall-success', { pluginId });
      this.log(`✅ 插件 ${pluginId} 卸载成功`);
      return true;

    } catch (error) {
      this.emit('uninstall-error', { pluginId, error: error.message });
      this.log(`❌ 插件 ${pluginId} 卸载失败:`, error.message);
      throw error;
    }
  }

  /**
   * 更新插件
   */
  async updatePlugin(pluginId, targetVersion = 'latest') {
    this.emit('update-start', { pluginId, targetVersion });
    
    try {
      const pluginPath = path.join(this.pluginsDir, pluginId);
      const installInfoPath = path.join(pluginPath, '.mtpkg-info.json');
      
      if (!await fs.pathExists(installInfoPath)) {
        throw new Error('插件非注册中心安装，无法更新');
      }

      const installInfo = await fs.readJson(installInfoPath);
      const currentVersion = installInfo.version;

      // 获取最新插件信息
      const pluginInfo = await this.getPluginInfo(pluginId);
      const latestVersion = targetVersion === 'latest' ? pluginInfo.latestVersion : targetVersion;

      if (currentVersion === latestVersion) {
        this.log(`插件 ${pluginId} 已是最新版本 ${currentVersion}`);
        return false;
      }

      // 备份当前版本
      const backupPath = path.join(this.cacheDir, 'backups', `${pluginId}-${currentVersion}-${Date.now()}`);
      await fs.ensureDir(path.dirname(backupPath));
      await fs.copy(pluginPath, backupPath);

      try {
        // 先卸载当前版本
        await fs.remove(pluginPath);
        
        // 安装新版本
        await this.installPlugin(pluginId, latestVersion);
        
        // 删除备份
        await fs.remove(backupPath);
        
        this.emit('update-success', { pluginId, fromVersion: currentVersion, toVersion: latestVersion });
        this.log(`✅ 插件 ${pluginId} 从 ${currentVersion} 更新到 ${latestVersion}`);
        return true;

      } catch (error) {
        // 恢复备份
        await fs.copy(backupPath, pluginPath);
        await fs.remove(backupPath);
        throw error;
      }

    } catch (error) {
      this.emit('update-error', { pluginId, error: error.message });
      this.log(`❌ 插件 ${pluginId} 更新失败:`, error.message);
      throw error;
    }
  }

  /**
   * 检查插件更新
   */
  async checkUpdates() {
    const installed = await this.getInstalledPlugins();
    const updates = [];

    for (const plugin of installed) {
      if (plugin.isLocal || !plugin.installInfo.source) continue;

      try {
        const pluginInfo = await this.getPluginInfo(plugin.id);
        if (pluginInfo.latestVersion !== plugin.version) {
          updates.push({
            pluginId: plugin.id,
            currentVersion: plugin.version,
            latestVersion: pluginInfo.latestVersion,
            changelog: pluginInfo.versions.find(v => v.version === pluginInfo.latestVersion)?.changelog
          });
        }
      } catch (error) {
        this.log(`检查 ${plugin.id} 更新失败:`, error.message);
      }
    }

    return updates;
  }

  /**
   * 下载插件包
   */
  async downloadPackage(url, pluginId, version) {
    const filename = `${pluginId}-${version}.mtpkg`;
    const filepath = path.join(this.cacheDir, filename);

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filepath);
      
      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0');
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const progress = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 50) : 0;
          this.emit('install-progress', { pluginId, stage: 'downloading', progress });
        });

        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve(filepath);
        });
      }).on('error', reject);
    });
  }

  /**
   * 验证包完整性
   */
  async verifyPackage(packagePath, expectedHash) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(packagePath);
    
    return new Promise((resolve, reject) => {
      stream.on('data', data => hash.update(data));
      stream.on('end', () => {
        const actualHash = hash.digest('hex');
        if (actualHash !== expectedHash) {
          reject(new Error('包文件哈希验证失败'));
        } else {
          resolve();
        }
      });
      stream.on('error', reject);
    });
  }

  /**
   * 解压插件包
   */
  async extractPackage(packagePath, pluginId) {
    const targetPath = path.join(this.pluginsDir, pluginId);
    await this.extractPackageToPath(packagePath, targetPath);
  }

  /**
   * 解压到指定路径
   */
  async extractPackageToPath(packagePath, targetPath) {
    return new Promise((resolve, reject) => {
      yauzl.open(packagePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          reject(err);
          return;
        }

        zipfile.readEntry();
        
        zipfile.on('entry', async (entry) => {
          if (/\/$/.test(entry.fileName)) {
            // 目录
            await fs.ensureDir(path.join(targetPath, entry.fileName));
            zipfile.readEntry();
          } else {
            // 文件
            zipfile.openReadStream(entry, async (err, readStream) => {
              if (err) {
                reject(err);
                return;
              }

              const filePath = path.join(targetPath, entry.fileName);
              await fs.ensureDir(path.dirname(filePath));
              
              const writeStream = fs.createWriteStream(filePath);
              readStream.pipe(writeStream);
              
              writeStream.on('close', () => {
                zipfile.readEntry();
              });
            });
          }
        });

        zipfile.on('end', resolve);
        zipfile.on('error', reject);
      });
    });
  }

  /**
   * 写入安装信息
   */
  async writeInstallInfo(pluginId, info) {
    const pluginPath = path.join(this.pluginsDir, pluginId);
    const infoPath = path.join(pluginPath, '.mtpkg-info.json');
    await fs.writeJson(infoPath, info, { spaces: 2 });
  }

  /**
   * 发起 HTTP 请求
   */
  async makeRequest(path) {
    return new Promise((resolve, reject) => {
      const url = `${this.registryUrl}${path}`;
      
      https.get(url, (response) => {
        let data = '';
        
        response.on('data', chunk => {
          data += chunk;
        });
        
        response.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (response.statusCode >= 400) {
              reject(new Error(result.message || `HTTP ${response.statusCode}`));
            } else {
              resolve(result);
            }
          } catch (error) {
            reject(new Error('响应格式错误'));
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * 日志输出
   */
  log(...args) {
    if (!this.isQuiet) {
      console.log('[PluginInstaller]', ...args);
    }
  }
}

module.exports = { PluginInstaller };
