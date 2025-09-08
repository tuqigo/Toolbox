// Coohom 工具 - 脚本（兼容项目网关 API）
const https = require('https');
const { clipboard } = (() => {
  try {
    return require('electron');
  } catch {
    return { clipboard: { writeText: () => { } } };
  }
})();

const SIT = 'auth-service-soa-sit.k8s-qunhe.qunhequnhe.com';
const PROD_TEST = 'auth-service-soa-prod-test-sg.k8s-aws-sg-prod.qunhequnhe.com';

// 使用网关 API 调用
function postJsonViaGateway({ hostname, path, body, port = 443 }) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify(body || {});
      const req = https.request({
        hostname,
        path,
        port,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.from(d)));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode === 200, status: res.statusCode, text: txt });
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.write(payload);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    try {
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(Buffer.from(d)));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: true, text: txt });
        });
      }).on('error', (e) => resolve({ ok: false, error: e.message }));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function toList(items) {
  return Array.isArray(items) ? items : [items];
}

module.exports = {
  // Base64 编解码
  'base64.id': {
    handleEnter: async (action, setList) => {
      const input = String(action.payload || '');
      const list = [
        { title: 'Base64 编码', description: Buffer.from(input, 'utf8').toString('base64') },
        { title: 'Base64 解码', description: (() => { try { return Buffer.from(input, 'base64').toString('utf8'); } catch { return '解码失败'; } })() }
      ];
      setList(list);
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      try {
        clipboard.writeText(itemData.description || '');
      } catch { }
    }
  },

  // URL 编解码
  'url.id': {
    handleEnter: async (action, setList) => {
      const input = String(action.payload || '');
      const list = [
        { title: 'URL 编码', description: encodeURIComponent(input) },
        { title: 'URL 解码', description: (() => { try { return decodeURIComponent(input); } catch { return '解码失败'; } })() }
      ];
      setList(list);
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      try {
        clipboard.writeText(itemData.description || '');
      } catch { }
    }
  },

  // JWT 解析
  'jwt.id': {
    handleEnter: async (action, setList) => {
      const token = String(action.payload || '').trim();
      const parts = token.split('.');
      if (parts.length < 2) {
        setList([{ title: '无效的 JWT 格式', description: '请确认输入的是三段式 JWT' }]);
        return;
      }
      try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        setList([
          { title: 'Header', description: JSON.stringify(header, null, 2) },
          { title: 'Payload', description: JSON.stringify(payload, null, 2) },
          { title: 'Signature', description: parts[2] || '' }
        ]);
      } catch (e) {
        setList([{ title: '解析失败', description: e.message }]);
      }
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      try {
        clipboard.writeText(itemData.description || '');
      } catch { }
      // 使用新的重定向方式
      if (action && typeof action.redirect === 'function') {
        action.redirect('json-formatter', itemData.description || '');
      }
    }
  },

  // IP 归属地
  'iplocation.id': {
    handleEnter: async (action, setList) => {
      const ip = String(action.payload || '').trim();
      const { ok, text, error } = await getJson(`https://ipinfo.io/${ip}/json`);
      const show = ok ? text : (error || '请求失败');
      try {
        clipboard.writeText(show);
      } catch { }
      setList([{ title: `IP: ${ip} 归属地`, description: show }]);
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      console.log('itemData', itemData);
      try {
        action.redirect('json-formatter', itemData.description);
      } catch (error) {
        console.error('handleSelect error:', error);
      }
    }
  },

  // OBS 转换
  'obs.id': {
    handleEnter: async (action, setList) => {
      const id = String(action.payload || '').trim();
      const { ok, text } = await getJson(`https://coops.qunhequnhe.com/api/dbv/common/obsconvert?id=${encodeURIComponent(id)}`);
      let d = '请求失败';
      try { d = JSON.parse(text || '{}').d || d; } catch { }
      try {
        clipboard.writeText(d);
      } catch { }
      setList([{ title: 'ObsId转换', description: String(d) }]);
    }
  },

  // encrypt - 后端计算
  'encrypt.id': {
    handleEnter: async (action, setList) => {
      const payload = String(action.payload || '');
      const items = [
        { title: '解密数据 (SIT)', hostname: SIT, path: '/api/i18n/auth/operation', expr: `T(com.qunhe.utils.apiencrypt.utils.EncryptUtils).decrypt(#strings.getBytes('UTF-8'),T(com.qunhe.utils.apiencrypt.data.Constants).H5_TOOLS_VIGENERE_KEY).getBody()`, data: payload },
        { title: '加密数据 (SIT)', hostname: SIT, path: '/api/i18n/auth/operation', expr: `new java.lang.String(T(com.qunhe.utils.apiencrypt.utils.EncryptUtils).encrypt(new com.qunhe.utils.apiencrypt.data.EncryptData(#strings),T(com.qunhe.utils.apiencrypt.data.Constants).H5_TOOLS_VIGENERE_KEY))`, data: payload }
      ];
      setList(items.map(i => ({ title: i.title, description: i.expr, hostname: i.hostname, path: i.path, data: i.data })));
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      const body = {
        calculate: itemData.description,
        paramList: [{ param: 'strings', paramType: 'java.lang.String', paramJson: String(itemData.data || '') }]
      };
      const { ok, text } = await postJsonViaGateway({ hostname: itemData.hostname, path: itemData.path, body });
      let json = null; try { json = JSON.parse(text || '{}'); } catch { }
      if (ok && json && json.c === '0') {
        try {
          clipboard.writeText(json.d || '');
        } catch { }
        callbackSetList([{ title: '计算成功', description: typeof json.d === 'string' ? json.d : JSON.stringify(json.d) }]);
      } else {
        callbackSetList([{ title: '计算失败', description: json ? JSON.stringify(json.m || json) : (text || 'error') }]);
      }
    }
  },

  // Email 查询
  'email.id': {
    handleEnter: async (action, setList) => {
      const email = String(action.payload || '');
      const items = [
        { title: 'Sit', hostname: SIT, path: '/api/i18n/auth/operation', expr: '@accountManager.getUserByEmail(#email)', param: 'email', data: email },
        { title: 'Prod-test', hostname: PROD_TEST, path: '/api/i18n/auth/operation', expr: '@accountManager.getUserByEmail(#email)', param: 'email', data: email }
      ];
      setList(items.map(i => ({ title: i.title, description: i.expr, hostname: i.hostname, path: i.path, param: i.param, data: i.data })));
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      const body = { calculate: itemData.description, paramList: [{ param: itemData.param, paramType: 'java.lang.String', paramJson: String(itemData.data || '') }] };
      const { ok, text } = await postJsonViaGateway({ hostname: itemData.hostname, path: itemData.path, body });
      let json = null; try { json = JSON.parse(text || '{}'); } catch { }
      if (ok && json && json.c === '0') {
        try {
          clipboard.writeText(String(json.d && json.d.kujialeId || ''));
        } catch { }
        callbackSetList([{ title: '计算成功', description: JSON.stringify(json.d) }]);
      } else {
        callbackSetList([{ title: '计算失败', description: json ? JSON.stringify(json.m || json) : (text || 'error') }]);
      }
    }
  },

  // 租户类型查询
  'tenant.id': {
    handleEnter: async (action, setList) => {
      const id = String(action.payload || '');
      const items = [
        { title: 'Sit', hostname: SIT, path: '/api/i18n/auth/operation', expr: '@tenantServiceImpl.getTenantTypeNoCache(#id)', param: 'id', data: id },
        { title: 'Prod-test', hostname: PROD_TEST, path: '/api/i18n/auth/operation', expr: '@tenantServiceImpl.getTenantTypeNoCache(#id)', param: 'id', data: id }
      ];
      setList(items.map(i => ({ title: i.title, description: i.expr, hostname: i.hostname, path: i.path, param: i.param, data: i.data })));
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      const body = { calculate: itemData.description, paramList: [{ param: itemData.param, paramType: 'java.lang.String', paramJson: String(itemData.data || '') }] };
      const { ok, text } = await postJsonViaGateway({ hostname: itemData.hostname, path: itemData.path, body });
      let json = null; try { json = JSON.parse(text || '{}'); } catch { }
      if (ok && json && json.c === '0') {
        callbackSetList([{ title: '计算成功', description: `${itemData.data} -> ${JSON.stringify(json.d)}` }]);
      } else {
        callbackSetList([{ title: '计算失败', description: json ? JSON.stringify(json.m || json) : (text || 'error') }]);
      }
    }
  },

  // KID 获取 AccessToken
  'getAccessTokenByKid.id': {
    handleEnter: async (action, setList) => {
      const id = String(action.payload || '');
      const items = [
        { title: 'Sit', hostname: SIT, path: '/api/i18n/auth/operation', expr: '@accountClient.getTokenByKId(#id)', param: 'id', data: id },
        { title: 'Prod-test', hostname: PROD_TEST, path: '/api/i18n/auth/operation', expr: '@accountClient.getTokenByKId(#id)', param: 'id', data: id }
      ];
      setList(items.map(i => ({ title: i.title, description: i.expr, hostname: i.hostname, path: i.path, param: i.param, data: i.data })));
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      const body = { calculate: itemData.description, paramList: [{ param: itemData.param, paramType: 'java.lang.String', paramJson: String(itemData.data || '') }] };
      const { ok, text } = await postJsonViaGateway({ hostname: itemData.hostname, path: itemData.path, body });
      let json = null; try { json = JSON.parse(text || '{}'); } catch { }
      if (ok && json && json.c === '0') {
        try {
          clipboard.writeText(String(json.d || ''));
        } catch { }
        callbackSetList([{ title: '计算成功', description: JSON.stringify(json.d) }]);
      } else {
        callbackSetList([{ title: '计算失败', description: json ? JSON.stringify(json.m || json) : (text || 'error') }]);
      }
    }
  },

  // KID 查询用户信息
  'coohom.id': {
    handleEnter: async (action, setList) => {
      const id = String(action.payload || '');
      const items = [
        { title: 'Sit', hostname: SIT, path: '/api/i18n/auth/operation', expr: '@accountManager.getUserInfo(#id)', param: 'id', data: id },
        { title: 'Prod-test', hostname: PROD_TEST, path: '/api/i18n/auth/operation', expr: '@accountManager.getUserInfo(#id)', param: 'id', data: id }
      ];
      setList(items.map(i => ({ title: i.title, description: i.expr, hostname: i.hostname, path: i.path, param: i.param, data: i.data })));
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      const body = { calculate: itemData.description, paramList: [{ param: itemData.param, paramType: 'java.lang.String', paramJson: String(itemData.data || '') }] };
      const { ok, text } = await postJsonViaGateway({ hostname: itemData.hostname, path: itemData.path, body });
      let json = null; try { json = JSON.parse(text || '{}'); } catch { }
      if (ok && json && json.c === '0') {
        try {
          clipboard.writeText(String(json.d && json.d.email || ''));
        } catch { }
        callbackSetList([{ title: '计算成功', description: JSON.stringify(json.d) }]);
      } else {
        callbackSetList([{ title: '计算失败', description: json ? JSON.stringify(json.m || json) : (text || 'error') }]);
      }
    }
  },

  // SPEL 计算（可输入表达式）
  'spel.id': {
    handleEnter: async (_action, setList) => {
      const items = [
        { title: 'Sit', hostname: SIT, path: '/api/i18n/auth/operation', placeholder: 'SPEL 表达式，如 1+1' },
        { title: 'Prod-test', hostname: PROD_TEST, path: '/api/i18n/auth/operation', placeholder: '谨慎调用' },
      ];
      setList(items.map(i => ({ title: i.title, description: i.placeholder, hostname: i.hostname, path: i.path })));
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      const expr = String(action.payload || '').trim();
      const body = { calculate: expr };
      const { ok, text } = await postJsonViaGateway({ hostname: itemData.hostname, path: itemData.path, body });
      let json = null; try { json = JSON.parse(text || '{}'); } catch { }
      if (ok && json && json.c === '0') {
        try {
          clipboard.writeText(String(json.d || ''));
        } catch { }
        callbackSetList([{ title: '计算成功', description: JSON.stringify(json.d) }]);
      } else {
        callbackSetList([{ title: '计算失败', description: json ? JSON.stringify(json.m || json) : (text || 'error') }]);
      }
    }
  }
};


