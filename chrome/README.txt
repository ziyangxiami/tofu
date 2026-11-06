豆伴旧版 Windows Chromium 启动器

构建（Windows，Visual Studio C++ 与 CMake 3.16+）：
  cmake -S chrome -B build/chrome
  cmake --build build/chrome --config Release

可执行文件位于 build/chrome/bin（多配置生成器可能位于 bin/Release）。
图标从 main.rc/app.ico 编入，构建产物不会写入源码目录。

将可执行文件放入以下目录结构：
  ChromeLauncher.exe
  config.ini             可选，复制 config.ini.example 并修改
  chrome/chrome.exe       需自行提供兼容 Chromium
  userdata/              浏览器启动后创建

config.ini 使用 [extension] 节的 id 字段，必须是 32 位 a-p 小写字母。
缺省值沿用历史扩展 ID。配置、浏览器和数据目录全部相对启动器文件，
不依赖快捷方式或调用者的工作目录。支持含空格和中文的目录。

这是历史发布渠道的启动器，仍使用 update.doufen.org 的策略更新地址。
它不会自动安装当前仓库里的 extension 目录，也不证明该更新站点提供
当前源码版本。验证本仓库扩展应在 Chrome 扩展管理页加载 extension。
运行启动器会写入当前用户的 Chromium 扩展策略；本次修复未执行该程序。

本地验证：node extension/tests/windows-settings-regression.mjs
其中 C 回归在宿主 clang 上编译真实 main.c，并用 Win32 API mock 检查路径、
配置、命令行、注册表错误与句柄清理；不等于 Windows 实际构建或运行验收。
