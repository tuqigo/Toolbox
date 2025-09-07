// 邮箱查询插件 - 新格式
const https = require('https');
const { clipboard } = (() => { try { return require('electron'); } catch { return { clipboard: { writeText: () => {} } }; } })();

// email.lookup 功能处理器
module.exports['email.lookup'] = {
  // 进入插件时调用
  handleEnter: async (action, callbackSetList) => {
    const email = String(action.payload || '').trim();

    if (!email || !email.includes('@')) {
      callbackSetList([{
        title: '请输入有效的邮箱地址',
        description: '格式: user@domain.com',
        data: null
      }]);
      return;
    }

    // 显示加载状态
    callbackSetList([{
      title: '正在查询...',
      description: `查询邮箱: ${email}`,
      data: null
    }]);

    try {
      // 调用API查询
      const result = await queryEmailAPI(email);

      if (result) {
        // 显示查询结果（不复制到剪贴板，点击后跳转到JSON插件）
        callbackSetList([{
          title: `邮箱: ${email} 查询结果`,
          description: result.substring(0, 200) + (result.length > 200 ? '...' : ''),
          data: result
          // 不设置 copiedToClipboard，因为我们不复制到剪贴板
        }]);
      } else {
        callbackSetList([{
          title: '查询失败',
          description: '无法获取该邮箱的信息',
          data: null
        }]);
      }
    } catch (error) {
      callbackSetList([{
        title: '查询出错',
        description: error.message || '网络请求失败',
        data: null
      }]);
    }
  },

  // 选择结果时调用
  handleSelect: async (action, itemData) => {
    if (itemData && itemData.data && action && typeof action.redirect === 'function') {
      action.redirect('json-formatter', itemData.data);
    }
  }
};

// idcard.lookup 功能处理器
module.exports['idcard.lookup'] = {
  handleEnter: async (action, callbackSetList) => {
    const idcard = String(action.payload || '').trim();
    if (idcard) {
      callbackSetList([{
        title: '你的身份证：',
        description: '格式: 123456789012345678',
        data: idcard
      }]);
      return;
    }
  },


  // 选择结果时调用
  handleSelect: async (action, itemData, callbackSetList) => {
    try {
      const raw = itemData && itemData.data;
      const idcard = typeof raw === 'string' ? raw : (raw && raw.idcard) || String(action.payload || '').trim();

      // 分支：动作处理（复制 / 打开 JSON）
      if (raw && typeof raw === 'object' && raw.action) {
        if (raw.action === 'copy') {
          try { clipboard.writeText(String(raw.value || '')); } catch {}
          callbackSetList([{
            title: `已复制: ${String(raw.value || '')}`,
            description: '',
            data: null
          }]);
          return;
        }
        if (raw.action === 'open_json') {
          const details = parseIdCard(idcard);
          const { redirect } = action;
          if (redirect) {
            redirect('json-formatter', JSON.stringify(details, null, 2));
          }
          return;
        }
      }

      // 默认：展示选项列表
      const details = parseIdCard(idcard);
      const header = {
        title: `已选择身份证: ${idcard}`,
        description: `校验: ${details.checksumValid ? '通过' : '不通过'}；生日: ${details.birth || '-'}；性别: ${details.gender || '-'}`,
        data: null
      };
      const items = [header];
      items.push({ title: '复制：身份证号', description: idcard, data: { action: 'copy', value: idcard, idcard } });
      if (details.birth) items.push({ title: '复制：生日', description: details.birth, data: { action: 'copy', value: details.birth, idcard } });
      if (details.age !== null && details.age !== undefined) items.push({ title: '复制：年龄', description: String(details.age), data: { action: 'copy', value: String(details.age), idcard } });
      if (details.gender) items.push({ title: '复制：性别', description: details.gender, data: { action: 'copy', value: details.gender, idcard } });
      items.push({ title: '在 JSON 插件中查看详情', description: '结构化信息', data: { action: 'open_json', idcard } });
      callbackSetList(items);
    } catch (e) {
      callbackSetList([{
        title: '选择失败',
        description: e && e.message || '未知错误',
        data: null
      }]);
    }
  }

};


// API查询函数
async function queryEmailAPI(email) {
  const hostname = 'tv.092201.xyz';
  const path = '/proxy/api/auth/check-username';
  const payload = JSON.stringify({ username: email });

  return new Promise((resolve, reject) => {
    try {
      const req = https.request({
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.from(d)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text);
        });
      });

      req.on('error', (e) => reject(e));
      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// 简单身份证信息解析（地区码仅保留原样；支持生日/年龄/性别/校验位）
function parseIdCard(id) {
  const result = { idcard: id, birth: '', age: null, gender: '', checksumValid: false };
  const s = String(id || '').trim();
  if (!/^\d{17}[\dXx]$/.test(s)) return result;
  const year = s.slice(6, 10);
  const month = s.slice(10, 12);
  const day = s.slice(12, 14);
  const birthStr = `${year}-${month}-${day}`;
  // 校验生日有效性
  const birth = new Date(`${year}-${month}-${day}T00:00:00`);
  if (!isNaN(birth.getTime())) {
    result.birth = birthStr;
    // 年龄
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    result.age = age;
  }
  // 性别: 倒数第二位奇数男 偶数女
  const seq = parseInt(s.charAt(16), 10);
  if (!isNaN(seq)) result.gender = (seq % 2 === 1) ? '男' : '女';
  // 校验位
  result.checksumValid = validateIdChecksum(s);
  return result;
}

function validateIdChecksum(id) {
  const coef = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const map = ['1','0','X','9','8','7','6','5','4','3','2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += parseInt(id[i], 10) * coef[i];
  const code = map[sum % 11];
  return code === id[17].toUpperCase();
}
