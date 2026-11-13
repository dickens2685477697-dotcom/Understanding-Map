"""Prepare local navigation requests; never call a model or launch on import."""
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

ADAPTER_REVISION = 7


def plain_text(text):
    text = re.sub(r'!?\[([^\]]+)\]\([^\n)]+\)', r'\1', text)
    text = re.sub(r'(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)', r'\1', text)
    return re.sub(r'[`*_~]', '', text)


def make_anchors(text):
    """Use several readable fragments rather than sending raw markdown to AX."""
    lines = [re.sub(r'\s+', ' ', line).strip() for line in plain_text(text).splitlines()]
    anchors = []
    for line in sorted(lines, key=len, reverse=True):
        if len(line) < 8:
            continue
        for fragment in re.split(r'[。！？!?；;]', line):
            fragment = fragment.strip()
            if len(fragment) >= 8 and fragment[:64] not in anchors:
                anchors.append(fragment[:64])
            if len(anchors) == 4:
                return anchors
    return anchors


def context_anchors(turns, node):
    """Use a unique fragment from the paired message in this same turn."""
    turn = next(t for t in turns if t.get('id') == node['turn_id'])
    other_role = 'assistant' if node['role'] == 'user' else 'user'
    corpus = [plain_text(m.get('text', '')) for t in turns for m in t.get('messages', [])]
    anchors = []
    for message in turn.get('messages', []):
        if message.get('role') != other_role:
            continue
        # Start near the paired message's beginning so the short source stays
        # nearby. Split inline formatting into independently readable AX text.
        for line in message.get('text', '').splitlines():
            for part in [plain_text(line), *re.split(r'\*\*|__|`|[。！？!?；;]', line)]:
                fragment = re.sub(r'\s+', ' ', plain_text(part)).strip(' ：:，,“”"')[:64]
                if (len(fragment) >= 8 and fragment not in anchors
                        and sum(text.count(fragment) for text in corpus) == 1):
                    anchors.append(fragment)
                if len(anchors) == 4:
                    return anchors
    return anchors


def build_target(record):
    config, node, turns, message, source_text = record
    position = 0
    target_position = None
    total = 0
    for turn in turns:
        for item in turn.get('messages', []):
            if item.get('role') == 'user':
                position += 1
                total += 1
            if (turn.get('id') == node['turn_id']
                    and item.get('id') == node['message_id']
                    and item.get('role') == node['role']):
                target_position = position
    if not target_position:
        raise ValueError('source_has_no_user_turn')
    panel = urlsplit(config.get('panel_url', 'http://127.0.0.1:18766/'))
    excluded = [f'{panel.scheme}://{panel.netloc}']
    target = {
        'version': 1,
        'scope': 'current_window',
        'thread_id': config['session_id'],
        'node_id': node['id'],
        'message_id': message['id'],
        'role': message['role'],
        'user_position': target_position,
        'captured_user_count': total,
        'anchors': make_anchors(source_text),
        'excluded_origins': excluded,
    }
    if not target['anchors']:
        short_text = re.sub(r'\s+', ' ', plain_text(source_text)).strip()
        if node['role'] == 'user' and 1 <= len(short_text) < 8:
            target['short_text'] = short_text
            target['context_anchors'] = context_anchors(turns, node)
    return target


def invoke_helper(helper_path, target):
    """Explicitly enabled by a user-run server, never used by the dry-run tests."""
    helper = Path(helper_path)
    if not helper.is_file() or helper.is_symlink():
        return {'status': 'helper_unavailable', 'verified': False}

    def failure(protocol_error, result=None, *, response_valid=False):
        # Fixed codes only: 1=size, 2=JSON, 3=shape, 4=status, 5=exit, 6=launch.
        # Never echo helper output, exception messages, or stderr into the panel.
        diagnostics = {'protocol_error': protocol_error,
                       'helper_response_valid': response_valid}
        if result is not None:
            diagnostics.update(helper_exit_code=min(abs(result.returncode), 12000),
                               helper_crashed=result.returncode < 0,
                               helper_output_empty=not bool(result.stdout))
        return {'status': 'helper_failed', 'verified': False, 'diagnostics': diagnostics}

    try:
        result = subprocess.run(
            [str(helper), '--navigate'],
            input=json.dumps(target, ensure_ascii=False).encode('utf-8'),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=18, check=False,
        )
    except subprocess.TimeoutExpired:
        return {'status': 'timed_out', 'verified': False}
    except OSError:
        return failure(6)

    if len(result.stdout) > 4096:
        return failure(1, result)
    try:
        response = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        return failure(2, result)
    if not isinstance(response, dict):
        return failure(3, result)
    allowed = {
        'located', 'turn_revealed', 'accessibility_required', 'app_not_running',
        'chat_unverified', 'rail_unavailable', 'ambiguous_target',
        'navigation_failed', 'invalid_request', 'focus_changed', 'chat_mismatch',
        'search_requested', 'find_unavailable', 'source_unsearchable', 'context_revealed',
    }
    status = response.get('status')
    if (not isinstance(status, str) or status not in allowed
            or (status == 'located' and response.get('verified') is not True)):
        return failure(4, result)
    if (result.returncode < 0
            or (result.returncode != 0 and status in ('located', 'turn_revealed', 'search_requested', 'context_revealed'))):
        return failure(5, result, response_valid=True)
    method = response.get('method')
    if method not in ('native_accessibility_find', 'native_accessibility_rail'):
        method = 'native_accessibility_rail'
    value = {'status': status, 'verified': status == 'located',
             'method': method,
             'scope': target.get('scope', 'thread')}
    diagnostics = response.get('diagnostics')
    if isinstance(diagnostics, dict):
        allowed_diagnostics = {
            'focused_window', 'native_pages', 'readable_addresses', 'matching_pages',
            'scan_complete', 'window_conflict', 'diagnostic_version', 'eligible_pages',
            'inspected_pages', 'nested_pages', 'readable_buttons', 'labelled_buttons',
            'rail_buttons', 'target_buttons', 'rail_nodes', 'rail_scan_complete',
            'document_scan_complete', 'manual_accessibility', 'file_address_pages',
            'enhanced_accessibility', 'manual_accessibility_error',
            'unknown_address_pages',
            'ax_read_errors',
            'find_triggered', 'chat_scope_found', 'find_input_found',
            'query_written', 'search_candidates',
            'chat_scope_pressed', 'chat_scope_selected', 'find_stage',
            'find_fields', 'chat_named_fields', 'field_scan_complete', 'field_read_errors',
            'field_nodes', 'focused_find_field',
            'browser_named_fields', 'scope_keyboard_attempted', 'scope_keyboard_activated',
            'contextual_search',
        }
        value['diagnostics'] = {k: v for k, v in diagnostics.items()
                                if k in allowed_diagnostics and type(v) in (bool, int)
                                and 0 <= int(v) <= (30000 if k == 'manual_accessibility_error' else 12000)}
    return value
