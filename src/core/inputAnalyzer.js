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
      imageExt: /\.(jpe?g|png|gif|webp|svg|bmp|tiff?|ico|psd|raw|cr2|nef|orf|sr2)$/i,
      // 视频扩展名
      videoExt: /\.(mp4|avi|mkv|mov|wmv|flv|webm|m4v|3gp|ogv)$/i,
      // 音频扩展名
      audioExt: /\.(mp3|wav|flac|aac|m4a|ogg|wma|opus)$/i
    };

    // 文件类型分类
    this.fileTypes = {
      document: ['doc', 'docx', 'pdf', 'txt', 'rtf', 'odt', 'pages', 'epub', 'mobi'],
      spreadsheet: ['xls', 'xlsx', 'csv', 'ods', 'numbers'],
      presentation: ['ppt', 'pptx', 'odp', 'key'],
      archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'cab', 'iso'],
      image: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'bmp', 'webp', 'tiff', 'tif', 'ico', 'psd', 'raw', 'cr2', 'nef', 'orf', 'sr2'],
      video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ogv'],
      audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'opus'],
      code: ['js', 'ts', 'py', 'java', 'cpp', 'c', 'h', 'html', 'css', 'php', 'rb', 'go', 'rs', 'swift', 'kt'],
      data: ['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf'],
      executable: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appx', 'bat', 'sh', 'ps1'],
      font: ['ttf', 'otf', 'woff', 'woff2', 'eot']
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
      // 进一步检测文件类型
      if (this.patterns.imageExt.test(content)) return 'image';
      if (this.patterns.videoExt.test(content)) return 'video';
      if (this.patterns.audioExt.test(content)) return 'audio';
      return 'file';
    }

    // 2. 默认为文本，具体的语义识别交给插件规则
    return 'text';
  }

  isFilePath(content) {
    return this.patterns.filePath.some(pattern => pattern.test(content));
  }

  // 获取文件扩展名
  getFileExtension(filePath) {
    const match = filePath.match(/\.([a-zA-Z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  // 获取文件类型分类
  getFileCategory(filePath) {
    const ext = this.getFileExtension(filePath);
    if (!ext) return 'unknown';

    for (const [category, extensions] of Object.entries(this.fileTypes)) {
      if (extensions.includes(ext)) {
        return category;
      }
    }
    return 'unknown';
  }

  // 检查是否为非文本文件（不参与内容分析）
  isNonTextFile(filePath) {
    const category = this.getFileCategory(filePath);
    // 这些类型的文件不参与内容分析，只显示胶囊
    const nonTextCategories = ['image', 'video', 'audio', 'archive', 'executable', 'font'];
    return nonTextCategories.includes(category);
  }
}

module.exports = { InputAnalyzer };


