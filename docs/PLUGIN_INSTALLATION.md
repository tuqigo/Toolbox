# MiniToolbox 插件安装系统

## 概述

MiniToolbox 提供了完整的插件安装系统，支持从插件商店安装、从文件安装，以及插件的管理和更新。

## 插件商店

### 访问插件商店

1. 在 MiniToolbox 中输入 `store` 或 `商店`
2. 或者在插件管理器中点击 `插件商店` 按钮

### 浏览和搜索插件

- **发现页面**: 浏览推荐和热门插件
- **分类浏览**: 按功能分类查看插件
- **搜索功能**: 通过关键词搜索插件
- **插件详情**: 查看插件详细信息、截图和评价

### 安装插件

1. 在插件商店中找到想要的插件
2. 点击插件卡片查看详情
3. 点击 `安装` 按钮
4. 等待下载和安装完成

## 插件管理

### 查看已安装插件

1. 在 MiniToolbox 中输入 `plugins`、`插件管理` 或 `store`
2. 在插件商店的 `已安装` 页面查看所有已安装的插件
3. 可以看到插件的详细信息、版本和状态

### 卸载插件

1. 在插件商店的 `已安装` 页面找到要卸载的插件
2. 点击 `卸载` 按钮
3. 确认卸载操作

**注意**: 本地开发的插件无法通过界面卸载，需要手动删除插件目录。

### 更新插件

1. 在插件商店的 `更新` 页面查看可用更新
2. 点击 `更新` 按钮更新单个插件
3. 或点击 `全部更新` 批量更新所有插件

## 从文件安装插件

### 安装 .mtpkg 文件

1. 在插件商店中点击 `从文件安装` 按钮
2. 选择 `.mtpkg` 插件包文件
3. 等待安装完成

### 手动安装

1. 将插件目录复制到 `plugins/` 文件夹下
2. 在插件商店的 `已安装` 页面点击 `重新加载` 按钮

## 插件包格式

### .mtpkg 文件

MiniToolbox 插件包使用 `.mtpkg` 扩展名，实际是一个 ZIP 压缩包，包含：

- `plugin.json`: 插件配置文件
- `index.html`: UI插件的界面文件（可选）
- `script.js`: 插件逻辑文件（可选）
- 其他资源文件：图片、CSS、JS等

### 插件信息文件

每个插件包都有对应的 `.json` 信息文件，包含：

```json
{
  "id": "plugin-id",
  "name": "插件名称",
  "description": "插件描述",
  "version": "1.0.0",
  "author": "作者名称",
  "package": {
    "filename": "plugin-id-1.0.0.mtpkg",
    "size": 12345,
    "hash": "sha256-hash",
    "created": "2024-01-01T00:00:00.000Z"
  }
}
```

## 安装过程

### 自动安装流程

1. **下载**: 从注册中心下载插件包
2. **验证**: 验证包文件的完整性和哈希
3. **解压**: 解压插件包到插件目录
4. **注册**: 在系统中注册插件
5. **完成**: 插件可立即使用

### 安装状态

安装过程中会显示进度信息：

- **下载中**: 显示下载进度
- **验证中**: 验证文件完整性
- **解压中**: 解压插件文件
- **注册中**: 注册插件到系统
- **完成**: 安装成功

## 插件存储

### 目录结构

```
plugins/
├── plugin-id/
│   ├── plugin.json
│   ├── index.html
│   ├── script.js
│   ├── .mtpkg-info.json  # 安装信息
│   └── ...
└── another-plugin/
    └── ...
```

### 安装信息

每个已安装的插件都有一个 `.mtpkg-info.json` 文件记录安装信息：

```json
{
  "source": "registry",
  "pluginId": "plugin-id",
  "version": "1.0.0",
  "installedAt": "2024-01-01T00:00:00.000Z",
  "downloadUrl": "https://registry.minitoolbox.com/...",
  "hash": "sha256-hash"
}
```

## 离线安装

### 准备离线包

1. 从在线环境下载 `.mtpkg` 文件
2. 或使用打包工具创建插件包：
   ```bash
   node tools/plugin-packager.js pack ./my-plugin ./dist
   ```

### 离线安装步骤

1. 将 `.mtpkg` 文件复制到目标机器
2. 在插件商店中选择 `从文件安装`
3. 选择插件包文件进行安装

## 批量操作

### 批量安装

```bash
# 批量安装多个插件包
for file in *.mtpkg; do
  # 通过API安装
  curl -X POST "http://localhost:3000/api/install" \
    -F "package=@$file"
done
```

### 批量更新

在插件商店的更新页面可以：

- 查看所有可用更新
- 一键更新所有插件
- 选择性更新特定插件

## 故障排除

### 安装失败

常见原因和解决方法：

1. **网络连接问题**
   - 检查网络连接
   - 使用代理或镜像源

2. **文件损坏**
   - 重新下载插件包
   - 验证文件完整性

3. **权限不足**
   - 确保有写入插件目录的权限
   - 以管理员身份运行

4. **版本冲突**
   - 卸载旧版本后重新安装
   - 检查依赖关系

### 插件无法加载

1. **检查插件配置**
   - 验证 `plugin.json` 格式
   - 检查必需字段

2. **查看错误日志**
   - 在开发模式下查看控制台输出
   - 检查插件管理器中的错误信息

3. **重新加载插件**
   - 在插件管理器中点击 `重新加载插件`
   - 重启 MiniToolbox

### 更新失败

1. **备份恢复**
   - 系统会自动备份旧版本
   - 更新失败时自动恢复

2. **手动更新**
   - 手动卸载旧版本
   - 重新安装新版本

## 安全考虑

### 插件来源

- **官方商店**: 经过审核的安全插件
- **第三方来源**: 需要用户自行判断安全性
- **本地开发**: 开发者自己负责安全性

### 权限控制

插件运行在受限环境中：

- 无法直接访问文件系统
- 通过API访问系统功能
- 网络请求经过代理

### 数据隔离

- 每个插件有独立的存储空间
- 插件间无法直接访问彼此的数据
- 敏感操作需要用户确认

## API参考

### 安装相关API

```javascript
// 搜索插件
const result = await api.invoke('mt.secure-call', {
  channel: 'installer.search',
  payload: {
    keyword: 'json',
    options: { limit: 20 }
  }
});

// 获取插件信息
const info = await api.invoke('mt.secure-call', {
  channel: 'installer.getInfo',
  payload: 'plugin-id'
});

// 安装插件
await api.invoke('mt.secure-call', {
  channel: 'installer.install',
  payload: {
    pluginId: 'plugin-id',
    version: 'latest'
  }
});

// 卸载插件
await api.invoke('mt.secure-call', {
  channel: 'installer.uninstall',
  payload: 'plugin-id'
});

// 检查更新
const updates = await api.invoke('mt.secure-call', {
  channel: 'installer.checkUpdates'
});
```

## 配置选项

### 注册中心设置

可以通过环境变量配置注册中心：

```bash
export PLUGIN_REGISTRY_URL="https://your-registry.com"
```

### 缓存设置

插件安装器会缓存下载的文件：

- 缓存目录: `cache/`
- 临时目录: `cache/temp/`
- 备份目录: `cache/backups/`

## 最佳实践

### 用户

1. **定期更新插件**保持功能和安全性
2. **从可信来源安装**插件
3. **备份重要配置**防止数据丢失
4. **及时清理无用插件**节省空间

### 开发者

1. **遵循版本规范**使用语义化版本
2. **提供详细说明**包括使用方法和更新日志
3. **测试兼容性**确保在不同环境下正常工作
4. **及时修复问题**响应用户反馈

---

更多信息请参考 [插件开发指南](./PLUGIN_DEVELOPMENT.md) 和 [API文档](./PLUGIN_API.md)。
