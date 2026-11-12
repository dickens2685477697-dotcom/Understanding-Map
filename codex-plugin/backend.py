#!/usr/bin/env python3
"""Reuse the map service inside the Codex-managed MCP process lifecycle."""
import json
import os
from pathlib import Path
import sys
import threading
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
            return {'status': 200, 'body': {'enabled': bool(self.helper), 'mode': 'native'}}
        if resource == 'refresh':
            return {'status': 202, 'body': self.jobs.start(Path(config_path), config)}
        if resource == 'refresh-status':
            return {'status': 200, 'body': self.jobs.status(Path(config_path))}
        record = resolve_node_record(self.data_root, '/' + config['view_access_token'] + '/node-source?' + urlencode({'id': request['node_id']}))
        if record is None:
            return {'status': 404, 'body': {'status': 'invalid_source'}}
        if not self.helper:
            return {'status': 503, 'body': {'status': 'helper_disabled'}}
        if not self.navigation_lock.acquire(blocking=False):
            return {'status': 409, 'body': {'status': 'busy'}}
        try:
            target = native_navigation.build_target(record)
            return {'status': 200, 'body': native_navigation.invoke_helper(self.helper, target)}
        finally:
            self.navigation_lock.release()


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
            result = {'id': request.get('id'), 'error': '读取或更新聊天失败（' + str(error) + '）。'}
        except Exception as error:
            # Avoid logging source text or token-scoped URLs.
            result = {'id': request.get('id'), 'error': '地图服务操作失败（' + type(error).__name__ + '）。'}
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
