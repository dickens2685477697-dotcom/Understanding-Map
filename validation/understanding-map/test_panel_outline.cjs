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
    { id: 'u2', turn_id: 't2', role: 'user', summary: '讨论关联线', topic_id: 'links', parent_ids: ['a1'] },
    { id: 'a2', turn_id: 't2', role: 'assistant', summary: 'AI 解释关联', topic_id: 'links', parent_ids: ['u2'] },
    { id: 'u3', turn_id: 't3', role: 'user', summary: '新的未归类问题', topic_id: null, parent_ids: [] },
  ] };
  let tick, copied = '';
  const dom = new JSDOM(html, { url: 'http://example.test/live-panel.html?debug=1', runScripts: 'dangerously', beforeParse(window) {
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
  const rootHeading=doc.querySelector('summary[data-topic-id="map"]');
  const childHeading=doc.querySelector('summary[data-topic-id="links"]');
  assert.equal(rootHeading.dataset.topicLevel,'0');
  assert.equal(childHeading.dataset.topicLevel,'1');
  assert.notEqual(rootHeading.style.getPropertyValue('--topic-color'),childHeading.style.getPropertyValue('--topic-color'),'subtopics have a lighter shade');
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
  assert.equal(doc.querySelectorAll('.time-leaf').length, 3, 'time view contains one summary per user message');
  assert.deepEqual([...doc.querySelectorAll('.time-leaf .num')].map(el=>el.textContent), ['01','02','03']);
  assert.ok(!doc.querySelector('#map').textContent.includes('AI'));
  assert.equal(doc.querySelectorAll('.time-graph .message-relation').length, 1, 'user relationship survives a hidden assistant intermediary');
  assert.equal(doc.querySelectorAll('.time-graph circle').length, 3);
  const point=id=>doc.querySelector(`.time-graph circle[data-node-id="${id}"]`);
  assert.equal(point('u1').dataset.topicLevel,'0');
  assert.equal(point('u2').dataset.topicLevel,'1');
  assert.equal(point('u1').style.getPropertyValue('--topic-color'),rootHeading.style.getPropertyValue('--topic-color'),'the same hierarchy uses the same shade across views');
  assert.equal(point('u2').style.getPropertyValue('--topic-color'),childHeading.style.getPropertyValue('--topic-color'));
  assert.equal(point('u3').style.getPropertyValue('--topic-color'),'var(--muted)','unassigned messages have a neutral marker');
  assert.equal(doc.querySelector('.time-leaf[data-node-id="u2"]').style.getPropertyValue('--topic-color'),point('u2').style.getPropertyValue('--topic-color'));
  assert.equal(doc.querySelectorAll('.time-graph .time-order').length,2,'time order includes messages with no recorded parents');
  assert.match(doc.querySelector('.hint').textContent,/虚线表示时间顺序/);
  assert.equal(doc.querySelector('.time-leaf[data-node-id="u1"]').getAttribute('aria-pressed'), 'true', 'selection survives view switch');
  doc.querySelector('#source-close').click();
  assert.equal(doc.querySelector('#source-panel').hidden, true);
  assert.equal(doc.querySelector('.time-leaf[data-node-id="u1"]').getAttribute('aria-pressed'), 'false');
  data.nodes.push({ id:'u4',turn_id:'t4',role:'user',summary:'<img src=x>',topic_id:'links',parent_ids:['u2'] });
  await tick();
  assert.equal(doc.querySelectorAll('.time-leaf').length, 4, 'poll loads changed user messages');
  doc.querySelector('.time-leaf[data-node-id="u4"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(doc.querySelector('#source-text').textContent, '其他原文');
  const laneOf=id=>doc.querySelector(`.time-graph circle[data-node-id="${id}"]`).getAttribute('cx');
  assert.equal(laneOf('u4'),laneOf('u2'),'same-topic follow-ups stay on the same lane');
  assert.notEqual(laneOf('u1'),laneOf('u2'),'a subtopic is indented relative to a top-level topic');
  const width=doc.querySelector('.time-graph').getAttribute('width');
  data.nodes.push({id:'u5',turn_id:'t4',role:'user',summary:'同话题继续追问',topic_id:'links',parent_ids:['u4']});
  await tick();
  assert.equal(laneOf('u5'),laneOf('u2'),'a longer discussion does not create deeper hierarchy');
  assert.equal(point('u5').style.getPropertyValue('--topic-color'),point('u2').style.getPropertyValue('--topic-color'),'following another message does not lighten the hierarchy color');
  assert.equal(doc.querySelector('.time-graph').getAttribute('width'),width,'a longer discussion does not widen the graph');
  assert.equal(doc.querySelectorAll('.time-graph .time-order').length,4,'time order stays continuous after a data update');
  assert.equal(doc.querySelectorAll('.time-graph .message-relation').length,3,'time order does not invent message dependencies');
  assert.equal(doc.querySelectorAll('.time-leaf').length,5,'each sent message has its own entry, including messages in the same turn');
  assert.match(doc.querySelector('.hint').textContent,/子层向右、颜色变浅/);
  data.nodes.push({id:'u6',turn_id:'t5',role:'user',summary:'切换回另一个顶层话题',topic_id:'map',parent_ids:[]});
  await tick();
  assert.equal(laneOf('u6'),laneOf('u1'),'different top-level topics share the same indentation');
  assert.ok(Number(laneOf('u6'))<Number(laneOf('u5')),'returning to a darker top-level topic moves left');
  assert.equal(point('u6').style.getPropertyValue('--topic-color'),point('u1').style.getPropertyValue('--topic-color'));
  data.topics.push({id:'detail',label:'更细一层',parent_id:'links'});
  data.nodes.push({id:'u7',turn_id:'t6',role:'user',summary:'深入具体细节',topic_id:'detail',parent_ids:['u5']});
  await tick();
  assert.ok(Number(laneOf('u7'))>Number(laneOf('u5')),'a deeper topic moves right');
  assert.equal(point('u7').dataset.topicLevel,'2');
  const lightness=id=>Number(point(id).style.getPropertyValue('--topic-color').match(/78% ([\d.]+)%/)[1]);
  assert.ok(lightness('u1')<lightness('u5')&&lightness('u5')<lightness('u7'),'blue gets lighter with topic depth');
  doc.querySelector('[data-mode="outline"]').click();
  assert.equal(doc.querySelectorAll('.outline-leaf').length, 7);
  assert.equal(doc.querySelectorAll('#map img').length, 0, 'summary is rendered as text');
  assert.ok(doc.querySelector('#map').textContent.includes('<img src=x>'));
  dom.window.close();
  console.log('Outline grouping, node selection, source preview, copy action, view switching and refresh passed.');
})().catch(error => { console.error(error); process.exitCode=1; });
