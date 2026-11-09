# Understanding Map

在 Codex 桌面聊天旁显示可定位的理解地图。用户继续在原生聊天中交流，右侧面板按话题或时间组织对话，点击节点可以回到原文。

产品由 Skill、本机网页面板、本地服务和原生导航辅助程序组成。地图生成与更新使用 Codex，点击节点的定位操作运行本机代码。

## 当前状态

- macOS 上的较长消息和短用户消息已由用户实测跳转成功。短消息通过同轮回复的唯一片段定位上下文。
- Windows UI Automation 辅助程序已交叉编译并通过纯协议检查，Windows 原生界面跳转仍待实机验证。
- 分发包的隔离安装、重复安装、数据分离和内容检查已通过。Mac 测试包尚未完成 Developer ID 签名和公证。
- 本机服务需要保持运行。地图按 Skill 工作流增量更新，默认每五轮完整对话刷新一次。

## 安装和使用

前往 [GitHub Release](https://github.com/dickens2685477697-dotcom/Understanding-Map/releases/tag/v0.2.0-test.1) 下载 `Understanding-Map-0.2.0-test.1.zip`，解压后使用。当前仓库为私有，下载者需要仓库访问权限。

测试包包含 Mac 的 `01-Install.command`、`02-Start.command` 和 Windows 的 `01-Install.cmd`、`02-Start.cmd`。接收者先安装 Codex 桌面版与 Python 3.9+。Mac 构建要求 Apple Silicon 和 macOS 15+，首次使用需要授予辅助功能权限。Windows 使用原生环境及 .NET Framework 4.8。

首次运行安装入口，以后运行启动入口并保持终端开启。在当前 Codex 聊天发送下面的指令。

```text
$understanding-map 为当前聊天开启理解地图并打开右侧面板
```

恢复已有地图时使用 `$understanding-map 打开理解地图`。测试包完整说明见 [START-HERE.txt](validation/understanding-map/distribution/START-HERE.txt)。

## 代码结构

| 目录 | 内容 |
| --- | --- |
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

## 本地数据

安装后的个人地图和聊天原文保存在 `~/.understanding-map`。开发实验使用的 `validation/understanding-map-private/`、访问令牌、聊天状态、依赖缓存和编译产物均由 `.gitignore` 排除。

早期浏览器扩展通过 `Structure` 操作读取选中的 ChatGPT 回复，并使用用户配置的 OpenAI API Key 调用 Responses API。该密钥由扩展保存在 `chrome.storage.local`。
