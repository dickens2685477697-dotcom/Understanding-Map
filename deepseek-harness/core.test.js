import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDefinition as projection, emptyMap, pendingMessages, mergeSummary, mergeTopicAssignments, validateMap } from './core.js';
import { apply } from './index.js';

const message = (id, text = id, seq = 1) => ({ id, rpcId: `rpc-${id}`, text, seq, time: 1, turn: 1, turnSeq: 0 });
const summary = (batch, parent = null) => ({ topics: [], nodes: batch.map(m => ({ id: m.id, summary: `摘要 ${m.text}`, parent, topic_id: null })) });

test('projection retains only genuine user messages with stable identities', () => {
  let state = projection.init();
  state = projection.apply(state, { type: 'turn/start', seq: 2, data: { turn: 3 } });
  const ignored = state;
  for (const event of [{ type: 'assistant/message', data: {} }, { type: 'user/message', data: { source: { kind: 'system' } } }]) assert.equal(projection.apply(state, event), ignored);
  const event = { type: 'user/message', seq: 3, time: 10, data: { id: 'one', content: [{ type: 'text', text: '继续' }], source: { kind: 'user', rpcId: 'request-one' } } };
  state = projection.apply(state, event);
  assert.equal(state.messages[0].rpcId, 'request-one');
  assert.equal(state.messages[0].turn, 3);
  assert.equal(projection.apply(state, event), state);
});

test('refresh adds each message once and preserves independent roots', () => {
  const first = [message('one')], second = [message('two', '新主题', 4)];
  let map = mergeSummary(emptyMap('chat'), first, summary(first));
  const before = structuredClone(map);
  map = mergeSummary(map, second, summary(second));
  assert.deepEqual(map.nodes[0], before.nodes[0]);
  assert.equal(map.nodes[1].parent, null);
  assert.deepEqual(pendingMessages(map, [...first, ...second]), []);
});

test('rejects missing, duplicate, invented and cyclic summaries before persistence', () => {
  const batch = [message('a'), message('b')], map = emptyMap('chat');
  for (const result of [
    { nodes: [] },
    { nodes: [{ id: 'a', summary: 'a', parent: null }, { id: 'a', summary: 'b', parent: null }] },
    { nodes: [{ id: 'a', summary: 'a', parent: 'b' }, { id: 'b', summary: 'b', parent: 'a' }] },
    { nodes: [{ id: 'a', summary: 'a', parent: null }, { id: 'invented', summary: 'b', parent: null }] },
  ]) assert.throws(() => mergeSummary(map, batch, result));
  assert.deepEqual(map.nodes, []);
});

async function hostFixture(fail = false, legacy = false) {
  const commands = new Map(), stored = new Map();
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const messages = [message('a', '建立地图'), message('b', '继续', 3)];
  if (legacy) stored.set('chat', { version: 1, sessionId: 'chat', updatedAt: 'old', nodes: messages.map(item => ({ ...item, summary: item.text, parent: null })) });
  const agent = { session: { id: 'chat' }, model: { current: () => ({ provider: 'test', model: 'test' }) } };
  const ctx = {
    sessionProjections: { register: async () => ({ stateOf: () => ({ messages }) }) },
    storageDomain: { open: async () => ({ table: () => ({ get: id => stored.get(id), put: async (id, map) => { stored.set(id, map); } }), close() {} }) },
    effect: fn => fn(),
    commands: { register: def => { commands.set(def.name, def); return () => {}; } },
    tools: { register: () => () => {} },
    llm: { prepareCall: async config => ({ config, stream: async function* (options) {
      calls++; await gate;
      const input = JSON.parse(options.messages[0].content[0].text);
      const result = input.messagesToClassify ? {
        topics: [{ id: 'map', label: '地图开发', parent_id: null }],
        assignments: input.messagesToClassify.map(item => ({ id: item.id, topic_id: 'map' })),
      } : summary(input.newMessages);
      yield { type: 'text-delta', text: fail ? '{invalid' : JSON.stringify(result) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }) },
  };
  await apply(ctx);
  return { run: () => commands.get('understanding-map').handler({ agent, signal: new AbortController().signal }), stored, messages, release, calls: () => calls };
}

test('concurrent manual refresh shares one model call; unchanged refresh costs zero calls', async () => {
  const f = await hostFixture();
  const a = f.run(), b = f.run(); f.release();
  const results = await Promise.all([a, b]);
  assert.equal(f.calls(), 1);
  assert.ok(results.every(r => r.kind === 'success'));
  assert.equal(f.stored.get('chat').nodes.length, 2);
  const again = JSON.parse((await f.run()).text);
  assert.equal(again.added, 0);
  assert.equal(f.calls(), 1);
});

test('malformed model output never replaces a saved map', async () => {
  const f = await hostFixture(true); f.release();
  assert.equal((await f.run()).kind, 'error');
  assert.equal(f.stored.size, 0);
});

test('topic containment is independent of message relations', () => {
  const batch = [message('a'), message('b')];
  const map = mergeSummary(emptyMap('chat'), batch, {
    topics: [{ id: 'development', label: '开发', parent_id: null }, { id: 'install', label: '安装', parent_id: 'development' }],
    nodes: [{ id: 'a', summary: '开发插件', parent: null, topic_id: 'development' }, { id: 'b', summary: '安装插件', parent: null, topic_id: 'install' }],
  });
  assert.equal(map.nodes[1].parent, null);
  assert.equal(map.topics[1].parent_id, 'development');
  const continued = mergeSummary(map, [message('c')], {
    topics: map.topics,
    nodes: [{ id: 'c', summary: '继续安装', parent: 'b', topic_id: 'install' }],
  });
  assert.equal(continued.topics.length, 2);
  assert.deepEqual(continued.nodes.slice(0, 2), map.nodes);
  assert.throws(() => validateMap({ ...map, topics: [{ ...map.topics[0], parent_id: 'install' }, map.topics[1]] }), /hierarchy/);
  assert.throws(() => validateMap({ ...map, nodes: [{ ...map.nodes[0], topic_id: 'missing' }] }), /topic/);
});

test('old maps gain topic assignments without rewriting summaries or source anchors', async () => {
  const fixture = await hostFixture(false, true);
  const before = structuredClone(fixture.stored.get('chat'));
  fixture.release();
  const result = JSON.parse((await fixture.run()).text);
  assert.equal(result.added, 0);
  assert.equal(result.classified, 2);
  assert.deepEqual(result.map.nodes, before.nodes.map(node => ({ ...node, topic_id: 'map' })));
  await fixture.run();
  assert.equal(fixture.calls(), 1);
  assert.throws(() => mergeTopicAssignments(before, before.nodes, { topics: [], assignments: [{ id: 'a', topic_id: null }, { id: 'a', topic_id: null }] }), /ids/);
});
