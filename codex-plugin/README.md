# Understanding Map · Codex 插件

本地测试版 0.3.3。Codex 管理 MCP 插件进程，地图面板通过 MCP 读取、更新和定位，无需单独启动终端或 HTTP 服务。

## 使用

安装后在 Codex 当前聊天的侧边工具中选择“理解地图”。首次打开会读取当前聊天并初始化地图，重新打开或点击“更新地图”时检查新增用户消息。支持“按层级”和“按时间”，点击节点调用已有原文定位辅助程序。

当前测试包依赖 Node.js 20+、Python 3.9+、已认证的 Codex CLI。macOS 优先使用桌面应用内置 CLI。原文定位沿用系统辅助功能权限。

数据默认保存在 `~/.understanding-map`，可用 `UNDERSTANDING_MAP_HOME` 指定已有数据目录。每次操作都校验 Codex 提供的聊天标识和保存在本机的地图连接凭据，支持重开面板和插件进程重启后恢复连接。

## 开发与本地安装

在此目录执行 `npm ci`、`npm run build` 和 `npm test`。后端测试使用 `python3 -m unittest discover -s test -p '*_test.py' -v`。构建复用仓库内地图代码和现有测试 Release 中的脱敏定位辅助程序。

新克隆仓库时，先在仓库根目录下载构建所需的辅助程序附件。

```sh
gh release download v0.2.0-test.1 --pattern Understanding-Map-0.2.0-test.1.zip --dir validation/understanding-map/releases
```

随后在 `codex-plugin` 目录执行以下命令。

```sh
npm ci
npm run package
npm test
python3 -m unittest discover -s test -p '*_test.py' -v
```

`npm run package` 构建并生成 `releases/Understanding-Map-Codex-0.3.3.zip`、SHA-256 校验文件和 `START-HERE-Codex.md`。安装包包含独立运行所需的已打包脚本，接收者准备 Node.js、Python 和已认证的 Codex CLI 后即可按包内说明安装。程序文件按白名单收集，个人地图保存在每位使用者自己的数据目录。

在仓库根目录执行下面两条命令。

```sh
codex plugin marketplace add .
codex plugin add understanding-map@understanding-map-local
```

插件来源配置在仓库的 `.agents/plugins/marketplace.json`。桌面应用可能需要重新加载才能显示新安装的入口。

通过 CLI 升级时，已运行的桌面应用可能仍持有上一版 MCP 进程。若面板提示未能显示，且日志仍引用旧版本的资源目录，完整退出并重新打开 Codex，再打开当前聊天的地图。

## 验证范围

10 项自动测试通过，覆盖安装后的 MCP 启动、侧边入口声明、聊天标识、跨聊天数据隔离、重复打开保留数据、重启后恢复读取与刷新、旧连接失效处理及请求校验。

0.3.3 修复了桌面恢复面板后连接失效的问题。已安装的插件通过真实 MCP 协议将当前地图从 89 个节点更新到 91 个节点。重启 MCP 进程后，复用之前的连接直接读取和刷新成功，无需再次调用打开工具。旧版面板重连、并发请求共用重连、错误提示及持久连接恢复也通过浏览器测试。

0.3.2 修正了兼容格式 `.mcp.json` 中的工作目录。使用 `cwd: "."` 和相对脚本参数，由插件加载器解析实际安装目录。Codex 的 `mcpServerStatus/list` 已验证安装后的服务成功启动，返回服务版本 0.3.2、两项工具及空错误。旧版路径占位符配置在桌面实际加载时返回 ENOENT。

独立浏览器使用模拟 MCP 宿主，验证了面板加载、两种视图、重新刷新、原文读取和定位请求，页面无运行时错误。该测试使用现有浏览器运行时，Browser skill 在本会话不可用，Playwright CLI 下载因网络解析失败，测试改用已安装的 Playwright 库。

Codex 桌面已通过插件工具打开真实 MCP 面板，验证两种视图和刷新。用户已确认 0.3.3 可从侧边正常显示并更新，实际面板显示“地图已更新，新增 1 条摘要”，已载入 45 轮对话。Windows 安装与插件内跳转尚待原生实测。
