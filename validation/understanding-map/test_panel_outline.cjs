const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const html = readFileSync('validation/understanding-map/live-panel.html', 'utf8');
  let data = { version: 1, topics: [
    { id: 'goals', label: '产品目标与定位', parent_id: null },
    { id: 'map', label: '地图的呈现方式', parent_id: null },
    { id: 'links', label: '消息之间如何关联', parent_id: 'map' },
  ], nodes: [
    { id: 'u1', turn_id: 't1', role: 'user', summary: '提出理解地图', topic_id: 'goals', parent_ids: [] },
    { id: 'a1', turn_id: 't1', role: 'assistant', summary: 'AI 回复摘要', topic_id: 'goals', parent_ids: ['u1'] },
    { id: 'u2', turn_id: 't2', role: 'user', summary: '讨论关联线', topic_id: 'links', parent_ids: ['u1'] },
    { id: 'a2', turn_id: 't2', role: 'assistant', summary: 'AI 解释关联', topic_id: 'links', parent_ids: ['u2'] },
    { id: 'u3', turn_id: 't3', role: 'user', summary: '新的未归类问题', topic_id: null, parent_ids: [] },
  ] };
  let tick, copied = '';
  const dom = new JSDOM(html, { url: 'http://example.test/live-panel.html', runScripts: 'dangerously', beforeParse(window) {
    window.fetch = async (url) => {
      if (url.startsWith('node-source?')) {
        const id = new URL(url, 'http://example.test/').searchParams.get('id');
        return { ok: true, json: async () => ({ id, text: id === 'u1' ? '这是原始用户消息' : '其他原文' }) };
      }
      return { ok: true, text: async () => JSON.stringify(data) };
    };
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
    window.setInterval = (fn) => { tick = fn; return 1; };
  }});
  await new Promise(resolve => setTimeout(resolve, 0));
  const doc = dom.window.document;
  const group = [...doc.querySelectorAll('summary')].find(el => el.textContent === '地图的呈现方式');
  assert.ok(group, 'topic heading exists');
  assert.ok([...group.parentElement.children].some(el => el.tagName === 'DETAILS' && el.querySelector('summary').textContent === '消息之间如何关联'), 'subtopic is nested');
  assert.equal(doc.querySelectorAll('.outline-leaf').length, 3, 'one outline row for each user turn');
  assert.deepEqual([...doc.querySelectorAll('.outline-leaf .num')].map(el=>el.textContent), ['01','02','03']);
  assert.ok(!doc.querySelector('#map').textContent.includes('AI 回复摘要'), 'assistant remains out of document outline');
  assert.ok([...doc.querySelectorAll('summary')].some(el => el.textContent === '待归类'), 'unassigned content remains visible');
  assert.ok([...doc.querySelectorAll('details')].every(el=>el.open), 'groups are expanded initially');
  const firstNode = doc.querySelector('[data-node-id="u1"]');
  assert.equal(firstNode.tagName, 'BUTTON', 'node is keyboard-accessible');
  firstNode.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(firstNode.getAttribute('aria-pressed'), 'true', 'clicked node becomes selected');
  assert.equal(doc.querySelector('#source-panel').hidden, false);
  assert.equal(doc.querySelector('#source-text').textContent, '这是原始用户消息');
  doc.querySelector('#source-copy').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied, '这是原始用户消息');
  assert.ok(doc.querySelector('#source-help').textContent.includes('⌘F'));
  doc.querySelector('[data-mode="time"]').click();
  assert.equal(doc.querySelectorAll('.time-leaf').length, 5, 'time view retains both roles');
  assert.equal(doc.querySelectorAll('.time-graph circle').length, 5);
  assert.equal(doc.querySelector('.time-leaf[data-node-id="u1"]').getAttribute('aria-pressed'), 'true', 'selection survives view switch');
  doc.querySelector('#source-close').click();
  assert.equal(doc.querySelector('#source-panel').hidden, true);
  assert.equal(doc.querySelector('.time-leaf[data-node-id="u1"]').getAttribute('aria-pressed'), 'false');
  data.nodes.push({ id:'u4',turn_id:'t4',role:'user',summary:'<img src=x>',topic_id:'links',parent_ids:['u2'] });
  await tick();
  assert.equal(doc.querySelectorAll('.time-leaf').length, 6, 'poll loads changed data');
  doc.querySelector('[data-mode="outline"]').click();
  assert.equal(doc.querySelectorAll('.outline-leaf').length, 4);
  assert.equal(doc.querySelectorAll('#map img').length, 0, 'summary is rendered as text');
  assert.ok(doc.querySelector('#map').textContent.includes('<img src=x>'));
  dom.window.close();
  console.log('Outline grouping, node selection, source preview, copy action, view switching and refresh passed.');
})().catch(error => { console.error(error); process.exitCode=1; });
