(() => {
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const lineNumbers = $('lineNumbers');
  const btnFormat = $('btnFormat');
  const btnCollapseAll = $('btnCollapseAll');
  const btnExpandAll = $('btnExpandAll');
  const btnCopyMinify = $('btnCopyMinify');
  const btnCopyEscape = $('btnCopyEscape');
  const errorBox = $('error');
  const queryInput = $('query');
  const tooltip = $('tooltip');
  
  // 查找替换相关元素
  const searchWidget = $('searchWidget');
  const searchInput = $('searchInput');
  const replaceInput = $('replaceInput');
  const searchClose = $('searchClose');
  const searchPrev = $('searchPrev');
  const searchNext = $('searchNext');
  const replaceOne = $('replaceOne');
  const replaceAll = $('replaceAll');
  const searchCount = $('searchCount');
  const caseSensitive = $('caseSensitive');

  let currentData = null;
  let originalContent = '';
  let foldedBlocks = new Map(); // 记录折叠的代码块 {startLine: endLine}
  let searchMatches = [];
  let currentMatchIndex = -1;
  let isCaseSensitive = false;

  function showError(msg) {
    errorBox.textContent = msg || '';
    errorBox.style.display = msg ? 'block' : 'none';
  }

  // 将常见 JS 对象/宽松 JSON 修复为严格 JSON
  function repairToStrictJSON(text) {
    let s = String(text || '');
    try { if (/%(?:7B|7D|22|27|2C|3A)/i.test(s)) s = decodeURIComponent(s); } catch {}
    s = s.replace(/^\uFEFF/, '').replace(/[\u0000-\u001F]/g, (m) => (m === '\n' || m === '\t' || m === '\r') ? m : '');
    s = s.replace(/([\{,]\s*)'([^'\n\r]+?)'\s*:/g, '$1"$2":');
    s = s.replace(/([\{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    s = s.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"');
    s = s.replace(/,\s*([}\]])/g, '$1');
    return s;
  }

  function parseOrRepair(text) {
    try { return JSON.parse(text); } catch (e) {
      const repaired = repairToStrictJSON(text);
      return JSON.parse(repaired);
    }
  }

  // 格式化JSON并显示 - 修复折叠后格式化的问题
  function formatJSON() {
    try {
      showError('');
      
      // 如果有原始数据，直接使用原始数据格式化
      if (currentData) {
        const formatted = JSON.stringify(currentData, null, 2);
        editor.value = formatted;
        originalContent = formatted;
        foldedBlocks.clear();
        updateLineNumbers();
        return;
      }
      
      // 否则尝试解析当前编辑器内容
      const text = editor.value.trim();
      if (!text) return;
      
      const obj = parseOrRepair(text);
      currentData = obj;
      const formatted = JSON.stringify(obj, null, 2);
      editor.value = formatted;
      originalContent = formatted;
      foldedBlocks.clear();
      updateLineNumbers();
    } catch (e) {
      showError(e.message || '解析失败');
    }
  }

  // 判断一行是否可以折叠
  function isLineCollapsible(line, lineIndex, allLines) {
    const trimmed = line.trim();
    
    // 包含 { 或 [ 且不在同一行结束的行可以折叠
    if (trimmed.includes('{') && !trimmed.includes('}')) return true;
    if (trimmed.includes('[') && !trimmed.includes(']')) return true;
    
    // 数组或对象的开始行
    if (trimmed.endsWith('{') || trimmed.endsWith('[')) return true;
    if (trimmed.match(/^"[^"]+"\s*:\s*[\{\[]$/)) return true;
    
    return false;
  }

  // 精确找到代码块的结束行
  function findBlockEnd(lines, startLine) {
    const startLine_content = lines[startLine];
    const startIndent = startLine_content.match(/^\s*/)[0].length;
    
    let depth = 0;
    let inObject = false;
    let inArray = false;
    
    // 分析起始行的类型
    if (startLine_content.includes('{')) {
      inObject = true;
      depth = 1;
    } else if (startLine_content.includes('[')) {
      inArray = true;
      depth = 1;
    }
    
    // 从下一行开始查找
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      const currentIndent = line.match(/^\s*/)[0].length;
      
      // 逐字符分析
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0 && inObject) {
            return i;
          }
        } else if (char === '[') {
          depth++;
        } else if (char === ']') {
          depth--;
          if (depth === 0 && inArray) {
            return i;
          }
        }
      }
      
      // 如果深度为0，说明找到了匹配的结束
      if (depth === 0) {
        return i;
      }
    }
    
    return lines.length - 1;
  }

  // 更新行号和折叠箭头
  function updateLineNumbers() {
    if (!originalContent) {
      lineNumbers.innerHTML = '';
      return;
    }

    const originalLines = originalContent.split('\n');
    const currentLines = editor.value.split('\n');
    const lineElements = [];
    
    // 计算哪些行应该显示
    const visibleLines = new Set();
    for (let i = 0; i < originalLines.length; i++) {
      let isHidden = false;
      
      // 检查这一行是否在某个折叠块内
      for (let [foldStart, foldEnd] of foldedBlocks.entries()) {
        if (i > foldStart && i <= foldEnd) {
          isHidden = true;
          break;
        }
      }
      
      if (!isHidden) {
        visibleLines.add(i);
      }
    }
    
    // 创建原始行号到当前显示行索引的映射
    let displayLineIndex = 0;
    const originalToDisplayMap = new Map();
    
    for (let i = 0; i < originalLines.length; i++) {
      if (visibleLines.has(i)) {
        originalToDisplayMap.set(i, displayLineIndex);
        displayLineIndex++;
      }
    }
    
    // 为每个可见的原始行创建行号元素
    for (let i = 0; i < originalLines.length; i++) {
      if (!visibleLines.has(i)) continue;
      
      const lineNum = i + 1;
      const originalLine = originalLines[i] || '';
      
      // 检查原始内容中这一行是否可折叠
      const isFoldable = isLineCollapsible(originalLine, i, originalLines);
      const isFolded = foldedBlocks.has(i);
      
      const lineEl = document.createElement('div');
      lineEl.className = 'line-number';
      // 确保行号元素的高度与编辑器行高完全一致
      lineEl.style.height = '21px'; // 1.5 * 14px
      lineEl.style.lineHeight = '21px';
      lineEl.innerHTML = `
        <span class="line-num">${lineNum}</span>
        <span class="fold-arrow ${isFoldable ? '' : 'hidden'}" data-line="${i}" style="line-height: 21px;">
          ${isFolded ? '▸' : '▾'}
        </span>
      `;
      
      lineElements.push(lineEl);
    }
    
    lineNumbers.innerHTML = '';
    lineElements.forEach(el => lineNumbers.appendChild(el));
    
    // 绑定折叠事件
    lineNumbers.querySelectorAll('.fold-arrow:not(.hidden)').forEach(arrow => {
      arrow.addEventListener('click', (e) => {
        const lineIndex = parseInt(e.target.dataset.line);
        toggleFold(lineIndex);
      });
    });
  }

  // 切换折叠状态
  function toggleFold(lineIndex) {
    if (!originalContent) return;
    
    const originalLines = originalContent.split('\n');
    
    if (foldedBlocks.has(lineIndex)) {
      // 展开：移除折叠状态
      foldedBlocks.delete(lineIndex);
    } else {
      // 折叠：找到要折叠的范围
      const endLine = findBlockEnd(originalLines, lineIndex);
      foldedBlocks.set(lineIndex, endLine);
    }
    
    rebuildContent();
    updateLineNumbers();
  }

  // 重建内容（应用所有折叠）
  function rebuildContent() {
    if (!originalContent) return;
    
    const lines = originalContent.split('\n');
    const result = [];
    
    for (let i = 0; i < lines.length; i++) {
      // 检查这一行是否在任何折叠块内（被隐藏）
      let isHidden = false;
      for (let [foldStart, foldEnd] of foldedBlocks.entries()) {
        if (i > foldStart && i <= foldEnd) {
          isHidden = true;
          break;
        }
      }
      
      if (isHidden) {
        continue; // 跳过隐藏的行
      }
      
      // 检查这一行是否是折叠的开始
      if (foldedBlocks.has(i)) {
        const line = lines[i];
        
        // 创建折叠显示
        if (line.includes('{')) {
          result.push(line.replace(/\{.*$/, '{ ... }'));
        } else if (line.includes('[')) {
          result.push(line.replace(/\[.*$/, '[ ... ]'));
        } else {
          result.push(line + ' { ... }');
        }
      } else {
        result.push(lines[i]);
      }
    }
    
    editor.value = result.join('\n');
  }

  // 折叠所有
  function collapseAll() {
    try {
      if (!currentData) return;
      const minified = JSON.stringify(currentData);
      editor.value = minified;
      // 保持原始内容用于行号显示
      if (!originalContent && currentData) {
        originalContent = JSON.stringify(currentData, null, 2);
      }
      updateLineNumbers();
    } catch (e) {
      showError(e.message);
    }
  }

  // 展开所有
  function expandAll() {
    try {
      if (!currentData) return;
      const formatted = JSON.stringify(currentData, null, 2);
      editor.value = formatted;
      originalContent = formatted;
      foldedBlocks.clear();
      updateLineNumbers();
    } catch (e) {
      showError(e.message);
    }
  }

  // 复制压缩JSON - 始终基于原始数据
  async function copyMinified() {
    try {
      if (!currentData) return;
      const minified = JSON.stringify(currentData);
      await window.MT.invoke('write-clipboard', minified);
    } catch (e) {
      showError('复制失败: ' + e.message);
    }
  }

  // 复制转义JSON - 始终基于原始数据
  async function copyEscaped() {
    try {
      if (!currentData) return;
      const minified = JSON.stringify(currentData);
      const escaped = JSON.stringify(minified);
      await window.MT.invoke('write-clipboard', escaped);
    } catch (e) {
      showError('复制失败: ' + e.message);
    }
  }

  // 执行查询 - 优化错误处理
  function runQuery() {
    const source = String(queryInput.value || '').trim();
    if (!source) {
      // 如果查询为空，恢复原始数据显示
      if (currentData) {
        const formatted = JSON.stringify(currentData, null, 2);
        editor.value = formatted;
        if (!originalContent) originalContent = formatted;
        updateLineNumbers();
      }
      showError('');
      return;
    }
    
    if (!currentData) return;
    
    try {
      // 在原始数据上执行查询，不修改 currentData
      const fn = new Function(`return (function(){ with(this){ return (${source}); } })`);
      const queryResult = fn().call(currentData);
      
      // 显示查询结果
      let resultText;
      if (queryResult === undefined) {
        resultText = 'undefined';
      } else {
        resultText = JSON.stringify(queryResult, null, 2);
      }
      
      editor.value = resultText;
      
      // 临时清空折叠状态，因为这是查询结果
      foldedBlocks.clear();
      
      // 更新行号显示（基于查询结果）
      const queryLines = resultText.split('\n');
      const lineElements = [];
      
      for (let i = 0; i < queryLines.length; i++) {
        const lineNum = i + 1;
        const lineEl = document.createElement('div');
        lineEl.className = 'line-number';
        lineEl.style.height = '21px';
        lineEl.style.lineHeight = '21px';
        lineEl.innerHTML = `
          <span class="line-num">${lineNum}</span>
          <span class="fold-arrow hidden"></span>
        `;
        lineElements.push(lineEl);
      }
      
      lineNumbers.innerHTML = '';
      lineElements.forEach(el => lineNumbers.appendChild(el));
      showError('');
      
    } catch (e) {
      // 错误时显示 undefined，不显示错误信息
      editor.value = 'undefined';
      updateLineNumbers();
      showError('');
    }
  }

  // 处理输入数据
  function processInput(inputText) {
    try {
      showError('');
      const obj = parseOrRepair(inputText);
      currentData = obj;
      const formatted = JSON.stringify(obj, null, 2);
      editor.value = formatted;
      originalContent = formatted;
      foldedBlocks.clear();
      updateLineNumbers();
    } catch (e) {
      showError(e.message || '解析失败');
    }
  }

  // 创建高亮层 - 完全重写，确保精确对齐
  function createHighlightLayer() {
    let highlightLayer = document.getElementById('highlightLayer');
    if (highlightLayer) {
      highlightLayer.remove();
    }
    
    highlightLayer = document.createElement('div');
    highlightLayer.id = 'highlightLayer';
    
    // 获取编辑器的计算样式
    const editorStyles = window.getComputedStyle(editor);
    
    highlightLayer.style.cssText = `
      position: absolute;
      top: ${editor.offsetTop}px;
      left: ${editor.offsetLeft}px;
      width: ${editor.clientWidth}px;
      height: ${editor.clientHeight}px;
      pointer-events: none;
      font-family: ${editorStyles.fontFamily};
      font-size: ${editorStyles.fontSize};
      line-height: ${editorStyles.lineHeight};
      padding: ${editorStyles.padding};
      margin: 0;
      border: none;
      white-space: pre;
      overflow: hidden;
      color: transparent;
      z-index: 1;
      box-sizing: border-box;
    `;
    
    editor.parentElement.appendChild(highlightLayer);
    return highlightLayer;
  }

  // 高亮搜索结果 - 完全重写，确保精确定位
  function highlightSearchResults() {
    const highlightLayer = createHighlightLayer();
    const content = editor.value;
    const searchTerm = searchInput.value;
    
    if (!searchTerm) {
      highlightLayer.innerHTML = '';
      return;
    }
    
    const flags = isCaseSensitive ? 'g' : 'gi';
    const regex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    
    // 转义HTML特殊字符
    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    
    // 分割内容并添加高亮
    let lastIndex = 0;
    let highlightedContent = '';
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      // 添加匹配前的内容
      highlightedContent += escapeHtml(content.substring(lastIndex, match.index));
      
      // 判断是否是当前匹配项
      const isCurrentMatch = searchMatches[currentMatchIndex] && 
                             searchMatches[currentMatchIndex].start === match.index;
      const className = isCurrentMatch ? 'search-current-match' : 'search-match';
      
      // 添加高亮的匹配内容
      highlightedContent += `<span class="${className}">${escapeHtml(match[0])}</span>`;
      
      lastIndex = match.index + match[0].length;
    }
    
    // 添加剩余内容
    highlightedContent += escapeHtml(content.substring(lastIndex));
    
    highlightLayer.innerHTML = highlightedContent;
    
    // 同步滚动位置
    highlightLayer.scrollTop = editor.scrollTop;
    highlightLayer.scrollLeft = editor.scrollLeft;
  }

  // 查找功能
  function performSearch() {
    const searchTerm = searchInput.value;
    const content = editor.value;
    
    // 清除之前的搜索结果
    searchMatches = [];
    currentMatchIndex = -1;
    
    if (!searchTerm) {
      updateSearchCount(0, 0);
      highlightSearchResults();
      return;
    }
    
    const flags = isCaseSensitive ? 'g' : 'gi';
    const regex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      searchMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
      });
    }
    
    if (searchMatches.length > 0) {
      currentMatchIndex = 0;
      scrollToCurrentMatch();
    }
    
    updateSearchCount(currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0, searchMatches.length);
    highlightSearchResults();
  }

  // 改进的滚动到当前匹配 - 确保在可视区内
  function scrollToCurrentMatch() {
    if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
      const match = searchMatches[currentMatchIndex];
      
      // 设置选中范围
      editor.setSelectionRange(match.start, match.end);
      editor.focus();
      
      // 计算匹配项的行号和位置
      const beforeText = editor.value.substring(0, match.start);
      const lineNumber = beforeText.split('\n').length;
      const lineHeight = 21; // 1.5 * 14px
      
      // 获取编辑器可视区域信息
      const editorHeight = editor.clientHeight;
      const visibleLines = Math.floor(editorHeight / lineHeight);
      const currentScrollTop = editor.scrollTop;
      const currentTopLine = Math.floor(currentScrollTop / lineHeight) + 1;
      const currentBottomLine = currentTopLine + visibleLines - 1;
      
      // 检查当前匹配是否在可视区域内
      if (lineNumber < currentTopLine || lineNumber > currentBottomLine) {
        // 将匹配项滚动到可视区域中央
        const targetScrollTop = Math.max(0, (lineNumber - Math.floor(visibleLines / 2)) * lineHeight);
        editor.scrollTop = targetScrollTop;
        lineNumbers.scrollTop = targetScrollTop;
      }
      
      // 更新高亮层
      setTimeout(() => highlightSearchResults(), 10);
    }
  }

  function updateSearchCount(current, total) {
    searchCount.textContent = `${current}/${total}`;
    searchPrev.disabled = total === 0;
    searchNext.disabled = total === 0;
    replaceOne.disabled = total === 0;
    replaceAll.disabled = total === 0;
  }

  function goToPrevMatch() {
    if (searchMatches.length === 0) return;
    currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    scrollToCurrentMatch();
    updateSearchCount(currentMatchIndex + 1, searchMatches.length);
  }

  function goToNextMatch() {
    if (searchMatches.length === 0) return;
    currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
    scrollToCurrentMatch();
    updateSearchCount(currentMatchIndex + 1, searchMatches.length);
  }

  function replaceCurrentMatch() {
    if (currentMatchIndex < 0 || currentMatchIndex >= searchMatches.length) return;
    
    const match = searchMatches[currentMatchIndex];
    const replaceText = replaceInput.value;
    const content = editor.value;
    
    const newContent = content.substring(0, match.start) + replaceText + content.substring(match.end);
    editor.value = newContent;
    
    // 重新执行搜索
    setTimeout(() => performSearch(), 10);
  }

  function replaceAllMatches() {
    if (searchMatches.length === 0) return;
    
    const searchTerm = searchInput.value;
    const replaceText = replaceInput.value;
    const content = editor.value;
    
    const flags = isCaseSensitive ? 'g' : 'gi';
    const regex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const newContent = content.replace(regex, replaceText);
    editor.value = newContent;
    
    // 重新执行搜索
    setTimeout(() => performSearch(), 10);
  }

  // 智能Tooltip定位
  function showTooltip(e, text) {
    tooltip.textContent = text;
    tooltip.style.display = 'block';
    
    // 获取视窗尺寸
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };
    
    // 获取tooltip尺寸（需要先显示才能获取）
    const tooltipRect = tooltip.getBoundingClientRect();
    
    let left = e.pageX + 10;
    let top = e.pageY - 30;
    
    // 防止右侧溢出
    if (left + tooltipRect.width > viewport.width) {
      left = e.pageX - tooltipRect.width - 10;
    }
    
    // 防止顶部溢出
    if (top < 0) {
      top = e.pageY + 20;
    }
    
    // 防止底部溢出
    if (top + tooltipRect.height > viewport.height) {
      top = viewport.height - tooltipRect.height - 10;
    }
    
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
  }

  // 事件绑定
  btnFormat.addEventListener('click', formatJSON);
  btnCollapseAll.addEventListener('click', collapseAll);
  btnExpandAll.addEventListener('click', expandAll);
  btnCopyMinify.addEventListener('click', copyMinified);
  btnCopyEscape.addEventListener('click', copyEscaped);

  // 为按钮添加 tooltip
  [btnFormat, btnCollapseAll, btnExpandAll, btnCopyMinify, btnCopyEscape].forEach(btn => {
    btn.addEventListener('mouseenter', (e) => {
      showTooltip(e, btn.getAttribute('title'));
    });
    btn.addEventListener('mouseleave', hideTooltip);
    btn.addEventListener('mousemove', (e) => {
      showTooltip(e, btn.getAttribute('title'));
    });
  });

  // 查找替换事件绑定
  searchInput.addEventListener('input', performSearch);
  searchClose.addEventListener('click', () => {
    searchWidget.style.display = 'none';
    const highlightLayer = document.getElementById('highlightLayer');
    if (highlightLayer) highlightLayer.remove();
  });
  searchPrev.addEventListener('click', goToPrevMatch);
  searchNext.addEventListener('click', goToNextMatch);
  replaceOne.addEventListener('click', replaceCurrentMatch);
  replaceAll.addEventListener('click', replaceAllMatches);
  
  // 大小写敏感按钮
  caseSensitive.addEventListener('click', () => {
    isCaseSensitive = !isCaseSensitive;
    caseSensitive.classList.toggle('active', isCaseSensitive);
    performSearch();
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    // Ctrl+F 打开查找
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      searchWidget.style.display = 'block';
      searchInput.focus();
      searchInput.select();
    }
    
    // ESC 关闭查找
    if (e.key === 'Escape' && searchWidget.style.display === 'block') {
      searchWidget.style.display = 'none';
      const highlightLayer = document.getElementById('highlightLayer');
      if (highlightLayer) highlightLayer.remove();
      editor.focus();
    }
    
    // Enter 在查找框中跳转到下一个
    if (e.key === 'Enter' && document.activeElement === searchInput) {
      e.preventDefault();
      goToNextMatch();
    }
    
    // Shift+Enter 跳转到上一个
    if (e.shiftKey && e.key === 'Enter' && document.activeElement === searchInput) {
      e.preventDefault();
      goToPrevMatch();
    }
  });

  // 查询功能
  let queryTimer = null;
  queryInput.addEventListener('input', () => {
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(runQuery, 500);
  });

  // 编辑器内容变化时更新行号
  editor.addEventListener('input', () => {
    const currentText = editor.value.trim();
    if (currentText && currentText !== originalContent) {
      try {
        const obj = parseOrRepair(currentText);
        currentData = obj;
        const formatted = JSON.stringify(obj, null, 2);
        if (formatted !== originalContent) {
          originalContent = formatted;
          foldedBlocks.clear();
        }
      } catch (e) {
        // 允许编辑无效JSON
      }
    }
    updateLineNumbers();
  });

  // 同步滚动
  editor.addEventListener('scroll', () => {
    lineNumbers.scrollTop = editor.scrollTop;
    const highlightLayer = document.getElementById('highlightLayer');
    if (highlightLayer) {
      highlightLayer.scrollTop = editor.scrollTop;
      highlightLayer.scrollLeft = editor.scrollLeft;
    }
  });

  // 窗口大小改变时重新创建高亮层
  window.addEventListener('resize', () => {
    if (searchInput.value) {
      setTimeout(() => highlightSearchResults(), 100);
    }
  });

  // 主程序数据输入
  if (window.MT && window.MT.onInput) {
    window.MT.onInput((data) => {
      const inputText = data.content || '';
      if (inputText.trim()) {
        processInput(inputText);
      }
    });
  }

  // 监听剪贴板粘贴
  document.addEventListener('paste', (e) => {
    if (document.activeElement === editor) {
      setTimeout(() => {
        const text = editor.value.trim();
        if (text) {
          try {
            const obj = parseOrRepair(text);
            currentData = obj;
            const formatted = JSON.stringify(obj, null, 2);
            editor.value = formatted;
            originalContent = formatted;
            foldedBlocks.clear();
            updateLineNumbers();
            showError('');
          } catch (e) {
            // 允许粘贴无效JSON，用户可以继续编辑
          }
        }
      }, 50);
    }
  });

  // 初始化
  updateLineNumbers();
})();