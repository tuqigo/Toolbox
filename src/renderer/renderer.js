const { ipcRenderer } = require('electron');
const { isValidJson } = require('../utils/jsonUtils');

class MiniToolboxRenderer {
  constructor() {
    this.searchInput = null;
    this.resultsList = null;
    this.editArea = null;
    this.editTextarea = null;
    this.saveButton = null;
    this.cancelButton = null;
    
    // 胶囊相关元素
    this.contentCapsule = null;
    this.capsuleContent = null;
    this.capsuleText = null;
    this.capsuleIcon = null;
    this.inputDisplay = null;
    
    this.currentContentAnalysis = null;
    this.selectedIndex = -1;
    this.lastInlineJsonContent = null; // 最近一次内联的 JSON 文本
    this.ignoreNextClipboardChange = false; // 忽略下一次剪贴板变化的标记
    this.clipboardIgnoreTimeout = null; // 忽略超时定时器
    
    // 输入内容管理
    this.lastInputTime = 0; // 上次输入时间
    this.inputClearTimeout = null; // 清除输入的超时定时器
    this.autoFillEnabled = true; // 是否启用自动填充
    
    // 内容管理
    this.actualContent = ''; // 实际的完整内容
    this.isEditingMode = false; // 是否处于编辑模式（本地状态）
    
    // 胶囊状态管理
    this.capsuleMode = false; // 是否处于胶囊模式
    this.capsuleData = null; // 胶囊数据
    this.filterText = ''; // 筛选文本
    
    // 拖拽状态管理
    this._isDragging = false;
    
    // 待处理的剪贴板内容
    this.pendingClipboardContent = null;
    
    // 响应式尺寸缓存
    this.responsiveSizes = null;
    
    this.init();
  }

  init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.initElements());
    } else {
      this.initElements();
    }
  }

  initElements() {
    this.searchInput = document.getElementById('searchInput');
    this.resultsList = document.getElementById('resultsList');
    this.editArea = document.getElementById('editArea');
    this.editTextarea = document.getElementById('editTextarea');
    this.saveButton = document.getElementById('saveButton');
    this.cancelButton = document.getElementById('cancelButton');
    
    // 胶囊相关元素
    this.contentCapsule = document.getElementById('contentCapsule');
    this.capsuleContent = document.getElementById('capsuleContent');
    this.capsuleText = document.getElementById('capsuleText');
    this.capsuleIcon = document.getElementById('capsuleIcon');
    this.inputDisplay = document.getElementById('inputDisplay');

    if (!this.searchInput || !this.resultsList) {
      console.error('关键元素未找到！');
      return;
    }

    // 初始化响应式尺寸
    this.initResponsiveSizes();

    this.setupEventListeners();

    // 监听主题变化，应用到主输入框
    try {
      ipcRenderer.on('ui-theme', (_e, payload) => {
        this.applyTheme(payload);
      });
    } catch {}
  }

  setupEventListeners() {
    // 输入事件
    this.searchInput.addEventListener('input', () => {
      this.lastInputTime = Date.now(); // 记录输入时间
      this.autoFillEnabled = false; // 用户手动输入时禁用自动填充
      
      if (this.capsuleMode) {
        // 胶囊模式下，输入的是筛选文本
        this.filterText = this.searchInput.value;
        this.performSearchWithCapsule();
      } else {
        // 普通模式
        this.actualContent = this.searchInput.value;
        this.performSearch();
      }
    });

    // 键盘事件
    this.searchInput.addEventListener('keydown', (e) => {
      this.handleKeydown(e);
    });

    // 粘贴事件
    this.searchInput.addEventListener('paste', (e) => {
      this.handlePaste(e);
    });

    // 拖放事件
    this.searchInput.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    this.searchInput.addEventListener('drop', (e) => {
      this.handleFileDrop(e);
    });

    // 窗口获得焦点时的处理
    window.addEventListener('focus', () => {
      // 重置自动填充状态，允许重新自动填充剪贴板内容
      this.autoFillEnabled = true;
      
      // 如果有待处理的剪贴板内容且输入框为空，优先使用
      if (this.pendingClipboardContent && !this.actualContent.trim()) {
        this.setContent(this.pendingClipboardContent, false);
        this.pendingClipboardContent = null;
      } else {
        this.focusInput();
      }
    });

    // 窗口失去焦点时的处理
    window.addEventListener('blur', () => {
      // 如果不在编辑模式，延迟一点时间后隐藏窗口
      if (!this.isEditingMode) {
        setTimeout(() => {
          // 再次检查是否仍然失去焦点且不在编辑模式
          if (!document.hasFocus() && !this.isEditingMode) {
            // 隐藏窗口前清除内容
            this.clearContent();
            try {
              ipcRenderer.send('hide-main-window');
            } catch {}
          }
        }, 150);
      }
    });

    // 点击窗口空白区域时隐藏主窗口（不在输入框或结果列表上）
    document.addEventListener('mousedown', (e) => {
      try {
        // 如果正在拖拽，不隐藏窗口
        if (this._isDragging) return;
        
        const target = e.target;
        const inInput = this.searchInput && (target === this.searchInput || this.searchInput.contains(target));
        const inResults = this.resultsList && (target === this.resultsList || this.resultsList.contains(target));
        const inEditArea = this.editArea && (target === this.editArea || this.editArea.contains(target));
        const inCapsule = this.contentCapsule && (target === this.contentCapsule || this.contentCapsule.contains(target));
        
        if (!inInput && !inResults && !inEditArea && !inCapsule) {
          // 记录隐藏时间，用于判断是否需要清除输入
          this.lastInputTime = Date.now();
          // 隐藏窗口前清除内容
          this.clearContent();
          ipcRenderer.send('hide-main-window');
        }
      } catch {}
    });

    // IPC 监听器
    ipcRenderer.on('clipboard-changed', (event, content) => {
      this.handleClipboardChange(content);
    });

    ipcRenderer.on('plugins-reloaded', () => {
      this.performSearch(); // 重新搜索以更新插件列表
    });

    // 清除输入框内容
    ipcRenderer.on('clear-input', () => {
      this.clearContent();
      this.autoFillEnabled = true; // 重置自动填充状态
    });

    // 接收插件列表结果
    ipcRenderer.on('plugin-list-results', (_e, payload) => {
      try {
        const { pluginId, items, inputData } = payload || {};
        
        this.renderPluginListResults(pluginId, items, inputData);
      } catch (error) {
        console.error('处理插件列表结果失败:', error);
      }
    });

    // 处理插件重定向
    ipcRenderer.on('plugin-redirect', (_e, payload) => {
      try {
        const { targetPluginId, content } = payload || {};
        this.handlePluginRedirect(targetPluginId, content);
      } catch (error) {
        console.error('处理插件重定向失败:', error);
      }
    });

    // 接收无UI插件的返回并按插件路由策略展示
    ipcRenderer.on('headless-plugin-result', (_e, payload) => {
      try {
        const { fromPluginId, result, route } = payload || {};
        
        // 处理新的结果格式
        let text, message, success = true;
        if (typeof result === 'string') {
          text = result;
          message = '处理完成';
        } else if (result && typeof result === 'object') {
          text = result.result || result.text || result.data || result.body || '';
          message = result.message || '处理完成';
          success = result.success !== false;
        }
        
        if (!text && !message) return;

        const trimmed = String(text).trim();
        const isJson = isValidJson(trimmed);

        const target = route && route.target;
        const mode = route && route.mode; // open_if_json | always_open | inline_only
        const fallback = route && route.fallback; // inline | input
        const inlineFirst = route && route.inlineFirst; // true: 首次内联展示，再次点击时若为 JSON 再跳转

        const openTarget = () => {
          const targetId = target || 'json-formatter';
          const card = this.resultsList.querySelector(`.result-item[data-plugin-id="${targetId}"]`);
          this.currentContentAnalysis = { content: trimmed, type: isJson ? 'json' : 'text', length: trimmed.length, lines: trimmed.split('\n').length };
          if (card) {
            this.executeSelectedPlugin(card);
          } else if (this.searchInput) {
            this.searchInput.value = trimmed;
            this.performSearch();
          }
        };

        // 优先内联一次的策略
        if (inlineFirst) {
          const card = this.resultsList.querySelector(`.result-item[data-plugin-id="${fromPluginId}"]`);
          const hasInline = !!(card && card.querySelector('.inline-result'));
          if (!hasInline) {
            this.renderInlineResult(fromPluginId, trimmed, isJson, { message, success });
            return;
          }
          // 已有内联，再次点击时按照 open_if_json/always_open 逻辑
        }

        if (mode === 'always_open' || (mode === 'open_if_json' && isJson)) {
          openTarget();
          return;
        }

        if (mode === 'inline' || mode === 'inline_only' || fallback === 'inline') {
          this.renderInlineResult(fromPluginId, trimmed, isJson, { message, success });
        } else {
          if (this.searchInput) { this.searchInput.value = trimmed; this.performSearch(); }
        }
      } catch {}
    });

    // 窗口拖拽功能
    this.setupWindowDragging();

    // 胶囊图标编辑功能事件监听器
    if (this.capsuleIcon) {
      this.capsuleIcon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // 只有文本胶囊可以编辑
        if (this.capsuleMode && this.capsuleData && this.capsuleData.type === 'text') {
          this.showEditArea();
        }
      });
    }

    // 多行文本相关事件监听器已删除

    if (this.saveButton) {
      this.saveButton.addEventListener('click', () => {
        this.saveMultilineContent();
      });
    }

    if (this.cancelButton) {
      this.cancelButton.addEventListener('click', () => {
        this.hideEditArea();
      });
    }

    if (this.editTextarea) {
      this.editTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.hideEditArea();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          this.saveMultilineContent();
        }
      });
    }

    // 初始化时自动聚焦
    setTimeout(() => {
      this.focusInput();
    }, 100);
  }

  async focusInput() {
    // 检查是否需要清除输入内容（超过3秒）
    const now = Date.now();
    const timeSinceLastInput = now - this.lastInputTime;
    
    if (timeSinceLastInput > 5000 && this.actualContent.trim()) {
      // 超过5秒且有内容，清除输入
      this.clearContent();
      this.autoFillEnabled = true; // 重置自动填充状态
    }
    
    // 聚焦到输入框
    if (this.searchInput) {
      this.searchInput.focus();
      this.searchInput.select();
    }
    
    // 只有在启用自动填充且输入框为空时才自动填充剪贴板内容
    if (this.autoFillEnabled && !this.actualContent.trim()) {
      await this.autoFillClipboard();
    }
  }

  async autoFillClipboard() {
    try {
      // 获取配置信息
      const config = await ipcRenderer.invoke('get-clipboard-config');
      
      // 使用新的最近剪贴板内容API（带时间限制）
      const recentClipboard = await ipcRenderer.invoke('get-recent-clipboard');
      
      if (recentClipboard && recentClipboard.trim()) {
        this.setContent(recentClipboard, false); // 剪贴板内容不是手动输入
        this.autoFillEnabled = false; // 禁用自动填充，避免重复填充
        
        console.log(`自动填充剪贴板内容 (最大时间: ${config.autoFillMaxAge}秒):`, recentClipboard.substring(0, 50));
      } else {
        // 如果没有符合时间条件的剪贴板内容，就不自动填充
        // 这样可以确保时间限制的有效性
        if (process.env.NODE_ENV === 'development') {
          console.log(`没有符合时间条件(${config.autoFillMaxAge}秒)的剪贴板内容，跳过自动填充`);
        }
      }
    } catch (error) {
      console.error('获取最近剪贴板内容失败:', error);
      
      // 只有在API调用失败时才降级到原始方法
      try {
        const clipboardContent = await ipcRenderer.invoke('get-clipboard');
        
        if (clipboardContent && clipboardContent.trim()) {
          this.setContent(clipboardContent, false); // 剪贴板内容不是手动输入
          this.autoFillEnabled = false; // 禁用自动填充
          console.log('使用降级方法自动填充剪贴板内容（API调用失败）');
        }
      } catch (fallbackError) {
        console.error('降级获取剪贴板内容也失败:', fallbackError);
      }
    }
  }

  handleClipboardChange(content) {
    // 如果设置了忽略标记，则跳过这次剪贴板变化
    if (this.ignoreNextClipboardChange) {
      this.ignoreNextClipboardChange = false;
      if (this.clipboardIgnoreTimeout) {
        clearTimeout(this.clipboardIgnoreTimeout);
        this.clipboardIgnoreTimeout = null;
      }
      return;
    }
    
    if (content && content.trim()) {
      // 存储剪贴板内容，当窗口获得焦点时使用
      this.pendingClipboardContent = content;
      
      // 如果窗口有焦点且输入框为空，立即处理
      if (document.hasFocus() && !this.actualContent.trim()) {
        this.setContent(content, false);
        this.pendingClipboardContent = null;
      }
    }
  }

  // 设置忽略下一次剪贴板变化（用于插件复制操作）
  setIgnoreNextClipboardChange() {
    this.ignoreNextClipboardChange = true;
    
    // 设置超时，防止标记永久生效
    if (this.clipboardIgnoreTimeout) {
      clearTimeout(this.clipboardIgnoreTimeout);
    }
    this.clipboardIgnoreTimeout = setTimeout(() => {
      this.ignoreNextClipboardChange = false;
      this.clipboardIgnoreTimeout = null;
    }, 2000); // 2秒后自动清除标记
  }

  handlePaste(e) {
    e.preventDefault();
    
    const clipboardData = e.clipboardData || window.clipboardData;
    
    // 处理文件
    if (clipboardData.files && clipboardData.files.length > 0) {
      const file = clipboardData.files[0];
      const filePath = file.path || file.name;
      this.setContent(filePath, false); // 使用setContent处理文件路径
      return;
    }
    
    // 处理文本
    const pastedText = clipboardData.getData('text/plain');
    if (pastedText) {
      this.setContent(pastedText, false); // 粘贴内容不是手动输入
    }
  }

  handleFileDrop(e) {
    e.preventDefault();
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const filePath = file.path || file.name;
      this.setContent(filePath, false); // 使用setContent处理文件路径
    } else {
      const droppedText = e.dataTransfer.getData('text/plain');
      if (droppedText) {
        this.setContent(droppedText, false); // 拖拽内容不是手动输入
      }
    }
  }

  handleKeydown(e) {
    const results = this.resultsList.querySelectorAll('.result-item:not(.no-results)');
    
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.clearContent();
        ipcRenderer.send('hide-main-window');
        break;
        
      case 'ArrowDown':
        e.preventDefault();
        if (results.length > 0) {
          this.selectedIndex = Math.min(this.selectedIndex + 1, results.length - 1);
          this.updateSelection();
        }
        break;
        
      case 'ArrowUp':
        e.preventDefault();
        if (results.length > 0) {
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.updateSelection();
        }
        break;
        
      case 'Enter':
        e.preventDefault();
        if (this.selectedIndex >= 0 && results.length > 0) {
          const selectedResult = results[this.selectedIndex];
          this.executeSelectedPlugin(selectedResult);
        }
        break;
        
      case 'Backspace':
        // 在胶囊模式下，如果输入框为空，删除胶囊
        if (this.capsuleMode && this.searchInput.value === '' && this.searchInput.selectionStart === 0) {
          e.preventDefault();
          this.deleteCapsule();
        }
        break;
    }
  }

  updateSelection() {
    const results = this.resultsList.querySelectorAll('.result-item:not(.no-results)');
    
    results.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.classList.add('selected');
        // 自动滚动到选中项，确保其在可见区域内
        item.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest'
        });
      } else {
        item.classList.remove('selected');
      }
    });
  }

  async performSearch() {
    const query = this.actualContent.trim();
    
    if (!query) {
      const resultsContainer = document.getElementById('resultsContainer');
      this.resultsList.innerHTML = '';
      this.selectedIndex = -1;
      
      // 隐藏结果容器
      if (resultsContainer) {
        resultsContainer.style.display = 'none';
      }
      return;
    }

    try {
      // 使用新的内容分析系统
      const contentAnalysis = await ipcRenderer.invoke('analyze-content', query);
      if (process.env.NODE_ENV === 'development') console.log('渲染进程 - 内容分析结果:', contentAnalysis);
      
      // 不再展示右侧类型指示，仅在内部使用

      // 获取匹配的插件
      const matchedPlugins = await ipcRenderer.invoke('match-plugins', contentAnalysis);
      if (process.env.NODE_ENV === 'development') console.log('渲染进程 - 匹配到的插件:', matchedPlugins);
      
      // 显示结果
      this.displayResults(matchedPlugins);
      
      // 保存当前内容分析结果
      this.currentContentAnalysis = contentAnalysis;
      
      // 重置选择
      this.selectedIndex = matchedPlugins.length > 0 ? 0 : -1;
      this.updateSelection();
      
    } catch (error) {
      console.error('搜索失败:', error);
      this.showError('搜索失败，请重试');
    }
  }

  showContentType(type) { /* 已移除类型指示 */ }

  applyTheme(payload) {
    try {
      const eff = (payload && payload.effective) || 'light';
      const pll = (payload && payload.palette) || {};
      const root = document.documentElement;
      const bg = eff === 'dark' ? '#0f1113' : 'transparent';
      root.style.setProperty('--mt-bg', bg);
      root.style.setProperty('--mt-panel', pll.panel || (eff==='dark' ? '#2b2d31' : 'rgba(255,255,255,0.95)'));
      root.style.setProperty('--mt-fg', pll.fg || (eff==='dark' ? '#e6e7ea' : '#333'));
      root.style.setProperty('--mt-border', pll.border || (eff==='dark' ? '#3a3b41' : 'rgba(0,0,0,0.08)'));
      // 调整 hover 对比度，并新增强 hover 变量，提升暗黑/明亮模式下的可感知度
      root.style.setProperty('--mt-hover', pll.hover || (eff==='dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'));
      root.style.setProperty('--mt-hover-strong', pll.hoverStrong || (eff==='dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'));
      root.style.setProperty('--mt-selected', pll.selected || (eff==='dark' ? 'rgba(0,122,255,0.22)' : 'rgba(0,122,255,0.12)'));
      root.style.setProperty('--mt-iconbg', pll.iconBg || (eff==='dark' ? '#3a3b41' : '#f1f1f3'));
      root.style.setProperty('--mt-scrollbar-thumb', eff==='dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)');
      root.style.setProperty('--mt-scrollbar-thumb-hover', eff==='dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)');
      root.style.setProperty('--mt-scrollbar-track', eff==='dark' ? 'rgba(255,255,255,0.06)' : 'transparent');
      root.style.setProperty('--mt-text-muted', pll.fgMuted || (eff==='dark' ? '#a1a1aa' : '#666'));
      // 应用到已有面板
      const container = document.querySelector('.container');
      const results = document.querySelector('.results-container');
      if (container) container.style.background = 'transparent';
      if (results) {
        results.style.background = 'var(--mt-panel)';
        results.style.borderColor = 'var(--mt-border)';
      }
      const sbox = document.querySelector('.search-box');
      if (sbox) {
        sbox.style.background = 'var(--mt-panel)';
        sbox.style.borderColor = 'var(--mt-border)';
      }
      const input = document.getElementById('searchInput');
      if (input) input.style.color = 'var(--mt-fg)';
      // 列表项前景色与图标底色
      document.querySelectorAll('.result-title').forEach(el => el.style.color = 'var(--mt-fg)');
      document.querySelectorAll('.result-description').forEach(el => el.style.color = 'var(--mt-text-muted)');
      document.querySelectorAll('.result-icon').forEach(el => el.style.background = 'var(--mt-iconbg)');
    } catch {}
  }

  getTypeDisplayName(type) {
    const typeNames = {
      'text': '文本',
      'url': '链接', 
      'file': '文件',
      'image': '图片',
      'json': 'JSON',
      'email': '邮箱',
      'number': '数字',
      'long-text': '长文本',
      'empty': '空'
    };
    return typeNames[type] || type;
  }

  displayResults(plugins) {
    const resultsContainer = document.getElementById('resultsContainer');
    
    if (!plugins || plugins.length === 0) {
      this.showNoResults();
      return;
    }

    const resultsHTML = plugins.map((plugin, index) => {
      // 如果有 featureCode，显示 feature 信息；否则显示插件信息
      const displayTitle = plugin.featureExplain || plugin.name;
      const displayDescription = plugin.featureCode ? 
        `${plugin.name} - ${plugin.description}` : 
        plugin.description;
      
      return `
        <div class="result-item" 
             data-plugin-id="${plugin.id}" 
             data-feature-code="${plugin.featureCode || ''}" 
             data-matched-by="${plugin.matchedBy || ''}" 
             data-has-ui="${plugin.hasUi ? 'true' : 'false'}" 
             data-index="${index}">
          <div class="result-icon">${plugin.icon}</div>
          <div class="result-content">
            <div class="result-title">${displayTitle}</div>
            <div class="result-description">${displayDescription}</div>
            ${plugin.featureCode ? `<div class="feature-code">${plugin.featureCode}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    this.resultsList.innerHTML = resultsHTML;
    
    // 显示结果容器
    if (resultsContainer) {
      resultsContainer.style.display = 'block';
    }

    // 添加点击事件和鼠标悬停事件
    this.resultsList.querySelectorAll('.result-item').forEach((item, index) => {
      item.addEventListener('click', (e) => {
        // 如果点击发生在该卡片内部的列表区域，则不触发执行插件，避免覆盖 handleSelect 结果
        if (e && e.target && e.target.closest && e.target.closest('.plugin-list-results')) {
          return;
        }
        this.executeSelectedPlugin(item);
      });
      
      // 鼠标悬停时更新选中状态
      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });
    });
  }

  showNoResults() {
    const resultsContainer = document.getElementById('resultsContainer');
    
    this.resultsList.innerHTML = `
      <div class="result-item no-results">
        <div class="result-icon">🔍</div>
        <div class="result-content">
          <div class="result-title">未找到匹配的插件</div>
          <div class="result-description">尝试输入其他内容或安装更多插件</div>
        </div>
      </div>
    `;
    
    // 显示结果容器
    if (resultsContainer) {
      resultsContainer.style.display = 'block';
    }
  }

  showError(message) {
    this.resultsList.innerHTML = `
      <div class="result-item error">
        <div class="result-icon">❌</div>
        <div class="result-content">
          <div class="result-title">错误</div>
          <div class="result-description">${message}</div>
        </div>
      </div>
    `;
  }

  renderInlineResult(pluginId, content, isJson, options = {}) {
    try {
      const card = this.resultsList.querySelector(`.result-item[data-plugin-id="${pluginId}"]`);
      if (!card) {
        if (this.searchInput) { this.searchInput.value = content; this.performSearch(); }
        return;
      }
      let panel = card.querySelector('.inline-result');
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'inline-result';
        panel.style.marginTop = '6px';
        panel.style.padding = '8px';
        panel.style.border = '1px solid rgba(0,0,0,0.06)';
        panel.style.borderRadius = '6px';
        panel.style.background = 'rgba(0,0,0,0.03)';
        
        // 添加消息显示区域
        const messageEl = document.createElement('div');
        messageEl.className = 'inline-result-message';
        messageEl.style.margin = '0 0 6px 0';
        messageEl.style.fontSize = '12px';
        messageEl.style.fontWeight = 'bold';
        
        const contentEl = document.createElement('pre');
        contentEl.className = 'inline-result-content';
        contentEl.style.margin = '0 0 6px 0';
        contentEl.style.whiteSpace = 'pre-wrap';
        contentEl.style.wordBreak = 'break-word';
        
        const btnRow = document.createElement('div');
        btnRow.className = 'inline-result-actions';
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '复制';
        copyBtn.style.marginRight = '8px';
        const openJsonBtn = document.createElement('button');
        openJsonBtn.textContent = '在 JSON 插件中打开';
        btnRow.appendChild(copyBtn);
        btnRow.appendChild(openJsonBtn);
        
        panel.appendChild(messageEl);
        panel.appendChild(contentEl);
        panel.appendChild(btnRow);
        card.querySelector('.result-content').appendChild(panel);

        copyBtn.addEventListener('click', async () => {
          try { await ipcRenderer.invoke('write-clipboard', content); } catch {}
        });
        const openJson = () => {
          const jsonPluginId = 'json-formatter';
          const jsonCard = this.resultsList.querySelector(`.result-item[data-plugin-id="${jsonPluginId}"]`);
          this.currentContentAnalysis = { content, type: 'json', length: content.length, lines: String(content).split('\n').length };
          if (jsonCard) {
            this.executeSelectedPlugin(jsonCard);
          } else {
            if (this.searchInput) { this.searchInput.value = content; this.performSearch(); }
          }
        };
        openJsonBtn.addEventListener('click', openJson);
        // 点击内容区域也可打开 JSON 插件
        contentEl.addEventListener('click', () => { if (isJson) openJson(); });
      }
      
      // 更新消息显示
      const messageEl = panel.querySelector('.inline-result-message');
      const { message = '处理完成', success = true } = options;
      if (messageEl) {
        messageEl.textContent = message;
        messageEl.style.color = success ? '#28a745' : '#dc3545';
      }
      
      // 更新内容显示
      const contentEl = panel.querySelector('.inline-result-content');
      if (content) {
        contentEl.textContent = isJson ? this.prettyJson(content) : content;
        contentEl.style.display = 'block';
      } else {
        contentEl.style.display = 'none';
      }
      
      panel.style.display = 'block';
      if (isJson && content) this.lastInlineJsonContent = content;
    } catch {}
  }

  prettyJson(s) {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  }

  // 渲染插件列表结果
  renderPluginListResults(pluginId, items, inputData) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[RENDERER] 渲染插件列表结果:`, {
        pluginId,
        itemCount: items?.length || 0,
        items: items
      });
    }
    
    const card = this.resultsList.querySelector(`.result-item[data-plugin-id="${pluginId}"]`);
    if (!card) {
      console.log(`[RENDERER] 找不到插件卡片: ${pluginId}`);
      return;
    }

    // 移除现有的列表结果
    const existingList = card.querySelector('.plugin-list-results');
    if (existingList) {
      if (process.env.NODE_ENV === 'development') console.log(`[RENDERER] 移除现有列表结果`);
      existingList.remove();
    }

    if (!items || items.length === 0) return;

    // 创建列表容器
    const listContainer = document.createElement('div');
    listContainer.className = 'plugin-list-results';
    listContainer.style.marginTop = '8px';
    listContainer.style.maxHeight = '300px';
    listContainer.style.overflowY = 'auto';

    // 渲染列表项
    items.forEach((item, index) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'list-item';
      itemEl.style.padding = '8px 12px';
      itemEl.style.borderBottom = index < items.length - 1 ? '1px solid var(--mt-border)' : 'none';
      // 交互控制：默认可点击，若明确 canClick===false 则禁用
      const isClickable = item.canClick !== false;
      itemEl.style.cursor = isClickable ? 'pointer' : 'not-allowed';
      itemEl.style.transition = 'background-color 0.2s';

      // 悬停效果：可点击使用强 hover，不可点击弱化并去除悬停背景
      itemEl.addEventListener('mouseenter', () => {
        if (isClickable) {
          itemEl.style.background = 'var(--mt-hover-strong)';
        } else {
          itemEl.style.background = 'transparent';
        }
      });
      itemEl.addEventListener('mouseleave', () => {
        itemEl.style.background = 'transparent';
      });
      itemEl.addEventListener('click', (e) => {
        // 阻止冒泡，避免触发外层卡片的点击（执行插件）
        if (e && e.stopPropagation) e.stopPropagation();
        if (!isClickable) return;
        this.handleListItemSelect(pluginId, item, inputData);
      });

      const titleEl = document.createElement('div');
      titleEl.style.fontWeight = '500';
      titleEl.style.fontSize = '13px';
      titleEl.style.color = 'var(--mt-fg)';
      titleEl.style.marginBottom = '2px';
      titleEl.textContent = item.title || '';

      const descEl = document.createElement('div');
      descEl.style.fontSize = '12px';
      descEl.style.color = 'var(--mt-text-muted)';
      descEl.style.wordBreak = 'break-word';
      descEl.textContent = item.description || '';
      
      // 不可点击的视觉区分
      if (!isClickable) {
        itemEl.style.opacity = '0.6';
        titleEl.style.color = 'var(--mt-text-muted)';
      }

      itemEl.appendChild(titleEl);
      itemEl.appendChild(descEl);
      listContainer.appendChild(itemEl);
    });

    card.querySelector('.result-content').appendChild(listContainer);
  }

  // 处理列表项选择
  handleListItemSelect(pluginId, itemData, inputData) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[RENDERER] 点击列表项:`, {
        pluginId,
        itemData: itemData,
        inputData: inputData
      });
    }
    
    // 发送选择事件：优先遵循 canClick 逻辑；可点击时放宽对 data 的限制，交由插件端决定
    const canClick = itemData && itemData.canClick !== false;
    if (!canClick) return;
    ipcRenderer.send('plugin-list-select', pluginId, itemData, inputData);
  }

  // 处理插件重定向
  handlePluginRedirect(targetPluginId, content) {
    // 查找目标插件
    const targetCard = this.resultsList.querySelector(`.result-item[data-plugin-id="${targetPluginId}"]`);
    if (targetCard) {
      // 设置内容分析
      this.currentContentAnalysis = { 
        content: content, 
        type: this.detectContentType(content), 
        length: content.length, 
        lines: String(content).split('\n').length 
      };
      
      // 执行目标插件
      this.executeSelectedPlugin(targetCard);
    } else {
      // 如果目标插件不在当前结果中，更新搜索内容并重新搜索
      if (this.searchInput) {
        this.searchInput.value = content;
        this.performSearch();
        
        // 等待搜索完成后自动执行目标插件
        setTimeout(() => {
          const newTargetCard = this.resultsList.querySelector(`.result-item[data-plugin-id="${targetPluginId}"]`);
          if (newTargetCard) {
            this.executeSelectedPlugin(newTargetCard);
          }
        }, 500);
      }
    }
  }

  // 检测内容类型（简化版）
  detectContentType(content) {
    const trimmed = (content || '').trim();
    if (!trimmed) return 'text';
    
    // 检测JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        return 'json';
      } catch {}
    }
    
    // 检测URL
    if (/^https?:\/\//.test(trimmed)) {
      return 'url';
    }
    
    // 检测邮箱
    if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmed)) {
      return 'email';
    }
    
    return 'text';
  }

  executeSelectedPlugin(resultElement) {
    const pluginId = resultElement.dataset.pluginId;
    const featureCode = resultElement.dataset.featureCode || '';
    const matchedBy = resultElement.dataset.matchedBy || '';
    const hasUi = resultElement.dataset.hasUi === 'true';
    
    if (!pluginId || !this.currentContentAnalysis) {
      console.error('无法执行插件: 缺少必要信息');
      return;
    }

    // 构造输入数据 - 只传递可序列化的基本数据
    const base = this.currentContentAnalysis || { content: '', type: 'text', length: 0, lines: 0 };
    let contentToSend = matchedBy === 'command' ? '' : this.actualContent;
    // 若打开的是 JSON 插件，优先使用最近一次内联 JSON 作为内容
    if (pluginId === 'json-formatter' && this.lastInlineJsonContent) {
      contentToSend = this.lastInlineJsonContent;
    }
    const inputData = {
      content: contentToSend,
      type: base.type,
      length: contentToSend.length,
      lines: String(contentToSend).split('\n').length,
      timestamp: Date.now(),
      inputMode: matchedBy || 'content',
      // 新增 feature 信息
      featureCode: featureCode
    };

    if (process.env.NODE_ENV === 'development') console.log('执行插件:', pluginId, '功能:', featureCode, inputData);

    // 点击某个feature后，仅保留该feature卡片，隐藏其他结果
    this.showOnlyFeatureCard(pluginId, featureCode);

    // 发送执行插件请求
    ipcRenderer.send('execute-plugin', pluginId, inputData);

    // 仅当插件有UI时才隐藏主窗口；无UI时保留窗口以便内联结果展示
    if (hasUi) {
      ipcRenderer.send('hide-main-window');
    }
  }

  // 仅保留指定feature的卡片
  showOnlyFeatureCard(pluginId, featureCode) {
    try {
      const all = this.resultsList.querySelectorAll('.result-item');
      all.forEach(el => {
        if (el.dataset) {
          // 如果是不同的插件，直接移除
          if (el.dataset.pluginId !== pluginId) {
            el.remove();
            return;
          }
          
          // 如果是同一个插件但不同的feature，也移除
          const cardFeatureCode = el.dataset.featureCode || '';
          if (featureCode && cardFeatureCode && cardFeatureCode !== featureCode) {
            el.remove();
            return;
          }
          
          // 如果当前选中的feature有featureCode，但某个卡片没有featureCode（老式插件），也移除
          if (featureCode && !cardFeatureCode) {
            el.remove();
            return;
          }
        }
      });
      
      // 重置选中态为首项（唯一项）
      this.selectedIndex = 0;
      this.updateSelection();
    } catch (error) {
      console.warn('showOnlyFeatureCard error:', error);
    }
  }

  // 兼容性：保留原有的showOnlyPluginCard方法，用于没有featureCode的场景
  showOnlyPluginCard(pluginId) {
    this.showOnlyFeatureCard(pluginId, null);
  }

  renderInlineResult(fromPluginId, text, isJson) {
    const resultsContainer = document.getElementById('resultsContainer');
    const resultsList = document.getElementById('resultsList');

    // 移除所有现有结果
    resultsList.innerHTML = '';
    this.selectedIndex = -1;

    // 显示结果容器
    if (resultsContainer) {
      resultsContainer.style.display = 'block';
    }

    // 创建内联结果项
    const inlineResultHTML = `
      <div class="result-item inline-result" data-plugin-id="${fromPluginId}" data-matched-by="inline">
        <div class="result-icon">${this.getTypeIcon(isJson ? 'json' : 'text')}</div>
        <div class="result-content">
          <div class="result-title">${this.getTypeDisplayName(isJson ? 'json' : 'text')}</div>
          <div class="result-description">${text}</div>
        </div>
      </div>
    `;
    resultsList.innerHTML = inlineResultHTML;

    // 添加点击事件
    resultsList.querySelector('.inline-result').addEventListener('click', () => {
      this.executeSelectedPlugin(resultsList.querySelector('.inline-result'));
    });
  }

  getTypeIcon(type) {
    const icons = {
      'text': '📝',
      'url': '🌐',
      'file': '📁',
      'image': '🖼️',
      'json': '🔗',
      'email': '✉️',
      'number': '🔢',
      'long-text': '📄',
      'empty': '❓'
    };
    return icons[type] || '⚙️';
  }

  // 多行文本处理核心方法
  async setContent(content, isManualInput = false) {
    if (!content) {
      this.clearContent();
      return;
    }

    this.actualContent = content;
    
    // 判断是否应该显示胶囊
    if (this.shouldShowCapsule(content, isManualInput)) {
      try {
        const capsuleData = await this.createCapsule(content);
        this.showCapsule(capsuleData);
        // 使用胶囊内容进行搜索
        this.performSearchWithCapsule();
        return;
      } catch (error) {
        console.error('创建胶囊失败:', error);
        // 降级到文本胶囊
        const textCapsule = this.createTextCapsule(content);
        this.showCapsule(textCapsule);
        this.performSearchWithCapsule();
        return;
      }
    }

    // 直接在输入框显示内容
    this.showSingleLineInput(content);

    this.performSearch();
  }

  clearContent() {
    this.actualContent = '';
    
    // 清除胶囊状态
    this.hideCapsule();
    
    if (this.searchInput) {
      this.searchInput.value = '';
      this.searchInput.style.display = 'block';
    }
    
    if (this.editArea) {
      this.editArea.style.display = 'none';
    }
    
    // 设置编辑模式状态
    this.isEditingMode = false;
    
    // 退出编辑模式
    try {
      ipcRenderer.send('set-editing-mode', false);
    } catch {}
    
    this.performSearch();
  }

  showSingleLineInput(content) {
    if (this.searchInput) {
      this.searchInput.value = content.trim();
      this.searchInput.style.display = 'block';
    }
    
    if (this.editArea) {
      this.editArea.style.display = 'none';
    }
  }


  showEditArea() {
    if (this.editTextarea) {
      // 如果是胶囊模式，使用胶囊内容；否则使用actualContent
      const contentToEdit = this.capsuleMode && this.capsuleData ? 
        this.capsuleData.content : this.actualContent;
      
      this.editTextarea.value = contentToEdit;
      this.editTextarea.focus();
      
      // 自动调整高度
      this.editTextarea.style.height = 'auto';
      this.editTextarea.style.height = Math.min(this.editTextarea.scrollHeight, 300) + 'px';
    }
    
    if (this.editArea) {
      this.editArea.style.display = 'block';
    }
    
    // 保持胶囊显示状态，不隐藏
    
    // 隐藏插件列表
    const resultsContainer = document.getElementById('resultsContainer');
    if (resultsContainer) {
      resultsContainer.style.display = 'none';
    }
    
    // 设置编辑模式状态
    this.isEditingMode = true;
    
    // 通知主进程进入编辑模式，防止自动隐藏
    try {
      ipcRenderer.send('set-editing-mode', true);
    } catch {}
  }

  hideEditArea() {
    if (this.editArea) {
      this.editArea.style.display = 'none';
    }
    
    // 重新显示插件列表
    const resultsContainer = document.getElementById('resultsContainer');
    if (resultsContainer && this.actualContent.trim()) {
      resultsContainer.style.display = 'block';
    }
    
    // 设置编辑模式状态
    this.isEditingMode = false;
    
    // 通知主进程退出编辑模式
    try {
      ipcRenderer.send('set-editing-mode', false);
    } catch {}
    
    // 重新聚焦到搜索输入框
    if (this.searchInput) {
      this.searchInput.focus();
    }
  }

  saveMultilineContent() {
    if (this.editTextarea) {
      const newContent = this.editTextarea.value;
      
      if (this.capsuleMode && this.capsuleData) {
        // 胶囊模式下，更新胶囊内容
        this.updateCapsuleContent(newContent);
      } else {
        // 非胶囊模式，正常设置内容
        this.setContent(newContent, false);
      }
    }
    this.hideEditArea();
  }
  
  // 更新胶囊内容
  updateCapsuleContent(newContent) {
    if (!this.capsuleMode || !this.capsuleData) return;
    
    // 更新实际内容
    this.actualContent = newContent;
    
    // 重新创建胶囊数据
    if (this.capsuleData.type === 'text') {
      const updatedCapsule = this.createTextCapsule(newContent);
      this.capsuleData = updatedCapsule;
      
      // 更新胶囊显示
      if (this.capsuleText) {
        this.capsuleText.textContent = updatedCapsule.displayText;
        this.capsuleText.title = updatedCapsule.content;
      }
    }
  }

  // 获取当前的实际内容（用于插件）
  getCurrentContent() {
    // 胶囊模式下返回胶囊内容，否则返回实际内容
    if (this.capsuleMode && this.capsuleData) {
      return this.capsuleData.content;
    }
    return this.actualContent;
  }

  // 胶囊功能相关方法
  
  // 判断是否应该显示胶囊
  shouldShowCapsule(content, isManualInput) {
    if (!content || typeof content !== 'string') return false;
    // 用户手动输入不显示胶囊
    if (isManualInput) return false;
    
    // 检查是否为文件路径
    if (this.isFilePath(content)) {
      return true; // 文件路径总是显示胶囊
    }
    
    // 长度大于50显示胶囊
    return content.trim().length > 50;
  }

  // 检查是否为文件路径
  isFilePath(content) {
    if (!content || typeof content !== 'string') return false;
    
    const trimmed = content.trim();
    const filePaths = [
      /^[a-zA-Z]:[\\\/]/,                    // Windows: C:\
      /^\/[^\/]/,                            // Unix: /home
      /^\.{1,2}[\\\/]/,                     // 相对路径: ./ ../
      /^\\\\[^\\]/,                         // UNC: \\server
      /[\\\/].*\.[a-zA-Z0-9]{1,10}$/        // 包含路径分隔符且有扩展名
    ];
    
    const result = filePaths.some(pattern => pattern.test(trimmed));
    return result;
  }

  // 检查是否为图片文件
  isImageFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
    const ext = this.getFileExtension(filePath).toLowerCase();
    return imageExts.includes(ext);
  }

  // 创建胶囊（根据内容类型自动选择）
  async createCapsule(content) {
    const trimmed = content.trim();
    
    // 检查是否为剪贴板图片数据
    if (trimmed.startsWith('[CLIPBOARD-IMAGE]')) {
      return await this.createClipboardImageCapsule(trimmed);
    }
    
    // 检查是否为文件路径
    if (this.isFilePath(trimmed)) {
      // 检查是否为图片文件
      if (this.isImageFile(trimmed)) {
        return await this.createImageCapsule(trimmed);
      }
      return await this.createFileCapsule(trimmed);
    }
    
    // 否则创建文本胶囊
    return this.createTextCapsule(trimmed);
  }

  // 创建文本胶囊
  createTextCapsule(content) {
    const trimmed = content.trim();
    const maxLength = 20; // 总显示长度
    const prefixLength = 12; // 前缀长度
    const suffixLength = 8; // 后缀长度
    
    let displayText;
    if (trimmed.length <= maxLength) {
      displayText = trimmed;
    } else {
      const prefix = trimmed.substring(0, prefixLength);
      const suffix = trimmed.substring(trimmed.length - suffixLength);
      displayText = `${prefix}...${suffix}`;
    }

    return {
      type: 'text',
      content: trimmed,
      displayText: displayText,
      icon: '📝'
    };
  }

  // 创建文件胶囊
  async createFileCapsule(filePath) {
    const fileName = this.getFileName(filePath);
    const fileExt = this.getFileExtension(filePath);
    
    try {
      // 获取系统图标
      const iconData = await ipcRenderer.invoke('get-file-icon', filePath);
      
      return {
        type: 'file',
        content: filePath,
        displayText: fileName,
        icon: iconData.type === 'native' ? iconData.data : iconData.data, // 系统图标或emoji
        iconType: iconData.type,
        fileName: fileName,
        fileExt: fileExt,
        filePath: filePath
      };
    } catch (error) {
      console.error('获取文件图标失败:', error);
      
      // 降级到默认图标
      return {
        type: 'file',
        content: filePath,
        displayText: fileName,
        icon: '📁',
        iconType: 'emoji',
        fileName: fileName,
        fileExt: fileExt,
        filePath: filePath
      };
    }
  }

  // 获取文件名
  getFileName(filePath) {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || 'unknown';
  }

  // 获取文件扩展名
  getFileExtension(filePath) {
    const fileName = this.getFileName(filePath);
    const match = fileName.match(/\.([a-zA-Z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  // 创建图片胶囊
  async createImageCapsule(filePath) {
    const fileName = this.getFileName(filePath);
    const fileExt = this.getFileExtension(filePath);
    
    console.log('开始创建图片胶囊:', filePath);
    
    // 立即返回loading状态的胶囊
    const loadingCapsule = {
      type: 'image',
      content: filePath,
      displayText: fileName,
      icon: null, // 无图标，显示骨架屏
      iconType: 'loading',
      fileName: fileName,
      fileExt: fileExt,
      filePath: filePath,
      isLoading: true
    };
    
    // 异步处理图片加载
    this.processImageAsync(filePath, loadingCapsule);
    
    return loadingCapsule;
  }

  // 异步处理图片
  async processImageAsync(filePath, capsuleData) {
    try {
      // 检查文件是否存在和大小
      const fileStats = await this.getFileStats(filePath);
      if (!fileStats.exists) {
        console.warn('图片文件不存在:', filePath);
        this.updateCapsuleToError(capsuleData, '文件不存在');
        return;
      }
      
      // 检查文件大小（使用配置的限制）
      const maxSize = this.getMaxImageSizeMB() * 1024 * 1024;
      if (fileStats.size > maxSize) {
        console.warn('图片文件过大，已丢弃:', { filePath, size: fileStats.size, maxSize });
        this.updateCapsuleToError(capsuleData, '文件过大');
        return;
      }
      
      // 生成缩略图
      const thumbnailData = await this.generateThumbnail(filePath);
      
      // 更新胶囊数据
      capsuleData.icon = thumbnailData || '🖼️';
      capsuleData.iconType = thumbnailData ? 'thumbnail' : 'emoji';
      capsuleData.isLoading = false;
      
      // 如果当前正在显示这个胶囊，更新UI
      if (this.capsuleData === capsuleData) {
        this.updateCapsuleDisplay(capsuleData);
      }
      
      console.log('图片胶囊加载完成:', filePath);
    } catch (error) {
      console.error('图片胶囊处理失败:', error);
      this.updateCapsuleToError(capsuleData, '处理失败');
    }
  }

  // 更新胶囊为错误状态
  updateCapsuleToError(capsuleData, errorMessage) {
    capsuleData.icon = '❌';
    capsuleData.iconType = 'emoji';
    capsuleData.isLoading = false;
    capsuleData.error = errorMessage;
    
    // 如果当前正在显示这个胶囊，更新UI
    if (this.capsuleData === capsuleData) {
      this.updateCapsuleDisplay(capsuleData);
    }
  }

  // 更新胶囊显示
  updateCapsuleDisplay(capsuleData) {
    if (!this.capsuleIcon || !capsuleData) return;
    
    if (capsuleData.iconType === 'loading') {
      // 显示骨架屏
      this.capsuleIcon.innerHTML = '<div class="image-skeleton"></div>';
    } else if (capsuleData.iconType === 'thumbnail' && capsuleData.icon.startsWith('data:')) {
      // 显示缩略图
      this.capsuleIcon.innerHTML = '';
      const img = document.createElement('img');
      img.src = capsuleData.icon;
      const thumbnailSize = this.getThumbnailSize();
      img.style.width = `${thumbnailSize}px`;
      img.style.height = `${thumbnailSize}px`;
      img.style.objectFit = 'cover';
      img.style.borderRadius = '4px';
      this.capsuleIcon.appendChild(img);
    } else {
      // 显示emoji
      this.capsuleIcon.textContent = capsuleData.icon;
    }
  }

  // 获取文件统计信息
  async getFileStats(filePath) {
    try {
      const stats = await ipcRenderer.invoke('get-file-stats', filePath);
      return stats;
    } catch (error) {
      console.error('获取文件统计信息失败:', error);
      return { exists: false, size: 0 };
    }
  }

  // 生成缩略图
  async generateThumbnail(filePath) {
    const imageSrc = `file://${filePath.replace(/\\/g, '/')}`;
    const logPrefix = filePath;
    return this.generateThumbnailFromSrc(imageSrc, logPrefix);
  }

  // 创建剪贴板图片胶囊
  async createClipboardImageCapsule(content) {
    console.log('开始创建剪贴板图片胶囊');
    
    // 立即返回loading状态的胶囊
    const loadingCapsule = {
      type: 'image',
      content: content, // 保存完整的剪贴板标识
      displayText: '剪贴板图片',
      icon: null, // 无图标，显示骨架屏
      iconType: 'loading',
      fileName: '剪贴板图片',
      fileExt: 'png',
      filePath: null, // 剪贴板图片没有文件路径
      isClipboardImage: true,
      isLoading: true
    };
    
    // 异步处理图片加载
    this.processClipboardImageAsync(content, loadingCapsule);
    
    return loadingCapsule;
  }

  // 异步处理剪贴板图片
  async processClipboardImageAsync(content, capsuleData) {
    try {
      // 提取base64数据
      const dataUrl = content.replace('[CLIPBOARD-IMAGE]', '');
      
      // 检查数据大小（估算）
      const sizeEstimate = dataUrl.length * 0.75; // base64大约是原数据的1.33倍
      const maxSize = this.getMaxImageSizeMB() * 1024 * 1024;
      
      if (sizeEstimate > maxSize) {
        console.warn('剪贴板图片过大，已丢弃:', { size: sizeEstimate, maxSize });
        this.updateCapsuleToError(capsuleData, '图片过大');
        return;
      }
      
      // 生成缩略图
      const thumbnailData = await this.generateThumbnailFromDataUrl(dataUrl);
      
      // 更新胶囊数据
      capsuleData.icon = thumbnailData || '🖼️';
      capsuleData.iconType = thumbnailData ? 'thumbnail' : 'emoji';
      capsuleData.isLoading = false;
      capsuleData.originalDataUrl = dataUrl;
      
      // 如果当前正在显示这个胶囊，更新UI
      if (this.capsuleData === capsuleData) {
        this.updateCapsuleDisplay(capsuleData);
      }
      
      console.log('剪贴板图片胶囊加载完成');
    } catch (error) {
      console.error('剪贴板图片胶囊处理失败:', error);
      this.updateCapsuleToError(capsuleData, '处理失败');
    }
  }

  // 从DataURL生成缩略图
  async generateThumbnailFromDataUrl(dataUrl) {
    return this.generateThumbnailFromSrc(dataUrl, '剪贴板图片');
  }

  // 通用缩略图生成方法
  async generateThumbnailFromSrc(imageSrc, logPrefix) {
    return new Promise((resolve) => {
      const img = new Image();
      
      // 设置超时
      const timeout = setTimeout(() => {
        console.warn('图片加载超时:', logPrefix);
        resolve(null);
      }, 5000);
      
      img.onload = () => {
        clearTimeout(timeout);
        try {
          // 创建canvas生成缩略图
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          // 缩略图尺寸（正方形，使用动态计算的尺寸）
          const size = this.getThumbnailSize();
          canvas.width = size;
          canvas.height = size;
          
          // 计算缩放和裁剪参数（保持纵横比，居中裁剪）
          const scale = Math.max(size / img.width, size / img.height);
          const scaledWidth = img.width * scale;
          const scaledHeight = img.height * scale;
          const offsetX = (size - scaledWidth) / 2;
          const offsetY = (size - scaledHeight) / 2;
          
          // 绘制缩略图
          ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);
          
          // 转换为base64
          const thumbnailData = canvas.toDataURL('image/jpeg', 0.8);
          console.log('缩略图生成成功:', logPrefix);
          resolve(thumbnailData);
        } catch (error) {
          console.error('缩略图生成失败:', logPrefix, error);
          resolve(null);
        }
      };
      
      img.onerror = () => {
        clearTimeout(timeout);
        console.error('图片加载失败:', logPrefix);
        resolve(null);
      };
      
      // 加载图片
      img.src = imageSrc;
    });
  }

  // 显示胶囊
  showCapsule(capsuleData) {
    if (!this.contentCapsule || !capsuleData) return;

    this.capsuleData = capsuleData;
    this.capsuleMode = true;

    // 更新胶囊内容
    if (this.capsuleText) {
      this.capsuleText.textContent = capsuleData.displayText;
      this.capsuleText.title = capsuleData.content; // 鼠标悬停显示完整内容
    }
    
    if (this.capsuleIcon) {
      // 根据图标类型设置显示
      if (capsuleData.iconType === 'loading') {
        // 显示骨架屏
        this.capsuleIcon.innerHTML = '<div class="image-skeleton"></div>';
      } else if (capsuleData.iconType === 'thumbnail' && capsuleData.icon && capsuleData.icon.startsWith('data:')) {
        // 图片缩略图
        this.capsuleIcon.innerHTML = '';
        const img = document.createElement('img');
        img.src = capsuleData.icon;
        const thumbnailSize = this.getThumbnailSize();
        img.style.width = `${thumbnailSize}px`;
        img.style.height = `${thumbnailSize}px`;
        img.style.objectFit = 'cover';
        img.style.borderRadius = '4px';
        this.capsuleIcon.appendChild(img);
      } else if (capsuleData.iconType === 'native' && capsuleData.icon && capsuleData.icon.startsWith('data:')) {
        // 系统图标（base64图片）
        this.capsuleIcon.innerHTML = '';
        const img = document.createElement('img');
        img.src = capsuleData.icon;
        // 系统图标尺寸为缩略图尺寸的70%
        const iconSize = Math.floor(this.getThumbnailSize() * 0.7);
        img.style.width = `${iconSize}px`;
        img.style.height = `${iconSize}px`;
        img.style.objectFit = 'contain';
        this.capsuleIcon.appendChild(img);
      } else {
        // Emoji图标
        this.capsuleIcon.textContent = capsuleData.icon || '📄';
        this.capsuleIcon.innerHTML = this.capsuleIcon.textContent; // 清除可能的img元素
      }
    }

    // 根据胶囊类型添加CSS类
    this.contentCapsule.classList.remove('file-capsule', 'text-capsule', 'image-capsule');
    if (capsuleData.type === 'image') {
      this.contentCapsule.classList.add('image-capsule');
    } else if (capsuleData.type === 'file') {
      this.contentCapsule.classList.add('file-capsule');
    } else {
      this.contentCapsule.classList.add('text-capsule');
    }

    // 显示胶囊
    this.contentCapsule.classList.remove('hidden');
    this.contentCapsule.style.display = 'flex';

    // 设置输入框为胶囊模式
    if (this.inputDisplay) {
      this.inputDisplay.classList.add('capsule-mode');
    }

    // 清空输入框，准备接收筛选文本
    this.searchInput.value = '';
    this.filterText = '';

    // 聚焦输入框
    this.searchInput.focus();
  }

  // 隐藏胶囊
  hideCapsule() {
    if (!this.contentCapsule) return;

    this.capsuleData = null;
    this.capsuleMode = false;
    this.filterText = '';

    // 隐藏胶囊
    this.contentCapsule.classList.add('hidden');
    this.contentCapsule.style.display = 'none';
    
    // 清除胶囊类型样式
    this.contentCapsule.classList.remove('file-capsule', 'text-capsule', 'image-capsule');

    // 移除输入框胶囊模式
    if (this.inputDisplay) {
      this.inputDisplay.classList.remove('capsule-mode');
    }
  }

  // 删除胶囊（Backspace时调用）
  deleteCapsule() {
    this.hideCapsule();
    // 清空输入框和内容
    if (this.searchInput) {
      this.searchInput.value = '';
      this.actualContent = '';
      this.filterText = '';
      // 清空后隐藏插件列表
      this.displayResults([]);
    }
  }


  // 胶囊模式下的搜索
  performSearchWithCapsule() {
    if (!this.capsuleData) return;

    // 使用胶囊内容进行内容分析
    this.analyzeAndSearch(this.capsuleData.content, this.filterText);
  }

  // 统一的分析和搜索方法
  async analyzeAndSearch(content, filterText = '') {
    try {
      // 分析胶囊内容
      const analysis = await ipcRenderer.invoke('analyze-content', content);
      this.currentContentAnalysis = analysis;

      // 匹配插件
      const plugins = await ipcRenderer.invoke('match-plugins', analysis);

      // 如果有筛选文本，进一步过滤插件
      let filteredPlugins = plugins;
      if (filterText && filterText.trim()) {
        const filterLower = filterText.toLowerCase().trim();
        filteredPlugins = plugins.filter(plugin => 
          plugin.name.toLowerCase().includes(filterLower) ||
          plugin.description.toLowerCase().includes(filterLower) ||
          (plugin.featureExplain && plugin.featureExplain.toLowerCase().includes(filterLower))
        );
      }

      this.displayResults(filteredPlugins);
    } catch (error) {
      console.error('搜索失败:', error);
    }
  }

  // 设置窗口拖拽功能
  setupWindowDragging() {
    let isDragging = false;
    let dragStartTime = 0;
    let startX = 0;
    let startY = 0;
    let hasMoved = false;
    let dragThreshold = 8; // 增加拖拽阈值，避免误触发
    let timeThreshold = 150; // 减少时间阈值，提高响应性

    if (!this.searchInput) return;

    // 清理函数，确保事件监听器被正确移除
    const cleanup = () => {
      if (isDragging) {
        isDragging = false;
        this._isDragging = false;
        document.body.style.userSelect = '';
        
        // 通知主进程结束拖拽
        try {
          ipcRenderer.send('window-drag-end');
        } catch (error) {
          console.error('发送拖拽结束事件失败:', error);
        }
      }
    };

    // 页面卸载时清理
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('unload', cleanup);

    // 在输入框上按住左键开始拖拽
    this.searchInput.addEventListener('mousedown', (e) => {
      // 只响应左键
      if (e.button !== 0) return;
      
      // 如果点击的是输入框内的文本选择，不启动拖拽
      if (this.searchInput.selectionStart !== this.searchInput.selectionEnd) {
        return;
      }
      
      dragStartTime = Date.now();
      startX = e.screenX;
      startY = e.screenY;
      hasMoved = false;
      
      // 设置全局鼠标移动监听
      const handleMouseMove = (moveEvent) => {
        const deltaX = Math.abs(moveEvent.screenX - startX);
        const deltaY = Math.abs(moveEvent.screenY - startY);
        const timeDiff = Date.now() - dragStartTime;
        
        // 修正拖拽触发逻辑：只有移动距离足够大才触发，时间作为辅助条件
        if (!isDragging && (deltaX > dragThreshold || deltaY > dragThreshold)) {
          isDragging = true;
          hasMoved = true;
          this._isDragging = true;
          document.body.style.userSelect = 'none';
          
          // 阻止输入框的默认行为
          this.searchInput.blur();
          
          // 通知主进程开始拖拽
          try {
            ipcRenderer.send('window-drag-start', { x: startX, y: startY });
          } catch (error) {
            console.error('发送拖拽开始事件失败:', error);
          }
        } else if (!isDragging && timeDiff > timeThreshold && (deltaX > 2 || deltaY > 2)) {
          // 或者按住时间足够长且有轻微移动
          isDragging = true;
          hasMoved = true;
          this._isDragging = true;
          document.body.style.userSelect = 'none';
          
          // 阻止输入框的默认行为
          this.searchInput.blur();
          
          // 通知主进程开始拖拽
          try {
            ipcRenderer.send('window-drag-start', { x: startX, y: startY });
          } catch (error) {
            console.error('发送拖拽开始事件失败:', error);
          }
        }
        
        if (isDragging) {
          try {
            ipcRenderer.send('window-drag-move', { x: moveEvent.screenX, y: moveEvent.screenY });
          } catch (error) {
            console.error('发送拖拽移动事件失败:', error);
          }
        }
      };

      const handleMouseUp = () => {
        const wasDragging = isDragging;
        
        if (isDragging) {
          isDragging = false;
          this._isDragging = false;
          document.body.style.userSelect = '';
          
          // 通知主进程结束拖拽
          try {
            ipcRenderer.send('window-drag-end');
          } catch (error) {
            console.error('发送拖拽结束事件失败:', error);
          }
        }
        
        // 如果没有拖拽，说明是正常点击，让输入框正常处理
        if (!wasDragging && !hasMoved) {
          // 延迟聚焦，确保拖拽状态已清理
          setTimeout(() => {
            if (this.searchInput && !this._isDragging) {
              this.searchInput.focus();
            }
          }, 10);
        }
        
        // 清理事件监听器
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('mouseleave', handleMouseUp);
      };

      // 添加全局事件监听器
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // 鼠标离开窗口时也结束拖拽
      document.addEventListener('mouseleave', handleMouseUp);
    });
  }

  // 初始化响应式尺寸
  async initResponsiveSizes() {
    try {
      // 从主进程获取响应式尺寸信息
      this.responsiveSizes = await ipcRenderer.invoke('get-responsive-sizes');
      console.log('响应式尺寸已加载:', JSON.stringify(this.responsiveSizes, null, 2));
      
      // 应用CSS变量
      this.applyCSSVariables();
    } catch (error) {
      console.error('获取响应式尺寸失败:', error);
      
      // 使用默认尺寸
      this.responsiveSizes = {
        windowWidth: 700,
        windowHeight: 450,
        pluginListWidth: 680,
        inputHeight: 54,
        capsuleHeight: 46,
        thumbnailSize: 41,
        maxImageSizeMB: 2
      };
      
      this.applyCSSVariables();
    }
  }

  // 应用CSS变量
  applyCSSVariables() {
    if (!this.responsiveSizes) return;
    
    const root = document.documentElement;
    const sizes = this.responsiveSizes;
    
    // 设置CSS变量
    root.style.setProperty('--window-width', `${sizes.windowWidth}px`);
    root.style.setProperty('--window-height', `${sizes.windowHeight}px`);
    root.style.setProperty('--plugin-list-width', `${sizes.pluginListWidth}px`);
    root.style.setProperty('--input-height', `${sizes.inputHeight}px`);
    root.style.setProperty('--capsule-height', `${sizes.capsuleHeight}px`);
    root.style.setProperty('--thumbnail-size', `${sizes.thumbnailSize}px`);
    
    console.log('CSS变量已应用:', JSON.stringify({
      windowWidth: sizes.windowWidth,
      windowHeight: sizes.windowHeight,
      pluginListWidth: sizes.pluginListWidth,
      inputHeight: sizes.inputHeight,
      capsuleHeight: sizes.capsuleHeight,
      thumbnailSize: sizes.thumbnailSize
    }, null, 2));
  }

  // 获取响应式尺寸
  getResponsiveSizes() {
    return this.responsiveSizes || {
      windowWidth: 700,
      windowHeight: 450,
      pluginListWidth: 680,
      inputHeight: 54,
      capsuleHeight: 46,
      thumbnailSize: 41,
      maxImageSizeMB: 2
    };
  }

  // 获取缩略图尺寸
  getThumbnailSize() {
    return this.getResponsiveSizes().thumbnailSize;
  }

  // 获取最大图片大小限制
  getMaxImageSizeMB() {
    return this.getResponsiveSizes().maxImageSizeMB;
  }
}

// 初始化渲染器
new MiniToolboxRenderer();
