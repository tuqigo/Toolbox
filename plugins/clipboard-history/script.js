(() => {
  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const qEl = $('q');
  const refreshBtn = $('refresh');
  const clearBtn = $('clear');

  async function query() {
    const q = qEl.value || '';
    const items = await window.MT.invoke('clip.query', { q, limit: 300 });
    render(items);
  }

  function render(items) {
    if (!items || items.length === 0) {
      listEl.innerHTML = '<div class="empty">暂无历史</div>';
      return;
    }
    listEl.innerHTML = items.map(it => {
      const full = String(it.text || '');
      return `
      <div class="item" data-id="${it.id}">
        <div class="type">${it.type}</div>
        <pre>${escapeHtml(full)}</pre>
        <div class="actions">
          <button class="btn" data-action="copy">复制</button>
          <button class="btn" data-action="delete">删除</button>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.item').forEach(row => {
      row.addEventListener('click', async (e) => {
        const action = e.target && e.target.getAttribute('data-action');
        const id = row.getAttribute('data-id');
        if (!action) return;
        if (action === 'copy') {
          const text = items.find(x => x.id === id)?.text || '';
          await window.MT.invoke('clip.copy', text);
        } else if (action === 'delete') {
          await window.MT.invoke('clip.delete', id);
          await query();
        }
      });
      // 绑定自定义 tooltip（悬停全文）
      const id = row.getAttribute('data-id');
      const pre = row.querySelector('pre');
      const it = items.find(x => x.id === id);
      if (pre && it) {
        pre.addEventListener('mouseenter', (ev) => showTooltip(it.text || '', ev.clientX, ev.clientY));
        pre.addEventListener('mousemove', (ev) => positionTooltip(ev.clientX, ev.clientY));
        pre.addEventListener('mouseleave', hideTooltip);
      }
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

  // 自定义 tooltip（主题适配）
  let tooltipEl;
  function ensureTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'tooltip';
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }
  function showTooltip(text, x, y) {
    try {
      const el = ensureTooltip();
      el.textContent = String(text || '');
      el.classList.add('show');
      positionTooltip(x, y);
    } catch {}
  }
  function positionTooltip(x, y) {
    if (!tooltipEl) return;
    const margin = 12;
    const maxLeft = window.innerWidth - tooltipEl.offsetWidth - margin;
    const maxTop = window.innerHeight - tooltipEl.offsetHeight - margin;
    const left = Math.max(8, Math.min(x + margin, Math.max(8, maxLeft)));
    const top = Math.max(8, Math.min(y + margin, Math.max(8, maxTop)));
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
  }
  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.remove('show');
  }

  qEl.addEventListener('input', debounce(query, 250));
  refreshBtn.addEventListener('click', query);
  clearBtn.addEventListener('click', async () => { await window.MT.invoke('clip.clear'); await query(); });
  listEl.addEventListener('scroll', hideTooltip);
  window.addEventListener('resize', hideTooltip);

  // 从主程序注入的输入，打开即刷新
  if (window.MT && window.MT.onInput) {
    window.MT.onInput(() => { query(); });
  }
  query();

  function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
})();


