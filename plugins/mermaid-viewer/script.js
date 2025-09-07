(() => {
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const viewer = $('viewer');
  const diagram = $('mermaid-diagram');
  const errorMessage = $('error-message');
  const status = $('status');
  
  const btnRender = $('btnRender');
  const btnClear = $('btnClear');
  const btnCopy = $('btnCopy');
  const btnExport = $('btnExport');
  const btnZoomIn = $('btnZoomIn');
  const btnZoomOut = $('btnZoomOut');
  const btnZoomReset = $('btnZoomReset');

  let currentZoom = 1;
  let renderCounter = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let translateX = 0;
  let translateY = 0;

  // Mermaid 配置
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    sequence: {
      actorMargin: 50,
      boxMargin: 10,
      boxTextMargin: 5,
      noteMargin: 10,
      messageMargin: 35,
      mirrorActors: true,
      bottomMarginAdj: 1,
      useMaxWidth: true,
      rightAngles: false,
      showSequenceNumbers: false
    }
  });

  // 示例代码
  const examples = {
    basic: `sequenceDiagram
    participant U as 用户
    participant S as 服务器
    
    U->>S: 发送登录请求
    S-->>U: 返回登录结果
    
    Note over U,S: 用户认证完成
    
    U->>S: 请求数据
    S-->>U: 返回数据`,

    complex: `sequenceDiagram
    participant C as 客户端
    participant A as API网关
    participant B as 业务服务
    participant D as 数据库
    
    C->>A: 请求资源
    A->>A: 验证Token
    
    alt 验证成功
        A->>B: 转发请求
        B->>D: 查询数据
        D-->>B: 返回结果
        B-->>A: 处理后数据
        A-->>C: 返回响应
    else 验证失败
        A-->>C: 返回401错误
    end
    
    Note over C,D: 完整的API调用流程`,

    api: `sequenceDiagram
    participant Client as 前端客户端
    participant Gateway as API网关
    participant Auth as 认证服务
    participant Business as 业务服务
    participant Cache as 缓存
    participant DB as 数据库
    
    Client->>Gateway: POST /api/login
    Gateway->>Auth: 验证用户凭据
    Auth->>DB: 查询用户信息
    DB-->>Auth: 返回用户数据
    Auth-->>Gateway: 返回JWT Token
    Gateway-->>Client: 登录成功
    
    loop 业务请求
        Client->>Gateway: GET /api/data (with JWT)
        Gateway->>Auth: 验证Token
        Auth-->>Gateway: Token有效
        Gateway->>Business: 转发请求
        Business->>Cache: 检查缓存
        
        alt 缓存命中
            Cache-->>Business: 返回缓存数据
        else 缓存未命中
            Business->>DB: 查询数据库
            DB-->>Business: 返回数据
            Business->>Cache: 更新缓存
        end
        
        Business-->>Gateway: 返回业务数据
        Gateway-->>Client: 返回响应
    end`
  };

  // 设置状态
  function setStatus(message, isLoading = false) {
    status.innerHTML = isLoading 
      ? `<span class="loading"></span>${message}` 
      : message;
  }

  // 显示错误
  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    diagram.style.display = 'none';
    setStatus('渲染失败', false);
  }

  // 隐藏错误
  function hideError() {
    errorMessage.style.display = 'none';
    diagram.style.display = 'block';
  }

  // 渲染图表
  async function renderDiagram() {
    const code = editor.value.trim();
    
    if (!code) {
      showError('请输入 Mermaid 代码');
      return;
    }

    try {
      setStatus('正在渲染图表...', true);
      hideError();
      
      // 清空之前的内容
      diagram.innerHTML = '';
      
      // 生成唯一ID
      const diagramId = `mermaid-${++renderCounter}`;
      
      // 验证语法
      const isValid = await mermaid.parse(code);
      if (!isValid) {
        throw new Error('Mermaid 语法错误');
      }
      
      // 渲染图表
      const { svg } = await mermaid.render(diagramId, code);
      
      // 插入SVG
      diagram.innerHTML = svg;
      
      // 应用缩放和平移
      applyTransform();
      
      // 设置拖拽和缩放事件（每次渲染后重新设置）
      setupDragAndZoom();
      
      setStatus('渲染完成');
      
    } catch (error) {
      console.error('渲染失败:', error);
      showError(`渲染失败: ${error.message || '未知错误'}`);
    }
  }

  // 应用缩放和平移
  function applyTransform() {
    const svg = diagram.querySelector('svg');
    if (svg) {
      svg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentZoom})`;
      svg.style.transformOrigin = 'center center';
      svg.style.cursor = 'grab';
    } else {
      console.warn('SVG element not found for transform');
    }
  }

  // 缩放控制
  function zoomIn() {
    currentZoom = Math.min(currentZoom * 1.2, 10); // 最大缩放调整到1000%
    applyTransform();
    setStatus(`缩放: ${Math.round(currentZoom * 100)}%`);
  }

  function zoomOut() {
    currentZoom = Math.max(currentZoom / 1.2, 0.1); // 最小缩放调整到10%
    applyTransform();
    setStatus(`缩放: ${Math.round(currentZoom * 100)}%`);
  }

  function zoomReset() {
    currentZoom = 1;
    translateX = 0;
    translateY = 0;
    applyTransform();
    setStatus('视图已重置');
  }

  // 鼠标拖拽功能
  function setupDragAndZoom() {
    const viewerContent = viewer; // viewer 本身就是 .viewer-content 元素
    
    // 移除之前的事件监听器（如果存在）
    if (!viewerContent || viewerContent._setupDone) return;
    viewerContent._setupDone = true;
    
    // 鼠标按下事件
    viewerContent.addEventListener('mousedown', (e) => {
      const svg = diagram.querySelector('svg');
      if (!svg) return;
      
      isDragging = true;
      dragStartX = e.clientX - translateX;
      dragStartY = e.clientY - translateY;
      svg.style.cursor = 'grabbing';
      e.preventDefault();
    });

    // 鼠标移动事件
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      translateX = e.clientX - dragStartX;
      translateY = e.clientY - dragStartY;
      applyTransform();
    });

    // 鼠标松开事件
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        const svg = diagram.querySelector('svg');
        if (svg) {
          svg.style.cursor = 'grab';
        }
      }
    });

    // 滚轮缩放事件
    viewerContent.addEventListener('wheel', (e) => {
      const svg = diagram.querySelector('svg');
      if (!svg) return;
      
      e.preventDefault();
      
      const rect = viewerContent.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const mouseX = e.clientX;
      const mouseY = e.clientY;
      
      // 计算鼠标相对于中心的偏移
      const offsetX = mouseX - centerX;
      const offsetY = mouseY - centerY;
      
      const oldZoom = currentZoom;
      
      if (e.deltaY < 0) {
        // 向上滚动，放大
        currentZoom = Math.min(currentZoom * 1.1, 10); // 最大缩放调整到1000%
      } else {
        // 向下滚动，缩小
        currentZoom = Math.max(currentZoom / 1.1, 0.1); // 最小缩放调整到10%
      }
      
      // 调整平移量，使缩放围绕鼠标位置进行
      const zoomRatio = currentZoom / oldZoom;
      translateX = offsetX - (offsetX - translateX) * zoomRatio;
      translateY = offsetY - (offsetY - translateY) * zoomRatio;
      
      applyTransform();
      setStatus(`缩放: ${Math.round(currentZoom * 100)}%`);
    });
  }

  // 清空编辑器
  function clearEditor() {
    editor.value = '';
    diagram.innerHTML = '';
    hideError();
    setStatus('已清空');
  }

  // 复制代码
  async function copyCode() {
    try {
      const code = editor.value.trim();
      if (!code) {
        setStatus('没有代码可复制');
        return;
      }
      
      if (window.MT && window.MT.invoke) {
        await window.MT.invoke('write-clipboard', code);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(code);
      } else {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = code;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      
      setStatus('代码已复制到剪贴板');
    } catch (error) {
      console.error('复制失败:', error);
      setStatus('复制失败');
    }
  }

  // 导出SVG
  function exportSVG() {
    const svg = diagram.querySelector('svg');
    if (!svg) {
      setStatus('没有图表可导出');
      return;
    }
    
    try {
      // 创建SVG数据
      const svgData = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl = URL.createObjectURL(svgBlob);
      
      // 创建下载链接
      const downloadLink = document.createElement('a');
      downloadLink.href = svgUrl;
      downloadLink.download = 'mermaid-diagram.svg';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      
      URL.revokeObjectURL(svgUrl);
      setStatus('SVG 已导出');
    } catch (error) {
      console.error('导出失败:', error);
      setStatus('导出失败');
    }
  }

  // 加载示例
  function loadExample(exampleKey) {
    if (examples[exampleKey]) {
      editor.value = examples[exampleKey];
      renderDiagram();
      setStatus(`已加载示例: ${exampleKey}`);
    }
  }

  // 事件监听器
  btnRender.addEventListener('click', renderDiagram);
  btnClear.addEventListener('click', clearEditor);
  btnCopy.addEventListener('click', copyCode);
  btnExport.addEventListener('click', exportSVG);
  btnZoomIn.addEventListener('click', zoomIn);
  btnZoomOut.addEventListener('click', zoomOut);
  btnZoomReset.addEventListener('click', zoomReset);

  // 示例点击事件
  document.querySelectorAll('.example-item').forEach(item => {
    item.addEventListener('click', () => {
      const example = item.getAttribute('data-example');
      loadExample(example);
    });
  });

  // 编辑器快捷键
  editor.addEventListener('keydown', (e) => {
    // Ctrl+Enter 渲染
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      renderDiagram();
    }
    // Ctrl+K 清空
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      clearEditor();
    }
  });

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    // 空格键重置视图
    if (e.code === 'Space' && !e.ctrlKey && !e.altKey && e.target !== editor) {
      e.preventDefault();
      zoomReset();
    }
    // + 号放大
    if ((e.key === '+' || e.key === '=') && !e.ctrlKey && e.target !== editor) {
      e.preventDefault();
      zoomIn();
    }
    // - 号缩小
    if (e.key === '-' && !e.ctrlKey && e.target !== editor) {
      e.preventDefault();
      zoomOut();
    }
    // R 键渲染
    if (e.key === 'r' && !e.ctrlKey && e.target !== editor) {
      e.preventDefault();
      renderDiagram();
    }
  });

  // 自动渲染（防抖）
  let renderTimeout;
  editor.addEventListener('input', () => {
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
      if (editor.value.trim()) {
        renderDiagram();
      }
    }, 1000);
  });

  // 监听主程序输入
  if (window.MT && window.MT.onInput) {
    window.MT.onInput((data) => {
      const content = data.content || '';
      console.log(content);
      editor.value = content;
      
      // 如果内容看起来像 Mermaid 代码，自动渲染
      if (content.includes('sequenceDiagram') || 
          content.includes('participant') || 
          content.includes('->') || 
          content.includes('->>')) {
        setTimeout(() => renderDiagram(), 100);
      } else if (content.trim()) {
        // 即使不是明显的 Mermaid 代码也尝试渲染
        setTimeout(() => renderDiagram(), 100);
      }
      
      setStatus('已接收输入内容');
    });
  } else {
    console.warn('window.MT 或 window.MT.onInput 不可用');
  }

  // 初始化
  setStatus('Mermaid 图表查看器已就绪');
  
  // 确保DOM完全加载后再设置事件
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => loadExample('basic'), 100);
    });
  } else {
    // 加载默认示例
    setTimeout(() => {
      loadExample('basic');
    }, 100);
  }
})();
