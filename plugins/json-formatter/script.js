(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('input');
  const viewer = $('viewer');
  const btnFormat = $('btnFormat');
  const btnMinify = $('btnMinify');
  const btnCopy = $('btnCopy');
  const errorBox = $('error');
  const queryInput = $('query');
  const btnRunQuery = $('btnRunQuery');
  const searchInput = $('search');
  const btnPrev = $('btnPrev');
  const btnNext = $('btnNext');
  const expandLevelSelect = $('expandLevel');
  const btnCollapseAll = $('btnCollapseAll');
  const btnExpandAll = $('btnExpandAll');

  function showError(msg) {
    errorBox.textContent = msg || '';
    errorBox.style.display = msg ? 'block' : 'none';
  }

  function formatJSON() {
    try {
      showError('');
      const obj = JSON.parse(input.value);
      renderTree(obj);
    } catch (e) {
      // 尝试宽松修复再解析
      try {
        const repaired = repairToStrictJSON(input.value);
        const obj2 = JSON.parse(repaired);
        renderTree(obj2);
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
      renderTree(obj);
    } catch (e) {
      try {
        const repaired = repairToStrictJSON(input.value);
        const obj2 = JSON.parse(repaired);
        renderTree(obj2);
        showError('');
      } catch (e2) {
        showError(e2.message || e.message);
      }
    }
  }

  function parseOrRepair(text) {
    try { return JSON.parse(text); } catch (e) {
      const repaired = repairToStrictJSON(text);
      return JSON.parse(repaired);
    }
  }

  function runQuery() {
    try {
      showError('');
      const source = String(queryInput.value || '').trim();
      const obj = parseOrRepair(input.value);
      if (!source) return renderTree(obj);
      // 以 this 为根执行表达式
      const fn = new Function(`return (function(){ with(this){ return (${source}); } })`);
      const res = fn().call(obj);
      renderTree(res);
    } catch (e) {
      showError(e && e.message || '查询执行失败');
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
    try { await window.MT.invoke('write-clipboard', getCurrentJsonText()); } catch {}
  });
  if (btnRunQuery) btnRunQuery.addEventListener('click', runQuery);
  // 动态查询：输入即运行，300ms 防抖
  let queryTimer = null;
  queryInput.addEventListener('input', () => {
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(runQuery, 300);
  });

  if (window.MT && window.MT.onInput) {
    window.MT.onInput((data) => {
      input.value = data.content || '';
      // 自动尝试格式化
      try {
        const obj = parseOrRepair(input.value);
        renderTree(obj);
        showError('');
      } catch (e2) {
        viewer.innerHTML = '';
        showError(e2.message || '解析失败');
      }
    });
  }

  // 简易可展开/折叠渲染
  function renderTree(data){
    viewer.innerHTML = '';
    const container = document.createElement('div');
    container.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    container.style.fontSize = '13px';
    container.style.lineHeight = '1.5';

    const expandLevel = parseInt(expandLevelSelect && expandLevelSelect.value || '1', 10);
    const matchNodes = [];

    function span(cls, text){ const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }

    function createNode(key, value, depth){
      const row = document.createElement('div');
      row.style.paddingLeft = (depth * 14) + 'px';
      const isObj = value && typeof value === 'object';
      const isArray = Array.isArray(value);

      const toggle = document.createElement('span');
      toggle.textContent = isObj ? '▸' : '•';
      toggle.style.cursor = isObj ? 'pointer' : 'default';
      toggle.style.marginRight = '6px';

      const keyEl = document.createElement('span');
      keyEl.className = 'json-key';
      keyEl.textContent = key !== null ? (JSON.stringify(String(key)) + ': ') : '';

      const valEl = document.createElement('span');
      if (isObj){
        valEl.textContent = isArray ? `[${value.length}]` : '{…}';
      } else {
        if (value === null) valEl.className = 'value-null';
        else if (typeof value === 'string') valEl.className = 'value-string';
        else if (typeof value === 'number') valEl.className = 'value-number';
        else if (typeof value === 'boolean') valEl.className = 'value-boolean';
        valEl.textContent = JSON.stringify(value);
      }

      row.appendChild(toggle);
      row.appendChild(keyEl);
      row.appendChild(valEl);

      let expanded = false;
      let childrenEl = null;
      if (isObj){
        childrenEl = document.createElement('div');
        childrenEl.style.display = 'none';
        const entries = isArray ? value : Object.entries(value);
        if (isArray){
          value.forEach((v, i)=> childrenEl.appendChild(createNode(i, v, depth+1)));
        } else {
          Object.keys(value).forEach(k => childrenEl.appendChild(createNode(k, value[k], depth+1)));
        }
        row.addEventListener('click', ()=>{
          expanded = !expanded;
          toggle.textContent = expanded ? '▾' : '▸';
          childrenEl.style.display = expanded ? 'block' : 'none';
        });
      }

      const wrapper = document.createElement('div');
      wrapper.appendChild(row);
      if (childrenEl) wrapper.appendChild(childrenEl);

      // 初始化展开级别
      if (isObj && depth < expandLevel){
        expanded = true;
        toggle.textContent = '▾';
        childrenEl.style.display = 'block';
      }
      return wrapper;
    }

    container.appendChild(createNode(null, data, 0));
    viewer.appendChild(container);

    // 搜索高亮
    function clearMatches(){ matchNodes.forEach(n=> n.classList.remove('match','active-match')); matchNodes.length = 0; currentMatch = -1; }
    function applySearch(){
      clearMatches();
      const q = String(searchInput && searchInput.value || '').trim();
      if (!q) return;
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      viewer.querySelectorAll('span').forEach(spanEl => {
        if (re.test(spanEl.textContent || '')){
          spanEl.classList.add('match');
          matchNodes.push(spanEl);
        }
      });
      if (matchNodes.length){ currentMatch = 0; matchNodes[0].classList.add('active-match'); matchNodes[0].scrollIntoView({ block:'center' }); }
    }
    let currentMatch = -1;
    function goto(delta){ if (!matchNodes.length) return; matchNodes[currentMatch].classList.remove('active-match'); currentMatch = (currentMatch + delta + matchNodes.length) % matchNodes.length; matchNodes[currentMatch].classList.add('active-match'); matchNodes[currentMatch].scrollIntoView({ block:'center' }); }

    // 事件绑定（局部）
    if (searchInput){ searchInput.oninput = () => applySearch(); }
    if (btnNext){ btnNext.onclick = () => goto(1); }
    if (btnPrev){ btnPrev.onclick = () => goto(-1); }
    if (btnCollapseAll){ btnCollapseAll.onclick = () => viewer.querySelectorAll('div').forEach(d=>{ if (d.firstChild && d.firstChild.firstChild && d.firstChild.firstChild.textContent==='▾'){ d.firstChild.firstChild.textContent='▸'; if (d.children[1]) d.children[1].style.display='none'; }}); }
    if (btnExpandAll){ btnExpandAll.onclick = () => viewer.querySelectorAll('div').forEach(d=>{ if (d.firstChild && d.firstChild.firstChild && d.firstChild.firstChild.textContent==='▸'){ d.firstChild.firstChild.textContent='▾'; if (d.children[1]) d.children[1].style.display='block'; }}); }
    if (expandLevelSelect){ expandLevelSelect.onchange = () => { try { const obj = parseOrRepair(input.value); renderTree(obj); } catch {} }; }
  }

  function getCurrentJsonText(){
    try { return JSON.stringify(parseOrRepair(input.value), null, 2); } catch { return input.value || ''; }
  }
})();


