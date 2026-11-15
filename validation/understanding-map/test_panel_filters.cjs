const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const html = readFileSync('validation/understanding-map/live-panel.html', 'utf8');
  const topics = [
    { id: 'root', label: '原文定位', parent_id: null },
    { id: 'find', label: '自动聊天查找', parent_id: 'root' },
    { id: 'windows', label: 'Windows 输入兼容', parent_id: 'find' },
    { id: 'share', label: '分享发布', parent_id: null },
    { id: 'permissions', label: '权限确认', parent_id: null },
  ];
  const node = (id, intent, topic, parent, turn = id) => ({
    id, intent, topic_id: topic, role: 'user', turn_id: turn,
    summary: `用户发言 ${id}`, parent_ids: parent ? [parent] : [],
  });
  let data = { topics, nodes: [
    node('u1', 'question', 'root', null),
    { id: 'a1', role: 'assistant', turn_id: 'u1', summary: 'AI 不参与标签筛选', parent_ids: ['u1'] },
    node('u2', 'idea', 'find', 'a1'),
    { id: 'a2', role: 'assistant', turn_id: 'u2', summary: 'AI 承接中间节点', parent_ids: ['u2'] },
    node('u3', 'request', 'find', 'a2'),
    node('u4', 'confirmation', 'permissions', 'u3'),
    node('u5', 'feedback', 'windows', 'u3'),
    node('u6', 'question', 'windows', 'u5'),
    node('u7', 'request', 'windows', 'u5'),
    node('u8', 'feedback', 'windows', 'u7', 'u7'),
    node('u9', null, null, null),
    node('u10', 'request', 'share', 'u9'),
  ] };
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const sessions = [];
  function page(pathname = '/filters/live-panel.html', measurements = null) {
    const requests = [];
    const observers = [];
    let tick;
    const dom = new JSDOM(html, {
      url: `http://example.test${pathname}`, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        Object.defineProperty(window, 'localStorage', { value: storage });
        window.scrollTo = () => {};
        window.requestAnimationFrame = fn => { fn(); return 1; };
        window.setInterval = fn => { tick = fn; return 1; };
        if (measurements) {
          window.HTMLElement.prototype.getBoundingClientRect = function () {
            const height = this.classList.contains('time-leaf') ? measurements.rows[this.dataset.nodeId] ?? 48
              : this.classList.contains('time-gap') ? measurements.gap : 0;
            return { x: 0, y: 0, width: 300, height, top: 0, bottom: height, left: 0, right: 300 };
          };
          window.ResizeObserver = class {
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(target) { this.target = target; }
            disconnect() {
              this.disconnected = true;
              this.connectedAtDisconnect = this.target?.isConnected;
            }
          };
        }
        window.fetch = async (url, options) => {
          requests.push({ url, options });
          if (url === 'native-navigation') return { ok: true, json: async () => ({ enabled: true, mode: 'native' }) };
          if (url === 'refresh') return { ok: true, json: async () => ({ id: 'refresh-1', status: 'unchanged' }) };
          if (url === 'navigate') return { ok: true, json: async () => ({ status: 'located', verified: true }) };
          return { ok: true, text: async () => JSON.stringify(data) };
        };
      },
    });
    const result = { dom, requests, observers, tick: () => tick(), d: dom.window.document };
    sessions.push(result);
    return result;
  }
  function filter(d, intent) {
    const button = d.querySelector(`.tag-filters [data-intent-filter="${intent}"]`);
    assert.ok(button, `${intent} filter is present`);
    button.click();
  }
  const ids = (d, kind = 'time') => [...d.querySelectorAll(`.${kind}-leaf`)].map(el => el.dataset.nodeId);
  const numbers = (d, kind = 'time') => [...d.querySelectorAll(`.${kind}-leaf .num`)].map(el => el.textContent);
  const point = (d, id) => d.querySelector(`.time-graph circle[data-node-id="${id}"]`);
  const edges = d => [...d.querySelectorAll('.message-relation')].map(el => `${el.dataset.parentId}->${el.dataset.childId}`).sort();
  const navs = page => page.requests.filter(r => r.url === 'navigate');
  const p = page();
  await settle();
  let d = p.d;
  assert.equal(d.querySelectorAll('.tag-filters [data-intent-filter]').length, 6, 'all plus the five existing intent labels');
  assert.equal(d.querySelector('[data-intent-filter="all"]').getAttribute('aria-pressed'), 'true');
  assert.match(d.querySelector('[data-intent-filter="all"]').textContent, /10/, 'counts exclude assistant messages');
  assert.match(d.querySelector('[data-intent-filter="request"]').textContent, /3/);
  assert.match(d.querySelector('[data-intent-filter="feedback"]').textContent, /2/);
  assert.equal(ids(d, 'outline').length, 10, 'unlabelled user messages are included in all');
  d.querySelector('[data-mode="time"]').click();
  const originalPoint = point(d, 'u7');
  const originalX = originalPoint.getAttribute('cx');
  const originalColor = originalPoint.style.getPropertyValue('--topic-color');
  const originalLevel = originalPoint.dataset.topicLevel;
  assert.ok(edges(d).includes('u1->u2'), 'original relation traverses an assistant intermediary');
  filter(d, 'request');
  filter(d, 'feedback');
  assert.deepEqual(ids(d), ['u3', 'u5', 'u7', 'u8', 'u10'], 'multiple selected labels use OR matching');
  assert.deepEqual(numbers(d), ['03', '05', '07', '08', '10'], 'filtered rows keep original ordinals');
  assert.match(d.querySelector('.filter-status').textContent, /5\s*\/\s*10/);
  assert.equal(point(d, 'u7').getAttribute('cx'), originalX, 'filtering does not shift the original hierarchy lane');
  assert.equal(point(d, 'u7').style.getPropertyValue('--topic-color'), originalColor, 'filtering does not recompute blue depth');
  assert.equal(point(d, 'u7').dataset.topicLevel, originalLevel);
  assert.deepEqual(edges(d), ['u3->u5', 'u5->u7', 'u7->u8'], 'hidden parents do not create shortcut relations');
  assert.equal(d.querySelectorAll('.time-gap').length, 4, 'each consecutive hidden run becomes one fold');
  const firstGap = d.querySelector('.time-gap');
  assert.equal(firstGap.getAttribute('aria-expanded'), 'false');
  assert.match(firstGap.textContent, /2/, 'the first hidden run contains two user messages');
  assert.equal(firstGap.dataset.gapId, JSON.stringify(['u1', 'u2']), 'gap identity uses original endpoints');
  firstGap.click();
  assert.deepEqual(ids(d), ['u1', 'u2', 'u3', 'u5', 'u7', 'u8', 'u10'], 'expanding a fold reveals the original messages in order');
  assert.equal(d.querySelector('.time-gap').getAttribute('aria-expanded'), 'true');
  assert.equal(d.querySelectorAll('.time-leaf.filtered-context').length, 2, 'revealed nonmatches remain visibly contextual');
  assert.deepEqual(edges(d), ['u1->u2', 'u2->u3', 'u3->u5', 'u5->u7', 'u7->u8'], 'expansion restores the actual original relationships');
  assert.equal(navs(p).length, 0, 'filtering and expansion never trigger native navigation');
  d.querySelector('.time-leaf[data-node-id="u7"]').click();
  await settle();
  assert.equal(navs(p).length, 1);
  assert.deepEqual(JSON.parse(navs(p)[0].options.body), { node_id: 'u7' }, 'a filtered click uses the original node id');
  d.querySelector('[data-mode="outline"]').click();
  assert.deepEqual(ids(d, 'outline'), ['u3', 'u5', 'u7', 'u8', 'u10']);
  assert.deepEqual(numbers(d, 'outline'), ['03', '05', '07', '08', '10'], 'separate sent messages keep separate ordinals even in the same turn');
  assert.ok(d.querySelector('summary[data-topic-id="root"]'), 'ancestor topic heading is kept for matching descendants');
  assert.ok(d.querySelector('summary[data-topic-id="find"]'));
  assert.ok(d.querySelector('summary[data-topic-id="windows"]'));
  assert.equal(d.querySelector('summary[data-topic-id="permissions"]'), null, 'unrelated topic branches are pruned');
  assert.ok(!d.querySelector('#map').textContent.includes('AI 不参与标签筛选'));
  d.querySelector('[data-mode="time"]').click();
  const prefsKey = 'understanding-map:panel:v1:/filters/live-panel.html';
  const saved = JSON.parse(values.get(prefsKey));
  assert.deepEqual(saved.intentFilters.sort(), ['feedback', 'request']);
  p.dom.window.dispatchEvent(new p.dom.window.Event('pagehide'));
  p.dom.window.close();

  const reopened = page();
  await settle();
  d = reopened.d;
  assert.equal(d.querySelector('[data-mode="time"]').getAttribute('aria-pressed'), 'true');
  assert.equal(d.querySelector('[data-intent-filter="request"]').getAttribute('aria-pressed'), 'true');
  assert.equal(d.querySelector('[data-intent-filter="feedback"]').getAttribute('aria-pressed'), 'true');
  assert.ok(ids(d).includes('u7'));
  assert.equal(navs(reopened).length, 0, 'restoring a filtered selection does not move native chat');
  filter(d, 'feedback');
  assert.deepEqual(ids(d), ['u3', 'u7', 'u10'], 'changing filters resets expanded nonmatching runs');
  filter(d, 'request');
  assert.equal(ids(d).length, 10, 'deselecting the last filter returns to all');
  assert.equal(d.querySelectorAll('.time-gap').length, 0);
  assert.equal(d.querySelector('[data-intent-filter="all"]').getAttribute('aria-pressed'), 'true');
  filter(d, 'feedback');
  data = { ...data, nodes: [...data.nodes, node('u11', 'feedback', 'windows', 'u8')] };
  await reopened.tick();
  assert.deepEqual(ids(d), ['u5', 'u8', 'u11'], 'data updates keep the active label filter');
  assert.deepEqual(numbers(d), ['05', '08', '11']);
  assert.match(d.querySelector('[data-intent-filter="feedback"]').textContent, /3/, 'counts refresh from the entire updated map');
  assert.match(d.querySelector('.filter-status').textContent, /3\s*\/\s*11/);

  const other = page('/other-chat/live-panel.html');
  await settle();
  assert.equal(other.d.querySelector('[data-intent-filter="all"]').getAttribute('aria-pressed'), 'true', 'another chat starts with its own filter settings');
  assert.equal(ids(other.d, 'outline').length, 11);
  const measurements = { rows: { u1: 88, u2: 72 }, gap: 36 };
  const measured = page('/measured-rows/live-panel.html', measurements);
  await settle();
  measured.d.querySelector('[data-mode="time"]').click();
  assert.equal(measured.observers.length, 1, 'the time list has one active size observer');
  const measuredPoint = id => point(measured.d, id);
  assert.equal(measuredPoint('u1').getAttribute('cy'), '44', 'a wrapped first row uses its actual center');
  assert.equal(measuredPoint('u2').getAttribute('cy'), '124', 'later centers include preceding measured heights');
  const originalHeight = Number(measured.d.querySelector('.time-graph').getAttribute('height'));
  const originalPath = measured.d.querySelector('[data-parent-id="u1"][data-child-id="u2"]').getAttribute('d');
  measurements.rows.u1 = 132;
  const observer = measured.observers[0];
  observer.callback([], observer);
  assert.equal(measuredPoint('u1').getAttribute('cy'), '66', 'row reflow moves the original point to its new center');
  assert.equal(measuredPoint('u2').getAttribute('cy'), '168', 'later points move after a preceding row grows');
  assert.equal(Number(measured.d.querySelector('.time-graph').getAttribute('height')), originalHeight + 44);
  const movedPath = measured.d.querySelector('[data-parent-id="u1"][data-child-id="u2"]').getAttribute('d');
  assert.notEqual(movedPath, originalPath, 'relations are redrawn after row reflow');
  assert.match(movedPath, /^M14 66 /, 'the relation starts at the measured parent center');
  assert.match(movedPath, /168/, 'the relation ends at the measured child center');
  assert.equal(measured.observers.length, 1, 'a size callback redraws in place without adding observers');
  filter(measured.d, 'request');
  assert.equal(observer.disconnected, true, 'filter rendering disconnects the old list observer');
  assert.equal(observer.connectedAtDisconnect, true, 'the observer disconnects before its old list is detached');
  assert.equal(measured.observers.length, 2, 'the replacement time list receives a fresh observer');
  assert.equal(measuredPoint('u3').getAttribute('cy'), '60', 'folded row measurement contributes to visible-node placement');
  measured.d.querySelector('[data-mode="outline"]').click();
  assert.equal(measured.observers[1].disconnected, true, 'leaving the time view disconnects its active observer');
  values.set('understanding-map:panel:v1:/invalid-pref/live-panel.html', JSON.stringify({ mode: 'time', intentFilters: ['invalid', 42, 'feedback'] }));
  const sanitized = page('/invalid-pref/live-panel.html');
  await settle();
  assert.deepEqual(ids(sanitized.d), ['u5', 'u8', 'u11'], 'invalid saved labels do not widen or break the filter');
  data = { topics: [], nodes: [] };
  await sanitized.tick();
  assert.equal(ids(sanitized.d).length, 0, 'an empty map remains renderable with a saved filter');
  assert.match(sanitized.d.querySelector('.filter-status').textContent, /0\s*\/\s*0/);
  assert.equal(sanitized.d.querySelectorAll('.time-gap').length, 0);
  sessions.forEach(session => session.dom.window.close());
  console.log('Tag filters preserve original identities and depth, fold hidden runs, prune hierarchy, navigate real IDs, and restore per-chat state.');
})().catch(error => { console.error(error); process.exitCode = 1; });
