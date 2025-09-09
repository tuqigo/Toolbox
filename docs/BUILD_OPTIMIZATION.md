# MiniToolbox 打包优化指南

## 🎯 目标
将打包大小从 168MB 优化到 50-80MB

## 📊 当前问题分析

### 1. 依赖项过大
- Electron 28.0.0: ~120MB
- fs-extra: ~2MB
- yauzl: ~1MB
- 其他依赖: ~5MB

### 2. 包含不必要的文件
- node_modules (开发依赖)
- cache 目录
- docs 目录
- tools 目录
- .git 目录
- README.md 等文档

## 🚀 优化方案

### 1. 使用 electron-builder 替代 electron-packager
```bash
npm run build:win:portable  # 生成便携版
npm run build:win:nsis      # 生成安装版
```

### 2. 文件排除优化
- 排除所有开发文件
- 排除文档和工具
- 只包含运行时必需文件

### 3. 压缩优化
- 使用 maximum 压缩
- 启用 asar 打包
- 排除插件目录的 asar 打包

## 📁 目录结构优化

### 包含的文件
```
dist/
├── MiniToolbox.exe
├── resources/
│   ├── app.asar
│   └── plugins/          # 未打包，便于插件更新
└── locales/
```

### 排除的文件
```
❌ node_modules/
❌ cache/
❌ docs/
❌ tools/
❌ build/
❌ .git/
❌ .vscode/
❌ *.md
❌ dist/
```

## 🎨 Windows 图标设置

### 1. 图标文件要求
- 格式: .ico
- 尺寸: 256x256, 128x128, 64x64, 32x32, 16x16
- 位置: `build/icon.ico`

### 2. 图标转换
使用在线工具将 SVG 转换为 ICO:
- https://convertio.co/svg-ico/
- https://www.icoconverter.com/

### 3. 图标配置
在 `package.json` 中已配置:
```json
"win": {
  "icon": "build/icon.ico"
}
```

## 🔧 构建命令

### 快速构建
```bash
npm run build:win:portable
```

### 完整构建
```bash
npm run build:win
```

### 优化构建
```bash
npm run pack:win:optimized
```

## 📈 预期效果

### 优化前
- 大小: ~168MB
- 包含: 所有开发文件

### 优化后
- 大小: ~50-80MB
- 包含: 仅运行时必需文件
- 启动速度: 更快
- 安装包: 更小

## 🛠️ 进一步优化建议

### 1. 代码分割
- 按需加载插件
- 延迟加载非核心功能

### 2. 资源优化
- 压缩图片资源
- 移除未使用的代码

### 3. 依赖优化
- 检查是否有不必要的依赖
- 使用更轻量的替代方案

## 📝 注意事项

1. 确保 `build/icon.ico` 文件存在
2. 测试打包后的应用功能
3. 检查插件加载是否正常
4. 验证所有功能是否完整
