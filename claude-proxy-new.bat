@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion


:: ================== 修改这里 ==================

set "PROXY_PORT=7890"
set "PROXY_HOST=127.0.0.1"

:: ==============================================


set "http_proxy=http://%PROXY_HOST%:%PROXY_PORT%/"
set "https_proxy=http://%PROXY_HOST%:%PROXY_PORT%/"
set "all_proxy=socks5://%PROXY_HOST%:%PROXY_PORT%/"


echo.
echo ============================================
echo       代理已设置（仅当前窗口有效）
echo ============================================
echo.

echo 端口: %PROXY_PORT%
echo HTTP_PROXY  = %http_proxy%
echo HTTPS_PROXY = %https_proxy%
echo ALL_PROXY   = %all_proxy%

echo.


echo 请选择 Claude Code 权限模式:
echo.
echo 1. auto              推荐模式
echo 2. acceptEdits       自动接受文件编辑
echo 3. bypassPermissions 完全跳过确认
echo 4. default           默认确认
echo 5. 仅进入代理环境
echo.


set /p choice=请输入数字 (1-5，默认1):

if "%choice%"=="" set choice=1


if "%choice%"=="1" set "PERM_MODE=auto"
if "%choice%"=="2" set "PERM_MODE=acceptEdits"
if "%choice%"=="3" set "PERM_MODE=bypassPermissions"
if "%choice%"=="4" set "PERM_MODE=default"

if "%choice%"=="5" goto env_only


if "%PERM_MODE%"=="" (
    echo 输入错误，使用 auto
    set "PERM_MODE=auto"
)


echo.
echo 当前模式: %PERM_MODE%
echo 正在启动 Claude Code...
echo.


claude --permission-mode "%PERM_MODE%"


goto :eof



:env_only

echo.
echo 已进入代理环境
echo.
echo 关闭代理:
echo set http_proxy=
echo set https_proxy=
echo set all_proxy=
echo.

cmd /k