// 规则编译器
// 负责将 plugin.json 中 features/cmds 规则编译为高效可执行的匹配对象
class RuleCompiler {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
  }

  // 将 plugin.json 的 features/cmds 编译成快速匹配规则
  compile(pluginConfig) {
    const rules = [];
    const features = Array.isArray(pluginConfig.features) ? pluginConfig.features : [];
    for (const feature of features) {
      const cmds = Array.isArray(feature.cmds) ? feature.cmds : [];
      for (const cmd of cmds) {
        const compiled = this.compileSingle(cmd, feature);
        if (compiled) {
          rules.push(compiled);
        }
      }
    }
    return rules;
  }

  // 支持四类：regex, keyword, prefix, files
  compileSingle(cmd, feature = null) {
    // 支持三类：regex, keyword, prefix（可扩展）
    if (typeof cmd === 'string') {
      return { 
        type: 'keyword', 
        value: cmd.toLowerCase(), 
        minLength: 0, 
        maxLength: Infinity,
        featureCode: feature ? feature.code : null,
        featureExplain: feature ? feature.explain : null
      };
    }
    if (!cmd || typeof cmd !== 'object') return null;

    const base = {
      minLength: typeof cmd.minLength === 'number' ? cmd.minLength : 0,
      maxLength: typeof cmd.maxLength === 'number' ? cmd.maxLength : Infinity,
      featureCode: feature ? feature.code : null,
      featureExplain: feature ? feature.explain : null
    };

    switch (cmd.type) {
      case 'regex': {
        // cmd.match 可能是如 "/^\d+$/" 这样的字符串
        const regex = this.safeBuildRegex(cmd.match, cmd.flags);
        if (!regex) return null;
        return { type: 'regex', trigger: 'content', regex, label: cmd.label || '', ...base };
      }
      case 'keyword': {
        if (!cmd.value) return null;
        return { type: 'keyword', trigger: 'command', value: String(cmd.value).toLowerCase().trim(), label: cmd.label || '', ...base };
      }
      case 'prefix': {
        if (!cmd.value) return null;
        return { type: 'prefix', trigger: 'command', value: String(cmd.value).toLowerCase().trim(), label: cmd.label || '', ...base };
      }
      case 'files': {
        const rule = {
          type: 'files', trigger: 'content',
          fileType: cmd.fileType || 'file', // file|image|directory
          extensions: Array.isArray(cmd.extensions) ? cmd.extensions.map(e => String(e).toLowerCase()) : [],
          ...base
        };
        return rule;
      }
      default:
        return null;
    }
  }

  // 安全构建正则，兼容 "/pattern/" 包裹形式
  safeBuildRegex(input, flags = 'i') {
    try {
      if (input instanceof RegExp) return input;
      if (typeof input !== 'string') return null;
      // 允许形如 "/pattern/" 或 "pattern"
      let pattern = input;
      const wrapped = /^\/(.*)\/[a-zA-Z]*$/.exec(input);
      if (wrapped) {
        pattern = wrapped[1];
      }
      return new RegExp(pattern, flags || 'i');
    } catch (e) {
      if (!this.isQuiet) console.warn('正则编译失败:', input, e.message);
      return null;
    }
  }

  // 根据文本/文件与长度约束进行快速匹配（先长度再策略）
  match(compiledRules, text, contentAnalysis) {
    const t = (text || '').trim();
    const n = t.length;
    if (n === 0) return false;

    for (const rule of compiledRules) {
      if (this.matchSingle(rule, text, contentAnalysis)) return true;
    }
    return false;
  }

  // 单个规则匹配
  matchSingle(rule, text, contentAnalysis) {
    const t = (text || '').trim();
    const n = t.length;
    if (n === 0) return false;
    if (n < rule.minLength || n > rule.maxLength) return false;
    
    switch (rule.type) {
      case 'regex':
        return rule.regex.test(t);
      case 'keyword':
        return t.toLowerCase().includes(rule.value);
      case 'prefix':
        return t.toLowerCase().startsWith(rule.value);
      case 'files': {
        if (!contentAnalysis) return false;
        const caType = contentAnalysis.type;
        if (rule.fileType && caType !== rule.fileType) return false;
        // 匹配扩展名
        if (Array.isArray(rule.extensions) && rule.extensions.length > 0) {
          const name = (contentAnalysis.content || '').toLowerCase();
          return rule.extensions.some(ext => name.endsWith('.' + ext.replace(/^\./, '')));
        } else {
          // 未配置扩展名，仅类型匹配则通过
          return true;
        }
      }
      default:
        return false;
    }
  }
}

module.exports = { RuleCompiler };


