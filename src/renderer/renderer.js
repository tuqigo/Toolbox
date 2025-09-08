const { ipcRenderer } = require('electron');
const { isValidJson } = require('../utils/jsonUtils');

class MiniToolboxRenderer {
  constructor() {
    this.searchInput = null;
    this.resultsList = null;
    this.multilinePreview = null;
    this.previewText = null;
    this.editButton = null;
    this.editArea = null;
    this.editTextarea = null;
    this.saveButton = null;
    this.cancelButton = null;
    
    this.currentContentAnalysis = null;
    this.selectedIndex = -1;
    this.lastInlineJsonContent = null; // 最近一次内联的 JSON 文本
    this.ignoreNextClipboardChange = false; // 忽略下一次剪贴板变化的标记
    this.clipboardIgnoreTimeout = null; // 忽略超时定时器
    
    // 输入内容管理
    this.lastInputTime = 0; // 上次输入时间
    this.inputClearTimeout = null; // 清除输入的超时定时器
    this.autoFillEnabled = true; // 是否启用自动填充
    
    // 多行文本管理
    this.actualContent = ''; // 实际的完整内容（包括换行）
    this.isMultilineMode = false; // 是否处于多行模式
    this.isEditingMode = false; // 是否处于编辑模式（本地状态）
    
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
    this.multilinePreview = document.getElementById('multilinePreview');
    this.previewText = document.getElementById('previewText');
    this.editButton = document.getElementById('editButton');
    this.editArea = document.getElementById('editArea');
    this.editTextarea = document.getElementById('editTextarea');
    this.saveButton = document.getElementById('saveButton');
    this.cancelButton = document.getElementById('cancelButton');
    

    if (!this.searchInput || !this.resultsList) {
      console.error('关键元素未找到！');
      return;
    }


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
      this.actualContent = this.searchInput.value; // 同步实际内容
      this.performSearch();
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
      this.focusInput();
    });

    // 窗口失去焦点时的处理
    window.addEventListener('blur', () => {
      // 如果不在编辑模式，延迟一点时间后隐藏窗口
      if (!this.isEditingMode) {
        setTimeout(() => {
          // 再次检查是否仍然失去焦点且不在编辑模式
          if (!document.hasFocus() && !this.isEditingMode) {
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
        const target = e.target;
        const inInput = this.searchInput && (target === this.searchInput || this.searchInput.contains(target));
        const inResults = this.resultsList && (target === this.resultsList || this.resultsList.contains(target));
        const inMultilinePreview = this.multilinePreview && (target === this.multilinePreview || this.multilinePreview.contains(target));
        const inEditArea = this.editArea && (target === this.editArea || this.editArea.contains(target));
        
        if (!inInput && !inResults && !inMultilinePreview && !inEditArea) {
          // 记录隐藏时间，用于判断是否需要清除输入
          this.lastInputTime = Date.now();
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

    // 多行文本相关事件监听器
    if (this.editButton) {
      this.editButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showEditArea();
      });
    }

    if (this.multilinePreview) {
      this.multilinePreview.addEventListener('click', (e) => {
        // 检查点击的是否是编辑按钮或其子元素
        if (!e.target.closest('.edit-button')) {
          this.showEditArea();
        }
      });

      // 添加键盘事件支持
      this.multilinePreview.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.showEditArea();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.clearContent();
        } else {
          // 传递其他键盘事件给handleKeydown
          this.handleKeydown(e);
        }
      });
    }

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
    
    // 根据当前模式聚焦到相应元素
    if (this.isMultilineMode && this.multilinePreview) {
      // 多行模式下，让预览区域可以接收焦点
      this.multilinePreview.setAttribute('tabindex', '0');
      this.multilinePreview.focus();
    } else if (this.searchInput) {
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
        this.setContent(recentClipboard);
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
          this.setContent(clipboardContent);
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
    
    if (content && content.trim() && document.hasFocus()) {
      this.setContent(content);
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
      this.searchInput.value = file.path || file.name;
      this.performSearch();
      return;
    }
    
    // 处理文本
    const pastedText = clipboardData.getData('text/plain');
    if (pastedText) {
      this.setContent(pastedText);
    }
  }

  handleFileDrop(e) {
    e.preventDefault();
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      this.searchInput.value = file.path || file.name;
      this.performSearch();
    } else {
      const droppedText = e.dataTransfer.getData('text/plain');
      if (droppedText) {
        this.setContent(droppedText);
      }
    }
  }

  handleKeydown(e) {
    const results = this.resultsList.querySelectorAll('.result-item:not(.no-results)');
    
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
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
  setContent(content) {
    if (!content) {
      this.clearContent();
      return;
    }

    this.actualContent = content;
    const lines = content.split('\n');
    const isMultiline = lines.length > 1 || content.includes('\n');

    if (isMultiline) {
      this.isMultilineMode = true;
      this.showMultilinePreview(content);
    } else {
      this.isMultilineMode = false;
      this.showSingleLineInput(content);
    }

    this.performSearch();
  }

  clearContent() {
    this.actualContent = '';
    this.isMultilineMode = false;
    
    if (this.searchInput) {
      this.searchInput.value = '';
      this.searchInput.style.display = 'block';
    }
    
    if (this.multilinePreview) {
      this.multilinePreview.style.display = 'none';
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
    
    if (this.multilinePreview) {
      this.multilinePreview.style.display = 'none';
    }
    
    if (this.editArea) {
      this.editArea.style.display = 'none';
    }
  }

  showMultilinePreview(content) {
    const allLines = content.split('\n');
    const nonEmptyLines = allLines.filter(line => line.trim());
    
    if (nonEmptyLines.length === 0) {
      this.clearContent();
      return;
    }

    const firstLine = nonEmptyLines[0].trim();
    const lastLine = nonEmptyLines[nonEmptyLines.length - 1].trim();
    const previewText = nonEmptyLines.length === 1 && allLines.length === 1 ? 
      firstLine : `${firstLine} —— ${lastLine}`;

    if (this.searchInput) {
      this.searchInput.style.display = 'none';
    }
    
    if (this.previewText) {
      this.previewText.textContent = previewText;
    }
    
    if (this.multilinePreview) {
      this.multilinePreview.style.display = 'flex';
    }
    
    if (this.editArea) {
      this.editArea.style.display = 'none';
    }
  }

  showEditArea() {
    if (this.editTextarea) {
      this.editTextarea.value = this.actualContent;
      this.editTextarea.focus();
      
      // 自动调整高度
      this.editTextarea.style.height = 'auto';
      this.editTextarea.style.height = Math.min(this.editTextarea.scrollHeight, 300) + 'px';
    }
    
    if (this.editArea) {
      this.editArea.style.display = 'block';
    }
    
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
    
    // 重新聚焦到搜索输入框或多行预览
    if (this.isMultilineMode && this.multilinePreview) {
      this.multilinePreview.setAttribute('tabindex', '0');
      this.multilinePreview.focus();
    } else if (this.searchInput) {
      this.searchInput.focus();
    }
  }

  saveMultilineContent() {
    if (this.editTextarea) {
      const newContent = this.editTextarea.value;
      this.setContent(newContent);
    }
    this.hideEditArea();
  }

  // 获取当前的实际内容（用于插件）
  getCurrentContent() {
    return this.actualContent;
  }
}

// 初始化渲染器
new MiniToolboxRenderer();
