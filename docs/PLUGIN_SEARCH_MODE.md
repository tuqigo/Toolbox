# 无 UI 插件：交互模式与搜索模式使用说明

本文档说明无 UI 插件的交互模式配置、搜索模式工作流、列表复制按钮的配置，以及脚本回调接口与示例。

## 设计总览
- 一切皆插件：主程序只提供基础能力，交互由插件自行定义。
- 支持三种交互模式（mode）：
  - list：点击后返回列表（setList 渲染），用户再点选列表项。
  - single：点击即执行（无需列表）。
  - search：点击后进入“搜索模式”（显示搜索胶囊），用户输入并按回车触发插件内部搜索。
- 配置继承规则（优先级从高到低）：feature > 插件顶层 > 默认值。
- 复制按钮：仅当 copyEnabled 显式为 true 时启用；复制字段由 copyField 指定，默认 description。

## plugin.json 配置
支持在插件顶层与 feature 级别配置交互与复制行为。

- 顶层默认：
  - mode（默认：list）
  - copyField（默认：description）
  - copyEnabled（默认：false）
- feature 级别（优先级最高）：
  - code（功能编码，需与脚本导出的键一致）
  - explain（功能说明，渲染卡片标题用）
  - mode（覆盖顶层）
  - copyField（覆盖顶层）
  - copyEnabled（覆盖顶层）
  - placeholder（仅 search 模式：输入框占位提示）
  - cmds（匹配规则：keyword/regex/prefix/files）

示例：
```json
{
  "name": "书签搜索",
  "description": "示例：search 模式的书签搜索插件",
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

## 脚本接口（script.js）
无 UI 插件以 CommonJS 导出，每个 feature 一个对象，支持如下回调：

- handleEnter(action, setList)
  - 进入该 feature 时调用（list/search 模式都会调用一次）。
  - 用 setList(items) 返回列表，items 元素形如：
    - { title, description, ...任意扩展字段 }
    - 若启用了复制按钮，copyField 指定的字段将作为复制内容（例如 url）。
- handleSearch(action, query, setList)
  - 仅在 search 模式下，用户在输入框内输入内容并按回车时调用。
  - 根据 query 生成并 setList。
- handleSelect(action, itemData, callbackSetList)
  - 用户点击列表项时触发；可使用 callbackSetList 更新列表（如二级结果）。

action 参数：
- action.payload：原始输入内容（按命令触发时可能为空字符串）
- action.type：内容类型（text/url/json/...）
- action.featureCode：当前 feature 的 code
- action.redirect(pluginId, content)：重定向到其他插件

最小示例：
```js
module.exports = {
  'feature.code': {
    handleEnter: async (action, setList) => {
      setList([{ title: '示例项', description: '描述' }]);
    },
    handleSearch: async (action, query, setList) => {
      setList([{ title: `搜索: ${query}`, description: '结果' }]);
    },
    handleSelect: async (action, itemData, callbackSetList) => {
      // 处理点击
    }
  }
};
```

## 渲染与交互细节
- 进入 search 模式：
  - 用户点击“无 UI 且 mode=search”的卡片后进入。
  - 显示“搜索胶囊”（左侧 🔍插件名），并设置输入框 placeholder（feature.placeholder 或 "输入关键词搜索 插件名..."）。
  - 立即触发一次 handleEnter，用于展示初始列表。
- 搜索触发：
  - 用户输入后按回车 → 调用 handleSearch(action, query, setList)。
- 退出搜索模式：
  - 按 ESC，或输入框为空时按 Backspace。
- 列表复制按钮：
  - 仅当 copyEnabled 为 true 时，列表项 hover 显示“复制”按钮。
  - 复制内容字段：feature.copyField > 顶层 copyField > 默认 description。

## 书签搜索插件示例（已内置）
- 位置：`plugins/bookmark-search/`
- 行为：
  - 读取本机 Chromium 系列浏览器的书签（Chrome/Edge/Brave/Chromium/Vivaldi）的 `Bookmarks` JSON。
  - 进入 search 模式时展示全部书签；回车根据关键词在内存中过滤。
  - hover 出现“复制”按钮（复制 url）。
- 后续可扩展：
  - Firefox 支持（`places.sqlite`）需主进程提供 SQLite 读取或引入依赖。

## 开发建议
- 列表数量较大时建议分页或延迟加载，避免卡顿。
- 列表项可自定义扩展字段，复制按钮使用 copyField 对应字段内容。
- search 模式场景：如“浏览器书签搜索”、“公司知识库搜索”等需要二次检索的插件。


