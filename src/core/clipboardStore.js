const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

class ClipboardStore {
  constructor(options = {}) {
    const userData = app.getPath('userData');
    this.filePath = path.join(userData, 'clipboard-history.json');
    this.maxItems = options.maxItems || 300;
    this.items = [];
    this.loaded = false;
    this.isQuiet = !!options.isQuiet;
  }

  async load() {
    try {
      if (await fs.pathExists(this.filePath)) {
        const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (Array.isArray(data.items)) {
          this.items = data.items;
          // 兼容旧数据：将 JSON 文本压缩为单行，并补充缺失的 type
          let changed = false;
          for (const item of this.items) {
            try {
              const raw = (item && item.text) ? String(item.text) : '';
              const t = raw.trim();
              if (!t) continue;
              const type = item.type || this.detectType(t);
              if (type === 'json') {
                try {
                  const parsed = JSON.parse(t);
                  const minified = JSON.stringify(parsed);
                  if (minified && minified !== t) {
                    item.text = minified;
                    changed = true;
                  }
                  item.type = 'json';
                } catch {}
              } else if (!item.type) {
                item.type = type;
                changed = true;
              }
            } catch {}
          }
          if (changed) {
            if (!this.isQuiet) {
              try { console.log('ClipboardStore: 已对历史 JSON 项进行单行化并补齐类型'); } catch {}
            }
            await this.save();
          }
        }
      }
      this.loaded = true;
    } catch (e) {
      if (!this.isQuiet) console.warn('加载剪贴板历史失败:', e.message);
      this.items = [];
      this.loaded = true;
    }
  }

  async save() {
    try {
      await fs.outputFile(this.filePath, JSON.stringify({ items: this.items }, null, 2), 'utf8');
    } catch (e) {
      if (!this.isQuiet) console.warn('保存剪贴板历史失败:', e.message);
    }
  }

  makeId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  detectType(text) {
    const t = (text || '').trim();
    if (!t) return 'empty';
    if (/^https?:\/\//i.test(t) || /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(t)) return 'url';
    try { const v = JSON.parse(t); if (typeof v === 'object') return 'json'; } catch {}
    return 'text';
  }

  async add(text) {
    if (!this.loaded) await this.load();
    const t = (text || '').trim();
    if (!t) return false;
    // 与最新一条重复则跳过
    if (this.items.length > 0 && this.items[0].text === t) return false;
    // 规范化文本：若为 JSON，则压缩为单行
    let normalizedText = t;
    let detectedType = this.detectType(t);
    if (detectedType === 'json') {
      try {
        const parsed = JSON.parse(t);
        const minified = JSON.stringify(parsed);
        if (minified && minified !== t) {
          if (!this.isQuiet) {
            try { console.log(`ClipboardStore: JSON normalized ${t.length} -> ${minified.length}`); } catch {}
          }
          normalizedText = minified;
        }
      } catch (e) {
        // JSON 解析失败则保持原样
      }
    }
    const item = { id: this.makeId(), text: normalizedText, type: detectedType, createdAt: Date.now() };
    this.items.unshift(item);
    if (this.items.length > this.maxItems) this.items.length = this.maxItems;
    await this.save();
    return true;
  }

  // 获取最近指定时间内的剪贴板内容（最新的一条）
  getRecentClipboard(maxAgeSeconds = 5) {
    if (!this.loaded || this.items.length === 0) return null;
    
    const now = Date.now();
    const maxAge = maxAgeSeconds * 1000; // 转换为毫秒
    
    const recentItem = this.items[0]; // 最新的一条
    if (now - recentItem.createdAt <= maxAge) {
      return recentItem;
    }
    
    return null; // 没有符合条件的最近内容
  }

  query(params = {}) {
    const { q = '', limit = 100 } = params;
    const s = (q || '').trim().toLowerCase();
    let arr = this.items;
    if (s) arr = arr.filter(x => x.text.toLowerCase().includes(s));
    return arr.slice(0, Math.min(limit, 500));
  }

  async delete(id) {
    const idx = this.items.findIndex(x => x.id === id);
    if (idx >= 0) {
      this.items.splice(idx, 1);
      await this.save();
      return true;
    }
    return false;
  }

  async clear() {
    this.items = [];
    await this.save();
    return true;
  }
}

module.exports = { ClipboardStore };


