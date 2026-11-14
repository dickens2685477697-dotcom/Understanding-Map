#!/usr/bin/env python3
"""Package the built Codex plugin using a program-file allowlist."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent


def package(output=None):
    builder_path = ROOT.parent / 'validation/understanding-map/distribution/windows/build_helper.py'
    spec = importlib.util.spec_from_file_location('windows_navigator_build', builder_path)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    builder.verify(ROOT / 'runtime/assets/windows/MapNavigator.exe')
    manifest = json.loads((ROOT / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
    version = manifest['version']
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version):
        raise ValueError('Invalid package version')
    name = 'Understanding-Map-Codex-' + version
    target = Path(output or ROOT / 'releases').resolve()
    target.mkdir(parents=True, exist_ok=True)
    files = {
        'codex-plugin/.codex-plugin/plugin.json': ROOT / '.codex-plugin/plugin.json',
        'codex-plugin/.mcp.json': ROOT / '.mcp.json',
        'codex-plugin/backend.py': ROOT / 'backend.py',
        'codex-plugin/dist/server.mjs': ROOT / 'dist/server.mjs',
        'codex-plugin/dist/panel.html': ROOT / 'dist/panel.html',
    }
    for filename in ('init_tracker.py', 'map_state.py', 'publish_view.py', 'reopen_map.py',
                     'preview_server.py', 'map_refresh.py', 'native_navigation.py', 'live-panel.html'):
        files['codex-plugin/runtime/' + filename] = ROOT / 'runtime' / filename
    for file in (ROOT / 'runtime/assets').rglob('*'):
        if file.is_file() and not file.is_symlink():
            files['codex-plugin/' + file.relative_to(ROOT).as_posix()] = file
    for required in (
        'codex-plugin/runtime/assets/native-helper/Understanding Map Navigator.app/Contents/MacOS/MapNavigator',
        'codex-plugin/runtime/assets/windows/MapNavigator.exe',
    ):
        if required not in files:
            raise ValueError('Native helper is missing. Run npm run build first.')

    catalog = {
        'name': 'understanding-map-local',
        'interface': {'displayName': 'Understanding Map 测试插件'},
        'plugins': [{
            'name': 'understanding-map',
            'source': {'source': 'local', 'path': './codex-plugin'},
            'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
            'category': 'Productivity',
        }],
    }
    instructions = f'''# Understanding Map · Codex 插件 {version}

这是可本地安装的 Codex 桌面插件测试包。安装后，在聊天右侧“更多工具…”中打开“理解地图”，使用“按层级”“按时间”和“更新地图”。Codex 管理后台进程。

## 安装前准备

- 安装 Codex 桌面版。
- 安装 Node.js 20+，确保 `node --version` 可用。
- 安装 Python 3.9+。Mac 需有 `python3` 命令，Windows 支持 `py -3`、`python` 或 `python3`。
- 确保 `codex` 命令可用，并已用自己的账号登录或配置 API。可用 `codex login status` 检查。
- 当前 Mac 原文定位辅助程序面向 Apple Silicon 与 macOS 15+。

## 首次安装

1. 解压完整文件夹，放到准备长期保留的位置。
2. 在解压后的 `{name}` 文件夹中打开终端或 PowerShell。
3. 执行以下两条命令。

```sh
codex plugin marketplace add .
codex plugin add understanding-map@understanding-map-local
```

4. 完全退出并重新打开 Codex。Mac 使用 ⌘Q。
5. 进入自己的聊天，打开右侧工具区的“更多工具…”，选择“理解地图”。
6. Mac 首次使用原文定位时，按系统提示为 Understanding Map Navigator 授予辅助功能权限。

如果终端提示找不到 `codex`，Mac 安装到默认位置的桌面应用通常附带 CLI，可使用下面的命令形式。

```sh
"/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" plugin marketplace add .
"/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" plugin add understanding-map@understanding-map-local
```

## 从旧版升级

先完全退出 Codex，再解压新版 ZIP 到准备长期保留的位置。在新版文件夹中重新执行上面的 `codex plugin marketplace add .` 和 `codex plugin add understanding-map@understanding-map-local`，然后重新打开 Codex 与地图。

## 日常使用

在 Codex 的聊天侧边打开“理解地图”。面板首次加载时整理该聊天历史，真正刷新或重新加载面板、点击“更新地图”时检查新增用户消息。宿主可能复用已挂载页面，发送新消息后请点击“更新地图”。摘要前显示询问、想法、需求、反馈、确认中的主要意图，承接设想的“开始做”按需求理解。旧地图更新时补齐缺失标签。内容相同且标签齐全时复用结果。点击节点请求定位原文。

## 首次启动失败时

Windows 安装或更新 Node.js、Python、Codex CLI 后，先完整退出 Codex 的所有窗口，再重新打开。在 PowerShell 中分别检查以下命令。

```powershell
node --version
py -3 --version
codex --version
```

Node.js 应为 20+，Python 应为 3.9+。如果 `py -3` 不可用，可检查 `python --version` 或 `python3 --version`。插件会检测可用的解释器。

如果依然启动失败，请提供地图内的完整错误文字。Python 缺失、版本不足、Codex CLI 缺失和插件后台连接中断会显示对应提示。安装后按包内命令注册插件，再从 Codex 的“更多工具…”进入地图。

如果提示摘要任务超时，说明后台已在运行。0.4.4 每批最多整理 16 条，校验后立即保存，单批最多等待 5 分钟。点击“更新地图”可继续处理剩余消息。仍超时时，请核对同一台电脑上的 Codex CLI 能否正常生成回复，并提供完整错误文字。

## Windows 原文定位

0.4.5 从当前源码重新编译 Windows 定位组件，优先识别已有的聊天查找框，兼容范围切换按钮隐藏的界面。若旧版点击摘要只出现空查找框，请升级后完整退出 Codex 的所有窗口，再重新打开对应聊天和地图。原生 Windows 跳转仍需实机确认。日常界面显示简短错误原因，详细诊断仅在开发模式显示。

## 数据和用量

每个人使用自己的 Codex 登录或 API 配置。摘要生成与更新计入该配置的模型用量。

个人地图和保存的聊天原文位于 `~/.understanding-map`。本测试包由程序文件白名单打包。再次分享时请转发原始 ZIP。

## 验证范围

作者的 Mac 已实测侧边打开、更新、重启恢复，以及点击地图节点跳转到原生聊天对应位置。Windows 的安装与原生跳转、其他电脑上的原文定位需要继续实测。本机定位辅助程序采用测试签名，跨机器分发仍处于测试阶段。

## 参考

- [Codex 插件打包与本地安装](https://developers.openai.com/plugins/build/plugins)
- [Node.js 下载](https://nodejs.org/en/download)
- [Python 下载](https://www.python.org/downloads/)
'''
    extras = {
        '.agents/plugins/marketplace.json': json.dumps(catalog, ensure_ascii=False, indent=2).encode('utf-8'),
        'START-HERE.md': instructions.encode('utf-8'),
        'manifest.json': json.dumps({
            'version': version, 'kind': 'codex-local-plugin',
            'requirements': ['Node.js 20+', 'Python 3.9+', 'authenticated Codex CLI'],
            'macos_native_helper': 'Apple Silicon, macOS 15+',
            'windows_native_verified': False,
        }, ensure_ascii=False, indent=2).encode('utf-8'),
    }
    forbidden = [str(Path.home()).encode(), str(ROOT.parent).encode()]
    sid = os.environ.get('CODEX_THREAD_ID')
    if sid:
        forbidden.append(sid.encode())
    for path, file in files.items():
        if not file.is_file() or file.is_symlink():
            raise ValueError('Missing or linked program file: ' + path)
        if any(marker in file.read_bytes() for marker in forbidden):
            raise ValueError('Personal build information found in ' + path)
    archive = target / (name + '.zip')
    fd, staged = tempfile.mkstemp(prefix='.' + name, suffix='.zip', dir=target)
    os.close(fd)
    try:
        with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED) as bundle:
            for path, file in sorted(files.items()):
                bundle.write(file, name + '/' + path)
            for path, content in extras.items():
                bundle.writestr(name + '/' + path, content)
        os.replace(staged, archive)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (archive.with_suffix('.zip.sha256')).write_text(digest + '  ' + archive.name + '\n', encoding='utf-8')
    (target / 'START-HERE-Codex.md').write_text(instructions, encoding='utf-8')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': digest}))
    return archive


if __name__ == '__main__':
    package()
