(() => {
  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const qEl = $('q');
  const toggleFavEl = $('toggleFav');
  const countEl = $('count');

  // 2025-09-19 ： 收藏集缓存，避免频繁 IO
  let favoriteIdSet = new Set();
  let favOnly = false;
  let currentItems = [];
  let autoTimer = null;

  // 2025-09-19 ： 统一查询并渲染
  async function query() {
    const q = qEl.value || '';
    await ensureFavoritesLoaded();
    const items = await window.MT.invoke('clip.query', { q, limit: 300 });
    currentItems = Array.isArray(items) ? items : [];
    const view = favOnly ? currentItems.filter(it => favoriteIdSet.has(it.id)) : currentItems;
    render(view);
    updateCount(view.length);
  }

  // 2025-09-19 ： 载入收藏（key 使用前缀 fav:<id>；兼容旧前缀 id:<id>）
  async function ensureFavoritesLoaded() {
    try {
      const set = new Set();
      const rowsFav = await window.MT.db.list({ prefix: 'fav:', limit: 10000, offset: 0 });
      (rowsFav || []).forEach(r => { const k = String(r && r.key || ''); if (k.startsWith('fav:')) set.add(k.slice(4)); });
      // 兼容旧数据
      const rowsOld = await window.MT.db.list({ prefix: 'id:', limit: 10000, offset: 0 });
      (rowsOld || []).forEach(r => { const k = String(r && r.key || ''); if (k.startsWith('id:')) set.add(k.slice(3)); });
      favoriteIdSet = set;
    } catch (e) {
      // 静默失败
      favoriteIdSet = new Set();
    }
  }

  // 2025-09-19 ： 设置收藏状态
  async function setFavorite(id, isFav) {
    try {
      if (isFav) {
        await window.MT.db.put(`fav:${id}`, 1);
        favoriteIdSet.add(id);
      } else {
        await window.MT.db.del(`fav:${id}`);
        favoriteIdSet.delete(id);
      }
    } catch {}
  }

  function updateCount(n) {
    try { countEl.textContent = String(n || 0); } catch {}
  }

  function render(items) {
    if (!items || items.length === 0) {
      listEl.innerHTML = '<div class="empty">暂无历史</div>';
      return;
    }
    listEl.innerHTML = items.map(it => {
      const full = String(it.text || '');
      const needsExpand = full.length > 120 || /\n/.test(full);
      const snippet = full; // 双行省略用 CSS 控制
      return `
      <div class="item" data-id="${it.id}">
        <div class="type">${it.type}</div>
        <pre class="line">${escapeHtml(snippet)}</pre>
        ${needsExpand ? `<button class="center-toggle" data-action="toggle" title="展开/收起">${getChevronChevronSvg()}</button>` : ''}
      </div>`;
    }).join('');

    // 行内事件：展开/收起 & 右键菜单
    listEl.querySelectorAll('.item').forEach(row => {
      row.addEventListener('click', async (e) => {
        const act = e.target && (e.target.getAttribute('data-action') || (e.target.closest('[data-action]') && e.target.closest('[data-action]').getAttribute('data-action')));
        if (act === 'toggle') {
          const id = row.getAttribute('data-id');
          const expanded = row.classList.toggle('expanded');
          // 切换中心箭头方向
          const btn = row.querySelector('.center-toggle');
          if (btn) btn.innerHTML = getChevronChevronSvg(expanded);
        }
      });

      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const id = row.getAttribute('data-id');
        const item = currentItems.find(x => x.id === id);
        if (!item) return;
        const isFav = favoriteIdSet.has(id);
        showContextMenu(ev.clientX, ev.clientY, [
          { cmd: 'copy', label: '复制', icon: 'copy', handler: async () => { await window.MT.invoke('clip.copy', item.text || ''); } },
          { cmd: 'delete', label: '删除', icon: 'delete', handler: async () => { await window.MT.invoke('clip.delete', id); await query(); } },
          { cmd: isFav ? 'unfav' : 'fav', label: isFav ? '取消收藏' : '收藏', icon: 'star', handler: async () => { await setFavorite(id, !isFav); if (favOnly) await query(); } }
        ]);
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 2025-09-19 ： 简易右键菜单（SVG + 文字）
  let ctxMenuEl = null;
  function ensureCtxMenu() {
    if (!ctxMenuEl) {
      ctxMenuEl = document.createElement('div');
      ctxMenuEl.className = 'ctx-menu';
      document.body.appendChild(ctxMenuEl);
    }
    return ctxMenuEl;
  }
  function hideContextMenu() { if (ctxMenuEl) ctxMenuEl.style.display = 'none'; }
  function showContextMenu(x, y, items) {
    const el = ensureCtxMenu();
    el.innerHTML = items.map(it => `
      <div class="menu-item" data-cmd="${it.cmd}">
        ${getMenuIconSvg(it.icon)}<span>${it.label}</span>
      </div>`).join('');
    el.style.display = 'block';
    // 定位，避免越界
    const pad = 8;
    const rectW = 180;
    const rectH = 8 + 36 * items.length;
    const left = Math.max(8, Math.min(x, window.innerWidth - rectW - pad));
    const top = Math.max(8, Math.min(y, window.innerHeight - rectH - pad));
    el.style.left = left + 'px';
    el.style.top = top + 'px';

    // 事件
    const handler = (ev) => {
      const mi = ev.target.closest('.menu-item');
      if (!mi) return;
      const cmd = mi.getAttribute('data-cmd');
      const def = items.find(a => a.cmd === cmd);
      hideContextMenu();
      if (def && typeof def.handler === 'function') def.handler();
    };
    el.onclick = handler;

    // 外点关闭
    setTimeout(() => {
      const onDoc = (e) => { if (!el.contains(e.target)) { hideContextMenu(); document.removeEventListener('mousedown', onDoc); } };
      document.addEventListener('mousedown', onDoc);
    }, 0);
  }

  function getMenuIconSvg(name) {
    switch (name) {
      case 'copy':
        return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
      case 'delete':
        return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"/></svg>';
      case 'star':
      default:
        return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
    }
  }
  function getChevronChevronSvg(expanded = false) {
    // 垂直方向 大于/小于 的感觉：使用上下三角形，展开后指向上
    return expanded
      ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14l5-5 5 5z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>';
  }

  // 交互绑定
  qEl.addEventListener('input', debounce(query, 250));
  toggleFavEl.addEventListener('click', async () => {
    favOnly = !favOnly;
    try { toggleFavEl.classList.toggle('active', favOnly); } catch {}
    await query();
  });
  listEl.addEventListener('scroll', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);

  // 从主程序注入的输入，打开即刷新
  if (window.MT && window.MT.onInput) {
    window.MT.onInput(() => { query(); });
  }
  // 自动刷新：轻量轮询最新数量变化
  try { if (autoTimer) clearInterval(autoTimer); } catch {}
  autoTimer = setInterval(async () => {
    try {
      const q = qEl.value || '';
      const items = await window.MT.invoke('clip.query', { q, limit: 50 });
      const latestId = (items && items[0] && items[0].id) || '';
      const currentLatestId = (currentItems && currentItems[0] && currentItems[0].id) || '';
      if (latestId && latestId !== currentLatestId) {
        await query();
      }
    } catch {}
  }, 1000);
  query();

  function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
})();


