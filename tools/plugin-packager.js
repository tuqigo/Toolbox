#!/usr/bin/env node
/**
 * MiniToolbox 插件打包工具
 * 用于将插件目录打包成可分发的 .mtpkg 文件
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { PluginIdManager } = require('../src/core/pluginIdManager');

class PluginPackager {
  constructor() {
    this.requiredFiles = ['plugin.json'];
    this.optionalFiles = ['index.html', 'script.js', 'icon.png', 'README.md'];
    this.allowedExtensions = ['.js', '.html', '.css', '.json', '.png', '.jpg', '.jpeg', '.svg', '.md', '.txt'];
    this.idManager = new PluginIdManager({ isQuiet: false });
  }

  /**
   * 验证插件目录结构
   */
  async validatePlugin(pluginDir) {
    const errors = [];
    const warnings = [];

    // 检查必需文件
    for (const file of this.requiredFiles) {
      const filePath = path.join(pluginDir, file);
      if (!await fs.pathExists(filePath)) {
        errors.push(`缺少必需文件: ${file}`);
      }
    }

      // 验证 plugin.json
      try {
        const manifestPath = path.join(pluginDir, 'plugin.json');
        if (await fs.pathExists(manifestPath)) {
          const rawManifest = await fs.readJson(manifestPath);
          
          // 检查废弃的id字段
          if (rawManifest.id) {
            warnings.push('id 字段已废弃，将被自动生成，建议删除此字段');
          }
          
          // 验证必需字段
          if (!rawManifest.name) errors.push('plugin.json 缺少 name 字段');
          if (!rawManifest.version) warnings.push('建议添加 version 字段，默认使用 1.0.0');
          if (!rawManifest.author) warnings.push('建议添加 author 字段');
          if (!rawManifest.description) warnings.push('建议添加 description 字段');

          // 验证版本号格式
          if (rawManifest.version && !/^\d+\.\d+\.\d+$/.test(rawManifest.version)) {
            errors.push('版本号格式不正确，应为 x.y.z 格式');
          }
          
          // 尝试规范化清单
          try {
            this.idManager.normalizeManifest(rawManifest);
          } catch (normalizeError) {
            errors.push(`清单规范化失败: ${normalizeError.message}`);
          }
        }
      } catch (error) {
        errors.push(`plugin.json 格式错误: ${error.message}`);
      }

    // 检查文件扩展名
    const files = await this.getAllFiles(pluginDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext && !this.allowedExtensions.includes(ext)) {
        warnings.push(`不建议的文件类型: ${file}`);
      }
    }

    return { errors, warnings };
  }

  /**
   * 获取目录下所有文件
   */
  async getAllFiles(dir, basePath = '') {
    const files = [];
    const entries = await fs.readdir(dir);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const relativePath = path.join(basePath, entry);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        // 跳过隐藏目录和 node_modules
        if (!entry.startsWith('.') && entry !== 'node_modules') {
          files.push(...await this.getAllFiles(fullPath, relativePath));
        }
      } else {
        files.push(relativePath);
      }
    }

    return files;
  }

  /**
   * 计算文件哈希
   */
  async calculateHash(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    
    return new Promise((resolve, reject) => {
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * 打包插件
   */
  async packPlugin(pluginDir, outputDir) {
    const pluginName = path.basename(pluginDir);
    console.log(`\n📦 开始打包插件: ${pluginName}`);

    // 验证插件
    const validation = await this.validatePlugin(pluginDir);
    if (validation.errors.length > 0) {
      console.error('❌ 插件验证失败:');
      validation.errors.forEach(error => console.error(`  - ${error}`));
      return false;
    }

    if (validation.warnings.length > 0) {
      console.warn('⚠️  警告:');
      validation.warnings.forEach(warning => console.warn(`  - ${warning}`));
    }

    // 读取并规范化插件清单
    const rawManifest = await fs.readJson(path.join(pluginDir, 'plugin.json'));
    const manifest = this.idManager.normalizeManifest(rawManifest);
    
    // 生成包ID
    const packageId = this.idManager.getPackageId(pluginDir, manifest);
    
    // 创建输出目录
    await fs.ensureDir(outputDir);
    
    // 生成包文件名
    const packageName = `${packageId}-${manifest.version || '1.0.0'}.mtpkg`;
    const packagePath = path.join(outputDir, packageName);

    // 创建压缩包
    const output = fs.createWriteStream(packagePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise(async (resolve, reject) => {
      output.on('close', async () => {
        // 计算包文件哈希
        const packageHash = await this.calculateHash(packagePath);
        const packageSize = archive.pointer();

        // 生成包信息文件
        const packageInfo = {
          id: packageId,
          ...manifest,
          package: {
            filename: packageName,
            size: packageSize,
            hash: packageHash,
            created: new Date().toISOString()
          }
        };

        const infoPath = path.join(outputDir, `${packageId}-${manifest.version || '1.0.0'}.json`);
        await fs.writeJson(infoPath, packageInfo, { spaces: 2 });

        console.log(`✅ 打包完成:`);
        console.log(`  - 包文件: ${packagePath}`);
        console.log(`  - 大小: ${(packageSize / 1024).toFixed(2)} KB`);
        console.log(`  - 哈希: ${packageHash.substring(0, 16)}...`);
        
        resolve(true);
      });

      archive.on('error', reject);
      archive.pipe(output);

      // 添加所有插件文件
      const files = await this.getAllFiles(pluginDir);
      for (const file of files) {
        const fullPath = path.join(pluginDir, file);
        archive.file(fullPath, { name: file });
      }

      archive.finalize();
    });
  }

  /**
   * 批量打包多个插件
   */
  async packAllPlugins(pluginsDir, outputDir) {
    const entries = await fs.readdir(pluginsDir);
    const results = [];

    for (const entry of entries) {
      const pluginPath = path.join(pluginsDir, entry);
      const stat = await fs.stat(pluginPath);
      
      if (stat.isDirectory()) {
        const manifestPath = path.join(pluginPath, 'plugin.json');
        if (await fs.pathExists(manifestPath)) {
          console.log(`\n处理插件目录: ${entry}`);
          const success = await this.packPlugin(pluginPath, outputDir);
          results.push({ name: entry, success });
        }
      }
    }

    console.log(`\n📋 打包汇总:`);
    results.forEach(({ name, success }) => {
      console.log(`  ${success ? '✅' : '❌'} ${name}`);
    });

    return results;
  }
}

// CLI 入口
if (require.main === module) {
  const [,, command, ...args] = process.argv;

  const packager = new PluginPackager();

  switch (command) {
    case 'pack':
      if (args.length < 2) {
        console.error('用法: node plugin-packager.js pack <插件目录> <输出目录>');
        process.exit(1);
      }
      packager.packPlugin(args[0], args[1]).catch(console.error);
      break;

    case 'pack-all':
      if (args.length < 2) {
        console.error('用法: node plugin-packager.js pack-all <插件根目录> <输出目录>');
        process.exit(1);
      }
      packager.packAllPlugins(args[0], args[1]).catch(console.error);
      break;

    case 'validate':
      if (args.length < 1) {
        console.error('用法: node plugin-packager.js validate <插件目录>');
        process.exit(1);
      }
      packager.validatePlugin(args[0]).then(({ errors, warnings }) => {
        if (errors.length > 0) {
          console.error('❌ 验证错误:');
          errors.forEach(error => console.error(`  - ${error}`));
          process.exit(1);
        }
        if (warnings.length > 0) {
          console.warn('⚠️  警告:');
          warnings.forEach(warning => console.warn(`  - ${warning}`));
        }
        console.log('✅ 插件验证通过');
      }).catch(console.error);
      break;

    default:
      console.log(`
MiniToolbox 插件打包工具

用法:
  node plugin-packager.js pack <插件目录> <输出目录>      打包单个插件
  node plugin-packager.js pack-all <插件根目录> <输出目录>  批量打包所有插件
  node plugin-packager.js validate <插件目录>           验证插件格式

示例:
  node plugin-packager.js pack ./plugins/json-formatter ./dist
  node plugin-packager.js pack-all ./plugins ./dist
  node plugin-packager.js validate ./plugins/json-formatter
      `);
  }
}

module.exports = PluginPackager;
