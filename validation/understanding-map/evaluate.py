#!/usr/bin/env python3
"""Offline candidate retrieval experiment; no model calls and no token claims."""
from dataclasses import dataclass
import re

@dataclass(frozen=True)
class Node:
    id: int
    text: str
    evidence_id: str

NODES = [
    Node(1, 'Understanding Map 产品形态 插件 Skill Codex harness', 'msg-01'),
    Node(2, '保留想法变化历史 推翻之前的决定 已改变', 'msg-02'),
    Node(3, '对话轮次 每条消息 总结 轮次顺序', 'msg-03'),
    Node(4, '信息种类 用户 AI 发言方 主题 状态', 'msg-04'),
    Node(5, '视觉效果 Git 线条 树状节点', 'msg-05'),
    Node(6, '关联线 直接关联 03 和 08', 'msg-06'),
    Node(7, '多个主题 各自轨道 重新展开', 'msg-07'),
    Node(8, '层级 父主题 子主题 拐弯 继承', 'msg-08'),
    Node(9, '另一个独立主问题 并列主题', 'msg-09'),
    Node(10, '折叠 分支 横向宽度 默认全部呈现', 'msg-10'),
    Node(11, '文档大纲 层级展示 缩进标题', 'msg-11'),
    Node(12, '增量整理 token 成本 产品形态', 'msg-12'),
]
# Prompts paraphrase this conversation. Expected links are manually specified,
# and express candidate-set expectations, not a unique semantic ground truth.
CASES = [
    ('explicit-old', '09 继承到 03 下一层级', {3}),
    ('multiple', '如何降低 token，以及这个产品形态', {1, 12}),
    ('correction', '用户推翻之前的决定要保留变化历史', {2}),
    ('turns', '地图需要呈现每轮对话的轮次和顺序', {3}),
    ('return-topic', '多个主题暂停之后如何重新展开', {7}),
    ('explicit-missing', '继承到 99 下一层级', set()),
]

REFERENCE = re.compile(r'(?:第\s*)?(\d{1,3})(?:\s*(?:条|轮|节点))?')
def grams(s):
    # Compact CJK bigram + Latin word retrieval: no semantic claims.
    chars = re.sub(r'[^\u4e00-\u9fffa-z0-9]', '', s.lower())
    return {chars[i:i+2] for i in range(len(chars)-1)}

def candidates(query, nodes, limit=5):
    by_id = {n.id: n for n in nodes}
    refs = [int(x) for x in REFERENCE.findall(query)]
    missing = [x for x in refs if x not in by_id]
    explicit = [by_id[x] for x in refs if x in by_id]
    # Prefer explicit IDs; then approximate lexical overlap, followed by recency.
    q = grams(query)
    ranked = sorted(nodes, key=lambda n: (len(q & grams(n.text)), n.id), reverse=True)
    result = []
    for n in explicit + [n for n in ranked if q & grams(n.text)] + list(reversed(nodes[-2:])):
        if n not in result:
            result.append(n)
        if len(result) == limit:
            break
    return result, missing

def validate_patch(patch, nodes, known_message_ids):
    known_nodes = {n.id for n in nodes}
    if not patch.get('summary', '').strip():
        return False
    if not set(patch.get('parents', [])) <= known_nodes:
        return False
    evidence = patch.get('evidence', [])
    if not evidence or not set(evidence) <= known_message_ids:
        return False
    return True

def run():
    # Real examples, synthetic node summaries. Character lengths compare node
    # summaries only, not complete model prompts, context or tokenizer counts.
    retrieved = 0
    total = 0
    candidate_chars = 0
    full_chars = 0
    for label, query, expected in CASES:
        got, missing = candidates(query, NODES)
        ids = {n.id for n in got}
        retrieved += len(expected & ids)
        total += len(expected)
        candidate_chars += sum(len(n.text) for n in got)
        full_chars += sum(len(n.text) for n in NODES)
        print(f'{label}: candidates={[n.id for n in got]} expected={sorted(expected)} missing_refs={missing}')
        assert expected <= ids, f'{label}: missing expected candidates {expected-ids}'
        if label == 'explicit-missing':
            assert missing == [99], 'unknown explicit reference must stay unresolved'
    evidence_ids = {n.evidence_id for n in NODES} | {'new-message'}
    assert validate_patch({'summary':'保留历史', 'parents':[2], 'evidence':['new-message','msg-02']}, NODES, evidence_ids)
    assert not validate_patch({'summary':'保留历史', 'parents':[99], 'evidence':['new-message']}, NODES, evidence_ids)
    assert not validate_patch({'summary':'保留历史', 'parents':[2], 'evidence':[]}, NODES, evidence_ids)
    assert not validate_patch({'summary':'保留历史', 'parents':[2], 'evidence':['fabricated-id']}, NODES, evidence_ids)
    print(f'Candidate recall on hand-picked examples: {retrieved}/{total}')
    print(f'Node-summary characters: candidates={candidate_chars}, full-history summaries={full_chars}')
    print('Evidence checks: known/unknown parents and evidence passed; semantic correctness not verified.')
    print('No LLM call, cost, token count, latency or production accuracy was measured.')

if __name__ == '__main__':
    run()
