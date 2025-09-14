'use strict';

(function(){
  const el = (id) => document.getElementById(id);
  const tbody = () => el('tableBody');
  const detailBox = () => el('detailBox');
  const statusEl = () => el('status');
  const toastEl = () => el('toast');

  let timer = null;
  let lastItems = [];
  let selectedId = null;

  function fmtTime(ts){ const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; }

  async function updateStatus(){
    try{
      const s = await window.MT.invoke('capture.status');
      const d = s || {};
      const pill = document.getElementById('pillRunning');
      const pillCert = document.getElementById('pillCert');
      if (d.running) {
        pill.textContent = `运行中 ${d.host||'127.0.0.1'}:${d.port}`;
        pill.classList.remove('bad');
        pill.classList.add('ok');
      } else {
        pill.textContent = '未运行';
        pill.classList.remove('ok');
        pill.classList.add('bad');
      }
      if (pillCert) {
        if (d.certInstalled) { pillCert.textContent = '证书已安装'; pillCert.classList.add('ok'); pillCert.classList.remove('bad'); }
        else { pillCert.textContent = '证书未安装'; pillCert.classList.add('bad'); pillCert.classList.remove('ok'); }
      }
    }catch(e){ statusEl().textContent = '状态获取失败'; }
  }

  function queryFilters(){
    return {
      method: el('fMethod').value || '',
      host: el('fHost').value.trim(),
      path: el('fPath').value.trim(),
      status: el('fStatus').value.trim()
    };
  }

  async function refreshList(){
    try{
      const q = queryFilters();
      const res = await window.MT.invoke('capture.list', { offset:0, limit:200, query:q });
      const items = (res && res.items) || (res && res.data && res.data.items) || res || [];
      renderList(Array.isArray(items) ? items : []);
    }catch(e){ /* ignore */ }
  }

  function renderList(items){
    lastItems = items;
    const rows = items.map(it => {
      const cls = (Number(it.status)>=400)?' style="color:#ff7b72"':'';
      return `<tr data-id="${it.id}"><td>${fmtTime(it.tsStart)}</td><td>${it.method}</td><td>${it.host}</td><td title="${it.path}">${it.path}</td><td${cls}>${it.status||''}</td><td>${it.duration||''}</td></tr>`;
    }).join('');
    tbody().innerHTML = rows;
  }

  async function loadDetail(id){
    try{
      const data = await window.MT.invoke('capture.detail', { id });
      const r = data || {};
      const reqHeaders = JSON.stringify(r.reqHeaders||{}, null, 2);
      const respHeaders = JSON.stringify(r.respHeaders||{}, null, 2);
      const reqBody = r.reqBody || '';
      const respBody = r.respBody || '';
      const txt = [
        `# ${r.method} ${r.scheme}://${r.host}${r.path}  [${r.status}] (${r.duration}ms)`,
        '',
        '## Request Headers', reqHeaders,
        '',
        '## Request Body', (String(reqBody).slice(0, 200000)),
        '',
        '## Response Headers', respHeaders,
        '',
        '## Response Body', (String(respBody).slice(0, 200000))
      ].join('\n');
      detailBox().textContent = txt;
    }catch(e){ detailBox().textContent = '加载详情失败: '+(e && e.message); }
  }

  async function start(){
    const port = Number(el('port').value||8888);
    const targets = el('targets').value.trim();
    const filters = {
      pathPrefixes: (el('capPrefix') && el('capPrefix').value.trim()) || ''
    };
    const delayRules = (el('capDelays') && el('capDelays').value.trim()) || null;
    const upstreamSel = (el('capUpstream') && el('capUpstream').value) || 'system';
    const upstream = upstreamSel === 'none' ? 'none' : 'system';
    await window.MT.invoke('capture.start', { host: '127.0.0.1', port, recordBody:true, maxEntries:2000, targets: targets||null, filters, delayRules, upstream });
    await updateStatus();
    await refreshList();
    toast('代理已启动');
  }

  async function stop(){
    await window.MT.invoke('capture.stop');
    await updateStatus();
    await refreshList();
    detailBox().textContent = '请选择一条请求...';
    toast('代理已停止');
  }

  async function clearAll(){
    await window.MT.invoke('capture.clear');
    await refreshList();
    detailBox().textContent = '已清空。';
  }

  async function exportHar(){
    try{
      const s = await window.MT.invoke('capture.exportHar', {});
      const har = typeof s === 'string' ? s : (s && s.data) || '';
      const blob = new Blob([har], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `capture-${Date.now()}.har`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }catch(e){ alert('导出失败: '+(e && e.message)); }
  }

  async function installCert(){
    try{
      const ret = await window.MT.invoke('capture.installCert');
      const ok = (ret && ret.ok) || (ret && ret.data && ret.data.ok);
      if (ok) alert('证书安装完成。若浏览器仍提示不受信，请在“受信任的根证书颁发机构(当前用户)”检查。');
      else alert('证书安装失败，请手动安装。');
    }catch(e){ alert('证书安装失败: '+(e && e.message)); }
  }

  function bind(){
    el('btnStart').addEventListener('click', start);
    el('btnStop').addEventListener('click', stop);
    el('btnRefresh').addEventListener('click', updateStatus);
    el('btnApplyTargets').addEventListener('click', async ()=>{
      try {
        await saveSettings();
        await stop();
        await start();
        await refreshList();
        toast('已应用抓包范围');
      } catch { toast('应用失败'); }
    });
    el('btnEnableSys').addEventListener('click', async ()=>{
      const port = Number(el('port').value||8888);
      const ret = await window.MT.invoke('capture.enableSystemProxy', { host:'127.0.0.1', port });
      const ok = ret && (ret.ok || (ret.data && ret.data.ok));
      const state = (ret && ret.data && ret.data.state) || {};
      if (ok) { toast(`已启用系统代理: 127.0.0.1:${port} (enable=${state.enable})`); await refreshList(); }
      else toast('启用系统代理失败');
    });
    el('btnDisableSys').addEventListener('click', async ()=>{
      const ret = await window.MT.invoke('capture.disableSystemProxy');
      const ok = ret && (ret.ok || (ret.data && ret.data.ok));
      if (ok) { toast('已禁用系统代理'); await refreshList(); }
      else toast('禁用系统代理失败');
    });
    el('btnCopyCurl').addEventListener('click', async ()=>{
      try {
        if (!selectedId) { toast('请先选择一条请求'); return; }
        const s = await window.MT.invoke('capture.toCurl', { id: selectedId });
        await window.MT.clipboard.writeText(s||'');
        toast('已复制 cURL');
      } catch (e) { toast('复制失败'); }
    });
    el('btnCopyCurlPS').addEventListener('click', async ()=>{
      try {
        if (!selectedId) { toast('请先选择一条请求'); return; }
        const s = await window.MT.invoke('capture.toCurlPS', { id: selectedId });
        await window.MT.clipboard.writeText(s||'');
        toast('已复制 cURL(PS)');
      } catch (e) { toast('复制失败'); }
    });
    el('btnReplay').addEventListener('click', async ()=>{
      try {
        if (!selectedId) { toast('请先选择一条请求'); return; }
        const r = await window.MT.invoke('capture.replay', { id: selectedId, followRedirects: true });
        const data = (r && r.data) ? r.data : r; // invoke 会在 ok=true 时直接返回 data
        if (data && (data.status !== undefined)) {
          const h = JSON.stringify(data.headers||{}, null, 2);
          const lines = [
            `# 重放结果 ${data.status} (${data.duration}ms)`,
            `URL: ${data.url}`,
            '',
            '## Response Headers', h,
            '',
            '## Response Body', String(data.bodyPreview||'')
          ];
          detailBox().textContent = lines.join('\n');
          toast('重放完成');
        } else {
          toast('重放失败');
        }
      } catch (e) { toast('重放失败'); }
    });
    el('btnClear').addEventListener('click', clearAll);
    el('btnExport').addEventListener('click', exportHar);
    el('btnInstallCert').addEventListener('click', installCert);

    el('fMethod').addEventListener('change', refreshList);
    el('fHost').addEventListener('input', debounce(refreshList, 200));
    el('fPath').addEventListener('input', debounce(refreshList, 200));
    el('fStatus').addEventListener('input', debounce(refreshList, 200));

    tbody().addEventListener('click', (e) => {
      let tr = e.target.closest('tr');
      if (!tr) return;
      const id = Number(tr.getAttribute('data-id'));
      selectedId = id;
      loadDetail(id);
    });
  }

  function debounce(fn, wait){ let t=null; return function(){ clearTimeout(t); t=setTimeout(()=>fn.apply(this, arguments), wait); } }

  function toast(msg){
    try {
      const t = toastEl();
      if (!t) return;
      t.textContent = String(msg||'');
      t.classList.add('show');
      setTimeout(()=>{ t.classList.remove('show'); }, 2200);
    } catch {}
  }

  // ====== 设置持久化（仅在“应用”时保存；启动时读取并应用） ======
  async function saveSettings(){
    try {
      if (!window.MT || !window.MT.db) return;
      const targets = el('targets').value.trim();
      const pathPrefixes = (el('capPrefix') && el('capPrefix').value.trim()) || '';
      const settings = { targets, pathPrefixes };
      await window.MT.db.put('http-sniffer.settings', settings);
    } catch (e) { try { console.warn('[HTTP-SNIFFER] saveSettings failed', e && e.message); } catch {} }
  }

  async function loadSettingsAndFillInputs(){
    try {
      if (!window.MT || !window.MT.db) return false;
      const rec = await window.MT.db.get('http-sniffer.settings');
      const val = rec && (rec.value || rec);
      if (val && (typeof val === 'object')) {
        if (val.targets != null) el('targets').value = String(val.targets || '');
        if (val.pathPrefixes != null && el('capPrefix')) el('capPrefix').value = String(val.pathPrefixes || '');
        return true;
      }
      return false;
    } catch (e) { try { console.warn('[HTTP-SNIFFER] loadSettings failed', e && e.message); } catch {} return false; }
  }

  async function loop(){
    await updateStatus();
    await refreshList();
    timer = setTimeout(loop, 1500);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    await updateStatus();
    // 自动启动并启用系统代理
    try {
      // 先加载已保存设置并填充输入框
      await loadSettingsAndFillInputs();
      const port = Number(el('port').value||8888);
      const targets = el('targets').value.trim();
      const filters = {
        pathPrefixes: (el('capPrefix') && el('capPrefix').value.trim()) || ''
      };
      const delayRules = (el('capDelays') && el('capDelays').value.trim()) || null;
      const upstreamSel = (el('capUpstream') && el('capUpstream').value) || 'system';
      const upstream = upstreamSel === 'none' ? 'none' : 'system';
      await window.MT.invoke('capture.start', { host:'127.0.0.1', port, recordBody:true, maxEntries:2000, targets: targets||null, filters, delayRules, upstream });
      await window.MT.invoke('capture.enableSystemProxy', { host:'127.0.0.1', port });
      toast('已自动启动代理并启用系统代理');
      await updateStatus();
      await refreshList();
    } catch (e) { toast('自动启动失败，请手动启动'); }
    loop();
  });

  window.addEventListener('beforeunload', async ()=>{
    try {
      if (timer) clearTimeout(timer);
      // 自动清理：禁用系统代理 + 停止代理
      await window.MT.invoke('capture.disableSystemProxy');
      await window.MT.invoke('capture.stop');
    } catch {}
  });
})();
