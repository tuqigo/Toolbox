(() => {
  const qs = (s) => document.querySelector(s);
  const fileListEl = qs('#fileList');
  const logsEl = qs('#logs');
  const toastEl = qs('#toast');

  const state = {
    inputs: [],
    outDir: '',
    concatOut: '',
    gifOut: '',
    snapOut: '',
    ffmpegOK: false
  };

  function showToast(msg){
    toastEl.textContent = String(msg || '');
    toastEl.style.display = 'block';
    setTimeout(()=>{ toastEl.style.display = 'none'; }, 3000);
  }
  function log(...args){
    const s = args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    logsEl.textContent += (s + '\n');
    logsEl.scrollTop = logsEl.scrollHeight;
  }
  function basename(p){ try{ return String(p).replace(/\\/g,'/').split('/').pop(); }catch{ return String(p||''); } }
  function renderList(){
    fileListEl.innerHTML = '';
    state.inputs.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div class="path" title="${p}">${basename(p)}</div>
        <div class="ops">
          <button class="btn secondary" data-op="up" data-idx="${idx}">↑</button>
          <button class="btn secondary" data-op="down" data-idx="${idx}">↓</button>
          <button class="btn danger" data-op="del" data-idx="${idx}">删除</button>
        </div>
      `;
      fileListEl.appendChild(row);
    });
  }
  function buildOutPath(inp, outFmt, kind){
    try{
      const norm = String(inp).replace(/\\/g,'/');
      const m = norm.match(/^(.*)\/([^\/]+)$/);
      const dir = m ? m[1] : norm.replace(/\/[^\/]*$/,'');
      const file = m ? m[2] : norm.split('/').pop();
      const base = file.replace(/\.[^\.]+$/,'');
      const inExt = (file.match(/\.([^\.]+)$/) || [,''])[1].toLowerCase();
      const suffixMap = { remux: '.remux', transcode: (qs('#vcodec') && qs('#vcodec').value === 'libx265') ? '.hevc' : '.transcoded', trim: '.cut' };
      const suf = suffixMap[kind] || '.new';
      let outName = `${base}.${outFmt}`;
      if (inExt === outFmt.toLowerCase()) outName = `${base}${suf}.${outFmt}`;
      return (dir ? (dir + '/') : '') + outName;
    }catch{ return String(inp).replace(/\.[^\.]+$/i, `.${outFmt}`); }
  }
  function move(arr, from, to){ if (to<0 || to>=arr.length) return; const [x]=arr.splice(from,1); arr.splice(to,0,x); }

  async function checkFFmpeg(){
    try{
      const r = await window.MT.invoke('exec.check');
      // 兼容两种返回：直接数组 或 { data: array }
      const list = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);
      const found = Array.isArray(list) ? list.find(x => x && x.exists === true && /(^|[\\\/])ffmpeg\.exe$/i.test(String(x.name||''))) : null;
      state.ffmpegOK = !!found;
      qs('#ffmpegStatus').textContent = state.ffmpegOK ? 'ffmpeg 就绪' : '未检测到 ffmpeg.exe（需放在插件目录）';
      log('[exec.check]', list);
    }catch(e){
      state.ffmpegOK = false;
      qs('#ffmpegStatus').textContent = 'ffmpeg 检测失败';
      log('[exec.check][error]', e.message);
    }
  }

  function toggleOpts(){
    const val = qs('#action').value;
    ['remux','transcode','concat','extractAudio','trim','gif','snapshot'].forEach(k=>{
      const el = qs('#opt-'+k);
      if (el) el.style.display = (val === k) ? '' : 'none';
    });
  }

  // 事件绑定
  qs('#action').addEventListener('change', toggleOpts);

  fileListEl.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t && t.dataset)) return;
    const op = t.dataset.op;
    const idx = Number(t.dataset.idx);
    if (op === 'del') { state.inputs.splice(idx,1); renderList(); }
    if (op === 'up') { move(state.inputs, idx, idx-1); renderList(); }
    if (op === 'down') { move(state.inputs, idx, idx+1); renderList(); }
  });

  qs('#pickFiles').addEventListener('click', async ()=>{
    try{
      const r = await window.MT.invoke('dialog.pickFiles', { multi: true, filters: [{ name: 'Media', extensions: ['mp4','mkv','mov','avi','flv','webm','ts','m2ts','wmv','m4v','mp3','aac','m4a','wav','flac','ogg'] }] });
      if (Array.isArray(r)) {
        state.inputs.push(...r);
        state.inputs = Array.from(new Set(state.inputs));
        renderList();
      }
    }catch(e){ log('[pickFiles][error]', e.message); }
  });

  qs('#pickDir').addEventListener('click', async ()=>{
    try{
      const dir = await window.MT.invoke('dialog.pickDirectory');
      if (!dir) return;
      const list = await window.MT.invoke('fs.list', { dir, extensions: ['mp4','mkv','mov','avi','flv','webm','ts','m2ts','wmv','m4v','mp3','aac','m4a','wav','flac','ogg'] });
      if (Array.isArray(list)) {
        state.inputs.push(...list);
        state.inputs = Array.from(new Set(state.inputs));
        renderList();
      }
    }catch(e){ log('[pickDir][error]', e.message); }
  });

  // 移除“加载目录视频”按钮的逻辑：合并到选择目录

  // 移除自定义输出目录：默认与源文件同目录

  qs('#pickConcatOut').addEventListener('click', async ()=>{
    try{
      const fmt = qs('#concatFmt').value || 'mp4';
      const label = ['mp3','m4a','wav'].includes(fmt) ? 'Audio' : 'Video';
      const fp = await window.MT.invoke('dialog.pickSaveFile', { defaultPath: `merged.${fmt}`, filters: [{ name: label, extensions: [fmt] }] });
      if (fp){ state.concatOut = fp; qs('#concatOutPath').textContent = fp; }
    }catch(e){ log('[pickConcatOut][error]', e.message); }
  });

  qs('#pickGifOut').addEventListener('click', async ()=>{
    try{
      const fp = await window.MT.invoke('dialog.pickSaveFile', { defaultPath: 'clip.gif', filters: [{ name: 'GIF', extensions: ['gif'] }] });
      if (fp){ state.gifOut = fp; qs('#gifOutPath').textContent = fp; }
    }catch(e){ log('[pickGifOut][error]', e.message); }
  });

  qs('#pickSnapOut').addEventListener('click', async ()=>{
    try{
      const fp = await window.MT.invoke('dialog.pickSaveFile', { defaultPath: 'cover.jpg', filters: [{ name: 'Image', extensions: ['jpg','png'] }] });
      if (fp){ state.snapOut = fp; qs('#snapOutPath').textContent = fp; }
    }catch(e){ log('[pickSnapOut][error]', e.message); }
  });

  qs('#openDownload').addEventListener('click', async ()=>{
    try{ await window.MT.invoke('openExternal', 'https://www.gyan.dev/ffmpeg/builds/'); }catch{}
  });

  qs('#run').addEventListener('click', async ()=>{
    try{
      if (!state.ffmpegOK){ showToast('未检测到 ffmpeg.exe'); return; }
      const action = qs('#action').value;
      if (['remux','transcode','extractAudio','trim'].includes(action) && state.inputs.length === 0){
        showToast('请先选择至少一个文件');
        return;
      }
      logsEl.textContent = '';

      const makeCmd = () => {
        // 仅拼接安全参数，主进程以 shell:false 执行
        if (action === 'remux'){
          const outFmt = (qs('#remuxFmt').value || 'mp4');
          return state.inputs.map(inp => ({ args: ['-y','-hide_banner','-i', inp, '-c','copy', buildOutPath(inp, outFmt, 'remux') ] }));
        }
        if (action === 'concat'){
          if (state.inputs.length < 2){ showToast('合并需要至少两个文件'); return []; }
          if (!state.concatOut){ showToast('请选择合并输出文件'); return []; }
          const fmt = (qs('#concatFmt').value || '').toLowerCase();
          // 使用 concat demuxer + stdin 文件清单，稳妥支持中文/空格路径
          const args = ['-y','-hide_banner','-protocol_whitelist','file,pipe,crypto,data','-f','concat','-safe','0','-i','-','-map','0:a:0'];
          if (['mp3','m4a','wav'].includes(fmt)) {
            if (fmt === 'wav') args.push('-c:a','pcm_s16le'); else args.push('-c:a','copy');
          } else {
            args.push('-c','copy');
          }
          args.push(state.concatOut);
          // 使用 ffconcat 清单（无 BOM），支持中文/空格路径
          const header = 'ffconcat version 1.0\n';
          const toLine = (p) => {
            const norm = String(p).replace(/\\/g, '/');
            const esc = norm.replace(/'/g, "'\\''");
            return `file '${esc}'`;
          };
          const list = state.inputs.map(toLine).join('\n');
          const stdin = header + list + '\n';
          return [{ args, stdin }];
        }
        if (action === 'transcode'){
          const vcodec = qs('#vcodec').value || 'libx265';
          const crf = String(Number(qs('#crf').value || 28));
          const preset = qs('#preset').value || 'medium';
          const acodec = qs('#acodec').value || 'copy';
          const outFmt = qs('#transFmt').value || 'mp4';
          return state.inputs.map(inp => ({ args: ['-y','-hide_banner','-i', inp, '-c:v', vcodec, '-crf', crf, '-preset', preset, '-c:a', acodec, buildOutPath(inp, outFmt, 'transcode') ] }));
        }
        if (action === 'extractAudio'){
          const fmt = qs('#audioFmt').value || 'm4a';
          return state.inputs.map(inp => ({ args: ['-y','-hide_banner','-i', inp, '-vn', '-c:a', 'copy', inp.replace(/\.[^\.]+$/i, `.${fmt}`) ] }));
        }
        if (action === 'trim'){
          const start = (qs('#trimStart').value || '0').trim();
          const dur = (qs('#trimDur').value || '').trim();
          const fmt = qs('#trimFmt').value || 'mp4';
          return state.inputs.map(inp => ({ args: ['-y','-hide_banner','-ss', start, ...(dur?['-t',dur]:[]), '-i', inp, '-c', 'copy', buildOutPath(inp, fmt, 'trim') ] }));
        }
        if (action === 'gif'){
          if (state.inputs.length === 0){ showToast('请选择一个文件'); return []; }
          if (!state.gifOut){ showToast('请选择 GIF 输出文件'); return []; }
          const secs = String(Number(qs('#gifSecs').value || 5));
          const height = String(Number(qs('#gifH').value || 480));
          return [{ args: ['-y','-hide_banner','-i', state.inputs[0], '-t', secs, '-vf', `fps=12,scale=-1:${height}:flags=lanczos`, state.gifOut ] }];
        }
        if (action === 'snapshot'){
          if (state.inputs.length === 0){ showToast('请选择一个文件'); return []; }
          if (!state.snapOut){ showToast('请选择图片输出文件'); return []; }
          const at = (qs('#snapAt').value || '00:00:01').trim();
          return [{ args: ['-y','-hide_banner','-ss', at, '-i', state.inputs[0], '-vframes', '1', state.snapOut ] }];
        }
        return [];
      };

      const cmds = makeCmd();
      if (!Array.isArray(cmds) || cmds.length === 0) return;

      for (const c of cmds) {
        log('> ffmpeg', c.args.join(' '));
        const payload = { name: 'bin/ffmpeg.exe', args: c.args, timeoutMs: 30*60*1000 };
        if (c.stdin) payload.stdin = c.stdin;
        const rt = await window.MT.exec.runStream(payload, {
          onLog: (m) => { if (m && m.text) log(m.text.trimEnd()); },
          onEnd: (m) => { log('[exit]', (m && m.code)); }
        });
        // 简单等待结束（onEnd 会打印 code）
        await new Promise((resolve) => {
          const endHandler = (e) => resolve();
          setTimeout(resolve, 50); // 兜底
        });
      }
      showToast('已完成');
    } catch (e) {
      showToast('执行异常：' + e.message);
      log('[run][error]', e.message);
    }
  });

  // 初始化
  checkFFmpeg();
  toggleOpts();
})();


