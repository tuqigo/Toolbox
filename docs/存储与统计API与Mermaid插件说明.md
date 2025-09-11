## 概览

本说明涵盖两部分：

- 主程序新增的本地存储与统计能力（基于 SQLite，暴露给插件的 `MT.db` 与 `MT.stats`）。
- `mermaid-viewer` 插件的“保存图表/历史”功能及使用方法。

目标：为所有插件提供统一、隔离、安全、可控的本地数据存储与基础统计能力；并示范在插件中落地存储/读取的最佳实践。

---

## 架构设计

- 存储引擎：主进程使用 `better-sqlite3`，单库文件 `data.sqlite` 位于 `app.getPath('userData')` 目录。
- 命名空间：统一使用两张表，并以 `plugin_id` 实现严格隔离。
  - `kv(plugin_id, collection, key, value, updated_at)`
  - `events(id, plugin_id, metric, value, ts)`
- 访问边界：渲染进程插件通过预加载暴露的 API 调用主进程网关 `mt.secure-call`，主进程依据事件来源解析真实 `plugin_id`，拒绝越权访问。
- 配额与约束：
  - 每插件最多 1000 个 KV 键（超过报错）。
  - 单值最大 256KB（超过报错）。
  - 后续可按需扩展速率限制、数据保留期等策略。

---

## 插件 API

预加载 `src/preload/plugin-preload.js` 暴露的可用接口：

```js
// KV
await MT.db.put({ collection, key, value })
await MT.db.get({ collection, key })              // => { value, updated_at } | null
await MT.db.del({ collection, key })
await MT.db.list({ collection, prefix?, limit?, offset? })
await MT.db.count({ collection, prefix? })

// 统计
await MT.stats.inc({ metric, value=1, ts? })
await MT.stats.range({ metric, from, to, groupBy: 'day'|'hour' })
```

注意：
- `collection` 建议使用功能域名，如 `charts`、`notes`、`prefs` 等。
- `value` 支持任意可 JSON 序列化对象，主进程会自动做字符串化与解析。
- 统计是“事件累加 + 时间聚合”，适合做趋势图、使用次数等分析。

---

## mermaid-viewer 插件使用

新增的 UI：
- 工具栏：
  - 保存图表：输入一个名称，将当前编辑器中的 Mermaid 代码保存到本地数据库的 `charts` 集合，键即名称。
  - 历史：打开已保存图表列表，支持“打开/删除”。
- 弹窗：
  - 保存命名弹窗：输入图表名称后确认保存。
  - 历史列表弹窗：展示最近保存的记录（按更新时间倒序）。

数据模型：
```json
{
  "name": "图表名称",
  "code": "Mermaid 源码",
  "saved_at": 1731328650000 // ms 时间戳
}
```

统计：
- 每次成功保存会调用 `MT.stats.inc({ metric: 'saved' })`，便于后续聚合查看保存行为趋势。

---

## 开发与打包

依赖：
- Node 20 LTS（推荐）。
- Electron 28（见 package.json）。
- 原生模块 `better-sqlite3`。

安装/重建命令（开发期）：
```powershell
cd /d D:\project\Toolbox
npm install
npx electron-rebuild -f -w better-sqlite3
npm run dev
```

常见问题：
1) 预编译二进制下载超时 → 回退本地编译失败（缺少 VS 工具）
   - 方案 A：安装 VS 2022 Build Tools（含 C++ 工作负载），然后重试 `npm install` 与 `electron-rebuild`。
   - 方案 B：确保网络可访问 GitHub 以拉取预编译包。

2) ABI 不匹配（NODE_MODULE_VERSION 不一致）
```powershell
rmdir /s /q node_modules\better-sqlite3\build 2>$null
npx electron-rebuild -f -w better-sqlite3
# 仍不行：
rmdir /s /q node_modules
del /f /q package-lock.json
npm install
npx electron-rebuild -f -w better-sqlite3
```

3) asar 解包
- 已在 `package.json` 的 `build.asarUnpack` 中加入：`"**/*.node"` 与 `"node_modules/better-sqlite3/**"`，确保打包后可加载原生模块。

---

## 安全与注意事项

- 主进程只信任事件来源解析的 `pluginId`，忽略 payload 中的插件 ID，杜绝越权访问。
- 未暴露任意 SQL 通道；插件仅能通过标准 API 读写自身命名空间下的数据。
- 配额：每插件 <= 1000 键；单值 <= 256KB；超过时报错，避免存储被滥用。
- 建议：
  - 名称规范化（避免过长/特殊字符）。
  - 业务上避免把大文件/base64 图片塞进 KV（超过 256KB 会失败）。
  - 如需更多性能/容量，考虑把大型内容做文件化管理，仅在 KV 中保存元数据与路径。

---

## 示例代码片段（插件侧）

保存：
```js
await MT.db.put({ collection: 'charts', key: name, value: { name, code, saved_at: Date.now() } });
```

读取列表：
```js
const items = await MT.db.list({ collection: 'charts', limit: 100 });
```

载入：
```js
const rec = await MT.db.get({ collection: 'charts', key: name });
editor.value = rec?.value?.code || '';
```

删除：
```js
await MT.db.del({ collection: 'charts', key: name });
```

统计：
```js
await MT.stats.inc({ metric: 'saved' });
```

---

## 变更清单（关键）

- 新增 `src/core/dbStore.js`：SQLite 封装、配额校验、KV 与统计接口。
- 修改 `src/main.js`：
  - 初始化 `DBStore`；
  - `mt.secure-call` 仅信任事件来源；
  - 新增 `db.*`、`stats.*` 通道。
- 修改 `src/preload/plugin-preload.js`：暴露 `MT.db` 与 `MT.stats`。
- 修改 `plugins/mermaid-viewer`：
  - 工具栏增加“保存图表/历史”；
  - 保存命名/历史列表弹窗；
  - 调用 `MT.db` 与 `MT.stats` 实现保存与读取。


