#!/usr/bin/env node
/**
 * 插件发布工具
 * 用于将插件发布到注册中心
 */

const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const PluginPackager = require('./plugin-packager');

class PluginPublisher {
  constructor() {
    this.registryUrl = process.env.PLUGIN_REGISTRY_URL || 'https://registry.minitoolbox.com';
    this.apiKey = process.env.PLUGIN_API_KEY;
    this.packager = new PluginPackager();
  }

  /**
   * 发布插件
   */
  async publishPlugin(pluginDir, options = {}) {
    console.log(`\n📤 准备发布插件: ${path.basename(pluginDir)}`);

    // 验证API密钥
    if (!this.apiKey) {
      throw new Error('缺少API密钥，请设置环境变量 PLUGIN_API_KEY');
    }

    // 验证插件
    const validation = await this.packager.validatePlugin(pluginDir);
    if (validation.errors.length > 0) {
      console.error('❌ 插件验证失败:');
      validation.errors.forEach(error => console.error(`  - ${error}`));
      throw new Error('插件验证失败');
    }

    if (validation.warnings.length > 0) {
      console.warn('⚠️  警告:');
      validation.warnings.forEach(warning => console.warn(`  - ${warning}`));
    }

    // 读取插件清单
    const manifest = await fs.readJson(path.join(pluginDir, 'plugin.json'));
    console.log(`\n插件信息:`);
    console.log(`  ID: ${manifest.id}`);
    console.log(`  名称: ${manifest.name}`);
    console.log(`  版本: ${manifest.version}`);
    console.log(`  作者: ${manifest.author}`);

    // 检查版本是否已存在
    if (!options.force) {
      const existingVersions = await this.getPluginVersions(manifest.id);
      if (existingVersions.includes(manifest.version)) {
        throw new Error(`版本 ${manifest.version} 已存在，使用 --force 强制覆盖`);
      }
    }

    // 打包插件
    const tempDir = path.join(__dirname, '../temp');
    await fs.ensureDir(tempDir);
    
    console.log('\n📦 打包插件...');
    await this.packager.packPlugin(pluginDir, tempDir);

    const packagePath = path.join(tempDir, `${manifest.id}-${manifest.version}.mtpkg`);
    const infoPath = path.join(tempDir, `${manifest.id}-${manifest.version}.json`);

    try {
      // 上传插件包
      console.log('\n🚀 上传插件包...');
      const uploadResult = await this.uploadPackage(packagePath, infoPath);
      
      console.log(`✅ 插件发布成功!`);
      console.log(`  插件ID: ${uploadResult.pluginId}`);
      console.log(`  版本: ${uploadResult.version}`);
      console.log(`  下载链接: ${uploadResult.downloadUrl}`);

      return uploadResult;

    } finally {
      // 清理临时文件
      await fs.remove(tempDir);
    }
  }

  /**
   * 获取插件已发布的版本列表
   */
  async getPluginVersions(pluginId) {
    try {
      const response = await this.makeRequest('GET', `/api/plugins/${pluginId}/versions`);
      return response.data.map(v => v.version);
    } catch (error) {
      if (error.statusCode === 404) {
        return []; // 插件不存在，返回空数组
      }
      throw error;
    }
  }

  /**
   * 上传插件包
   */
  async uploadPackage(packagePath, infoPath) {
    const packageInfo = await fs.readJson(infoPath);
    
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('package', fs.createReadStream(packagePath));
      form.append('info', JSON.stringify(packageInfo));
      
      const req = https.request({
        hostname: new URL(this.registryUrl).hostname,
        port: 443,
        path: '/api/plugins/publish',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          ...form.getHeaders()
        }
      }, (res) => {
        let data = '';
        
        res.on('data', chunk => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(result.message || `HTTP ${res.statusCode}`));
            } else {
              resolve(result.data);
            }
          } catch (error) {
            reject(new Error('响应格式错误'));
          }
        });
      });

      req.on('error', reject);
      form.pipe(req);
    });
  }

  /**
   * 发起HTTP请求
   */
  async makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.registryUrl + path);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        
        res.on('data', chunk => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode >= 400) {
              const error = new Error(result.message || `HTTP ${res.statusCode}`);
              error.statusCode = res.statusCode;
              reject(error);
            } else {
              resolve(result);
            }
          } catch (error) {
            reject(new Error('响应格式错误'));
          }
        });
      });

      req.on('error', reject);

      if (data) {
        req.write(JSON.stringify(data));
      }
      
      req.end();
    });
  }

  /**
   * 批量发布多个插件
   */
  async publishAllPlugins(pluginsDir, options = {}) {
    const entries = await fs.readdir(pluginsDir);
    const results = [];

    for (const entry of entries) {
      const pluginPath = path.join(pluginsDir, entry);
      const stat = await fs.stat(pluginPath);
      
      if (stat.isDirectory()) {
        const manifestPath = path.join(pluginPath, 'plugin.json');
        if (await fs.pathExists(manifestPath)) {
          try {
            const result = await this.publishPlugin(pluginPath, options);
            results.push({ name: entry, success: true, result });
          } catch (error) {
            console.error(`\n❌ 发布 ${entry} 失败: ${error.message}`);
            results.push({ name: entry, success: false, error: error.message });
          }
        }
      }
    }

    console.log(`\n📋 发布汇总:`);
    results.forEach(({ name, success, error }) => {
      console.log(`  ${success ? '✅' : '❌'} ${name}${error ? ` - ${error}` : ''}`);
    });

    return results;
  }
}

// CLI 入口
if (require.main === module) {
  const [,, command, ...args] = process.argv;

  const publisher = new PluginPublisher();

  switch (command) {
    case 'publish':
      if (args.length < 1) {
        console.error('用法: node publish-plugin.js publish <插件目录> [--force]');
        process.exit(1);
      }
      
      const options = {};
      if (args.includes('--force')) {
        options.force = true;
      }
      
      publisher.publishPlugin(args[0], options).catch(error => {
        console.error('❌ 发布失败:', error.message);
        process.exit(1);
      });
      break;

    case 'publish-all':
      if (args.length < 1) {
        console.error('用法: node publish-plugin.js publish-all <插件根目录> [--force]');
        process.exit(1);
      }
      
      const batchOptions = {};
      if (args.includes('--force')) {
        batchOptions.force = true;
      }
      
      publisher.publishAllPlugins(args[0], batchOptions).catch(error => {
        console.error('❌ 批量发布失败:', error.message);
        process.exit(1);
      });
      break;

    default:
      console.log(`
MiniToolbox 插件发布工具

环境变量:
  PLUGIN_REGISTRY_URL    注册中心地址 (默认: https://registry.minitoolbox.com)
  PLUGIN_API_KEY         API密钥 (必需)

用法:
  node publish-plugin.js publish <插件目录> [--force]         发布单个插件
  node publish-plugin.js publish-all <插件根目录> [--force]    批量发布所有插件

选项:
  --force               强制覆盖已存在的版本

示例:
  export PLUGIN_API_KEY="your-api-key"
  node publish-plugin.js publish ./plugins/json-formatter
  node publish-plugin.js publish-all ./plugins --force
      `);
  }
}

module.exports = PluginPublisher;
