// 输入分析器
// 负责对原始输入进行快速类型判断（text/url/file/image/json）
// 仅提供必要的启发式判断，深入的规则匹配交由 Matcher 完成
const path = require('path');
const { isValidJson } = require('../utils/jsonUtils');

class InputAnalyzer {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
  }

  // 返回 { type, content, length, lines }
  analyze(content) {
    if (!content || typeof content !== 'string') {
      return { type: 'empty', content: '' };
    }

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return { type: 'empty', content: '' };
    }

    let basicType = 'text';

    // 优先判断网络内容（URL、邮箱）
    if (this.isEmailContent(trimmed)) {
      basicType = 'email';
    } else if (this.isUrlContent(trimmed)) {
      basicType = 'url';
    } else if (this.isJsonContent(trimmed)) {
      basicType = 'json';
    } else if (this.isFilePath(trimmed)) {
      basicType = this.isImageFile(trimmed) ? 'image' : 'file';
    }

    const result = {
      type: basicType,
      content: trimmed,
      length: trimmed.length,
      lines: trimmed.split('\n').length
    };

    if (!this.isQuiet) {
      console.log('基础内容分析:', {
        content: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
        type: result.type
      });
    }

    return result;
  }

  // 轻量文件路径判断
  isFilePath(content) {
    const patterns = [
      /^[a-zA-Z]:[\\\/]/,    // Windows 路径 C:\
      /^\/[^\/]/,             // Unix 绝对路径 /home
      /^\.{1,2}[\\\/]/,     // 相对路径 ./ ../
      /^\\\\[^\\]/,        // UNC 路径 \\server
      /[\\\/].*\.[a-zA-Z0-9]{1,10}$/ // 包含路径分隔符且有扩展名
    ];
    return patterns.some(r => r.test(content));
  }

  // 轻量图片扩展名判断
  isImageFile(content) {
    const imageExts = /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff|ico|psd|raw|cr2|nef|orf|sr2)$/i;
    return imageExts.test(content);
  }

  // 使用统一的严格模式 JSON 判断逻辑
  isJsonContent(content) {
    return isValidJson(content);
  }

  // 常见 URL/域名/IP/localhost 识别
  isUrlContent(content) {
    const trimmed = (content || '').trim();
    if (!trimmed) return false;
    // JSON 外形优先，不应被误判为 URL
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      return false;
    }
    // 如果包含 @ 并且是邮箱格式，则不是 URL
    if (this.isEmailContent(trimmed)) return false;
    const urlPatterns = [
      /^https?:\/\//i,
      /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/,
      /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/,
      /^(localhost|127\.0\.0\.1)/,
      /\.(com|org|net|cn|io|co|gov|edu)\b/i
    ];
    return urlPatterns.some(p => p.test(trimmed));
  }

  // 邮箱检测（简单 RFC 兼容）
  isEmailContent(content) {
    const trimmed = (content || '').trim();
    if (!trimmed || !trimmed.includes('@')) return false;
    const emailRegex = /^\w+([-.+]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*$/;
    return emailRegex.test(trimmed);
  }
}

module.exports = { InputAnalyzer };


