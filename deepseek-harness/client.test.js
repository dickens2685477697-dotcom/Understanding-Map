import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
const nodes = [
  { id: 'u1', intent: 'question', parent: null, topic_id: 'main', summary: '最初的问题' },
  { id: 'u2', intent: 'idea', parent: 'u1', topic_id: 'child', summary: '可讨论的设想' },
  { id: 'u3', intent: 'request', parent: 'u2', topic_id: 'child', summary: '实现最初的功能' },
  { id: 'u4', intent: 'confirmation', parent: 'u3', topic_id: 'child', summary: '允许进行安装' },
  { id: 'u5', intent: 'feedback', parent: 'u3', topic_id: 'detail', summary: '查找没有填入原文' },
  { id: 'u6', intent: 'question', parent: 'u5', topic_id: 'detail', summary: '为什么无法识别' },
  { id: 'u7', intent: 'request', parent: 'u5', topic_id: 'detail', summary: '修复输入框兼容' },
  { id: 'u8', intent: null, parent: null, topic_id: 'other', summary: '尚未确认的发言意图' },
].map((node, index) => ({ ...node, text: `原文 ${node.id}`, rpcId: `rpc-${node.id}`, seq: index + 1 }));
const topics = [
  { id: 'main', label: '原文定位', parent_id: null },
  { id: 'child', label: '自动查找', parent_id: 'main' },
  { id: 'detail', label: '输入框兼容', parent_id: 'child' },
  { id: 'other', label: '其他分支', parent_id: null },
];

async function fixture(context, { preferences = {}, lang = 'zh' } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://example.test/' });
  const prior = Object.fromEntries(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  for (const [sessionId, prefs] of Object.entries(preferences)) dom.window.localStorage.setItem(`understanding-map:deepseek:v2:${sessionId}`, JSON.stringify(prefs));
  let plugin;
  const components = new Map(), locales = {}, navigations = [];
  let sessionId = 'chat-a', currentNodes = nodes;
  const ctx = {
    effect: fn => fn(),
    locale: { register(id, value) { Object.assign(locales, value); }, bind: () => key => locales[lang][key] ?? key },
    slots: { inject(name, fn) { fn(); }, register(meta, component) { components.set(meta.name, component); } },
    sidebarRightTabs: { register() {} },
    sidebarRight: { mounted: { getSnapshot: () => sessionId } },
    sessions: { binding: () => ({ session: { async loadThrough(seq) { navigations.push(seq); } } }) },
    remote: { commands: { async execute() { return { ok: true, value: { result: { kind: 'success', text: JSON.stringify({ added: 0, map: { version: 1, sessionId, nodes: currentNodes, topics } }) } } }; } } },
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { plugin = value.factory(name => { assert.equal(name, 'react'); return React; }); } } },
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => setTimeout(callback, 0),
    console,
  });
  plugin.apply(ctx);
  const Panel = components.get('sidebar.right.pane.tab'), Marker = components.get('conversation.chat.user.before');
  const root = createRoot(dom.window.document.querySelector('#root'));
  async function render() {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(Panel, { sessionId, useProjection: () => ({ count: currentNodes.length }), useTabInfo: () => ({ tab: { visible: true } }) }),
      ...currentNodes.map(node => React.createElement(Marker, { key: `${sessionId}:${node.id}`, sessionId, matched: node.rpcId })))));
  }
  await render();
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(prior)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const document = dom.window.document;
  const click = async selector => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    await act(async () => element.click());
  };
  const rowIds = () => [...document.querySelectorAll('.node-button')].map(row => row.dataset.nodeId);
  return { document, dom, click, rowIds, navigations,
    async switchChat(id) { sessionId = id; await render(); },
    async update(nextNodes) { currentNodes = nextNodes; await click('.controls button:last-of-type'); },
  };
}

test('filtering shares OR selection across views and retains original ordinals, depth and parent endpoints', async context => {
  const page = await fixture(context);
  await page.click('[data-mode="time"]');
  const originalX = page.document.querySelector('circle[data-node-id="u7"]').getAttribute('cx');
  const originalColor = page.document.querySelector('circle[data-node-id="u7"]').getAttribute('style');
  await page.click('.intent-filter[data-intent="request"]');
  await page.click('.intent-filter[data-intent="feedback"]');
  assert.deepEqual(page.rowIds(), ['u3', 'u5', 'u7']);
  assert.match(page.document.querySelector('.filter-status').textContent, /3 \/ 8/);
  assert.deepEqual([...page.document.querySelectorAll('.node-button .num')].map(el => el.textContent), ['03', '05', '07']);
  assert.equal(page.document.querySelector('circle[data-node-id="u7"]').getAttribute('cx'), originalX);
  assert.equal(page.document.querySelector('circle[data-node-id="u7"]').getAttribute('style'), originalColor);
  assert.deepEqual([...page.document.querySelectorAll('.message-relation')].map(el => [el.dataset.parentId, el.dataset.childId]), [['u3', 'u5'], ['u5', 'u7']]);
  assert.equal(page.document.querySelectorAll('.timeline-gap').length, 4);
  await page.click('[data-mode="outline"]');
  assert.deepEqual(page.rowIds(), ['u3', 'u5', 'u7']);
  const headings = [...page.document.querySelectorAll('.outline-group>summary')].map(el => el.textContent);
  assert.ok(headings.includes('原文定位'), 'an ancestor topic with no matching direct leaves is retained');
  assert.ok(!headings.includes('其他分支'), 'an empty branch is omitted');
  await page.click('.intent-filter[data-intent="all"]');
  assert.equal(page.rowIds().length, 8, 'All restores unlabelled messages as well');
  assert.equal(page.navigations.length, 0, 'filtering and changing views never navigate');
});

test('collapsed runs reveal original clickable messages and restore original relation endpoints', async context => {
  const page = await fixture(context);
  await page.click('[data-mode="time"]');
  await page.click('.intent-filter[data-intent="request"]');
  const firstGap = page.document.querySelector('.timeline-gap');
  assert.match(firstGap.textContent, /已隐藏 2 条发言01–02/);
  await page.click('.timeline-gap');
  assert.deepEqual(page.rowIds(), ['u1', 'u2', 'u3', 'u7']);
  assert.equal(page.document.querySelectorAll('.filtered-context').length, 2);
  assert.ok(page.document.querySelector('[data-parent-id="u2"][data-child-id="u3"]'));
  assert.ok(!page.document.querySelector('[data-parent-id="u3"][data-child-id="u7"]'), 'hidden intermediate parents are never shortcut into a solid relation');
  assert.match(page.document.querySelector('.timeline-gap').textContent, /收起 2/);
  await page.click('.filtered-context[data-node-id="u2"]');
  assert.deepEqual(page.navigations, [2], 'expanded rows navigate to their original source sequence');
  await page.click('.timeline-gap');
  assert.deepEqual(page.rowIds(), ['u3', 'u7']);
  assert.equal(page.document.querySelector('.timeline-gap').getAttribute('aria-expanded'), 'false');
});

test('per-chat filters and expanded runs persist, restore without navigation and prune after updates', async context => {
  const gapKey = JSON.stringify(['u1', 'u2']);
  const page = await fixture(context, { preferences: {
    'chat-a': { mode: 'time', intentFilters: ['request', 'invalid'], expandedGaps: [gapKey, 'old-run'], selectedId: 'u7' },
    'chat-b': { mode: 'outline', intentFilters: ['feedback'] },
  } });
  assert.deepEqual(page.rowIds(), ['u1', 'u2', 'u3', 'u7']);
  assert.equal(page.navigations.length, 0);
  let prefs = JSON.parse(page.dom.window.localStorage.getItem('understanding-map:deepseek:v2:chat-a'));
  assert.deepEqual(prefs.intentFilters, ['request']);
  assert.deepEqual(prefs.expandedGaps, [gapKey]);
  await page.switchChat('chat-b');
  assert.deepEqual(page.rowIds(), ['u5']);
  await page.switchChat('chat-a');
  assert.deepEqual(page.rowIds(), ['u1', 'u2', 'u3', 'u7']);
  await page.update(nodes.map(node => node.id === 'u2' ? { ...node, intent: 'request' } : node));
  assert.deepEqual(page.rowIds(), ['u2', 'u3', 'u7']);
  prefs = JSON.parse(page.dom.window.localStorage.getItem('understanding-map:deepseek:v2:chat-a'));
  assert.deepEqual(prefs.expandedGaps, [], 'changed run identities invalidate stale expansion preferences');
  assert.equal(page.navigations.length, 0);
});

test('empty results and English labels remain usable', async context => {
  const page = await fixture(context, { lang: 'en' });
  await page.update(nodes.filter(node => node.intent !== 'confirmation'));
  await page.click('.intent-filter[data-intent="confirmation"]');
  assert.match(page.document.querySelector('.filter-empty').textContent, /No matching messages/);
  assert.match(page.document.querySelector('.filter-status').textContent, /Showing 0 \/ 7 messages/);
  await page.click('[data-mode="time"]');
  assert.equal(page.document.querySelectorAll('.timeline-gap').length, 1);
  assert.match(page.document.querySelector('.timeline-gap').textContent, /Hidden 7 messages/);
  await page.click('.intent-filter[data-intent="confirmation"]');
  assert.equal(page.rowIds().length, 7, 'deselecting the last filter returns to All');
});
