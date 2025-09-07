// 编解码工具 - 新格式

// 安全获取clipboard
function getClipboard() {
  try {
    const electron = require('electron');
    if (electron && electron.clipboard) {
      return electron.clipboard;
    }
  } catch (e) {
    // electron 不可用
  }
  
  // 测试环境或非electron环境，使用模拟clipboard
  return {
    writeText: (text) => {
      // 在测试环境中静默处理
      if (process.env.NODE_ENV !== 'test') {
        console.log('已复制到剪贴板:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
      }
    }
  };
}

// Base64 编码功能
module.exports['base64.encode'] = {
  handleEnter: async (action, callbackSetList) => {
    const content = String(action.payload || '').trim();
    
    if (!content) {
      callbackSetList([{
        title: '请输入要编码的内容',
        description: 'Base64 编码',
        data: null
      }]);
      return;
    }
    
    try {
      const result = Buffer.from(content, 'utf8').toString('base64');
      try { getClipboard().writeText(result); } catch {}
      
      callbackSetList([{
        title: 'Base64 编码完成',
        description: result.substring(0, 100) + (result.length > 100 ? '...' : ''),
        data: result
      }]);
    } catch (error) {
      callbackSetList([{
        title: 'Base64 编码失败',
        description: error.message,
        data: null
      }]);
    }
  }
};

// Base64 解码功能
module.exports['base64.decode'] = {
  handleEnter: async (action, callbackSetList) => {
    const content = String(action.payload || '').trim();
    
    if (!content) {
      callbackSetList([{
        title: '请输入要解码的 Base64 内容',
        description: 'Base64 解码',
        data: null
      }]);
      return;
    }
    
    try {
      const normalized = content.replace(/\s+/g, '');
      const result = Buffer.from(normalized, 'base64').toString('utf8');
      try { getClipboard().writeText(result); } catch {}
      
      callbackSetList([{
        title: 'Base64 解码完成',
        description: result.substring(0, 100) + (result.length > 100 ? '...' : ''),
        data: result
      }]);
    } catch (error) {
      callbackSetList([{
        title: 'Base64 解码失败',
        description: '无效的 Base64 格式',
        data: null
      }]);
    }
  }
};

// URL 编码功能
module.exports['url.encode'] = {
  handleEnter: async (action, callbackSetList) => {
    const content = String(action.payload || '').trim();
    
    if (!content) {
      callbackSetList([{
        title: '请输入要编码的内容',
        description: 'URL 编码',
        data: null
      }]);
      return;
    }
    
    try {
      const result = encodeURIComponent(content);
      try { getClipboard().writeText(result); } catch {}
      
      callbackSetList([{
        title: 'URL 编码完成',
        description: result.substring(0, 100) + (result.length > 100 ? '...' : ''),
        data: result
      }]);
    } catch (error) {
      callbackSetList([{
        title: 'URL 编码失败',
        description: error.message,
        data: null
      }]);
    }
  }
};

// URL 解码功能
module.exports['url.decode'] = {
  handleEnter: async (action, callbackSetList) => {
    const content = String(action.payload || '').trim();
    
    if (!content) {
      callbackSetList([{
        title: '请输入要解码的 URL 编码内容',
        description: 'URL 解码',
        data: null
      }]);
      return;
    }
    
    try {
      let result;
      try {
        result = decodeURIComponent(content);
      } catch {
        result = decodeURIComponent(content.replace(/%([^0-9A-Fa-f]|$)/g, '%25$1'));
      }
      try { getClipboard().writeText(result); } catch {}
      
      callbackSetList([{
        title: 'URL 解码完成',
        description: result.substring(0, 100) + (result.length > 100 ? '...' : ''),
        data: result
      }]);
    } catch (error) {
      callbackSetList([{
        title: 'URL 解码失败',
        description: '无效的 URL 编码格式',
        data: null
      }]);
    }
  }
};

// HTML 编码功能
module.exports['html.encode'] = {
  handleEnter: async (action, callbackSetList) => {
    const content = String(action.payload || '').trim();
    
    if (!content) {
      callbackSetList([{
        title: '请输入要编码的内容',
        description: 'HTML 编码',
        data: null
      }]);
      return;
    }
    
    try {
      const result = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      
      try { getClipboard().writeText(result); } catch {}
      
      callbackSetList([{
        title: 'HTML 编码完成',
        description: result.substring(0, 100) + (result.length > 100 ? '...' : ''),
        data: result
      }]);
    } catch (error) {
      callbackSetList([{
        title: 'HTML 编码失败',
        description: error.message,
        data: null
      }]);
    }
  }
};

// HTML 解码功能
module.exports['html.decode'] = {
  handleEnter: async (action, callbackSetList) => {
    const content = String(action.payload || '').trim();
    
    if (!content) {
      callbackSetList([{
        title: '请输入要解码的 HTML 实体内容',
        description: 'HTML 解码',
        data: null
      }]);
      return;
    }
    
    try {
      const result = content
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
      
      try { getClipboard().writeText(result); } catch {}
      
      callbackSetList([{
        title: 'HTML 解码完成',
        description: result.substring(0, 100) + (result.length > 100 ? '...' : ''),
        data: result
      }]);
    } catch (error) {
      callbackSetList([{
        title: 'HTML 解码失败',
        description: error.message,
        data: null
      }]);
    }
  }
};
