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
    listEl.innerHTML = items.map(it => `
      <div class="item" data-id="${it.id}">
        <div class="type">${it.type}</div>
        <pre>${escapeHtml(it.text.substring(0, 1000))}</pre>
        <div>
          <button class="btn" data-action="copy">复制</button>
          <button class="btn" data-action="delete">删除</button>
        </div>
      </div>
    `).join('');

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

  qEl.addEventListener('input', debounce(query, 250));
  refreshBtn.addEventListener('click', query);
  clearBtn.addEventListener('click', async () => { await window.MT.invoke('clip.clear'); await query(); });

  // 从主程序注入的输入，打开即刷新
  if (window.MT && window.MT.onInput) {
    window.MT.onInput(() => { query(); });
  }
  query();

  function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
})();


