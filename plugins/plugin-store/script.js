/**
 * 插件商店界面逻辑
 */

class PluginStore {
  constructor() {
    this.api = window.MT;
    this.currentPage = 'discover';
    this.plugins = [];
    this.installedPlugins = [];
    this.updates = [];
    this.isLoading = false;
    
    this.init();
  }

  async init() {
    this.bindEvents();
    await this.loadInstalledPlugins();
    await this.checkUpdates();
    await this.loadPage('discover');
  }

  bindEvents() {
    // 侧边栏导航
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        this.switchPage(page);
      });
    });

    // 搜索
    const searchInput = document.getElementById('searchInput');
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.searchPlugins(e.target.value);
      }, 300);
    });

    // 刷新按钮
    document.getElementById('refreshBtn').addEventListener('click', () => {
      this.refreshCurrentPage();
    });

    // 从文件安装入口已迁移至“开发者工具”插件

    // 模态框
    document.getElementById('modalClose').addEventListener('click', () => {
      this.closeModal();
    });
    document.getElementById('modalCancelBtn').addEventListener('click', () => {
      this.closeModal();
    });
    document.getElementById('pluginModal').addEventListener('click', (e) => {
      if (e.target.id === 'pluginModal') {
        this.closeModal();
      }
    });
  }

  async switchPage(page) {
    if (this.currentPage === page) return;

    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });
    document.querySelector(`[data-page="${page}"]`).classList.add('active');

    this.currentPage = page;
    await this.loadPage(page);
  }

  async loadPage(page) {
    const pageTitle = document.getElementById('pageTitle');
    const contentBody = document.getElementById('contentBody');

    // 更新标题
    const titles = {
      discover: '发现',
      installed: '已安装',
      updates: '更新',
      categories: '分类'
    };
    pageTitle.textContent = titles[page] || '发现';

    // 显示加载状态
    this.showLoading();

    try {
      switch (page) {
        case 'discover':
          await this.loadDiscoverPage();
          break;
        case 'installed':
          await this.loadInstalledPage();
          break;
        case 'updates':
          await this.loadUpdatesPage();
          break;
        case 'categories':
          await this.loadCategoriesPage();
          break;
      }
    } catch (error) {
      this.showError(`加载页面失败: ${error.message}`);
    }
  }

  async loadDiscoverPage() {
    try {
      console.log('[Store] 发现页：尝试从注册中心搜索插件');
      const data = await this.api.invoke('installer.search', { keyword: '', options: { limit: 50 } });
      // 期望 data 为数组；若注册中心不可用则回退
      if (Array.isArray(data) && data.length > 0) {
        this.plugins = data;
      } else {
        console.warn('[Store] 注册中心返回为空，回退到内置示例列表');
        this.plugins = this.getMockPlugins();
      }
      this.renderPluginGrid(this.plugins);
    } catch (error) {
      console.warn('[Store] 注册中心搜索失败，回退到内置示例列表:', error && error.message);
      this.plugins = this.getMockPlugins();
      this.renderPluginGrid(this.plugins);
    }
  }

  async loadInstalledPage() {
    await this.loadInstalledPlugins();
    this.renderInstalledGrid(this.installedPlugins);
  }

  async loadUpdatesPage() {
    await this.checkUpdates();
    this.renderUpdatesGrid(this.updates);
  }

  async loadCategoriesPage() {
    const categories = [
      { id: 'utility', name: '实用工具', icon: '🔧', count: 25 },
      { id: 'development', name: '开发工具', icon: '💻', count: 18 },
      { id: 'design', name: '设计工具', icon: '🎨', count: 12 },
      { id: 'security', name: '安全工具', icon: '🔐', count: 8 },
      { id: 'productivity', name: '效率工具', icon: '⚡', count: 20 },
      { id: 'entertainment', name: '娱乐工具', icon: '🎮', count: 6 }
    ];

    this.renderCategoriesGrid(categories);
  }

  async loadInstalledPlugins() {
    try {
      console.log('[Store] 获取已安装插件 (installer.getInstalled)');
      const installedList = await this.api.invoke('installer.getInstalled');
      const installed = Array.isArray(installedList) ? installedList : [];

      // 同时获取当前已加载（运行时）的所有插件，用于合并显示本地/内置插件
      let runtimeList = [];
      try {
        runtimeList = await this.api.invoke('plugin.list');
      } catch (e) {
        console.warn('[Store] 获取运行时插件列表失败:', e && e.message);
      }
      const runtime = Array.isArray(runtimeList) ? runtimeList : [];

      // 合并：优先使用 installer.getInstalled 的条目（包含 installInfo/isLocal 等）
      const map = new Map();
      installed.forEach(p => map.set(p.id, { ...p }));
      runtime.forEach(p => {
        if (!map.has(p.id)) {
          map.set(p.id, {
            ...p,
            version: '1.0.0',
            isLocal: true
          });
        } else {
          // 合并补充图标 URL 等
          const cur = map.get(p.id);
          map.set(p.id, { ...p, ...cur, icon: cur.icon || p.icon, iconUrl: cur.iconUrl || p.iconUrl });
        }
      });

      this.installedPlugins = Array.from(map.values());
    } catch (error) {
      console.warn('[Store] installer.getInstalled 失败，降级使用 plugin.list:', error && error.message);
      try {
        const basicList = await this.api.invoke('plugin.list');
        this.installedPlugins = (basicList || []).map(plugin => ({
          ...plugin,
          version: '1.0.0',
          isLocal: true
        }));
      } catch (e2) {
        console.error('[Store] 降级获取基础插件列表失败:', e2);
        this.installedPlugins = [];
      }
    }
  }

  async checkUpdates() {
    try {
      console.log('[Store] 检查插件更新 (installer.checkUpdates)');
      const list = await this.api.invoke('installer.checkUpdates');
      this.updates = Array.isArray(list) ? list : [];
    } catch (error) {
      console.warn('[Store] 检查更新失败:', error && error.message);
      this.updates = [];
    }
    
    // 更新侧边栏的更新计数
    const updateCount = document.querySelector('.update-count');
    if (this.updates.length > 0) {
      updateCount.textContent = this.updates.length;
      updateCount.style.display = 'inline';
    } else {
      updateCount.style.display = 'none';
    }
  }

  async searchPlugins(keyword) {
    if (!keyword.trim()) {
      this.renderPluginGrid(this.plugins);
      return;
    }

    const filtered = this.plugins.filter(plugin => 
      plugin.name.toLowerCase().includes(keyword.toLowerCase()) ||
      plugin.description.toLowerCase().includes(keyword.toLowerCase()) ||
      plugin.author.toLowerCase().includes(keyword.toLowerCase())
    );

    this.renderPluginGrid(filtered);
  }

  renderPluginGrid(plugins) {
    const contentBody = document.getElementById('contentBody');
    
    if (plugins.length === 0) {
      contentBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📦</div>
          <div class="empty-title">没有找到插件</div>
          <div class="empty-description">尝试调整搜索条件或浏览不同分类</div>
        </div>
      `;
      return;
    }

    const pluginsHtml = plugins.map(plugin => {
      const isInstalled = this.installedPlugins.some(p => p.id === plugin.id);
      const actionButton = isInstalled ? 
        `<button class="btn btn-sm" disabled>已安装</button>` :
        `<button class="btn btn-sm primary" onclick="pluginStore.showPluginDetail('${plugin.id}')">安装</button>`;

      return `
        <div class="plugin-card" onclick="pluginStore.showPluginDetail('${plugin.id}')">
          <div class="plugin-header">
            <div class="plugin-icon">${plugin.icon}</div>
            <div class="plugin-info">
              <div class="plugin-name">${plugin.name}</div>
              <div class="plugin-author">by ${plugin.author}</div>
            </div>
          </div>
          <div class="plugin-description">${plugin.description}</div>
          <div class="plugin-footer">
            <div class="plugin-stats">
              <span>⭐ ${plugin.rating}</span>
              <span>📥 ${this.formatNumber(plugin.downloads)}</span>
              <span>v${plugin.version}</span>
            </div>
            <div class="plugin-actions" onclick="event.stopPropagation()">
              ${actionButton}
            </div>
          </div>
        </div>
      `;
    }).join('');

    contentBody.innerHTML = `<div class="plugins-grid">${pluginsHtml}</div>`;
  }

  renderInstalledGrid(plugins) {
    const contentBody = document.getElementById('contentBody');
    
    if (plugins.length === 0) {
      contentBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📦</div>
          <div class="empty-title">还没有安装任何插件</div>
          <div class="empty-description">去发现页面找找有趣的插件吧</div>
        </div>
      `;
      return;
    }

    // 添加顶部操作栏
    const headerActions = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 0 4px;">
        <div style="color: #666; font-size: 14px;">
          共 ${plugins.length} 个插件 (本地: ${plugins.filter(p => p.isLocal).length}, 已安装: ${plugins.filter(p => !p.isLocal).length})
        </div>
        <div style="display: flex; gap: 12px;">
          <button class="btn btn-sm" onclick="pluginStore.reloadPlugins()">
            <span style="margin-right: 4px;">🔄</span>重新加载
          </button>
          <button class="btn btn-sm" onclick="pluginStore.checkAllUpdates()">
            <span style="margin-right: 4px;">📦</span>检查更新
          </button>
        </div>
      </div>
    `;

    const pluginsHtml = plugins.map(plugin => {
      const hasUpdate = this.updates.some(u => u.pluginId === plugin.id);
      const updateBadge = hasUpdate ? `<span style="background: #ff3b30; color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 10px; margin-left: 8px;">有更新</span>` : '';
      
      return `
        <div class="installed-card" style="position: relative;">
          <div class="installed-icon">${plugin.icon || '🔧'}</div>
          <div class="installed-info">
            <div class="installed-name">${plugin.name}${updateBadge}</div>
            <div class="installed-version">
              v${plugin.version} ${plugin.isLocal ? '(本地开发)' : ''}
              <br><span style="font-size: 10px; color: #999;">${plugin.id}</span>
            </div>
            ${plugin.description ? `<div style="font-size: 12px; color: #666; margin-top: 4px;">${plugin.description}</div>` : ''}
          </div>
          <div class="installed-actions">
            ${hasUpdate ? `<button class="btn btn-sm primary" onclick="pluginStore.updatePlugin('${plugin.id}')" style="margin-right: 4px;">更新</button>` : ''}
            ${!plugin.isLocal ? `<button class="btn btn-sm" onclick="pluginStore.uninstallPlugin('${plugin.id}')">卸载</button>` : `<button class="btn btn-sm" disabled>本地插件</button>`}
          </div>
        </div>
      `;
    }).join('');

    contentBody.innerHTML = headerActions + `<div class="installed-grid">${pluginsHtml}</div>`;
  }

  renderUpdatesGrid(updates) {
    const contentBody = document.getElementById('contentBody');
    
    if (updates.length === 0) {
      contentBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✅</div>
          <div class="empty-title">所有插件都是最新版本</div>
          <div class="empty-description">没有可用的更新</div>
        </div>
      `;
      return;
    }

    // TODO: 渲染更新列表
    contentBody.innerHTML = `<div class="installed-grid"><!-- 更新列表 --></div>`;
  }

  renderCategoriesGrid(categories) {
    const contentBody = document.getElementById('contentBody');
    
    const categoriesHtml = categories.map(category => `
      <div class="plugin-card" onclick="pluginStore.browseCategory('${category.id}')">
        <div class="plugin-header">
          <div class="plugin-icon">${category.icon}</div>
          <div class="plugin-info">
            <div class="plugin-name">${category.name}</div>
            <div class="plugin-author">${category.count} 个插件</div>
          </div>
        </div>
      </div>
    `).join('');

    contentBody.innerHTML = `<div class="plugins-grid">${categoriesHtml}</div>`;
  }

  showPluginDetail(pluginId) {
    const plugin = this.plugins.find(p => p.id === pluginId);
    if (!plugin) return;

    const isInstalled = this.installedPlugins.some(p => p.id === plugin.id);
    
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const modalActionBtn = document.getElementById('modalActionBtn');

    modalTitle.textContent = plugin.name;
    modalBody.innerHTML = `
      <div style="display: flex; margin-bottom: 16px;">
        <div class="plugin-icon" style="margin-right: 16px;">${plugin.icon}</div>
        <div>
          <h3 style="margin: 0 0 4px 0;">${plugin.name}</h3>
          <p style="margin: 0; color: #666;">by ${plugin.author} • v${plugin.version}</p>
        </div>
      </div>
      <p style="margin-bottom: 16px;">${plugin.description}</p>
      <div style="display: flex; gap: 16px; margin-bottom: 16px; font-size: 14px; color: #666;">
        <span>⭐ ${plugin.rating} 评分</span>
        <span>📥 ${this.formatNumber(plugin.downloads)} 下载</span>
        <span>📦 ${plugin.category}</span>
      </div>
      ${plugin.changelog ? `<div style="margin-bottom: 16px;"><strong>更新日志:</strong><br>${plugin.changelog}</div>` : ''}
    `;

    if (isInstalled) {
      modalActionBtn.textContent = '已安装';
      modalActionBtn.disabled = true;
      modalActionBtn.classList.remove('primary');
    } else {
      modalActionBtn.textContent = '安装';
      modalActionBtn.disabled = false;
      modalActionBtn.classList.add('primary');
      modalActionBtn.onclick = () => this.installPlugin(plugin.id);
    }

    document.getElementById('pluginModal').style.display = 'flex';
  }

  closeModal() {
    document.getElementById('pluginModal').style.display = 'none';
  }

  async installPlugin(pluginId) {
    this.closeModal();
    this.showProgressModal('安装插件', '正在下载并安装插件...');

    try {
      console.log('[Store] 开始安装插件:', pluginId);
      await this.api.invoke('installer.install', { pluginId, version: 'latest' });
      // 安装完成后刷新运行时插件列表
      try { await this.api.invoke('plugin.reload'); } catch {}
      await this.loadInstalledPlugins();
      
      if (this.currentPage === 'discover') {
        this.renderPluginGrid(this.plugins);
      }
      
      this.showMessage('插件安装成功！', 'success');
    } catch (error) {
      this.showMessage(`安装失败: ${error.message}`, 'error');
    } finally {
      this.closeProgressModal();
    }
  }

  async uninstallPlugin(pluginId) {
    const plugin = this.installedPlugins.find(p => p.id === pluginId);
    if (!plugin) return;
    
    if (!confirm(`确定要卸载插件"${plugin.name}"吗？\n\n此操作不可恢复。`)) return;

    try {
      this.showProgressModal('卸载插件', '正在卸载插件...');
      
      // 传入实际目录名：优先从 installPath 推断
      const dirName = (plugin.installPath && plugin.installPath.split(/[/\\]/).pop()) || pluginId;
      await this.api.invoke('installer.uninstall', dirName);
      // 卸载后立刻刷新运行时插件列表，避免主输入框还能匹配到已卸载插件
      try { await this.api.invoke('plugin.reload'); } catch {}

      this.closeProgressModal();
      await this.loadInstalledPlugins();
      await this.checkUpdates();
      
      if (this.currentPage === 'installed') {
        this.renderInstalledGrid(this.installedPlugins);
      }
      
      this.showMessage(`插件"${plugin.name}"卸载成功！`, 'success');
    } catch (error) {
      this.closeProgressModal();
      this.showMessage(`卸载失败: ${error.message}`, 'error');
    }
  }

  async updatePlugin(pluginId) {
    const plugin = this.installedPlugins.find(p => p.id === pluginId);
    if (!plugin) return;

    try {
      this.showProgressModal('更新插件', '正在检查最新版本...');
      
      // 更新需传目录名
      const dirName = (plugin.installPath && plugin.installPath.split(/[/\\]/).pop()) || pluginId;
      const updated = await this.api.invoke('installer.update', { pluginId: dirName, version: 'latest' });

      this.closeProgressModal();
      await this.loadInstalledPlugins();
      await this.checkUpdates();
      
      if (this.currentPage === 'installed') {
        this.renderInstalledGrid(this.installedPlugins);
      }
      
      if (updated === false) {
        this.showMessage(`插件"${plugin.name}"已是最新版本`, 'success');
      } else {
        this.showMessage(`插件"${plugin.name}"更新成功！`, 'success');
      }
    } catch (error) {
      this.closeProgressModal();
      this.showMessage(`更新失败: ${error.message}`, 'error');
    }
  }

  async reloadPlugins() {
    try {
      this.showProgressModal('重新加载', '正在重新加载插件...');
      
      await this.api.invoke('plugin.reload');

      this.closeProgressModal();
      await this.loadInstalledPlugins();
      
      if (this.currentPage === 'installed') {
        this.renderInstalledGrid(this.installedPlugins);
      }
      
      this.showMessage('插件重新加载成功！', 'success');
    } catch (error) {
      this.closeProgressModal();
      this.showMessage(`重新加载失败: ${error.message}`, 'error');
    }
  }

  async checkAllUpdates() {
    try {
      this.showProgressModal('检查更新', '正在检查插件更新...');
      
      await this.checkUpdates();
      
      this.closeProgressModal();
      
      if (this.updates.length > 0) {
        this.showMessage(`发现 ${this.updates.length} 个插件更新`, 'info');
        if (this.currentPage === 'installed') {
          this.renderInstalledGrid(this.installedPlugins);
        }
      } else {
        this.showMessage('所有插件都是最新版本', 'success');
      }
    } catch (error) {
      this.closeProgressModal();
      this.showMessage(`检查更新失败: ${error.message}`, 'error');
    }
  }

  // 从文件安装功能迁移至“开发者工具”插件

  async simulateInstall(pluginId) {
    const steps = [
      { message: '正在下载插件包...', progress: 20 },
      { message: '验证插件包...', progress: 40 },
      { message: '解压插件文件...', progress: 60 },
      { message: '注册插件...', progress: 80 },
      { message: '安装完成', progress: 100 }
    ];

    for (const step of steps) {
      await new Promise(resolve => setTimeout(resolve, 500));
      this.updateProgress(step.message, step.progress);
    }
  }

  // 发现页的本地示例数据（注册中心不可用时回退）
  getMockPlugins() {
    return [
      {
        id: 'password-generator',
        name: '密码生成器',
        author: 'Security Team',
        description: '生成安全的随机密码，支持多种复杂度设置',
        version: '1.2.0',
        downloads: 15420,
        rating: 4.8,
        icon: '🔐',
        category: 'security',
        screenshots: ['screenshot1.png'],
        changelog: '修复了特殊字符生成的问题'
      },
      {
        id: 'color-picker',
        name: '取色器',
        author: 'Design Tools',
        description: '屏幕取色工具，支持多种颜色格式输出',
        version: '2.1.3',
        downloads: 8930,
        rating: 4.6,
        icon: '🎨',
        category: 'design',
        screenshots: ['screenshot1.png'],
        changelog: '新增 HSL 颜色格式支持'
      },
      {
        id: 'qr-generator',
        name: '二维码生成器',
        author: 'Utility Team',
        description: '快速生成二维码，支持文本、URL、WiFi等多种内容',
        version: '1.0.5',
        downloads: 12350,
        rating: 4.9,
        icon: '📱',
        category: 'utility',
        screenshots: ['screenshot1.png'],
        changelog: '优化生成速度和图片质量'
      },
      {
        id: 'markdown-editor',
        name: 'Markdown 编辑器',
        author: 'Editor Team',
        description: '功能强大的 Markdown 编辑器，支持实时预览和语法高亮',
        version: '3.2.1',
        downloads: 25670,
        rating: 4.7,
        icon: '📝',
        category: 'editor',
        screenshots: ['screenshot1.png'],
        changelog: '新增表格编辑功能'
      }
    ];
  }

  showProgressModal(title, message) {
    document.getElementById('progressTitle').textContent = title;
    document.getElementById('progressMessage').textContent = message;
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('progressModal').style.display = 'flex';
  }

  updateProgress(message, progress) {
    document.getElementById('progressMessage').textContent = message;
    document.getElementById('progressBar').style.width = progress + '%';
    document.getElementById('progressPercent').textContent = progress + '%';
  }

  closeProgressModal() {
    document.getElementById('progressModal').style.display = 'none';
  }

  showLoading() {
    document.getElementById('contentBody').innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        加载中...
      </div>
    `;
  }

  showError(message) {
    document.getElementById('contentBody').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">❌</div>
        <div class="empty-title">加载失败</div>
        <div class="empty-description">${message}</div>
      </div>
    `;
  }

  showMessage(message, type = 'info') {
    // 创建消息提示元素
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      z-index: 10000;
      max-width: 300px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      transform: translateX(100%);
      transition: transform 0.3s ease;
    `;
    
    // 根据类型设置颜色
    const colors = {
      success: '#28a745',
      error: '#dc3545',
      warning: '#ffc107',
      info: '#007aff'
    };
    
    toast.style.backgroundColor = colors[type] || colors.info;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // 显示动画
    setTimeout(() => {
      toast.style.transform = 'translateX(0)';
    }, 100);
    
    // 自动隐藏
    setTimeout(() => {
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => {
        document.body.removeChild(toast);
      }, 300);
    }, 3000);
  }

  async refreshCurrentPage() {
    await this.loadPage(this.currentPage);
  }

  browseCategory(categoryId) {
    // TODO: 实现分类浏览
    console.log('Browse category:', categoryId);
  }

  formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }
}

// 全局实例
let pluginStore;

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', () => {
  pluginStore = new PluginStore();
});
