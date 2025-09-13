class DevtoolsUI {
  constructor() {
    this.api = window.MT;
    this.mountCandidates = [];
    this.lastPickedDir = null;
    this.init();
  }

  init() {
    document.getElementById('pickBtn').addEventListener('click', () => this.pick());
    document.getElementById('mountBtn').addEventListener('click', () => this.pickAndMount());
    document.getElementById('refreshBtn').addEventListener('click', () => this.refreshRunning());
    document.getElementById('packBtn').addEventListener('click', () => this.pack());
    document.getElementById('installFileBtn').addEventListener('click', () => this.installFromFile());
    this.refreshRunning();
  }

  async pick() {
    try {
      const res = await this.api.invoke('devtools.pickManifest');
      if (res && res.path) {
        this.lastPickedDir = res.path;
        this.mountCandidates.push({ path: res.path, name: '待挂载' });
        this.renderCandidates();
      }
    } catch (e) {
      if (String(e && e.message) !== 'cancelled') alert('选择失败: ' + (e && e.message));
    }
  }

  async pickAndMount() {
    try {
      if (this.lastPickedDir) {
        const result = await this.api.invoke('devtools.mountPath', { dir: this.lastPickedDir });
        if (result && result.id) await this.refreshRunning();
      } else {
        const result = await this.api.invoke('devtools.pickAndMount');
        if (result && result.id) await this.refreshRunning();
      }
    } catch (e) {
      if (String(e && e.message) !== 'cancelled') alert('挂载失败: ' + (e && e.message));
    }
  }

  async unmount(id) {
    try {
      await this.api.invoke('devtools.unmount', { id });
      await this.refreshRunning();
    } catch (e) {
      alert('卸载失败: ' + (e && e.message));
    }
  }

  async refreshRunning() {
    try {
      // 复用 plugin.list 展示所有插件
      const list = await this.api.invoke('plugin.list');
      const container = document.getElementById('runningList');
      container.innerHTML = '';
      list.forEach(p => {
        const row = document.createElement('div');
        row.className = 'item';
        row.innerHTML = `<div><strong>${p.name}</strong> <span class="badge">${p.id}</span></div>` +
          `<div><button class="btn" data-id="${p.id}">暂停/卸载</button></div>`;
        row.querySelector('button').addEventListener('click', () => this.unmount(p.id));
        container.appendChild(row);
      });
    } catch (e) {
      alert('刷新失败: ' + (e && e.message));
    }
  }

  renderCandidates() {
    const container = document.getElementById('mountedList');
    container.innerHTML = '';
    this.mountCandidates.forEach(c => {
      const row = document.createElement('div');
      row.className = 'item';
      row.textContent = `${c.name || c.id || '未知'} — ${c.path}`;
      container.appendChild(row);
    });
  }

  async pack() {
    const msg = document.getElementById('packMsg');
    msg.textContent = '正在打包...';
    try {
      await this.api.invoke('devtools.pack');
      msg.textContent = '打包完成 ✅';
    } catch (e) {
      if (String(e && e.message) === 'cancelled') {
        msg.textContent = '已取消';
      } else {
        msg.textContent = '打包失败: ' + (e && e.message);
      }
    }
  }

  async installFromFile() {
    try {
      await this.api.invoke('installer.installFromFile');
      try { await this.api.invoke('plugin.reload'); } catch {}
      await this.refreshRunning();
      alert('安装成功');
    } catch (e) {
      if (String(e && e.message) === 'cancelled') return;
      alert('安装失败: ' + (e && e.message));
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new DevtoolsUI();
});


