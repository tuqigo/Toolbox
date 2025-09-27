'use strict';

(() => {
  // 时间：2025-09-24 新增翻译 UI 插件（中文→英文；非中文→中文；支持复制与主题）

  const $ = (id) => document.getElementById(id);
  const srcEl = $('src'), dstEl = $('dst'), detEl = $('det');
  const chipZh = $('chipZh'), chipEn = $('chipEn');
  const btnCopy = $('btnCopy'), btnTrans = $('btnTrans'), btnSwap = $('btnSwap');
  const toastEl = $('toast');

  let target = 'zh'; // 目标语言：'zh' 或 'en'
  let lastDetected = 'auto';

  // 主题适配
  (async function applyTheme() {
    try {
      const t = await window.MT.invoke('ui.getTheme');
      const tokens = t && t.tokens && tokensFromTheme(t.tokens, t.effective);
      if (tokens) setCssVars(tokens);
    } catch {}
  })();

  function tokensFromTheme(all, eff) {
    try {
      const tok = all && all[String(eff || 'light')];
      if (!tok) return null;
      const c = tok.color || {};
      return {
        bg: c.bg, panel: c.panel, fg: c.fg, muted: c.muted, primary: c.primary, border: c.border
      };
    } catch { return null; }
  }
  function setCssVars(t) {
    const root = document.documentElement;
    root.style.setProperty('--bg', t.bg);
    root.style.setProperty('--panel', t.panel);
    root.style.setProperty('--fg', t.fg);
    root.style.setProperty('--muted', t.muted);
    root.style.setProperty('--primary', t.primary);
    root.style.setProperty('--border', t.border);
  }

  function toast(msg){
    try{
      toastEl.textContent = String(msg||'');
      toastEl.classList.add('show');
      setTimeout(()=>toastEl.classList.remove('show'), 3000);
    }catch{}
  }

  function detectCJK(s){ return /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(String(s||'')); }
  function decideDefaultTarget(text){ return detectCJK(text) ? 'en' : 'zh'; }

  function setTarget(t){
    target = (t === 'en') ? 'en' : 'zh';
    chipZh.classList.toggle('active', target==='zh');
    chipEn.classList.toggle('active', target==='en');
  }

  async function requestGet(url){
    try{
      const u = new URL(url);
      const res = await window.MT.net.request({
        protocol: (u.protocol||'https:').replace(':',''),
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol==='https:'?443:80),
        path: u.pathname + (u.search||''),
        method: 'GET',
        headers: { 'User-Agent':'MiniToolbox/translator-ui', 'Accept':'*/*' }
      });
      return res && res.data || '';
    }catch(e){ throw new Error(e && e.message || '网络错误'); }
  }

  async function translateByGoogleWeb(text, sl='auto', tl='en'){
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const body = await requestGet(url);
    let json; try { json = JSON.parse(body); } catch { throw new Error('Google 解析失败'); }
    const out = Array.isArray(json && json[0]) ? json[0].map(a=>a&&a[0]||'').join('') : '';
    const detected = (json && (json[2] || (json[8] && json[8][0] && json[8][0][0]))) || sl || 'auto';
    if (!out) throw new Error('Google 无结果');
    return { text: out, detected };
  }

  async function translateByMyMemory(text, sl='auto', tl='en'){
    const from = (sl && sl !== 'auto') ? sl : (detectCJK(text) ? 'zh' : 'en');
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(from)}|${encodeURIComponent(tl)}`;
    const body = await requestGet(url);
    let json; try { json = JSON.parse(body); } catch { throw new Error('MyMemory 解析失败'); }
    const out = json && json.responseData && json.responseData.translatedText;
    if (!out) throw new Error('MyMemory 无结果');
    return { text: out, detected: from };
  }

  async function translateSmart(text, sl='auto', tl='en'){
    try{ return await translateByGoogleWeb(text, sl, tl); }
    catch(e1){ try { console.warn('[TRANSLATOR-UI] google failed:', e1.message); } catch {} }
    return await translateByMyMemory(text, sl, tl);
  }

  async function doTranslate(){
    const text = String(srcEl.value||'').trim();
    if (!text){ dstEl.value=''; detEl.textContent='检测语言：-'; return; }
    btnTrans.disabled = true;
    try{
      const tl = target;
      const sl = detectCJK(text) ? 'zh' : 'auto';
      const res = await translateSmart(text, sl, tl);
      dstEl.value = res.text || '';
      lastDetected = res.detected || sl || 'auto';
      detEl.textContent = `检测语言：${String(lastDetected).toUpperCase()}  →  ${tl.toUpperCase()}`;
    }catch(e){
      dstEl.value = '';
      toast(e && e.message || '翻译失败');
    }finally{
      btnTrans.disabled = false;
    }
  }

  function debounce(fn, ms){ let t=null; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

  // 输入节流翻译
  const debouncedTranslate = debounce(doTranslate, 420);

  // 事件
  chipZh.addEventListener('click', ()=>{ setTarget('zh'); debouncedTranslate(); });
  chipEn.addEventListener('click', ()=>{ setTarget('en'); debouncedTranslate(); });
  btnSwap.addEventListener('click', ()=>{
    setTarget(target==='zh' ? 'en' : 'zh');
    debouncedTranslate();
  });
  btnCopy.addEventListener('click', async ()=>{
    try{ await window.MT.clipboard.writeText(String(dstEl.value||'')); toast('已复制译文'); } catch { toast('复制失败'); }
  });
  btnTrans.addEventListener('click', ()=> doTranslate());
  srcEl.addEventListener('input', ()=>{ debouncedTranslate(); });

  // 接收主输入框内容并自动翻译
  if (window.MT && window.MT.onInput){
    window.MT.onInput((data)=>{
      const content = (data && data.content) || '';
      srcEl.value = content;
      // 默认方向：中文→英文；非中文→中文
      setTarget(decideDefaultTarget(content));
      doTranslate();
    });
  }

  // 初始状态
  setTarget('zh');
})();


