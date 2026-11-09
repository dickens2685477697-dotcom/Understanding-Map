#!/usr/bin/env python3
"""Local, token-scoped previews for Understanding Map sessions."""
import argparse
import hmac
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import threading
from urllib.parse import urlencode
from urllib.parse import parse_qs, urlsplit

import native_navigation

ROOT = Path(__file__).resolve().parent
TOKEN = re.compile(r'^[A-Za-z0-9_-]{32,128}$')
SESSION = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def candidate_configs(private_root):
    """Find the legacy config and direct session configs without following links."""
    root = Path(private_root).resolve()
    legacy = root / 'tracking.json'
    if legacy.is_file() and not legacy.is_symlink():
        yield legacy, None
    sessions = root / 'sessions'
    if not sessions.is_dir() or sessions.is_symlink():
        return
    for folder in sorted(sessions.iterdir()):
        if folder.is_symlink() or not folder.is_dir() or not SESSION.fullmatch(folder.name):
            continue
        config = folder / 'tracking.json'
        if config.is_file() and not config.is_symlink():
            yield config, folder.name


def resolve_session(private_root, supplied):
    """Resolve one unambiguous token to its validated session configuration."""
    if not TOKEN.fullmatch(supplied):
        return None
    matches = []
    for config_path, folder_id in candidate_configs(private_root):
        try:
            config = json.loads(config_path.read_text(encoding='utf-8'))
            if not isinstance(config, dict):
                continue
            token = config.get('view_access_token')
            sid = config.get('session_id')
            if not isinstance(token, str) or not TOKEN.fullmatch(token):
                continue
            if not isinstance(sid, str) or not SESSION.fullmatch(sid) or (folder_id is not None and sid != folder_id):
                continue
            view = Path(config['view_file'])
            if not view.is_absolute() or view.is_symlink():
                continue
            # Only a dedicated summary view is served, never the raw state.
            expected = config_path.parent.resolve() / 'map-view.json'
            if view.resolve() != expected or (view.exists() and view.stat().st_nlink != 1):
                continue
            if hmac.compare_digest(supplied, token):
                matches.append((config_path, config, view))
        except (KeyError, TypeError, ValueError, OSError, UnicodeError, json.JSONDecodeError):
            continue
    # Refuse ambiguous tokens rather than accidentally crossing sessions.
    if len(matches) != 1:
        return None
    return matches[0]


def resolve_resource(private_root, request_path, panel_path=None):
    """Resolve two allow-listed resources; return None for unauthorized requests."""
    pieces = urlsplit(request_path).path.split('/')
    if len(pieces) != 3 or pieces[2] not in ('live-panel.html', 'map-view.json'):
        return None
    session = resolve_session(private_root, pieces[1])
    if session is None:
        return None
    _, _, view = session
    resource = pieces[2]
    if resource == 'live-panel.html':
        return Path(panel_path or ROOT / 'live-panel.html'), 'text/html; charset=utf-8'
    return view, 'application/json; charset=utf-8'


def resolve_node_record(private_root, request_path):
    """Resolve the selected original within its own private session only."""
    parsed = urlsplit(request_path)
    pieces = parsed.path.split('/')
    if len(pieces) != 3 or pieces[2] != 'node-source':
        return None
    try:
        query = parse_qs(parsed.query, strict_parsing=True, max_num_fields=1)
        ids = query.get('id', [])
        if set(query) != {'id'} or len(ids) != 1 or not ids[0] or len(ids[0]) > 256:
            return None
        resolved = resolve_session(private_root, pieces[1])
        if resolved is None:
            return None
        config_path, config, _ = resolved
        state_path = Path(config['state_file'])
        if (not state_path.is_absolute() or state_path.is_symlink()
                or state_path.resolve() != config_path.parent.resolve() / 'state.json'
                or not state_path.is_file() or state_path.stat().st_nlink != 1):
            return None
        state = json.loads(state_path.read_text(encoding='utf-8'))
        session = state['sessions'][config['session_id']]
        matches = [n for n in session['nodes'] if n.get('id') == ids[0]]
        if len(matches) != 1:
            return None
        node = matches[0]
        for turn in session['turns']:
            if turn.get('id') != node.get('turn_id'):
                continue
            for message in turn.get('messages', []):
                if message.get('id') == node.get('message_id') and message.get('role') == node.get('role'):
                    text = message.get('text')
                    if not isinstance(text, str):
                        return None
                    # These are host UI metadata, not user-authored messages.
                    has_envelope = any(marker in text for marker in (
                        '<in-app-browser-context', '<response-annotations>',
                        '<external_codex_apps_open_page>', '# Files mentioned by the user:'))
                    text = re.sub(r'<in-app-browser-context\b[^>]*>.*?</in-app-browser-context>\s*', '', text, flags=re.DOTALL)
                    text = re.sub(r'<external_codex_apps_open_page>.*?</external_codex_apps_open_page>\s*', '', text, flags=re.DOTALL)
                    if message['role'] == 'user' and has_envelope and '\n## My request:' in text:
                        text = text.rsplit('\n## My request:', 1)[1]
                    if message['role'] == 'user':
                        reply = re.fullmatch(r'\s*<send_user_message_question_reply>\s*(.*?)\s*</send_user_message_question_reply>\s*', text, flags=re.DOTALL)
                        if reply:
                            try:
                                answers = json.loads(reply.group(1))
                            except ValueError:
                                answers = None
                            if (isinstance(answers, list) and answers
                                    and all(isinstance(item, dict) and isinstance(item.get('answer'), str) for item in answers)):
                                text = '\n'.join(item['answer'] for item in answers)
                    return config, node, session['turns'], message, text.strip()
    except (KeyError, TypeError, ValueError, OSError, UnicodeError, json.JSONDecodeError):
        return None
    return None


def resolve_node_source(private_root, request_path):
    record = resolve_node_record(private_root, request_path)
    if record is None:
        return None
    _, node, _, message, text = record
    return {'id': node['id'], 'role': message['role'], 'text': text}


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_key')
        result[key] = value
    return result


def make_handler(private_root, native_helper=None, dry_run=False):
    navigation_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def send_data(self, data, content_type='application/json; charset=utf-8', status=200):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")
            self.end_headers()
            self.wfile.write(data)

        def send_json(self, value, status=200):
            self.send_data(json.dumps(value, ensure_ascii=False).encode('utf-8'), status=status)

        def do_GET(self):
            parsed = urlsplit(self.path)
            pieces = parsed.path.split('/')
            if parsed.path == '/health' and not parsed.query:
                data_id = hashlib.sha256(str(Path(private_root).resolve()).encode()).hexdigest()[:16]
                self.send_json({'service': 'understanding-map', 'data_id': data_id,
                                'adapter_revision': native_navigation.ADAPTER_REVISION,
                                'native_enabled': bool(native_helper and Path(native_helper).is_file())})
                return
            if len(pieces) == 3 and pieces[2] == 'native-navigation' and not parsed.query:
                if resolve_session(private_root, pieces[1]) is None:
                    self.send_error(404)
                    return
                enabled = bool(dry_run or (native_helper and Path(native_helper).is_file()))
                self.send_json({'enabled': enabled, 'mode': 'dry_run' if dry_run else 'native',
                                'navigation_scope': 'current_window',
                                'adapter_revision': native_navigation.ADAPTER_REVISION})
                return
            if parsed.path.endswith('/node-source'):
                source = resolve_node_source(private_root, self.path)
                if source is None:
                    self.send_error(404)
                    return
                data = json.dumps(source, ensure_ascii=False).encode('utf-8')
                content_type = 'application/json; charset=utf-8'
            else:
                item = resolve_resource(private_root, self.path)
                if item is None:
                    self.send_error(404)
                    return
                try:
                    data = item[0].read_bytes()
                except OSError:
                    self.send_error(404)
                    return
                content_type = item[1]
            self.send_data(data, content_type)

        def do_POST(self):
            parsed = urlsplit(self.path)
            pieces = parsed.path.split('/')
            if len(pieces) != 3 or pieces[2] != 'navigate' or parsed.query:
                self.send_error(404)
                return
            host = self.headers.get('Host', '')
            expected_hosts = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
            if (host not in expected_hosts or self.headers.get('Origin') != f'http://{host}'
                    or self.headers.get('X-Understanding-Map-Action') != 'navigate'
                    or self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json'):
                self.send_error(403)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 1 <= size <= 2048:
                    raise ValueError('invalid_size')
                body = json.loads(self.rfile.read(size), object_pairs_hook=reject_duplicate_keys)
                if (not isinstance(body, dict) or set(body) != {'node_id'}
                        or not isinstance(body['node_id'], str) or not 1 <= len(body['node_id']) <= 256):
                    raise ValueError('invalid_body')
            except (ValueError, UnicodeError, json.JSONDecodeError):
                self.send_error(400)
                return
            record = resolve_node_record(private_root, f'/{pieces[1]}/node-source?{urlencode({"id": body["node_id"]})}')
            if record is None:
                self.send_error(404)
                return
            if not dry_run and not native_helper:
                self.send_json({'status': 'helper_disabled', 'verified': False}, 503)
                return
            try:
                target = native_navigation.build_target(record)
            except (KeyError, TypeError, ValueError):
                self.send_json({'status': 'invalid_source', 'verified': False}, 422)
                return
            if dry_run:
                self.send_json({'status': 'dry_run', 'verified': False,
                                'user_position': target['user_position'], 'role': target['role']})
                return
            if not navigation_lock.acquire(blocking=False):
                self.send_json({'status': 'busy', 'verified': False}, 409)
                return
            try:
                self.send_json(native_navigation.invoke_helper(native_helper, target))
            finally:
                navigation_lock.release()

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, help='tracking.json path; sibling sessions/ is also searched')
    parser.add_argument('--port', type=int, default=18766)
    native = parser.add_mutually_exclusive_group()
    native.add_argument('--native-helper', help='Explicit user opt-in: compiled MapNavigator executable')
    native.add_argument('--native-dry-run', action='store_true', help='Validate requests without operating any application')
    args = parser.parse_args()
    config_parent = Path(args.config).resolve().parent
    private_root = config_parent.parent.parent if config_parent.parent.name == 'sessions' else config_parent
    handler = make_handler(private_root, args.native_helper, args.native_dry_run)

    ThreadingHTTPServer(('127.0.0.1', args.port), handler).serve_forever()


if __name__ == '__main__':
    main()
