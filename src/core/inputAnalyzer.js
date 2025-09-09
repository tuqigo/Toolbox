// 输入分析器 - 基础物理特征识别
// 职责：只识别文件路径、图片等物理特征，语义内容匹配交给插件规则处理

class InputAnalyzer {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    
    // 只保留物理特征识别的正则
    this.patterns = {
      // 文件路径特征
      filePath: [
        /^[a-zA-Z]:[\\\/]/,                    // Windows: C:\
        /^\/[^\/]/,                            // Unix: /home
        /^\.{1,2}[\\\/]/,                     // 相对路径: ./ ../
        /^\\\\[^\\]/,                         // UNC: \\server
        /[\\\/].*\.[a-zA-Z0-9]{1,10}$/        // 包含路径分隔符且有扩展名
      ],
      // 图片扩展名（物理特征）
      imageExt: /\.(jpe?g|png|gif|webp|svg|bmp|tiff?|ico|psd|raw|cr2|nef|orf|sr2)$/i
    };
  }

  analyze(content) {
    if (!content || typeof content !== 'string') {
      return { type: 'empty', content: '' };
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return { type: 'empty', content: '' };
    }

    // 只做基础的物理特征识别
    const type = this.detectBasicType(trimmed);
    
    const result = {
      type,
      content: trimmed,
      length: trimmed.length,
      lines: trimmed.split('\n').length
    };

    return result;
  }

  detectBasicType(content) {
    // 1. 文件路径检测（物理特征）
    if (this.isFilePath(content)) {
      return this.patterns.imageExt.test(content) ? 'image' : 'file';
    }

    // 2. 默认为文本，具体的语义识别交给插件规则
    return 'text';
  }

  isFilePath(content) {
    return this.patterns.filePath.some(pattern => pattern.test(content));
  }
}

module.exports = { InputAnalyzer };


