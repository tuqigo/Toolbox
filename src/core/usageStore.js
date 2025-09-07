const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

class UsageStore {
  constructor(options = {}) {
    this.isQuiet = !!options.isQuiet;
    const userData = app.getPath('userData');
    this.filePath = path.join(userData, 'usage.json');
    this.data = { counts: {} };
    this._loaded = false;
  }

  async load() {
    try {
      if (await fs.pathExists(this.filePath)) {
        this.data = JSON.parse(await fs.readFile(this.filePath, 'utf8')) || { counts: {} };
      }
      this._loaded = true;
    } catch (e) {
      if (!this.isQuiet) console.warn('加载使用偏好失败:', e.message);
      this.data = { counts: {} };
    }
  }

  async save() {
    try {
      await fs.outputFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      if (!this.isQuiet) console.warn('保存使用偏好失败:', e.message);
    }
  }

  getScores() {
    return { ...(this.data.counts || {}) };
  }

  async increment(pluginId) {
    if (!this._loaded) await this.load();
    this.data.counts[pluginId] = (this.data.counts[pluginId] || 0) + 1;
    await this.save();
  }
}

module.exports = { UsageStore };


