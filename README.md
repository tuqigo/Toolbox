# MiniToolbox - 轻量化插件桌面工具箱

基于 Electron 的插件式工具箱，采用“注册-匹配-决策”核心架构，高效可扩展，遵循“一切皆插件”。

## 架构总览（Host ↔ Plugin）

- 核心层（Host 主程序）
  - 插件管理 PluginManager：扫描 `plugins/`，解析 `plugin.json`，编译匹配规则
  - 输入分析 InputAnalyzer：判断输入类型（text/url/file/image/json/email...）
  - 规则编译 RuleCompiler：将 `features[].cmds` 编译为可执行规则（regex/keyword/prefix/files）
  - 匹配器 Matcher：仅规则命中才进入候选（文本类）；结合使用偏好分排序
  - 窗口管理 WindowManager：按插件元信息创建/管理窗口（存在 `index.html` 即视为有 UI），失焦自动隐藏
  - 配置/偏好/历史：`ConfigStore`、`UsageStore`、`ClipboardStore`
  - IPC 网关：提供受限 API（如剪贴板、网络、外链打开、剪贴板历史）

- 插件生态（Plugin）
  - `plugin.json` 通过 `features` 声明能力；Host 将规则编译后统一匹配
  - 有 UI：`index.html`（可配 `window` 尺寸），通过 `window.MT` 调用受限 API
  - 无 UI（Headless）：在 `preload` 指定的 JS 中导出各 `feature.code` 对应的处理器对象：`{ handleEnter, handleSelect }`

### 系统架构图

```mermaid
graph TD
  A[Renderer 主输入框] -- analyze-content/match-plugins --> B[Main Host]
  B -- loadAll/list --> PM[PluginManager]
  PM -- compile --> RC[RuleCompiler]
  B -- rebuild/match --> M[Matcher]
  B -- createForPlugin --> W[WindowManager]
  B -- stores --> S[Config/Usage/Clipboard]
  subgraph Plugins
    P1[有 UI: index.html] -->|window.MT| G[IPC 网关]
    P2[无 UI: preload.js 的 feature 处理器]
  end
  B -- execute-plugin --> P1
  B -- execute-headless --> P2
  G -- mt.secure-call --> B
```

## 流程图

### 输入到匹配到执行（主流程）

```mermaid
sequenceDiagram
  participant R as Renderer(输入框)
  participant M as Main Host
  participant PM as PluginManager/Matcher
  participant P as Plugin(有UI或无UI)

  R->>M: analyze-content(query)
  M->>R: contentAnalysis(type,length,...)
  R->>M: match-plugins(contentAnalysis)
  M->>PM: rebuild/index/match
  PM-->>M: matched plugins(features)
  M-->>R: results(featureExplain,featureCode,...)
  R->>M: execute-plugin(pluginId,inputData)
  alt 有UI
    M->>P: create window & send plugin-input
  else 无UI
    M->>P: require(preload.js)[feature.handleEnter]
    P-->>M: callbackSetList(items) 可多次
    M-->>R: plugin-list-results(items)
    R->>M: plugin-list-select(item)
    M->>P: feature.handleSelect
    opt 需要重定向
      P-->>M: redirect(targetPluginId,content)
      M-->>R: plugin-redirect
    end
  end
```

### 隐藏与剪贴板行为

```mermaid
sequenceDiagram
  participant R as Renderer
  participant M as Main
  participant W as Plugin Window

  R-->>M: document 外部点击 -> hide-main-window
  M->>R: 主输入框隐藏(blur 也会隐藏)
  W-->>W: blur -> hide()
  Note over M: 任何 writeText 都会短暂设置忽略下一次剪贴板变化
```

### 详细代码流程图

```mermaid
graph TB
    A[应用启动 main.js] --> B[初始化核心模块]
    B --> C[ConfigStore 加载配置]
    B --> D[PluginManager 扫描插件]
    B --> E[创建主窗口]
    B --> F[注册全局快捷键]
    B --> G[启动剪贴板监听]
    
    C --> C1[读取 config.json]
    C1 --> C2[合并默认配置]
    C2 --> C3[应用UI主题和窗口设置]
    
    D --> D1[扫描 plugins 目录]
    D1 --> D2[解析 plugin.json]
    D2 --> D3[编译匹配规则]
    D3 --> D4[构建插件索引]
    
    H[用户输入] --> I[InputAnalyzer 分析内容]
    I --> J[Matcher 匹配插件]
    J --> K[显示匹配结果]
    K --> L[用户选择插件]
    L --> M[执行插件]
    
    M --> N{插件类型}
    N -->|有UI插件| O[WindowManager 创建窗口]
    N -->|无UI插件| P[直接执行脚本]
    
    O --> Q[应用主题到插件窗口]
    P --> R[返回结果到主界面]
    
    S[配置变更] --> T[IPC 通信]
    T --> U[ConfigStore 更新配置]
    U --> V[实时应用到所有窗口]
    V --> W[更新托盘菜单]
```

### 配置刷新时序图

```mermaid
sequenceDiagram
    participant U as 用户操作
    participant T as 托盘菜单
    participant M as 主进程
    participant C as ConfigStore
    participant W as WindowManager
    participant R as 渲染进程
    
    U->>T: 点击配置选项
    T->>M: 调用配置方法
    M->>C: 更新配置值
    C->>C: 保存到文件
    C-->>M: 返回新配置
    
    M->>W: 应用主题变更
    W->>W: 更新所有窗口
    W->>R: 广播主题消息
    
    M->>T: 更新托盘菜单
    T->>T: 重建菜单项
    
    Note over M,R: 配置立即生效，无需重启
```


### 插件匹配和执行时序图

```mermaid
sequenceDiagram
    participant U as 用户输入
    participant R as 渲染进程
    participant M as 主进程
    participant I as InputAnalyzer
    participant Ma as Matcher
    participant P as PluginManager
    participant W as WindowManager
    
    U->>R: 输入内容
    R->>M: IPC: analyze-content
    M->>I: 分析输入类型
    I-->>M: 返回内容分析结果
    M-->>R: 返回分析结果
    
    R->>M: IPC: match-plugins
    M->>Ma: 匹配插件
    Ma->>P: 获取插件规则
    P-->>Ma: 返回编译规则
    Ma->>Ma: 规则匹配和评分
    Ma-->>M: 返回匹配结果
    M-->>R: 返回插件列表
    
    R->>R: 显示匹配结果
    U->>R: 选择插件
    R->>M: IPC: execute-plugin
    
    alt 有UI插件
        M->>W: 创建插件窗口
        W->>W: 应用主题配置
        W-->>M: 返回窗口实例
        M->>R: 发送输入数据到插件
    else 无UI插件
        M->>M: 执行插件脚本
        M->>R: 返回执行结果
    end
```


## 目录结构

```
src/
  core/
    inputAnalyzer.js    # 输入类型分析
    ruleCompiler.js     # 规则编译器（features → 可执行规则）
    pluginManager.js    # 插件清单加载与元信息构建
    matcher.js          # 索引构建、匹配、打分排序
    windowManager.js    # 插件窗口创建与管理
    usageStore.js       # 插件使用频次，偏好排序
    clipboardStore.js   # 剪贴板历史
  preload/
    plugin-preload.js   # 暴露安全 API（window.MT）
  renderer/
    index.html / renderer.js / style.css
plugins/
  <your-plugin>/plugin.json
  <your-plugin>/index.html|index.js|script.js
```

## 快速开始

1. `npm i`（或运行 `start.bat`）
2. 运行：`npm run dev` 或 `npm start`
3. `Ctrl+Space` 唤醒输入框，输入内容进行匹配

## 代码执行流程（要点）

- Renderer 仅做输入、显示结果、收发 IPC；输入时使用 `analyze-content` 与 `match-plugins`
- Main 将 `plugins/` 扫描为元信息，存在 `index.html` 判定 `ui=true`，`preload` 指向无 UI 处理模块
- 规则：`regex | keyword | prefix | files`，文本类只在规则命中时展示
- 无 UI 插件通过 `handleEnter(action, callbackSetList)` 产出列表，`handleSelect(action, itemData, callbackSetList)` 处理二级动作
- 剪贴板写入：主进程统一拦截一次，短时间忽略自动回填
- 隐藏规则：
  - 主输入框 blur 自动隐藏；点击输入框/结果之外区域隐藏
  - 插件窗口 blur 自动隐藏

## 插件开发

- 声明文件 `plugin.json`（核心字段）：
```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "description": "说明",
  "logo": "🔧",
  "window": { "width": 720, "height": 560, "resizable": true },
  "preload": "preload.js",
  "permissions": ["net", "clipboard"],
  "features": [
    {
      "code": "demo.do",
      "explain": "示例动作",
      "cmds": [
        { "type": "keyword", "value": "demo" },
        { "type": "prefix", "value": "demo " },
        { "type": "regex", "match": "/^do:.+/i" }
      ]
    }
  ]
}
```

- 有 UI 插件：`index.html` + `script.js`，通过 `window.MT.invoke(channel, ...)` 与 Host 交互
- 无 UI 插件：在 `preload.js` 中按 feature 导出处理器对象：

```js
// preload.js（无 UI 插件的功能处理器）
module.exports['demo.do'] = {
  async handleEnter(action, callbackSetList) {
    const text = String(action.payload || '').trim();
    if (!text) {
      callbackSetList([{ title: '请输入内容', description: '', data: null }]);
      return;
    }
    // 产出列表项（可多次调用，以分步加载）
    callbackSetList([{ title: '处理结果', description: text.toUpperCase(), data: { value: text } }]);
  },
  async handleSelect(action, item, callbackSetList) {
    // 处理列表点击，如复制/跳转/二级列表
    const { redirect } = action;
    if (redirect) redirect('json-formatter', JSON.stringify({ picked: item }, null, 2));
  }
};
```

### 图标与 Logo 配置指南

通过 `plugin.json` 的 `logo` 字段为插件设置图标。系统在不同位置的显示规则如下：

- 列表（主输入框下的插件结果列表）
  - 支持：Emoji/字符、SVG、PNG/JPG/GIF/ICO、`file://`、`data:`。
  - 行为：若为图片，按缩略图容器自适应（contain），不会被拉伸变形。
  - 推荐：SVG 或 64×64 PNG（透明背景），图形居中，适度留白。

- 沙盒顶部栏（插件窗口标题左侧小图标）
  - 支持：SVG、PNG/JPG/GIF/ICO。
  - 行为：固定显示高度约 18px，按 contain 自适应。
  - 推荐：SVG 或 64×64 PNG（透明背景）。

- 任务栏/窗口图标（Windows）
  - 支持：PNG/JPG/GIF/ICO（不支持 SVG）。
  - 行为：当 `logo` 为位图/ICO 文件时，插件窗口将使用该文件作为任务栏图标；若为 SVG 则回退为默认图标。
  - 推荐：256×256 或 128×128 PNG（透明背景），或多尺寸 ICO。

配置示例：

```json
{
  "name": "剪贴板历史",
  "description": "查看剪贴板历史",
  "logo": "icon.svg", // 列表与顶部栏渲染为图片
  "window": { "width": 720, "height": 560, "resizable": true },
  "features": [ /* ... */ ]
}
```

若需在任务栏显示清晰图标，建议直接让 `logo` 指向位图/ICO（如 `icon.png` 或 `icon.ico`）。

## 插件 API（window.MT）

- 运行环境：有 UI 插件使用 sandbox + contextIsolation（无 Node/Electron），通过 `window.MT` 访问能力；无 UI 功能处理器在主进程中按 feature 执行。

- 基本用法：
```js
// 监听主程序传入输入数据
MT.onInput((inputData) => {
  // inputData: { content, type, length, lines, timestamp, featureCode }
});

// 统一网关（底层）：
const res = await MT.invoke('net.request', { hostname: 'httpbin.org', path: '/get', method: 'GET' });
```

- 能力列表：
  - 输入/消息：`onInput(callback)`
  - 剪贴板：`clipboard.readText()`、`clipboard.writeText(text)`
  - 外链：`shell.openExternal(url)`
  - 网络：`net.request(options)` → `{ ok, status, headers, data } | { ok:false, error }`
  - 剪贴板历史：`clip.query(params)`、`clip.delete(id)`、`clip.clear()`、`clip.copy(text)`
  - 窗口控制（UI 插件）：
    - 置顶钉住：`window.pin(true|false)`（钉住后失焦不隐藏，置顶）
    - DevTools：`window.devtools.open()` / `close()` / `toggle()`（默认分离窗口）
  - 工具/诊断：`utils.getPermissions()`（预留，现返回空数组）

- 示例：
```js
// 复制
await MT.clipboard.writeText('Hello');

// 打开链接
await MT.shell.openExternal('https://example.com');

// HTTP 请求
const r = await MT.net.request({ protocol: 'https:', hostname: 'httpbin.org', path: '/get', method: 'GET' });
if (r.ok) console.log(r.data);

// 剪贴板历史
const items = await MT.clip.query({ q: '', limit: 50 });
if (items[0]) await MT.clip.copy(items[0].text || '');

// UI 插件：钉住与 DevTools
document.getElementById('btnPin').onclick = () => MT.window.pin(true);
document.getElementById('btnUnpin').onclick = () => MT.window.pin(false);
document.getElementById('btnDev').onclick = () => MT.window.devtools.toggle();
```

### 错误处理与最佳实践

- 所有 `MT.*` 方法异常会抛出，请用 `try/catch` 捕获并给出友好提示。
- 渲染层只做 UI 与 `MT` 调用；外部网络统一走 `MT.net.request`；注意转义输出避免 XSS。

## 已内置示例

- `json-formatter`：JSON 格式化与压缩（有 UI）
- `url-opener`：URL/域名直达（无 UI，进入即打开）
- `clipboard-history`：剪贴板历史查看/搜索/复制/删除/清空（有 UI）


## 打包命令

- npm run build:win:portable # 便携版 (推荐)
- npm run build:win:nsis # 安装程序版  
- npm run build:win # 两个版本一起构建

## 许可证

MIT License
