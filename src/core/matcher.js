// 匹配器
// 核心职责：
// 1) 建立两类索引：按类型(byType)与按规则(rules)
// 2) 根据输入类型与文本进行候选筛选：
//    - 文本类(text/json/url)：必须命中特征规则才进入候选
//    - 非文本类(file/image...)：类型或规则命中均可进入候选
// 3) 打分与排序：规则命中强加权，结合使用频次做偏好排序
const { RuleCompiler } = require('./ruleCompiler');

class Matcher {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    this.ruleCompiler = new RuleCompiler({ isQuiet: this.isQuiet });
    this.usageStore = options.usageStore;
    this.index = {
      byType: new Map(), // type -> Set(pluginId)
      rules: new Map()   // pluginId -> compiledRules
    };
    this.pluginMeta = new Map(); // pluginId -> meta
  }

  rebuild(plugins) {
    this.index.byType.clear();
    this.index.rules.clear();
    this.pluginMeta.clear();
    for (const p of plugins) {
      this.pluginMeta.set(p.id, p);
      // 注册规则
      if (Array.isArray(p.compiledRules) && p.compiledRules.length > 0) {
        this.index.rules.set(p.id, p.compiledRules);
      }
    }
  }

  match(contentAnalysis) {
    const text = contentAnalysis.content || '';
    const type = contentAnalysis.type || 'text';
    const matchedFeatures = new Map(); // pluginId -> Set of matched features

    // 规则候选（规则总览，不局限于类型）
    const commandHits = new Set();
    const contentHits = new Set();
    for (const [pluginId, rules] of this.index.rules) {
      const commandRules = rules.filter(r => r.trigger === 'command');
      const contentRules = rules.filter(r => r.trigger === 'content');
      
      const commandHit = this.ruleCompiler.match(commandRules, text, contentAnalysis);
      const contentHit = this.ruleCompiler.match(contentRules, text, contentAnalysis);
      
      if (commandHit || contentHit) {
        // 收集匹配的具体 features（使用Map避免重复）
        const matchedFeatureMap = new Map();
        [...commandRules, ...contentRules].forEach(rule => {
          if (this.ruleCompiler.matchSingle(rule, text, contentAnalysis)) {
            if (rule.featureCode) {
              // 使用 featureCode 作为 key，避免同一个 feature 重复添加
              if (!matchedFeatureMap.has(rule.featureCode)) {
                matchedFeatureMap.set(rule.featureCode, {
                  code: rule.featureCode,
                  explain: rule.featureExplain,
                  matchedBy: rule.trigger || 'unknown'
                });
              }
            }
          }
        });
        const matchedFeatureSet = new Set(matchedFeatureMap.values());
        
        if (matchedFeatureSet.size > 0) {
          matchedFeatures.set(pluginId, matchedFeatureSet);
        }
        
        if (commandHit) commandHits.add(pluginId);
        if (contentHit) contentHits.add(pluginId);
      }
    }

    // 统一改为"仅规则命中"进入候选，主程序只负责类型识别
    const baseSet = new Set(matchedFeatures.keys());

    // 打分
    const usageScores = (this.usageStore && this.usageStore.getScores()) || {};
    const results = [];
    
    for (const pluginId of baseSet) {
      const meta = this.pluginMeta.get(pluginId);
      const features = matchedFeatures.get(pluginId);
      if (!meta || !features) continue;

      // 为每个匹配的 feature 创建一个结果项
      for (const feature of features) {
        let score = 0;

        // 规则匹配分
        const rules = this.index.rules.get(pluginId) || [];
        for (const r of rules) {
          if (r.featureCode === feature.code) {
            switch (r.type) {
              case 'prefix':
                if (text.toLowerCase().startsWith(r.value)) score += 30;
                break;
              case 'keyword':
                if (text.toLowerCase() === r.value) score += 15;
                break;
              case 'regex':
                if (r.regex.test(text)) score += 25;
                break;
            }
            // 长度约束轻微加权
            if (text.length >= (r.minLength || 0) && text.length <= (r.maxLength || Infinity)) score += 5;
          }
        }

        // 使用偏好加权（对数放大）- 基于插件级别的使用频次
        const used = usageScores[pluginId] || 0;
        if (used > 0) score += Math.min(30, Math.floor(Math.log2(used + 1) * 10));

        // 附加 feature UI 配置（mode/copyField/copyEnabled/placeholder）
        const fcfg = (meta.featuresMap && meta.featuresMap[feature.code]) || {
          mode: meta.defaultMode || 'list',
          copyField: meta.defaultCopyField || 'description',
          // 默认关闭复制（除非显式开启）
          copyEnabled: meta.defaultCopyEnabled === true,
          placeholder: ''
        };

        results.push({ 
          meta, 
          feature, 
          score, 
          matchedBy: feature.matchedBy,
          featureMode: fcfg.mode,
          featureCopyField: fcfg.copyField,
          featureCopyEnabled: fcfg.copyEnabled !== false,
          featurePlaceholder: fcfg.placeholder || ''
        });
      }
    }

    // 排序
    results.sort((a, b) => b.score - a.score);
    return results.map(r => ({
      id: r.meta.id,
      name: r.meta.name,
      description: r.meta.description || '',
      icon: r.meta.icon || '🔧',
      iconUrl: r.meta.iconUrl || null,
      score: r.score,
      matchedBy: r.matchedBy,
      hasUi: !!r.meta.ui,
      // 新增 feature 信息
      featureCode: r.feature.code,
      featureExplain: r.feature.explain,
      // 透传 feature UI 配置
      mode: r.featureMode,
      copyField: r.featureCopyField,
      copyEnabled: r.featureCopyEnabled,
      placeholder: r.featurePlaceholder
    }));
  }
}

module.exports = { Matcher };


