@echo off
REM MiniToolbox 插件构建脚本
echo MiniToolbox 插件构建工具
echo.

REM 检查 Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

REM 设置目录
set TOOLS_DIR=%~dp0
set ROOT_DIR=%TOOLS_DIR%..
set PLUGINS_DIR=%ROOT_DIR%\plugins
set DIST_DIR=%ROOT_DIR%\dist\plugins

echo 工具目录: %TOOLS_DIR%
echo 插件目录: %PLUGINS_DIR%
echo 输出目录: %DIST_DIR%
echo.

REM 创建输出目录
if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

REM 显示菜单
:menu
echo 请选择操作:
echo 1. 验证所有插件
echo 2. 打包所有插件
echo 3. 创建新插件
echo 4. 发布插件 (需要API密钥)
echo 5. 安装依赖
echo 0. 退出
echo.
set /p choice=请输入选择 (0-5): 

if "%choice%"=="1" goto validate
if "%choice%"=="2" goto pack
if "%choice%"=="3" goto create
if "%choice%"=="4" goto publish
if "%choice%"=="5" goto install
if "%choice%"=="0" goto end
echo 无效选择，请重试
goto menu

:validate
echo.
echo 正在验证所有插件...
cd /d "%TOOLS_DIR%"
for /d %%i in ("%PLUGINS_DIR%\*") do (
    echo 验证插件: %%~ni
    node plugin-packager.js validate "%%i"
    if errorlevel 1 (
        echo 验证失败: %%~ni
    ) else (
        echo 验证通过: %%~ni
    )
    echo.
)
echo 验证完成
pause
goto menu

:pack
echo.
echo 正在打包所有插件...
cd /d "%TOOLS_DIR%"
node plugin-packager.js pack-all "%PLUGINS_DIR%" "%DIST_DIR%"
if errorlevel 1 (
    echo 打包失败
) else (
    echo 打包完成，输出目录: %DIST_DIR%
)
pause
goto menu

:create
echo.
echo 创建新插件
cd /d "%TOOLS_DIR%"
node plugin-generator.js create
pause
goto menu

:publish
echo.
echo 发布插件到注册中心
set /p api_key=请输入API密钥: 
if "%api_key%"=="" (
    echo 未提供API密钥，取消发布
    pause
    goto menu
)
set PLUGIN_API_KEY=%api_key%
set /p plugin_path=请输入插件路径 (或留空发布所有): 
cd /d "%TOOLS_DIR%"
if "%plugin_path%"=="" (
    node publish-plugin.js publish-all "%PLUGINS_DIR%"
) else (
    node publish-plugin.js publish "%plugin_path%"
)
pause
goto menu

:install
echo.
echo 安装项目依赖...
cd /d "%ROOT_DIR%"
npm install
if errorlevel 1 (
    echo 依赖安装失败
) else (
    echo 依赖安装完成
)
pause
goto menu

:end
echo 感谢使用 MiniToolbox 插件构建工具！
pause
