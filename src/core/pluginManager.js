// 插件管理器
// 负责扫描 plugins 目录，解析 plugin.json/config.json，生成统一的插件元信息
const path = require('path');
const fs = require('fs-extra');
const { RuleCompiler } = require('./ruleCompiler');
const { PluginIdManager } = require('./pluginIdManager');

class PluginManager {
  constructor(options = {}) {
    this.pluginsDir = options.pluginsDir || path.join(__dirname, '../../plugins');
    this.isQuiet = !!options.isQuiet;
    this.plugins = new Map(); // id -> plugin meta
    this.ruleCompiler = new RuleCompiler({ isQuiet: this.isQuiet });
    this.idManager = new PluginIdManager({ isQuiet: this.isQuiet });
  }

  async loadAll() {
    this.plugins.clear();
    try {
      const entries = await fs.readdir(this.pluginsDir);
      for (const entry of entries) {
        const dir = path.join(this.pluginsDir, entry);
        if ((await fs.stat(dir)).isDirectory()) {
          await this.loadOne(dir).catch(e => {
            if (!this.isQuiet) console.error('加载插件失败:', dir, e.message);
          });
        }
      }
      if (!this.isQuiet) console.log(`已加载 ${this.plugins.size} 个插件`);
    } catch (e) {
      if (!this.isQuiet) console.error('扫描插件目录失败:', e.message);
    }
  }

  async loadOne(pluginPath) {
    // 只支持 plugin.json
    const manifestPath = await this.resolveManifest(pluginPath);
    if (!manifestPath) return;
    
    const raw = await fs.readFile(manifestPath, 'utf8');
    const rawManifest = JSON.parse(raw);
    
    // 规范化清单（移除废弃的id字段）
    const manifest = this.idManager.normalizeManifest(rawManifest);
    
    // 分析插件信息
    const analysis = await this.idManager.analyzePlugin(pluginPath);
    
    // 生成运行时ID
    const id = this.idManager.generateRuntimeId(pluginPath, manifest, analysis.installInfo);
    
    const name = manifest.name;
    const description = manifest.description || '';
    
    // 新的窗口配置，有默认值
    const windowCfg = {
      width: 720,
      height: 560,
      resizable: true,
      ...manifest.window
    };
    
    // 通过检查是否存在 index.html 来判断是否有UI
    const indexHtmlPath = path.join(pluginPath, 'index.html');
    const ui = await fs.pathExists(indexHtmlPath);

    // 编译规则
    const compiledRules = this.ruleCompiler.compile(manifest);

    const meta = {
      id,
      name,
      description,
      path: pluginPath,
      icon: manifest.logo || '🔧',
      window: windowCfg,
      ui,
      main: ui ? 'index.html' : null,
      version: manifest.version || '1.0.0',
      author: manifest.author || 'Unknown',
      isLocal: analysis.isLocal,
      installInfo: analysis.installInfo,
      // 不再依赖 manifest.preload；无 UI 情况下默认查找 script.js（兼容 preload.js）
      compiledRules
    };

    this.plugins.set(id, meta);
  }

  async resolveManifest(pluginPath) {
    const p = path.join(pluginPath, 'plugin.json');
    if (await fs.pathExists(p)) return p;
    return null;
  }

  list() {
    return Array.from(this.plugins.values());
  }

  get(id) {
    return this.plugins.get(id);
  }
}

module.exports = { PluginManager };


