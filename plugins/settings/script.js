class SettingsManager {
    constructor() {
        this.config = {};
        this.currentPanel = 'ui';
        this.recordingShortcut = null;
        this.init();
    }

    async init() {
        await this.loadConfig();
        this.setupEventListeners();
        this.updateUI();
        this.applyTheme();
    }

    // 加载配置
    async loadConfig() {
        try {
            const configData = await window.MT.invoke('config.get');
            this.config = configData || {};
        } catch (error) {
            console.error('配置加载失败:', error);
            // 使用默认配置
            this.config = {
                ui: { theme: 'system', titlebarHeight: 48, windowOpacity: 0.95 },
                clipboard: { enabled: true, autoFillMaxAge: 5 },
                plugins: { maxResults: 10 },
                shortcuts: { mainWindow: 'Ctrl+Space' },
                performance: { debounceDelay: 150 }
            };
        }
    }

    // 更新UI显示
    updateUI() {
        // UI设置
        this.setUIValue('theme', this.config.ui?.theme || 'system');
        this.setUIValue('titlebarHeight', this.config.ui?.titlebarHeight || 48);
        this.setUIValue('windowOpacity', this.config.ui?.windowOpacity || 0.95);
        this.setUIValue('fontSize', this.config.ui?.fontSize || 'medium');
        this.setToggle('animations', this.config.ui?.animations ?? true);
        this.setToggle('compactMode', this.config.ui?.compactMode ?? false);

        // 剪贴板设置
        this.setToggle('clipboardEnabled', this.config.clipboard?.enabled ?? true);
        this.setUIValue('clipboardMaxAge', this.config.clipboard?.autoFillMaxAge || 5);
        this.setUIValue('clipboardMaxHistory', this.config.clipboard?.maxHistoryItems || 500);

        // 插件设置
        this.setToggle('pluginAutoReload', this.config.plugins?.autoReload ?? false);
        this.setUIValue('pluginMaxResults', this.config.plugins?.maxResults || 10);
        this.setToggle('pluginEnableHeadless', this.config.plugins?.enableHeadless ?? true);
        this.setToggle('pluginShowFeatureCodes', this.config.plugins?.showFeatureCodes ?? false);

        // 快捷键设置
        this.setUIValue('shortcutMainWindow', this.config.shortcuts?.mainWindow || 'Ctrl+Space');
        this.setUIValue('shortcutHideWindow', this.config.shortcuts?.hideWindow || 'Escape');

        // 高级设置
        this.setUIValue('performanceDebounceDelay', this.config.performance?.debounceDelay || 150);
        this.setToggle('performanceCacheResults', this.config.performance?.cacheResults ?? true);
        this.setToggle('performanceEnableLogging', this.config.performance?.enableLogging ?? false);

        // 更新透明度显示
        this.updateOpacityDisplay();
    }

    // 设置UI元素的值
    setUIValue(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.value = value;
        }
    }

    // 设置开关状态
    setToggle(id, value) {
        const element = document.getElementById(id);
        if (element) {
            if (value) {
                element.classList.add('active');
            } else {
                element.classList.remove('active');
            }
        }
    }

    // 更新透明度显示
    updateOpacityDisplay() {
        const slider = document.getElementById('windowOpacity');
        const display = document.getElementById('opacityValue');
        if (slider && display) {
            const value = parseFloat(slider.value);
            display.textContent = Math.round(value * 100) + '%';
        }
    }

    // 设置事件监听器
    setupEventListeners() {
        // 侧边栏菜单切换
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => this.switchPanel(item.dataset.panel));
        });

        // 开关控件
        document.querySelectorAll('.toggle-switch').forEach(toggle => {
            toggle.addEventListener('click', () => this.toggleSwitch(toggle));
        });

        // 下拉选择和输入框
        document.querySelectorAll('.select-control, .number-input').forEach(control => {
            control.addEventListener('change', () => this.handleConfigChange());
        });

        // 滑块
        const opacitySlider = document.getElementById('windowOpacity');
        if (opacitySlider) {
            opacitySlider.addEventListener('input', () => {
                this.updateOpacityDisplay();
                this.handleConfigChange();
            });
        }

        // 按钮事件
        document.getElementById('exportConfig')?.addEventListener('click', () => this.exportConfig());
        document.getElementById('importConfig')?.addEventListener('click', () => this.importConfig());
        document.getElementById('resetConfig')?.addEventListener('click', () => this.resetConfig());
        
        // 文件选择
        document.getElementById('configFile')?.addEventListener('change', (e) => this.handleFileImport(e));

        // 快捷键设置
        document.querySelectorAll('.shortcut-input').forEach(input => {
            input.addEventListener('click', () => this.startRecordingShortcut(input));
            input.addEventListener('blur', () => this.stopRecordingShortcut());
        });
    }

    // 切换面板
    switchPanel(panelId) {
        // 更新菜单状态
        document.querySelectorAll('.menu-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-panel="${panelId}"]`).classList.add('active');

        // 显示对应面板
        document.querySelectorAll('.content-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        document.getElementById(`panel-${panelId}`).classList.add('active');

        // 更新标题和描述
        const titles = {
            ui: { title: '外观', desc: '自定义应用的外观和主题设置' },
            clipboard: { title: '剪贴板', desc: '配置剪贴板自动填充和历史记录功能' },
            plugins: { title: '插件', desc: '管理插件的加载和显示设置' },
            shortcuts: { title: '快捷键', desc: '设置全局快捷键和键盘操作' },
            advanced: { title: '高级', desc: '高级选项和配置管理' }
        };

        const info = titles[panelId] || { title: '设置', desc: '' };
        document.getElementById('contentTitle').textContent = info.title;
        document.getElementById('contentDesc').textContent = info.desc;

        this.currentPanel = panelId;
    }

    // 切换开关
    toggleSwitch(toggle) {
        toggle.classList.toggle('active');
        this.handleConfigChange();
    }

    // 处理配置变更
    async handleConfigChange() {
        try {
            // 收集当前UI状态
            const newConfig = this.collectCurrentConfig();
            
            // 更新内存中的配置
            this.config = { ...this.config, ...newConfig };
            
            // 立即保存到后端
            const success = await this.saveConfig(newConfig);
            
            if (success) {
                // 如果主题发生变化，立即应用
                this.applyTheme();
            }
            
        } catch (error) {
            console.error('配置保存失败:', error);
        }
    }

    // 收集当前UI配置
    collectCurrentConfig() {
        return {
            ui: {
                theme: document.getElementById('theme')?.value || 'system',
                titlebarHeight: parseInt(document.getElementById('titlebarHeight')?.value) || 48,
                windowOpacity: parseFloat(document.getElementById('windowOpacity')?.value) || 0.95,
                fontSize: document.getElementById('fontSize')?.value || 'medium',
                animations: document.getElementById('animations')?.classList.contains('active') ?? true,
                compactMode: document.getElementById('compactMode')?.classList.contains('active') ?? false
            },
            clipboard: {
                enabled: document.getElementById('clipboardEnabled')?.classList.contains('active') ?? true,
                autoFillMaxAge: parseInt(document.getElementById('clipboardMaxAge')?.value) || 5,
                maxHistoryItems: parseInt(document.getElementById('clipboardMaxHistory')?.value) || 500
            },
            plugins: {
                autoReload: document.getElementById('pluginAutoReload')?.classList.contains('active') ?? false,
                maxResults: parseInt(document.getElementById('pluginMaxResults')?.value) || 10,
                enableHeadless: document.getElementById('pluginEnableHeadless')?.classList.contains('active') ?? true,
                showFeatureCodes: document.getElementById('pluginShowFeatureCodes')?.classList.contains('active') ?? false
            },
            shortcuts: {
                mainWindow: document.getElementById('shortcutMainWindow')?.value || 'Ctrl+Space',
                hideWindow: document.getElementById('shortcutHideWindow')?.value || 'Escape'
            },
            performance: {
                debounceDelay: parseInt(document.getElementById('performanceDebounceDelay')?.value) || 150,
                cacheResults: document.getElementById('performanceCacheResults')?.classList.contains('active') ?? true,
                enableLogging: document.getElementById('performanceEnableLogging')?.classList.contains('active') ?? false
            }
        };
    }

    // 保存配置到后端
    async saveConfig(configData) {
        try {
            await window.MT.invoke('config.import', configData);
            return true;
        } catch (error) {
            console.error('配置保存失败:', error);
            return false;
        }
    }

    // 导出配置
    async exportConfig() {
        try {
            const configData = await window.MT.invoke('config.export');
            const configJson = JSON.stringify(configData, null, 2);
            const blob = new Blob([configJson], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = `minitoolbox-config-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
        } catch (error) {
            console.error('导出失败:', error);
        }
    }

    // 导入配置
    importConfig() {
        document.getElementById('configFile')?.click();
    }

    // 处理文件导入
    async handleFileImport(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const configData = JSON.parse(text);
            
            await window.MT.invoke('config.import', configData);
            await this.loadConfig();
            this.updateUI();
        } catch (error) {
            console.error('导入失败:', error);
        }
        
        // 清空文件选择
        event.target.value = '';
    }

    // 重置配置
    async resetConfig() {
        if (!confirm('确定要重置所有设置为默认值吗？此操作不可恢复。')) {
            return;
        }

        try {
            await window.MT.invoke('config.reset');
            await this.loadConfig();
            this.updateUI();
        } catch (error) {
            console.error('重置失败:', error);
        }
    }

    // 开始录制快捷键
    startRecordingShortcut(input) {
        if (this.recordingShortcut) return;
        
        this.recordingShortcut = input;
        input.classList.add('recording');
        input.value = '按下快捷键...';
        input.focus();

        // 添加键盘事件监听
        this.handleShortcutKeydown = (e) => this.onShortcutKeydown(e);
        document.addEventListener('keydown', this.handleShortcutKeydown, true);
    }

    // 停止录制快捷键
    stopRecordingShortcut() {
        if (!this.recordingShortcut) return;
        
        this.recordingShortcut.classList.remove('recording');
        if (this.recordingShortcut.value === '按下快捷键...') {
            // 恢复原值
            const id = this.recordingShortcut.id;
            if (id === 'shortcutMainWindow') {
                this.recordingShortcut.value = this.config.shortcuts?.mainWindow || 'Ctrl+Space';
            } else if (id === 'shortcutHideWindow') {
                this.recordingShortcut.value = this.config.shortcuts?.hideWindow || 'Escape';
            }
        }
        
        this.recordingShortcut = null;
        document.removeEventListener('keydown', this.handleShortcutKeydown, true);

        // 无需通知主进程
    }

    // 处理快捷键按下
    onShortcutKeydown(e) {
        if (!this.recordingShortcut) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        // 黑名单：直接拦截系统菜单组合（Alt+Space）、F10、Alt 键单独
        if ((e.altKey && (e.key === ' ' || e.code === 'Space')) || e.key === 'F10' || (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight'))) {
            // 什么也不做，只是阻止默认
            return;
        }

        const keys = [];
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');
        if (e.metaKey) keys.push('Meta');
        
        // 添加主键
        const key = e.key;
        if (key && key !== 'Control' && key !== 'Alt' && key !== 'Shift' && key !== 'Meta') {
            // 特殊键名转换
            const keyMap = {
                ' ': 'Space',
                'ArrowUp': 'Up',
                'ArrowDown': 'Down',
                'ArrowLeft': 'Left',
                'ArrowRight': 'Right'
            };
            keys.push(keyMap[key] || key);
        }
        
        if (keys.length > 0) {
            const shortcut = keys.join('+');
            this.recordingShortcut.value = shortcut;
            
            // 保存快捷键
            setTimeout(() => {
                this.handleConfigChange();
                this.stopRecordingShortcut();
            }, 100);
        }
    }

    // 应用主题
    async applyTheme() {
        try {
            // 从当前配置中获取主题信息
            const theme = this.config.ui?.theme || 'system';
            let effective = theme;
            if (theme === 'system') {
                // 系统主题检测
                effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }
            
            document.documentElement.setAttribute('data-theme', effective);
            
            const isDark = effective === 'dark';
            document.documentElement.style.setProperty('--bg', isDark ? '#1e1e1e' : '#ffffff');
            document.documentElement.style.setProperty('--fg', isDark ? '#e0e0e0' : '#333333');
            document.documentElement.style.setProperty('--panel', isDark ? '#2d2d2d' : '#ffffff');
            document.documentElement.style.setProperty('--sidebar-bg', isDark ? '#252526' : '#f8f9fa');
            document.documentElement.style.setProperty('--border', isDark ? '#404040' : '#e1e5e9');
            document.documentElement.style.setProperty('--border-light', isDark ? '#353535' : '#f0f0f0');
            document.documentElement.style.setProperty('--text-muted', isDark ? '#a0a0a0' : '#666666');
            document.documentElement.style.setProperty('--hover', isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)');
            document.documentElement.style.setProperty('--primary-bg', '#007AFF');
            
        } catch (error) {
            console.error('主题应用失败:', error);
        }
    }
}

// 监听插件输入
window.MT.onInput((inputData) => {
    // 设置插件收到输入时不需要特殊处理
});

// 初始化设置管理器
let settingsManager;
document.addEventListener('DOMContentLoaded', () => {
    settingsManager = new SettingsManager();
});

// 全局错误处理
window.addEventListener('error', (event) => {
    console.error('设置界面错误:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('未处理的Promise错误:', event.reason);
});