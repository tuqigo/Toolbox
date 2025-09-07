const { shell } = require('electron');

module.exports['open.url'] = {
  handleEnter: async (action, callbackSetList) => {
    const raw = String(action.payload || '').trim();
    if (!raw) {
      callbackSetList([{
        title: '请输入 URL 或域名',
        description: '例如: https://example.com 或 example.com',
        data: null
      }]);
      return;
    }
    
    let url = raw;
    if (!/^https?:\/\//i.test(url)) {
      if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(url)) {
        url = 'https://' + url;
      } else {
        callbackSetList([{
          title: '无效的 URL 格式',
          description: '请输入有效的 URL 或域名',
          data: null
        }]);
        return;
      }
    }
    
    try {
      await shell.openExternal(url);
      // // 直接打开即可，不再返回列表或内联结果
      // callbackSetList([]);
    } catch (error) {
      callbackSetList([{
        title: '打开链接失败',
        description: error.message,
        data: null
      }]);
    }
  }
};
