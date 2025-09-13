// 示例：书签搜索（search 模式）
const fs = require('fs');
const { shell } = require('electron');
const path = require('path');


// 缓存，避免每次都扫磁盘
let bookmarksCache = { items: [], ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟

function getEnv(name, fallback = '') {
  try { return process.env[name] || fallback; } catch { return fallback; }
}

function exists(p) {
  try { return !!(p && fs.existsSync(p)); } catch { return false; }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function* enumerateChromiumBookmarkFiles() {
  const local = getEnv('LOCALAPPDATA', '');
  const candidates = [
    path.join(local, 'Google', 'Chrome', 'User Data'),
    path.join(local, 'Microsoft', 'Edge', 'User Data'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    path.join(local, 'Chromium', 'User Data'),
    path.join(local, 'Vivaldi', 'User Data')
  ];
  for (const base of candidates) {
    if (!exists(base)) continue;
    let profiles = [];
    try { profiles = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { profiles = []; }
    // 优先 Default，再遍历其他 Profile*
    const ordered = ['Default', ...profiles.filter(n => /^Profile \d+$/i.test(n))];
    const seen = new Set();
    for (const prof of ordered) {
      if (!prof || seen.has(prof)) continue;
      seen.add(prof);
      const f = path.join(base, prof, 'Bookmarks');
      if (exists(f)) yield f;
    }
  }
}

function collectFromChromiumJson(json) {
  const results = [];
  if (!json || !json.roots) return results;
  const roots = ['bookmark_bar', 'other', 'synced'];
  const pushNode = (node) => {
    if (!node) return;
    if (node.type === 'url' && node.url) {
      results.push({ title: node.name || node.url, url: node.url, description: node.url });
      return;
    }
    const children = node.children || [];
    for (const c of children) pushNode(c);
  };
  for (const key of roots) pushNode(json.roots[key]);
  return results;
}

function dedup(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = (it.url || it.description || '') + '|' + (it.title || '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function loadBookmarksIfNeeded(force = false) {
  const now = Date.now();
  if (!force && bookmarksCache.items && (now - (bookmarksCache.ts || 0) < CACHE_TTL_MS)) {
    return bookmarksCache.items;
  }
  let collected = [];
  try {
    for (const file of enumerateChromiumBookmarkFiles()) {
      const json = readJsonSafe(file);
      if (!json) continue;
      collected = collected.concat(collectFromChromiumJson(json));
    }
  } catch { }
  // TODO: Firefox 支持（places.sqlite）需要引入 sqlite 读取，这里暂不实现
  const items = dedup(collected);
  bookmarksCache = { items, ts: now };
  return items;
}

function searchIn(list, q) {
  const s = String(q || '').toLowerCase();
  if (!s) return list;
  return list.filter(b => (b.title && b.title.toLowerCase().includes(s)) || (b.url && b.url.toLowerCase().includes(s)));
}

module.exports = {
  // 进入搜索模式前的入口提示
  'bookmark.search': {
    handleEnter: async (_action, setList) => {
      const items = await loadBookmarksIfNeeded();
      setList(items);
    },
    handleSearch: async (action, query, setList) => {
      const base = await loadBookmarksIfNeeded();
      const items = searchIn(base, query);
      setList(items.length > 0 ? items : [{ title: '无结果', description: '换个关键词试试', canClick: false }]);
    },
    handleSelect: async (_action, itemData, callbackSetList) => {
      try {
        await shell.openExternal(itemData.url);
      } catch (error) {
        callbackSetList([{
          title: '打开链接失败',
          description: error.message,
          data: null
        }]);
      }
    }
  }
};


