## 插件 plugin.json 使用方法

面向 MiniToolbox 插件开发者的清单（plugin.json）配置指南。本文覆盖所有当前受支持的字段、配置方法与生效范围，并给出最小示例与常见用法。请配合仓库内置示例插件与源码注释一起食用。

### 基础必填
- **name**: 插件名称（字符串，必填）
- **description**: 插件描述（字符串，建议）
- **logo**: 图标，支持三类：
  - Emoji（例如 "🔧"）
  - URL（`http/https/data/file`）
  - 相对路径文件（位于插件目录，支持 `svg/png/jpg/jpeg/gif/ico`）
- 说明：当为位图/ico 文件时，会作为 Windows 任务栏图标使用。

参考实现（图标解析）：
```106:123:src/core/pluginManager.js
// 解析图标：兼容 emoji / URL / 相对路径文件（svg/png/...）
const rawIcon = manifest.logo || '';
...
```

### 实例模式
- 两种形式，二选一：
  - 顶层 **instance**: "single" | "multi"
  - 顶层 **multiInstance**: `true` 表示多实例
- 默认：多实例

参考实现（实例模式推导）：
```135:143:src/core/pluginManager.js
instanceMode: (function(){
  try {
    if (typeof manifest.instance === 'string') {
      return (manifest.instance.toLowerCase() === 'multi') ? 'multi' : 'single';
    }
    if (manifest.multiInstance === true) return 'multi';
  } catch {}
  return 'multi';
})(),
```

### 窗口配置 window
- 放在顶层字段 **window** 下，用于 UI 插件（存在 `index.html` 即视为 UI 插件）。
- 支持：
  - **width**: 窗口宽度（数字，默认 720）
  - **height**: 窗口高度（数字，默认 560）
  - **resizable**: 是否可调整大小（布尔，默认 true）
    - 当 `false` 时，最大化被禁用，标题栏“最大化/还原”按钮自动隐藏
  - **hideOnBlur**: 失焦自动隐藏（布尔，默认 false）
  - **position**: 初始位置（字符串，默认 `center`）
    - 可选：`center` | `top-left` | `top-right` | `bottom-left` | `bottom-right`
    - 兼容：`tl/tr/bl/br` 与中文“左上(角)/右上(角)/左下(角)/右下(角)`
    - 基于显示器 `workArea` 贴边定位，自动避开任务栏
  - **edgeMargin**: 贴边间距（数字，像素，默认 0，表示紧贴边缘）

参考实现（创建窗口与传参）：
```62:83:src/core/windowManager.js
const windowOptions = {
  width: cfg.width || 900,
  height: cfg.height || 640,
  show: false,
  frame: false,
  autoHideMenuBar: true,
  resizable: cfg.resizable !== false,
  maximizable: cfg.resizable !== false,
  webPreferences: { ... }
};
```

参考实现（初始位置，考虑任务栏 workArea + 贴边 + edgeMargin）：
```85:121:src/core/windowManager.js
// 计算初始位置：支持 center/top-left/top-right/bottom-left/bottom-right（基于 workArea，考虑任务栏）
...
windowOptions.x = Math.round(x);
windowOptions.y = Math.round(y);
```

参考实现（单例复用也按配置定位）：
```36:51:src/core/windowManager.js
if (this.windows.has(existingKey)) {
  const win = this.windows.get(existingKey);
  if (win && !win.isDestroyed()) {
    if (targetScreen) {
      try {
        this.positionWindowByConfig(win, pluginMeta.window || {}, targetScreen);
      } catch { this.centerWindowOnScreen(win, targetScreen); }
    }
    win.show();
    win.focus();
    return win;
  }
  this.windows.delete(existingKey);
}
```

### 交互默认（顶层）
- 以下顶层字段为 feature 的默认值（feature 可覆盖）：
  - **mode**: `list` | `single` | `search`（默认 `list`）
  - **copyField**: 列表复制字段（默认 `description`）
  - **copyEnabled**: 是否启用复制按钮（默认 `false`）

参考实现（默认继承）：
```86:104:src/core/pluginManager.js
const features = Array.isArray(manifest.features) ? manifest.features : [];
const defaultMode = manifest.mode || 'list';
const defaultCopyField = manifest.copyField || 'description';
const defaultCopyEnabled = manifest.copyEnabled === true;
...
featuresMap[f.code] = {
  code: f.code,
  explain: f.explain || '',
  mode: f.mode || defaultMode || 'list',
  copyField: f.copyField ? f.copyField : (defaultCopyField || 'description'),
  copyEnabled: typeof f.copyEnabled === 'boolean' ? f.copyEnabled : defaultCopyEnabled,
  placeholder: f.placeholder || ''
};
```

### 功能定义 features[]
- 每个功能对象字段：
  - **code**: 功能编码（字符串，必填；需与 `script.js` 导出的键一致）
  - **explain**: 功能说明（字符串，用于 UI 显示）
  - **mode/copyField/copyEnabled/placeholder**: 见上节（可覆盖顶层默认）
  - **cmds**: 匹配触发规则数组（见下节）

### 匹配规则 cmds[]（由 RuleCompiler 编译）
- 单个规则支持以下字段：
  - **type**: `keyword` | `prefix` | `regex` | `files`
  - **label**: 规则说明（字符串，可选）
  - **minLength/maxLength**: 触发的文本长度约束（数字，可选）
  - 不同类型的专属字段：
    - `keyword`: `value`（如 "clip"）
    - `prefix`: `value`（如 "clip ")
    - `regex`: `match`（如 `"/^\\d+$/"` 或 `"^https?://"`），`flags`（默认 `i`）
    - `files`: `fileType`（`file|image|directory`），`extensions`（如 `["png","jpg"]`）

参考实现（规则编译）：
```24:69:src/core/ruleCompiler.js
// 支持四类：regex, keyword, prefix, files
compileSingle(cmd, feature = null) {
  ...
}
```

### UI 与脚本入口约定
- **UI 插件**：必须有 `index.html`，主进程会以 BrowserView 方式承载；顶栏由 `src/ui/chrome.html` 覆盖。
- **无 UI 插件**：无需 `index.html`，约定入口 `script.js`，每个 feature 导出一个对象，支持 `handleEnter/handleSearch/handleSelect` 三个回调。
- 详细见：`docs/支持三种交互模式（mode）.md`

### 安全与限制（重要）
- **ID**：插件 ID 由系统生成与管理（目录名/内容哈希/注册中心），无需在清单中手工指定，也不应假设固定 ID。
- **受限 API**：插件调用系统能力须经 `window.MT` 的 `mt.secure-call` 通道，禁止在渲染/插件中直连 Node/FS。
- **XSS**：展示外部内容需转义；URL 必须校验协议（`http/https`）。

### 最小示例
- UI 插件（单例，固定尺寸，右下角贴边，禁用最大化）：
```json
{
  "name": "剪贴板历史",
  "description": "查看与搜索剪贴板",
  "logo": "icon.png",
  "instance": "single",
  "window": { "width": 460, "height": 600, "resizable": false, "position": "bottom-right", "edgeMargin": 8 },
  "features": [
    {
      "code": "clipboard.history",
      "explain": "剪贴板历史",
      "cmds": [
        { "type": "keyword", "value": "clip" },
        { "type": "prefix", "value": "clip " }
      ]
    }
  ]
}
```

- 无 UI 插件（search 模式）：
```json
{
  "name": "书签搜索",
  "description": "示例：search 模式",
  "logo": "🔖",
  "mode": "list",
  "copyField": "description",
  "copyEnabled": false,
  "features": [
    {
      "code": "bookmark.search",
      "explain": "书签搜索",
      "mode": "search",
      "copyField": "url",
      "copyEnabled": true,
      "placeholder": "输入关键字搜索书签...",
      "cmds": [
        { "type": "keyword", "value": "书签" },
        { "type": "keyword", "value": "bookmark" }
      ]
    }
  ]
}
```

### 变更记录
- 2025-09：新增 `window.position` 与 `window.edgeMargin`；`resizable:false` 时最大化禁用且标题栏按钮隐藏；窗口定位改为基于 `workArea`（考虑任务栏）。


