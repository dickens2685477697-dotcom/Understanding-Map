#!/usr/bin/env python3
"""Reuse the map service inside the Codex-managed MCP process lifecycle."""
import json
import os
from pathlib import Path
import sys
import threading
import uuid
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'runtime'))
from init_tracker import checked_session_id, initialize
from map_refresh import CodexReader, RefreshJobs, UpdateError
from preview_server import resolve_resource, resolve_session, resolve_node_record, resolve_node_source
import native_navigation


class MapSessionExpired(ValueError):
    pass


class Backend:
    def __init__(self):
        self.data_root = Path(os.environ.get('UNDERSTANDING_MAP_HOME', Path.home() / '.understanding-map')).expanduser().resolve()
        if sys.platform == 'darwin':
            helper = ROOT / 'runtime/assets/native-helper/Understanding Map Navigator.app/Contents/MacOS/MapNavigator'
        elif sys.platform == 'win32':
            helper = ROOT / 'runtime/assets/windows/MapNavigator.exe'
        else:
            helper = None
        self.helper = str(helper) if helper and helper.is_file() else None
        self.jobs = RefreshJobs()
        self.navigation_lock = threading.Lock()
        self.navigation_state_lock = threading.Lock()
        self.navigation_jobs = {}

    def dispatch(self, request):
        sid = checked_session_id(request.get('thread_id'))
        if request['action'] == 'open':
            with CodexReader() as reader:
                if reader.call('thread/read', {'threadId': sid})['thread']['id'] != sid:
                    raise ValueError('当前聊天校验失败。')
            result = initialize(self.data_root, sid)
            config = json.loads(Path(result['config_path']).read_text(encoding='utf-8'))
            return {'ready': True, 'session': config['view_access_token']}
        if request['action'] != 'request':
            raise ValueError('地图操作无效。')
        entry = resolve_session(self.data_root, request.get('session', ''))
        if entry is None:
            raise MapSessionExpired('地图连接已失效，请重新连接理解地图。')
        config_path, config, _view = entry
        if config['session_id'] != sid:
            raise ValueError('当前聊天与地图不一致，请重新打开理解地图。')
        resource = request.get('resource')
        if resource not in ('map-view.json', 'node-source', 'native-navigation', 'navigate', 'refresh', 'refresh-status'):
            raise ValueError('地图操作无效。')
        path = '/' + config['view_access_token'] + '/' + resource
        if resource in ('navigate', 'node-source'):
            node = request.get('node_id')
            if not isinstance(node, str) or not 1 <= len(node) <= 256:
                raise ValueError('地图节点无效。')
            if resource == 'node-source':
                path += '?' + urlencode({'id': node})
        if resource == 'map-view.json':
            item = resolve_resource(self.data_root, path)
            if item and item[0].is_file():
                return {'status': 200, 'body': json.loads(item[0].read_text(encoding='utf-8'))}
            return {'status': 404, 'body': {}}
        if resource == 'node-source':
            source = resolve_node_source(self.data_root, path)
            return {'status': 200 if source else 404, 'body': source or {}}
        if resource == 'native-navigation':
            with self.navigation_state_lock:
                navigation = dict(self.navigation_jobs.get(sid, {}))
            return {'status': 200, 'body': {'enabled': bool(self.helper), 'mode': 'native', 'navigation': navigation}}
        if resource == 'refresh':
            return {'status': 202, 'body': self.jobs.start(Path(config_path), config)}
        if resource == 'refresh-status':
            return {'status': 200, 'body': self.jobs.status(Path(config_path))}
        record = resolve_node_record(self.data_root, '/' + config['view_access_token'] + '/node-source?' + urlencode({'id': request['node_id']}))
        if record is None:
            return {'status': 404, 'body': {'status': 'invalid_source'}}
        if not self.helper:
            return {'status': 503, 'body': {'status': 'helper_disabled'}}
        target = native_navigation.build_target(record)
        if not self.navigation_lock.acquire(blocking=False):
            return {'status': 409, 'body': {'status': 'busy'}}
        job = {'status': 'pending', 'request_id': uuid.uuid4().hex, 'node_id': request['node_id']}
        with self.navigation_state_lock:
            self.navigation_jobs[sid] = job

        def run_navigation():
            try:
                result = native_navigation.invoke_helper(self.helper, target)
            except Exception:
                result = {'status': 'helper_failed', 'verified': False}
            with self.navigation_state_lock:
                job.update(result)
            self.navigation_lock.release()
            print(json.dumps({'understanding_map_navigation': result}), file=sys.stderr, flush=True)

        # Return the MCP call before the helper queries the host's native UI.
        worker = threading.Timer(0.2, run_navigation)
        worker.daemon = True
        try:
            worker.start()
        except RuntimeError:
            with self.navigation_state_lock:
                job.update(status='helper_failed', verified=False)
            self.navigation_lock.release()
            raise
        return {'status': 202, 'body': dict(job)}


def main():
    backend = Backend()
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            result = {'id': request['id'], 'result': backend.dispatch(request)}
        except MapSessionExpired as error:
            result = {'id': request.get('id'), 'error': str(error), 'error_code': 'map_session_expired'}
        except UpdateError as error:
            code = str(error)
            messages = {
                'codex_missing': '未找到 Codex CLI。请确认 codex --version 可用，并完整退出后重新打开 Codex。',
                'codex_permission': '无法启动 Codex CLI，系统拒绝访问。请检查 CLI 文件的运行权限。',
                'codex_start_failed': 'Codex CLI 启动失败。请确认 codex --version 可用，并完整退出后重新打开 Codex。',
                'source_unavailable': 'Codex CLI 已启动，但无法读取当前聊天。请更新 Codex 并从当前聊天重新打开理解地图。',
                'source_timeout': '读取当前聊天超时，请点击更新重试。',
            }
            result = {'id': request.get('id'), 'error': messages.get(code, '读取或更新聊天失败（' + code + '）。'),
                      'error_code': code}
        except Exception as error:
            # Avoid logging source text or token-scoped URLs.
            result = {'id': request.get('id'), 'error': '地图服务操作失败（' + type(error).__name__ + '）。'}
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
