// 插件管理器
// 负责扫描 plugins 目录，解析 plugin.json/config.json，生成统一的插件元信息
const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');
const { RuleCompiler } = require('./ruleCompiler');
const { PluginIdManager } = require('./pluginIdManager');

class PluginManager {
  constructor(options = {}) {
    const defaultDir = path.join(__dirname, '../../plugins');
    const opt = options.pluginsDir;
    // 兼容单目录与多目录入参：内置目录优先，后续目录可覆盖同名插件
    this.pluginsDirs = Array.isArray(opt) ? (opt.length ? opt : [defaultDir]) : [opt || defaultDir];
    this.isQuiet = !!options.isQuiet;
    this.plugins = new Map(); // id -> plugin meta
    this.ruleCompiler = new RuleCompiler({ isQuiet: this.isQuiet });
    this.idManager = new PluginIdManager({ isQuiet: this.isQuiet });
  }

  async loadAll() {
    this.plugins.clear();
    for (const baseDir of this.pluginsDirs) {
      try {
        if (!await fs.pathExists(baseDir)) {
          if (!this.isQuiet) console.warn('[PluginManager] 插件目录不存在:', baseDir);
          continue;
        }
        const entries = await fs.readdir(baseDir);
        for (const entry of entries) {
          const dir = path.join(baseDir, entry);
          if ((await fs.stat(dir)).isDirectory()) {
            await this.loadOne(dir).catch(e => {
              if (!this.isQuiet) console.error('加载插件失败:', dir, e.message);
            });
          }
        }
        if (!this.isQuiet) console.log('[PluginManager] 扫描完成:', baseDir);
      } catch (e) {
        if (!this.isQuiet) console.error('[PluginManager] 扫描插件目录失败:', baseDir, e.message);
      }
    }
    if (!this.isQuiet) console.log(`已加载 ${this.plugins.size} 个插件`);
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
    // 新增窗口行为默认：失焦不自动隐藏（可通过 manifest.window.hideOnBlur 显式 true 开启）
    if (!('hideOnBlur' in windowCfg)) {
      windowCfg.hideOnBlur = false;
    }
    
    // 通过检查是否存在 index.html 来判断是否有UI
    const indexHtmlPath = path.join(pluginPath, 'index.html');
    const ui = await fs.pathExists(indexHtmlPath);

    // 编译规则
    const compiledRules = this.ruleCompiler.compile(manifest);

    // 解析 feature 配置（含继承与默认值）
    const features = Array.isArray(manifest.features) ? manifest.features : [];
    const defaultMode = manifest.mode || 'list';
    const defaultCopyField = manifest.copyField || 'description';
    // copyEnabled 默认关闭；仅显式 true 时开启
    const defaultCopyEnabled = manifest.copyEnabled === true;
    const featuresMap = {};
    for (const f of features) {
      if (!f || typeof f !== 'object' || !f.code) continue;
      const effective = {
        code: f.code,
        explain: f.explain || '',
        mode: f.mode || defaultMode || 'list',
        copyField: (typeof f.copyField === 'string' && f.copyField) ? f.copyField : (defaultCopyField || 'description'),
        // feature 优先级最高；默认关闭（除非 feature 或 顶层显式 true）
        copyEnabled: (typeof f.copyEnabled === 'boolean') ? f.copyEnabled : defaultCopyEnabled,
        placeholder: f.placeholder || ''
      };
      featuresMap[f.code] = effective;
    }

    // 解析图标：兼容 emoji / URL / 相对路径文件（svg/png/...）
    const rawIcon = manifest.logo || '';
    let iconUrl = null;
    let iconPathFs = null;
    try {
      if (typeof rawIcon === 'string' && rawIcon) {
        if (/^(data:|file:|https?:)/i.test(rawIcon)) {
          iconUrl = rawIcon;
        } else if (/\.(svg|png|jpg|jpeg|gif|ico)$/i.test(rawIcon)) {
          const abs = path.isAbsolute(rawIcon) ? rawIcon : path.join(pluginPath, rawIcon);
          iconUrl = pathToFileURL(abs).toString();
          // 仅为常见位图/ico暴露文件路径给 BrowserWindow.icon（Windows 任务栏图标）
          if (/\.(png|jpg|jpeg|gif|ico)$/i.test(rawIcon)) {
            iconPathFs = abs;
          }
        }
      }
    } catch {}

    const meta = {
      id,
      name,
      description,
      path: pluginPath,
      icon: rawIcon || '🔧',
      iconUrl: iconUrl || null,
      iconPath: iconPathFs || null,
      window: windowCfg,
      // 单例/多实例：默认多实例
      instanceMode: (function(){
        try {
          if (typeof manifest.instance === 'string') {
            return (manifest.instance.toLowerCase() === 'multi') ? 'multi' : 'single';
          }
          if (manifest.multiInstance === true) return 'multi';
        } catch {}
        return 'multi';
      })(),
      ui,
      main: ui ? 'index.html' : null,
      version: manifest.version || '1.0.0',
      author: manifest.author || 'Unknown',
      isLocal: analysis.isLocal,
      installInfo: analysis.installInfo,
      // 不再依赖 manifest.preload；无 UI 情况下默认查找 script.js（兼容 preload.js）
      compiledRules,
      // feature 元信息（供匹配与渲染阶段使用）
      featuresMap,
      // 顶层默认（作为继承兜底）
      defaultMode,
      defaultCopyField,
      defaultCopyEnabled
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

  // 开发者工具：挂载任意目录插件（临时）
  async mountDevPlugin(pluginPath) {
    try {
      if (!await fs.pathExists(pluginPath)) throw new Error('路径不存在');
      await this.loadOne(pluginPath);
      const meta = Array.from(this.plugins.values()).find(p => p.path === pluginPath);
      if (!this.isQuiet) console.log('[PluginManager] 开发挂载:', pluginPath, '=>', meta && meta.id);
      return meta || null;
    } catch (e) {
      if (!this.isQuiet) console.error('[PluginManager] 开发挂载失败:', pluginPath, e && e.message || e);
      throw e;
    }
  }

  // 开发者工具：按ID卸载（仅从运行时移除，不删除磁盘）
  async unmountById(id) {
    try {
      if (!this.plugins.has(id)) return false;
      const meta = this.plugins.get(id);
      this.plugins.delete(id);
      if (!this.isQuiet) console.log('[PluginManager] 开发卸载:', id, 'path=', meta && meta.path);
      return true;
    } catch (e) {
      if (!this.isQuiet) console.error('[PluginManager] 开发卸载失败:', id, e && e.message || e);
      throw e;
    }
  }
}

module.exports = { PluginManager };


