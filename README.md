# Understanding Map

在 Codex 桌面聊天旁显示可定位的理解地图。用户继续在原生聊天中交流，右侧面板按话题或时间组织对话，点击节点可以回到原文。

当前提供 Codex 桌面本地插件和独立的 DeepSeek Harness 原生插件。Codex 插件由 Codex 管理 MCP 后台进程，在侧边工具中显示地图，使用已登录的 Codex 或 API 配置生成摘要，并调用本机导航辅助程序定位原文。DeepSeek 版本使用 Harness 的模型、侧边面板和原生消息定位。

## 当前状态

- Codex 插件最新源码为 `0.4.3` 测试版，包含五类意图标签、灰玫瑰配色、日常与开发模式及原文定位兼容修复。macOS 已验证侧边打开、刷新更新、重启恢复和旧连接自动重连。
- 现有 macOS 导航辅助程序的较长消息和短用户消息跳转已实测成功。短消息通过同轮回复的唯一片段定位上下文，插件在其他电脑上的原生跳转仍需验证。
- Windows UI Automation 辅助程序已交叉编译并通过纯协议检查，Windows 原生界面跳转仍待实机验证。
- 插件包已验证解压后的独立启动、Python 后台读取、侧边入口声明及隔离安装。Mac 测试包使用本地签名。
- 打开或刷新地图、点击“更新地图”时检查新增用户消息，由独立 Codex 任务增量生成摘要。内容相同时跳过模型调用。
- DeepSeek Harness 插件最新源码为 `0.3.2`，包含相同的意图标签与配色，并优化了摘要提示词。macOS 已验证层级与时间视图、增量更新和原生消息定位，详见 [DeepSeek 说明](deepseek-harness/README.md)。

## 安装 Codex 插件

已发布的测试安装包为 [0.4.3 Release](https://github.com/dickens2685477697-dotcom/Understanding-Map/releases/tag/v0.4.3)，下载 `Understanding-Map-Codex-0.4.3.zip` 后解压完整文件夹。Release 同时提供 DeepSeek Harness `0.3.2` 插件 ZIP 和两端安装说明。当前仓库为私有，下载者需要仓库访问权限，也可以接收原始 ZIP。

准备 Codex 桌面版、Node.js 20+、Python 3.9+，并确保 Codex CLI 已用自己的账号登录或配置 API。Mac 使用 `python3`，Windows 使用 `python`。原文定位的 Mac 辅助程序面向 Apple Silicon 和 macOS 15+，首次使用需要辅助功能权限。

在解压后的 `Understanding-Map-Codex-0.4.3` 文件夹中打开终端或 PowerShell，执行以下命令。

```sh
codex plugin marketplace add .
codex plugin add understanding-map@understanding-map-local
```

完全退出并重新打开 Codex，在自己的聊天右侧选择“更多工具… → 理解地图”。首次打开整理聊天历史，之后打开或刷新地图、点击“更新地图”时整理新增用户消息。安装包内的 `START-HERE.md` 包含完整说明及 Mac 内置 CLI 的替代命令。

从旧版升级时，先完全退出 Codex，在新版解压目录重新执行上面两条命令，再重开应用。

生成和更新摘要使用每位接收者自己的模型额度。个人地图和聊天原文保存在自己的 `~/.understanding-map`。

## 原有 Skill 与本机服务版本

[0.2.0-test.1 Release](https://github.com/dickens2685477697-dotcom/Understanding-Map/releases/tag/v0.2.0-test.1) 提供 Skill 与双击启动程序。该版本按附件中的 `START-HERE.txt` 安装和启动。对应源码说明见 [START-HERE.txt](validation/understanding-map/distribution/START-HERE.txt)。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `codex-plugin/` | Codex MCP 插件、嵌入式地图、恢复连接和 Release 打包 |
| `.agents/plugins/marketplace.json` | 构建后用于本地安装的 Codex 插件来源配置 |
| `deepseek-harness/` | DeepSeek Harness 原生插件及验证代码 |
| `validation/understanding-map/` | 理解地图、本地服务和验证代码 |
| `validation/understanding-map/skill-draft/understanding-map/` | Skill 工作流与状态管理脚本 |
| `validation/understanding-map/native-helper/` | macOS Swift 导航辅助程序源码 |
| `validation/understanding-map/distribution/` | 跨平台安装、启动、打包及 Windows C# 适配 |
| `src/` | 早期 ChatGPT 浏览器扩展原型 |

## 开发和验证

```bash
npm ci
npm test
npm run build
python3 -m unittest discover -s validation/understanding-map -p 'test_*.py'
python3 -m unittest discover -s validation/understanding-map/skill-draft/understanding-map/scripts -p 'test_*.py'
```

构建 Mac 本机辅助程序需要 Xcode Command Line Tools。

```bash
sh validation/understanding-map/native-helper/build_helper.sh
```

跨平台测试包的构建还需要 Mono，以及 Microsoft .NET Framework 4.8 的 UI Automation 引用程序集。引用程序集可以从 Microsoft 官方 NuGet 包 `Microsoft.NETFramework.ReferenceAssemblies.net48` 中获取，解压后使用包含 `UIAutomationClient.dll`、`UIAutomationTypes.dll` 和 `WindowsBase.dll` 的目录。

```bash
python3 validation/understanding-map/distribution/build_release.py --net48-refs /path/to/references
python3 validation/understanding-map/distribution/test_distribution.py
```

构建产物位于 `validation/understanding-map/releases/`。

### 构建 Codex 插件包

插件构建使用当前 Swift 源码生成 macOS 定位辅助程序，并复用 `0.2.0-test.1` Release 中的 Windows 辅助程序。准备该附件后，在 `codex-plugin` 目录执行构建与打包，详细命令见 [插件开发说明](codex-plugin/README.md)。发布产物位于 `codex-plugin/releases/`。

## 本地数据

安装后的个人地图和聊天原文保存在 `~/.understanding-map`。开发实验使用的 `validation/understanding-map-private/`、访问令牌、聊天状态、依赖缓存和编译产物均由 `.gitignore` 排除。

早期浏览器扩展通过 `Structure` 操作读取选中的 ChatGPT 回复，并使用用户配置的 OpenAI API Key 调用 Responses API。该密钥由扩展保存在 `chrome.storage.local`。
