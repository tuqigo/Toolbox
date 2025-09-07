(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('input');
  const output = $('output');
  const btnFormat = $('btnFormat');
  const btnMinify = $('btnMinify');
  const btnCopy = $('btnCopy');
  const errorBox = $('error');

  function showError(msg) {
    errorBox.textContent = msg || '';
    errorBox.style.display = msg ? 'block' : 'none';
  }

  function formatJSON() {
    try {
      showError('');
      const obj = JSON.parse(input.value);
      output.value = JSON.stringify(obj, null, 2);
    } catch (e) {
      // 尝试宽松修复再解析
      try {
        const repaired = repairToStrictJSON(input.value);
        const obj2 = JSON.parse(repaired);
        output.value = JSON.stringify(obj2, null, 2);
        showError('');
      } catch (e2) {
        showError(e2.message || e.message);
      }
    }
  }

  function minifyJSON() {
    try {
      showError('');
      const obj = JSON.parse(input.value);
      output.value = JSON.stringify(obj);
    } catch (e) {
      try {
        const repaired = repairToStrictJSON(input.value);
        const obj2 = JSON.parse(repaired);
        output.value = JSON.stringify(obj2);
        showError('');
      } catch (e2) {
        showError(e2.message || e.message);
      }
    }
  }

  // 将常见 JS 对象/宽松 JSON 修复为严格 JSON
  function repairToStrictJSON(text) {
    let s = String(text || '');
    // URL 解码（若包含 %7B %7D 之类）
    try { if (/%(?:7B|7D|22|27|2C|3A)/i.test(s)) s = decodeURIComponent(s); } catch {}
    // 去除 BOM 和不可见字符
    s = s.replace(/^\uFEFF/, '').replace(/[\u0000-\u001F]/g, (m) => (m === '\n' || m === '\t' || m === '\r') ? m : '');
    // 去除多余换行/空格（不影响结构）
    // 单引号 key -> 双引号
    s = s.replace(/([\{,]\s*)'([^'\n\r]+?)'\s*:/g, '$1"$2":');
    // 未加引号的 key -> 加双引号（尽量避免误伤数值/布尔）
    s = s.replace(/([\{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    // 单引号字符串值 -> 双引号
    s = s.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"');
    // 结尾多余逗号 -> 去掉
    s = s.replace(/,\s*([}\]])/g, '$1');
    return s;
  }

  btnFormat.addEventListener('click', formatJSON);
  btnMinify.addEventListener('click', minifyJSON);
  btnCopy.addEventListener('click', async () => {
    try { await window.MT.invoke('write-clipboard', output.value || ''); } catch {}
  });

  if (window.MT && window.MT.onInput) {
    window.MT.onInput((data) => {
      input.value = data.content || '';
      // 自动尝试格式化
      try {
        const obj = JSON.parse(input.value);
        output.value = JSON.stringify(obj, null, 2);
        showError('');
      } catch (e) {
        try {
          const repaired = repairToStrictJSON(input.value);
          const obj2 = JSON.parse(repaired);
          output.value = JSON.stringify(obj2, null, 2);
          showError('');
        } catch (e2) {
          output.value = '';
          showError(e2.message || e.message);
        }
      }
    });
  }
})();


