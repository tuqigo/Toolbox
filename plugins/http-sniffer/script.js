'use strict';

(function(){
  const el = (id) => document.getElementById(id);
  const tbody = () => el('tableBody');
  const detailBox = () => el('detailBox');
  const statusEl = () => el('status');

  let timer = null;
  let lastItems = [];
  let selectedId = null;

  function fmtTime(ts){ const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; }

  async function updateStatus(){
    try{
      const s = await window.MT.invoke('capture.status');
      const d = s || {};
      const pill = document.getElementById('pillRunning');
      if (d.running) {
        pill.textContent = `运行中 ${d.host||'127.0.0.1'}:${d.port}`;
        pill.classList.remove('bad');
        pill.classList.add('ok');
      } else {
        pill.textContent = '未运行';
        pill.classList.remove('ok');
        pill.classList.add('bad');
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
    // 强提示
    if (!confirm('HTTPS 抓包需要在系统中安装并信任自签根证书，请确保用于合法合规目的。是否继续启动代理？')) return;
    await window.MT.invoke('capture.start', { host: '127.0.0.1', port, recordBody:true, maxEntries:2000, targets: targets||null });
    await updateStatus();
  }

  async function stop(){
    await window.MT.invoke('capture.stop');
    await updateStatus();
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
    el('btnEnableSys').addEventListener('click', async ()=>{
      const port = Number(el('port').value||8888);
      const ret = await window.MT.invoke('capture.enableSystemProxy', { host:'127.0.0.1', port });
      const ok = ret && (ret.ok || (ret.data && ret.data.ok));
      const state = (ret && ret.data && ret.data.state) || {};
      if (ok) alert(`已启用系统代理: 127.0.0.1:${port}\n当前状态: enable=${state.enable} server=${state.server}`); else alert('启用失败');
    });
    el('btnDisableSys').addEventListener('click', async ()=>{
      const ret = await window.MT.invoke('capture.disableSystemProxy');
      const ok = ret && (ret.ok || (ret.data && ret.data.ok));
      const state = (ret && ret.data && ret.data.state) || {};
      if (ok) alert(`已禁用系统代理\n当前状态: enable=${state.enable} server=${state.server||''}`); else alert('禁用失败');
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

  async function loop(){
    await updateStatus();
    await refreshList();
    timer = setTimeout(loop, 1500);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    await updateStatus();
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
