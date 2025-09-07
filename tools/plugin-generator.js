#!/usr/bin/env node
/**
 * MiniToolbox 插件生成器
 * 用于快速创建插件模板
 */

const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');

class PluginGenerator {
  constructor() {
    this.templates = {
      'basic': '基础插件（无UI）',
      'ui': 'UI插件',
      'text-processor': '文本处理插件',
      'utility': '实用工具插件'
    };
  }

  async generatePlugin(options = {}) {
    const config = await this.collectPluginInfo(options);
    const templatePath = path.join(__dirname, 'templates', config.template);
    const outputPath = path.join(config.outputDir, config.id);

    console.log(`\n🚀 创建插件: ${config.name}`);
    console.log(`📁 输出目录: ${outputPath}`);
    console.log(`📋 模板: ${this.templates[config.template]}`);

    // 检查目录是否已存在
    if (await fs.pathExists(outputPath)) {
      const overwrite = await this.askQuestion(`目录 ${outputPath} 已存在，是否覆盖？ (y/N): `);
      if (overwrite.toLowerCase() !== 'y') {
        console.log('取消创建插件');
        return false;
      }
      await fs.remove(outputPath);
    }

    // 创建插件目录
    await fs.ensureDir(outputPath);

    // 复制模板文件
    await this.copyTemplate(templatePath, outputPath, config);

    console.log(`\n✅ 插件创建成功！`);
    console.log(`\n📝 下一步:`);
    console.log(`  1. cd ${path.relative(process.cwd(), outputPath)}`);
    console.log(`  2. 编辑 plugin.json 完善插件配置`);
    console.log(`  3. 实现插件功能`);
    console.log(`  4. 使用 node ../tools/plugin-packager.js validate . 验证插件`);
    console.log(`  5. 使用 node ../tools/plugin-packager.js pack . ../dist 打包插件`);

    return true;
  }

  async collectPluginInfo(options) {
    const config = {};

    // 插件目录名（用作本地ID）
    config.id = options.id || await this.askQuestion('插件目录名 (如: my-plugin): ');
    if (!config.id || !/^[a-z0-9-]+$/.test(config.id)) {
      throw new Error('插件目录名只能包含小写字母、数字和连字符');
    }

    // 插件名称
    config.name = options.name || await this.askQuestion('插件名称: ');
    if (!config.name) {
      throw new Error('插件名称不能为空');
    }

    // 插件描述
    config.description = options.description || await this.askQuestion('插件描述: ');

    // 作者
    config.author = options.author || await this.askQuestion('作者: ') || 'Anonymous';

    // 版本
    config.version = options.version || await this.askQuestion('版本 (1.0.0): ') || '1.0.0';
    if (!/^\d+\.\d+\.\d+$/.test(config.version)) {
      throw new Error('版本号格式不正确，应为 x.y.z 格式');
    }

    // 模板类型
    if (!options.template) {
      console.log('\n选择插件模板:');
      Object.entries(this.templates).forEach(([key, name], index) => {
        console.log(`  ${index + 1}. ${name} (${key})`);
      });
      
      const templateIndex = await this.askQuestion('请选择模板 (1): ') || '1';
      const templateKeys = Object.keys(this.templates);
      const selectedIndex = parseInt(templateIndex) - 1;
      
      if (selectedIndex < 0 || selectedIndex >= templateKeys.length) {
        throw new Error('无效的模板选择');
      }
      
      config.template = templateKeys[selectedIndex];
    } else {
      config.template = options.template;
    }

    // 输出目录
    config.outputDir = options.outputDir || path.join(process.cwd(), 'plugins');

    return config;
  }

  async copyTemplate(templatePath, outputPath, config) {
    // 检查模板是否存在
    if (!await fs.pathExists(templatePath)) {
      // 使用内置模板
      await this.createBuiltinTemplate(outputPath, config);
      return;
    }

    // 复制模板文件
    await fs.copy(templatePath, outputPath);

    // 处理模板变量
    await this.processTemplateFiles(outputPath, config);
  }

  async createBuiltinTemplate(outputPath, config) {
    // 创建 plugin.json（不再包含id字段）
    const manifest = {
      name: config.name,
      description: config.description,
      version: config.version,
      author: config.author,
      logo: '🔧'
    };

    // 根据模板类型添加特定配置
    switch (config.template) {
      case 'ui':
        manifest.window = {
          width: 800,
          height: 600,
          resizable: true
        };
        manifest.features = [{
          code: `${config.id}.open`,
          explain: `打开${config.name}`,
          cmds: [{
            type: 'keyword',
            value: config.id
          }]
        }];
        break;

      case 'text-processor':
        manifest.features = [{
          code: `${config.id}.process`,
          explain: `使用${config.name}处理文本`,
          cmds: [{
            type: 'keyword',
            value: config.id
          }]
        }];
        break;

      case 'utility':
        manifest.features = [{
          code: `${config.id}.run`,
          explain: `运行${config.name}`,
          cmds: [{
            type: 'keyword',
            value: config.id
          }]
        }];
        break;

      default: // basic
        manifest.features = [{
          code: `${config.id}.execute`,
          explain: `执行${config.name}`,
          cmds: [{
            type: 'keyword',
            value: config.id
          }]
        }];
    }

    await fs.writeJson(path.join(outputPath, 'plugin.json'), manifest, { spaces: 2 });

    // 创建对应的文件
    if (config.template === 'ui') {
      await this.createUIFiles(outputPath, config);
    } else {
      await this.createScriptFile(outputPath, config);
    }

    // 创建 README.md
    await this.createReadme(outputPath, config);
  }

  async createUIFiles(outputPath, config) {
    // 创建 index.html
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.name}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f7;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: #fff;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    h1 {
      margin: 0 0 16px 0;
      color: #1d1d1f;
    }
    .description {
      color: #666;
      margin-bottom: 24px;
    }
    .btn {
      background: #007aff;
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
    }
    .btn:hover {
      background: #0056cc;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${config.name}</h1>
    <p class="description">${config.description || '这是一个MiniToolbox插件'}</p>
    
    <button class="btn" onclick="handleAction()">执行操作</button>
    
    <div id="result" style="margin-top: 20px;"></div>
  </div>

  <script>
    const api = window.MT;
    
    // 监听插件输入数据
    window.addEventListener('DOMContentLoaded', () => {
      if (window.MT) {
        // 可以在这里处理插件输入
        console.log('插件已加载');
      }
    });

    // 处理用户操作
    function handleAction() {
      const result = document.getElementById('result');
      result.innerHTML = '<p>功能开发中...</p>';
    }

    // 监听插件输入事件
    if (window.MT) {
      window.addEventListener('plugin-input', (event) => {
        console.log('收到插件输入:', event.detail);
        // 处理输入数据
      });
    }
  </script>
</body>
</html>`;

    await fs.writeFile(path.join(outputPath, 'index.html'), html);
  }

  async createScriptFile(outputPath, config) {
    const script = `/**
 * ${config.name}
 * ${config.description || ''}
 */

// 导出功能处理器
module.exports = {
  // 主要功能处理器
  '${config.id}.${config.template === 'text-processor' ? 'process' : config.template === 'utility' ? 'run' : 'execute'}': {
    /**
     * 处理进入事件
     * @param {Object} action - 操作对象
     * @param {string} action.payload - 输入内容
     * @param {string} action.type - 输入类型
     * @param {string} action.featureCode - 功能代码
     * @param {Function} action.redirect - 重定向函数
     * @param {Function} callbackSetList - 设置结果列表的回调函数
     */
    async handleEnter(action, callbackSetList) {
      try {
        const { payload, type } = action;
        
        console.log('处理输入:', payload, type);
        
        // 在这里实现你的插件逻辑
        const result = await this.processInput(payload, type);
        
        // 设置结果列表
        callbackSetList([{
          title: '处理结果',
          description: result,
          data: { result }
        }]);
        
      } catch (error) {
        console.error('处理失败:', error);
        callbackSetList([{
          title: '处理失败',
          description: error.message,
          data: null
        }]);
      }
    },

    /**
     * 处理选择事件
     * @param {Object} action - 操作对象
     * @param {Object} itemData - 选中的项目数据
     * @param {Function} callbackSetList - 设置结果列表的回调函数
     */
    async handleSelect(action, itemData, callbackSetList) {
      try {
        console.log('选择项目:', itemData);
        
        if (itemData.data && itemData.data.result) {
          // 复制结果到剪贴板
          const api = require('electron').clipboard;
          api.writeText(itemData.data.result);
          
          console.log('结果已复制到剪贴板');
        }
        
      } catch (error) {
        console.error('处理选择失败:', error);
      }
    },

    /**
     * 处理输入的核心逻辑
     * @param {string} input - 输入内容
     * @param {string} type - 输入类型
     * @returns {string} 处理结果
     */
    async processInput(input, type) {
      // 在这里实现具体的处理逻辑
      return \`处理完成: \${input}\`;
    }
  }
};`;

    await fs.writeFile(path.join(outputPath, 'script.js'), script);
  }

  async createReadme(outputPath, config) {
    const readme = `# ${config.name}

${config.description || '这是一个MiniToolbox插件'}

## 功能特性

- 功能1
- 功能2
- 功能3

## 使用方法

1. 在MiniToolbox中输入关键词 \`${config.id}\`
2. 选择对应的功能
3. 按回车执行

## 开发说明

### 插件结构

\`\`\`
${config.id}/
├── plugin.json    # 插件配置文件
${config.template === 'ui' ? '├── index.html     # 插件界面' : '├── script.js     # 插件逻辑'}
└── README.md      # 说明文档
\`\`\`

### 配置说明

- \`name\`: 插件显示名称
- \`description\`: 插件功能描述
- \`version\`: 插件版本号
- \`author\`: 插件作者

## 版本历史

### v${config.version}
- 初始版本

## 许可证

MIT
`;

    await fs.writeFile(path.join(outputPath, 'README.md'), readme);
  }

  async processTemplateFiles(outputPath, config) {
    const files = await this.getAllFiles(outputPath);
    
    for (const file of files) {
      const filePath = path.join(outputPath, file);
      const content = await fs.readFile(filePath, 'utf8');
      
      // 替换模板变量
      const processedContent = content
        .replace(/\{\{id\}\}/g, config.id)
        .replace(/\{\{name\}\}/g, config.name)
        .replace(/\{\{description\}\}/g, config.description)
        .replace(/\{\{author\}\}/g, config.author)
        .replace(/\{\{version\}\}/g, config.version);
      
      await fs.writeFile(filePath, processedContent);
    }
  }

  async getAllFiles(dir, basePath = '') {
    const files = [];
    const entries = await fs.readdir(dir);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const relativePath = path.join(basePath, entry);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        files.push(...await this.getAllFiles(fullPath, relativePath));
      } else {
        files.push(relativePath);
      }
    }

    return files;
  }

  askQuestion(question) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
}

// CLI 入口
if (require.main === module) {
  const [,, command, ...args] = process.argv;

  const generator = new PluginGenerator();

  switch (command) {
    case 'create':
      const options = {};
      
      // 解析命令行参数
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i]?.replace(/^--/, '');
        const value = args[i + 1];
        if (key && value) {
          options[key] = value;
        }
      }

      generator.generatePlugin(options).catch(error => {
        console.error('❌ 创建插件失败:', error.message);
        process.exit(1);
      });
      break;

    default:
      console.log(`
MiniToolbox 插件生成器

用法:
  node plugin-generator.js create [选项]

选项:
  --id <id>              插件目录名
  --name <name>          插件名称
  --description <desc>   插件描述
  --author <author>      作者
  --version <version>    版本号
  --template <template>  模板类型 (basic|ui|text-processor|utility)
  --outputDir <dir>      输出目录

示例:
  node plugin-generator.js create
  node plugin-generator.js create --id my-plugin --name "我的插件" --template ui
      `);
  }
}

module.exports = PluginGenerator;
