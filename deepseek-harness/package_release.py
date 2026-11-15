#!/usr/bin/env python3
"""Build a deterministic Harness plugin ZIP from an explicit program allowlist."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
PROGRAM_FILES = (
    'package.json', 'index.js', 'core.js', 'client.js',
    'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json',
)


def package(output=None):
    payload = {}
    for name in PROGRAM_FILES:
        source = ROOT / name
        if (not source.is_file() or source.is_symlink()
                or not source.resolve().is_relative_to(ROOT.resolve())):
            raise ValueError('Missing or linked program file: ' + name)
        payload[name] = source.read_bytes()
    metadata = json.loads(payload['package.json'])
    version = metadata['version']
    if (metadata.get('name') != '@local/understanding-map-deepseek'
            or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version)):
        raise ValueError('Invalid DeepSeek plugin package identity')
    name = 'Understanding-Map-DeepSeek-' + version
    instructions = f'''# Understanding Map · DeepSeek Harness 插件 {version}

这是 DeepSeek Harness 原生本地插件测试包。在聊天标题栏打开“理解地图”，使用“按层级”“按时间”、顶部标签筛选和“更新地图”。

## 安装与升级

1. 准备支持本地插件的 DeepSeek Harness，选好可用的模型和供应商。
2. 解压完整的 `{name}` 文件夹，放到准备长期保留的位置。
3. 在 Harness 中请助手使用原生 `plugin_manager` 工具安装。将以下 `target` 换成自己电脑上解压目录的绝对路径。

```json
{{"action":"install_bundle","target":"/absolute/path/to/{name}"}}
```

4. 通过 Harness 的安装审批，再按插件管理器提示启用插件并重新启动 Harness。
5. 打开自己的聊天，点击聊天标题栏的“理解地图”。

从旧版升级时，对新版目录执行同一安装命令，再按提示更新和重启。链接安装需要长期保留插件目录。无需手动编辑 Harness 配置文件。

## 打开与更新

地图首次挂载或切换聊天时检查当前聊天历史。继续交流后，地图底部会提示新消息数量；点击“更新地图”，等待“地图已更新”或“已是最新”。已挂载面板隐藏后再显示时可能复用缓存，检查新发言请点击“更新地图”。

只为新增用户发言生成摘要，旧地图缺少话题或意图字段时补齐分类，复用原有摘要、层级和定位标识。每批结果校验通过后保存，后续失败时已完成批次保留，再次更新继续处理剩余消息。

## 标签筛选与原文定位

顶部提供“全部、询问、想法、需求、反馈、确认”和各标签数量。可多选，显示匹配任一选中标签的发言。“全部”或“清除筛选”恢复完整地图，取消最后一个标签也恢复全部。两种视图共用筛选选择，并按聊天保存。

“按层级”保留匹配内容的祖先话题标题，隐藏空分支。“按时间”将连续未匹配发言折叠为“已隐藏 N 条”，标出原始序号范围；点击可展开为较淡的原始摘要，再次点击收起。展开后的发言仍可点击定位。

原始序号、蓝色深浅和横向层级保持原样。实线只连接原本存在且当前可见的承接两端，灰色虚线表示时间顺序。保持 Harness 原生“对话”视图打开，点击摘要即可请求补载历史并定位对应原文。

标签筛选、展开和定位只使用本机已有数据，不调用模型、不消耗模型 Token，也不修改保存的地图。摘要生成和标签补齐使用 Harness 当前选择的模型及供应商额度，不需要 Codex 账号。

## 数据与分享

每个人使用自己的 Harness 登录与模型配置。地图由 Harness Storage Domain 按聊天保存。本包只包含插件程序、安装说明和版本清单，分享时转发原始 ZIP 与 SHA-256 校验文件。

## 验证范围

此前版本已在 macOS 原生 Harness 验证打开地图、增量更新、重启恢复和原文定位。本版新增标签筛选与时间片段折叠的原生宿主验收仍需完成。Windows、英文原生界面、超长历史分页和附件单独消息仍需分别实测。
'''
    payload['START-HERE.md'] = instructions.encode('utf-8')
    payload['manifest.json'] = (json.dumps({
        'version': version,
        'kind': 'deepseek-harness-local-plugin',
        'package': metadata['name'],
        'requirements': ['DeepSeek Harness with native local-plugin support', 'configured Harness model provider'],
        'tag_filters_native_ui_verified': False,
    }, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    forbidden = [str(Path.home()).encode(), str(ROOT.parent).encode()]
    thread = os.environ.get('CODEX_THREAD_ID')
    if thread:
        forbidden.append(thread.encode())
    for entry, content in payload.items():
        if any(marker in content for marker in forbidden):
            raise ValueError('Personal build information found in ' + entry)

    target = Path(output or ROOT / 'releases').resolve()
    target.mkdir(parents=True, exist_ok=True)
    archive = target / (name + '.zip')
    handle, staged = tempfile.mkstemp(prefix='.' + name, suffix='.zip', dir=target)
    os.close(handle)
    try:
        with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
            for entry, content in sorted(payload.items()):
                info = zipfile.ZipInfo(name + '/' + entry, (2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                bundle.writestr(info, content)
        os.replace(staged, archive)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(
        digest + '  ' + archive.name + '\n', encoding='utf-8')
    (target / 'START-HERE-DeepSeek.md').write_text(instructions, encoding='utf-8')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': digest}))
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    package(args.output)
