# IPC 通道与使用注意事项

本文档列出当前应用对外暴露的 IPC 通道、返回结构与使用注意点，便于插件开发者安全、稳定地复用。

> 统一入口：渲染/插件通过 `await window.MT.invoke(channel, payload)` 调用；
> 预加载层同时暴露了部分便捷 API（如 `MT.exec.runStream`）。

## 目录

- 剪贴板：clipboard.readText / clipboard.writeText / get-clipboard / get-recent-clipboard / get-clipboard-config / set-clipboard-config / write-clipboard
- 窗口：hide-main-window / set-editing-mode / mt.plugin.* / ui.getTheme
- 插件：plugin.list / plugin.reload / mt.get-plugin-meta / execute-plugin / plugin-search / plugin-list-select / plugin-redirect
- 网络：net.request
- 文件对话框：dialog.pickFiles / dialog.pickDirectory / dialog.pickSaveFile
- 文件系统：get-file-icon / get-file-stats / fs.list / fs.listVideos
- SQLite KV & 统计：db.put / db.get / db.del / db.list / db.count / stats.inc / stats.range
- 抓包：capture.*
- 执行器：exec.check / exec.run / exec.runStream（流式）

---

## 剪贴板

- `clipboard.readText` → `string`
- `clipboard.writeText`(text: string) → `true`
- `get-clipboard` → `string`
- `get-recent-clipboard` → `string|null`（受配置时间窗限制）
- `get-clipboard-config` → `{ enabled, autoFillMaxAge }`
- `set-clipboard-config`({ enabled?, autoFillMaxAge? }) → 配置对象
- `write-clipboard`(text) → `true`（与 clipboard.writeText 类似，附带忽略下一次剪贴板变化）

注意：插件复制文本应使用上述通道，主进程会自动抑制一次剪贴板回填。

## 窗口与主题

- `hide-main-window`
- `set-editing-mode`(boolean)
- `mt.plugin.pin`({ pluginId, instanceId, pinned })
- `mt.plugin.devtools`({ pluginId, instanceId, open|close|toggle })
- `mt.plugin.win`({ pluginId, instanceId, action }) // minimize|maximize|toggle-maximize|close
- `ui.getTheme` → `{ theme, effective, tokens }`

## 插件清单与执行

- `plugin.list` → 插件元数据列表（含 iconUrl、ui、instanceMode）
- `plugin.reload` → 重新加载插件并返回列表
- `mt.get-plugin-meta` → `{ id, name, icon }`（针对当前内容视图）
- `execute-plugin`(pluginId, inputData) → 执行插件（UI/无 UI）
- `plugin-search` → 无 UI 插件 feature 内搜索
- `plugin-list-select` → 无 UI 插件列表项点击回调
- `plugin-redirect` → 渲染端兜底的重定向（主进程 prefer 直接执行）

注意：`inputData` 仅传基础可序列化数据（content/type/length/lines/timestamp/featureCode）。

## 网络

- `net.request`(options) → `{ status, headers, data }`
  - 自动处理 gzip/deflate/br

## 文件选择 / 文件系统

- `dialog.pickFiles`({ multi, filters }) → `string[]`
- `dialog.pickDirectory`() → `string`
- `dialog.pickSaveFile`({ defaultPath, filters }) → `string`
- `get-file-icon`(filePath) → `{ type, data }`
- `get-file-stats`(filePath) → `{ exists, size, isFile, isDirectory, mtime }`
- `fs.list`({ dir, extensions?, recursive?, includeFiles?, includeDirs?, maxEntries?, includeStats? }) → `string[] | {path,type,size,mtime}[]`
- `fs.listVideos`(dir) → `string[]`（向后兼容简版）

注意：所有文件系统访问由主进程代理，插件内禁止直接使用 Node/FS。

## SQLite KV 与统计

- `db.put/get/del/list/count`：以“当前内容视图最后一次的 featureCode”为默认 collection，也可通过 payload.featureCode 指定。
- `stats.inc(metric, value)` 与 `stats.range(metric, opts)`：同样默认以 featureCode 作为前缀。

## 抓包（仅简述）

- `capture.start/stop/status/list/detail/clear/exportHar/installCert/uninstallCert/enableSystemProxy/disableSystemProxy/toCurlPS/replay/testUpstream/getBody`
  - 详见《抓包与链式上游-架构与使用指南.md》

## 执行器（ExecService）

- `exec.check`() → `{ ok, data: [{name, exists}] }`
- `exec.run`({ name, args[], timeoutMs?, stdin? }) → `{ ok, data: { code, timeout, stdout, stderr } }`
- `exec.runStream`({ name, args[], timeoutMs?, stdin? }) → `{ ok, data: { taskId } }` + 事件：
  - `mt.exec.log` → `{ taskId, stream: 'stdout'|'stderr', text }`
  - `mt.exec.end` → `{ taskId, code }`

注意：

- `name` 必须匹配 `plugin.json.allowExec` 的相对路径，推荐显式如 `bin/ffmpeg.exe`。
- 需首次授权；可在设置里清空“总是允许”来重置。
- 进程受并发/超时限制；`stdin` 以 UTF-8 发送。

## 返回结构约定

- `MT.invoke` 统一返回 `{ ok, data }` 或 `{ ok:false, error }`。
- 预加载 `secureInvoke` 已解包返回，异常统一抛错。

## 开发注意点

- 不要在插件内直接使用 Node/FS/child_process；一切通过 `MT.invoke` 网关。
- 传输大文本请谨慎，优先传递必要信息；窗口 UI 注意暗黑模式与 hover/selected 配色。
- 任何外部内容展示需转义，URL 需校验协议（http/https）。


