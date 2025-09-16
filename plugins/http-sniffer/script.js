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
        // 端口自动回填（若被占用切换了端口）
        try { const p = el('port'); const newPort = Number(d.port||0); if (newPort && Number(p.value) !== newPort) p.value = String(newPort); } catch {}
      } else {
        pill.textContent = '未运行';
        pill.classList.remove('ok');
        pill.classList.add('bad');
      }
      if (pillCert) {
        if (d.certInstalled) { pillCert.textContent = '证书已安装'; pillCert.classList.add('ok'); pillCert.classList.remove('bad'); }
        else { pillCert.textContent = '证书未安装'; pillCert.classList.add('bad'); pillCert.classList.remove('ok'); }
      }
      // 展示证书信息
      try {
        const info = el('certInfo');
        if (info) {
          const thumb = d.caThumbprint || '-';
          const path = d.caPath || '-';
          info.textContent = `证书指纹(SHA1): ${thumb}\nCA路径: ${path}`;
        }
      } catch {}
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
    const tb = tbody();
    if (!tb) return;
    // 首次或结构变化大：整表渲染
    const needFull = !Array.isArray(lastItems) || lastItems.length === 0;
    if (needFull) {
      const rows = items.map(it => {
        const cls = (Number(it.status)>=400)?' style="color:#ff7b72"':'';
        return `<tr data-id="${it.id}"><td>${fmtTime(it.tsStart)}</td><td>${it.method}</td><td>${it.host}</td><td title="${it.path}">${it.path}</td><td${cls}>${it.status||''}</td><td>${it.duration||''}</td></tr>`;
      }).join('');
      tb.innerHTML = rows;
      lastItems = items;
      return;
    }
    // 增量渲染：仅追加新到达项，并修剪多余行
    const oldFirst = lastItems[0] && lastItems[0].id;
    const idx = items.findIndex(x => x && x.id === oldFirst);
    // 若无法定位，或变化较大，回退整表渲染
    if (idx < 0 || Math.abs(items.length - lastItems.length) > 50) {
      const rows = items.map(it => {
        const cls = (Number(it.status)>=400)?' style="color:#ff7b72"':'';
        return `<tr data-id="${it.id}"><td>${fmtTime(it.tsStart)}</td><td>${it.method}</td><td>${it.host}</td><td title="${it.path}">${it.path}</td><td${cls}>${it.status||''}</td><td>${it.duration||''}</td></tr>`;
      }).join('');
      tb.innerHTML = rows;
      lastItems = items;
      return;
    }
    // idx 表示旧首项在新列表的位置，0..idx-1 是新增项（按最新在前）
    if (idx > 0) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < idx; i++) {
        const it = items[i];
        const tr = document.createElement('tr');
        tr.setAttribute('data-id', String(it.id));
        const cls = (Number(it.status)>=400)?' style="color:#ff7b72"':'';
        tr.innerHTML = `<td>${fmtTime(it.tsStart)}</td><td>${it.method}</td><td>${it.host}</td><td title="${it.path}">${it.path}</td><td${cls}>${it.status||''}</td><td>${it.duration||''}</td>`;
        frag.appendChild(tr);
      }
      tb.insertBefore(frag, tb.firstChild);
    }
    // 修剪多余行（保持与 items 同步）
    while (tb.children.length > items.length) {
      tb.removeChild(tb.lastChild);
    }
    // 若数量更少，执行整表渲染以保持顺序
    if (tb.children.length < items.length) {
      const rows = items.map(it => {
        const cls = (Number(it.status)>=400)?' style="color:#ff7b72"':'';
        return `<tr data-id="${it.id}"><td>${fmtTime(it.tsStart)}</td><td>${it.method}</td><td>${it.host}</td><td title="${it.path}">${it.path}</td><td${cls}>${it.status||''}</td><td>${it.duration||''}</td></tr>`;
      }).join('');
      tb.innerHTML = rows;
    }
    lastItems = items;
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
    let rewriteRules = null;
    try { const rr = (el('rewriteRules') && el('rewriteRules').value.trim()) || ''; if (rr) rewriteRules = JSON.parse(rr); } catch {}
    const maxBodyDirMB = Number(el('maxBodyDirMB') && el('maxBodyDirMB').value) || 512;
    // 链式代理：默认关闭；仅当勾选且填写地址时才传
    let upstreamParam = undefined;
    try {
      const enableUp = el('enableUpstream') ? !!el('enableUpstream').checked : false; // 默认关闭
      if (enableUp) {
        const addrRaw = (el('upstreamAddr') && el('upstreamAddr').value || '').trim();
        if (addrRaw) {
          // 允许直接填 host:port 或带协议的 URL (http/https/socks/socks5)
          const norm = (s) => (/^(https?|socks|socks5):\/\//i.test(s) ? s : ('http://' + s));
          let url = norm(addrRaw);
          if (/^https?:\/\/socks/i.test(url)) url = url.replace(/^https?:\/\//i, '');
          upstreamParam = { http: url, https: url };
        }
      }
    } catch {}
    const payload = { host: '127.0.0.1', port, recordBody:true, maxEntries:2000, targets: targets||null, filters, delayRules, rewriteRules, maxBodyDirMB };
    if (upstreamParam) payload.upstream = upstreamParam;
    const startRet = await window.MT.invoke('capture.start', payload);
    // 启用全局系统代理
    await window.MT.invoke('capture.enableSystemProxy', { host:'127.0.0.1', port: (startRet && startRet.port) || port });
    try { console.info('[HTTP-SNIFFER] start: proxy started and system proxy enabled on 127.0.0.1:%s', port); } catch {}
    await updateStatus();
    toast('已开启（已启动代理并启用系统代理）');
  }

  async function stop(){
    try { console.info('[HTTP-SNIFFER] stop: starting graceful shutdown...'); } catch {}
    // 先禁用系统代理，再停止代理服务（重要：顺序不能颠倒）
    try { 
      await window.MT.invoke('capture.disableSystemProxy'); 
      try { console.info('[HTTP-SNIFFER] stop: system proxy disabled'); } catch {}
    } catch (e) { 
      try { console.error('[HTTP-SNIFFER] stop: failed to disable system proxy:', e.message); } catch {}
    }
    try {
      await window.MT.invoke('capture.stop');
      try { console.info('[HTTP-SNIFFER] stop: proxy service stopped'); } catch {}
    } catch (e) {
      try { console.error('[HTTP-SNIFFER] stop: failed to stop proxy service:', e.message); } catch {}
    }
    await updateStatus();
    toast('已关闭（已停止代理并恢复系统代理）');
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
      if (ok) toast('证书安装完成。若浏览器仍提示不受信，请在“受信任的根证书颁发机构(当前用户)”检查。');
      else toast('证书安装失败，请手动安装。');
    }catch(e){ alert('证书安装失败: '+(e && e.message)); }
  }

  function bind(){
    el('btnStart').addEventListener('click', start);
    el('btnStop').addEventListener('click', stop);
    el('btnRefresh').addEventListener('click', updateStatus);
    // 系统代理开关已集成到开启/关闭按钮
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
        const viaSel = document.getElementById('replayRoute');
        const via = viaSel ? (viaSel.value || 'direct') : 'direct';
        const r = await window.MT.invoke('capture.replay', { id: selectedId, followRedirects: true, via });
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
    el('btnUninstallCert').addEventListener('click', async ()=>{
      try {
        const ret = await window.MT.invoke('capture.uninstallCert');
        if (ret && (ret.ok || (ret.data && ret.data.ok))) toast('证书已卸载'); else toast('卸载失败');
        await updateStatus();
      } catch { toast('卸载失败'); }
    });
    el('btnTestUpstream').addEventListener('click', async ()=>{
      try {
        const statusEl = el('upstreamStatus');
        const btnEl = el('btnTestUpstream');
        
        // 更新UI状态
        statusEl.textContent = '测试中...';
        statusEl.className = 'pill';
        btnEl.disabled = true;
        
        // 获取当前上游地址配置
        const enableUpstream = el('enableUpstream') ? !!el('enableUpstream').checked : false;
        const addrRaw = (el('upstreamAddr') && el('upstreamAddr').value || '').trim();
        if (!enableUpstream || !addrRaw) {
          statusEl.textContent = '已禁用';
          statusEl.className = 'pill bad';
          btnEl.disabled = false;
          return;
        }
        let upstreamAddr = addrRaw;
        // 如果是填入的 127.0.0.1:10808 这样的地址，根据端口推断协议
        if (upstreamAddr !== 'system' && !/^(https?|socks)/i.test(upstreamAddr)) {
          if (/:\d+$/.test(upstreamAddr)) {
            const port = parseInt(upstreamAddr.split(':').pop(), 10);
            if (port === 1080 || port === 10808 || port === 1086) {
              upstreamAddr = `socks5://${upstreamAddr}`;
            }
          }
        }
        
        // 获取用户选择的测试URL
        const selectedTestUrl = (el('testUrlSelect') && el('testUrlSelect').value) || 'https://www.google.com/generate_204';
        const urlLabel = el('testUrlSelect') ? (el('testUrlSelect').selectedOptions[0] ? el('testUrlSelect').selectedOptions[0].text : '默认端点') : '默认端点';
        
        // 显示正在测试的信息
        toast(`正在测试代理连通性...\n测试端点: ${urlLabel}\n测试地址: ${selectedTestUrl}`);
        
        // 使用用户选择的测试端点
        const ret = await window.MT.invoke('capture.testUpstream', {
          upstream: upstreamAddr,
          testUrl: selectedTestUrl
        });
        
        // 添加调试日志
        try { console.log('[HTTP-SNIFFER] test result:', JSON.stringify(ret, null, 2)); } catch {}
        
        if (ret && ret.ok) {
          statusEl.textContent = '连通正常';
          statusEl.className = 'pill ok';
          const duration = ret.details && ret.details.duration;
          const upstream = ret.details && ret.details.upstream;
          if (duration && upstream) {
            toast(`✓ 连通性测试成功！\n响应时间: ${duration}ms\n代理地址: ${upstream}\n测试端点: ${urlLabel}`);
          } else if (duration) {
            toast(`✓ 连通性测试成功！\n响应时间: ${duration}ms\n测试端点: ${urlLabel}`);
          } else {
            toast(`✓ 连通性测试成功！\n测试端点: ${urlLabel}`);
          }
        } else {
          statusEl.textContent = '连接失败';
          statusEl.className = 'pill bad';
          const error = (ret && ret.error) || '未知错误';
          const details = ret && ret.details;
          let detailMsg = '';
          if (details) {
            const upstream = details.upstream;
            if (upstream) detailMsg += `\n代理地址: ${upstream}`;
            if (details.tcp === false) detailMsg += '\n失败原因: TCP连接失败';
            else if (details.http === false) detailMsg += '\n失败原因: HTTPS请求失败';
          }
          toast(`✗ 连通性测试失败\n错误: ${error}${detailMsg}\n测试端点: ${urlLabel}`);
        }
      } catch (e) {
        const statusEl = el('upstreamStatus');
        statusEl.textContent = '测试异常';
        statusEl.className = 'pill bad';
        toast('测试失败: ' + (e && e.message || '网络错误'));
      } finally {
        const btnEl = el('btnTestUpstream');
        btnEl.disabled = false;
      }
    });

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

    // 设置面板
    const panel = el('settingsPanel');
    const btnSettings = el('btnSettings');
    const btnSettingsClose = el('btnSettingsClose');
    const btnSettingsApply = el('btnSettingsApply');
    if (btnSettings) btnSettings.addEventListener('click', (e)=>{ 
      e.stopPropagation(); 
      if (panel) panel.style.display = 'block'; 
    });
    if (btnSettingsClose) btnSettingsClose.addEventListener('click', ()=>{ if (panel) panel.style.display = 'none'; });
    if (btnSettingsApply) btnSettingsApply.addEventListener('click', async ()=>{
      try {
        try { console.info('[HTTP-SNIFFER] settings apply: saving and restarting...'); } catch {}
        await saveSettings();
        
        // 先确保完全停止并恢复代理
        try {
          await window.MT.invoke('capture.disableSystemProxy');
          await window.MT.invoke('capture.stop');
          try { console.info('[HTTP-SNIFFER] settings apply: stopped previous instance'); } catch {}
        } catch (e) {
          try { console.error('[HTTP-SNIFFER] settings apply: stop failed:', e.message); } catch {}
        }
        
        // 等待一小段时间确保清理完成
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 重新启动
        await start();
        if (panel) panel.style.display = 'none';
        toast('设置已应用并重启');
      } catch (e) { 
        try { console.error('[HTTP-SNIFFER] settings apply failed:', e.message); } catch {}
        toast('应用失败: ' + (e.message || '未知错误')); 
      }
    });
    // 联动：开关控制输入框禁用和状态显示
    try {
      const upChk = el('enableUpstream');
      const upAddr = el('upstreamAddr');
      const upStatus = el('upstreamStatus');
      const upTestBtn = el('btnTestUpstream');
      const testUrlSelect = el('testUrlSelect');
      
      if (upChk && upAddr) {
        const sync = () => { 
          const enabled = upChk.checked;
          upAddr.disabled = !enabled; 
          upTestBtn.disabled = !enabled;
          if (testUrlSelect) testUrlSelect.disabled = !enabled;
          
          if (!enabled && upStatus) {
            upStatus.textContent = '已禁用';
            upStatus.className = 'pill bad';
          } else if (enabled && upStatus && upStatus.textContent === '已禁用') {
            upStatus.textContent = '未测试';
            upStatus.className = 'pill';
          }
        };
        upChk.addEventListener('change', async ()=>{ sync(); await syncSystemUpstreamState(); });
        syncSystemUpstreamState();
      }
      
      // 监听代理地址和测试URL变化，重置测试状态
      const resetTestStatus = () => {
        if (upStatus && upStatus.textContent !== '已禁用' && upStatus.textContent !== '测试中...') {
          upStatus.textContent = '未测试';
          upStatus.className = 'pill';
        }
      };
      
      if (upAddr) upAddr.addEventListener('input', async ()=>{ resetTestStatus(); await syncSystemUpstreamState(); });
      if (testUrlSelect) testUrlSelect.addEventListener('change', resetTestStatus);
    } catch {}
    
    // 点击外部隐藏设置面板
    document.addEventListener('click', (e) => {
      if (panel && panel.style.display === 'block') {
        if (!panel.contains(e.target)) {
          panel.style.display = 'none';
        }
      }
    });
    if (panel) panel.addEventListener('click', (e) => e.stopPropagation());
  }

  function debounce(fn, wait){ let t=null; return function(){ clearTimeout(t); t=setTimeout(()=>fn.apply(this, arguments), wait); } }

  function toast(msg){
    try {
      const t = toastEl();
      if (!t) return;
      t.textContent = String(msg||'');
      t.classList.add('show');
      setTimeout(()=>{ t.classList.remove('show'); }, 3200);
    } catch {}
  }

  // 同步系统代理状态与“链式代理”控件的一致性
  async function syncSystemUpstreamState(){
    try {
      const upChk = el('enableUpstream');
      const upAddr = el('upstreamAddr');
      const upStatus = el('upstreamStatus');
      const upTestBtn = el('btnTestUpstream');
      const testUrlSelect = el('testUrlSelect');
      if (!upChk || !upAddr) return;
      const val = String(upAddr.value || '').trim().toLowerCase();
      if (val === 'system') {
        let sysOn = false;
        try {
          const st = await window.MT.invoke('capture.status');
          sysOn = !!(st && st.proxyState && st.proxyState.enable === 1);
        } catch {}
        if (!sysOn) {
          // 系统代理未启用：强制关闭链式代理勾选并禁用相关控件
          upChk.checked = false;
          try {
            upAddr.disabled = true;
            if (upTestBtn) upTestBtn.disabled = true;
            if (testUrlSelect) testUrlSelect.disabled = true;
            if (upStatus) { upStatus.textContent = '系统未启用'; upStatus.className = 'pill bad'; }
          } catch {}
        }
      }
    } catch {}
  }

  // ====== 设置持久化（仅在“应用”时保存；启动时读取并应用） ======
  async function saveSettings(){
    try {
      if (!window.MT || !window.MT.db) return;
      const targets = el('targets').value.trim();
      const pathPrefixes = (el('capPrefix') && el('capPrefix').value.trim()) || '';
      const rewriteRules = (el('rewriteRules') && el('rewriteRules').value) || '';
      const maxBodyDirMB = Number(el('maxBodyDirMB') && el('maxBodyDirMB').value) || 512;
      // 注意：enableUpstream / upstreamAddr 为系统判定项，不入库
      const settings = { targets, pathPrefixes, rewriteRules, maxBodyDirMB };
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
        if (val.rewriteRules != null && el('rewriteRules')) el('rewriteRules').value = String(val.rewriteRules || '');
        if (val.maxBodyDirMB != null && el('maxBodyDirMB')) el('maxBodyDirMB').value = String(val.maxBodyDirMB || '512');
        return true;
      }
      return false;
    } catch (e) { try { console.warn('[HTTP-SNIFFER] loadSettings failed', e && e.message); } catch {} return false; }
  }

  async function loop(){
    // await updateStatus();
    await refreshList();
    timer = setTimeout(loop, 1500);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    await updateStatus();
    try {
      // 先加载已保存设置并填充输入框
      await loadSettingsAndFillInputs();
      await syncSystemUpstreamState();
      await start();
    } catch (e) { toast('自动启动失败，请手动启动'); }
    loop();
  });

  // 页面卸载时的清理（同步执行，不能使用async）
  window.addEventListener('beforeunload', (event) => {
    try {
      if (timer) clearTimeout(timer);
      try { console.info('[HTTP-SNIFFER] beforeunload: starting emergency cleanup...'); } catch {}
      // 注意：beforeunload不支持async，但我们尝试同步调用
      // 为了更可靠的清理，我们在多个地方都添加了保护
      try {
        // 使用同步的方式尝试清理（虽然invoke本身是异步的）
        window.MT.invoke('capture.disableSystemProxy');
        window.MT.invoke('capture.stop');
      } catch {}
    } catch {}
  });
  
  // 添加额外的页面隐藏事件监听（更可靠）
  window.addEventListener('pagehide', (event) => {
    try {
      try { console.info('[HTTP-SNIFFER] pagehide: cleanup triggered'); } catch {}
      window.MT.invoke('capture.disableSystemProxy');
      window.MT.invoke('capture.stop');
    } catch {}
  });
  
  // 添加窗口关闭前的确认和清理
  window.addEventListener('unload', (event) => {
    try {
      try { console.info('[HTTP-SNIFFER] unload: final cleanup attempt'); } catch {}
      window.MT.invoke('capture.disableSystemProxy');
      window.MT.invoke('capture.stop');
    } catch {}
  });
})();
