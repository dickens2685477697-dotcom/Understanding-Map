const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, 'probe.html'), 'utf8');
const calls = [];
const dom = new JSDOM(html, { runScripts: 'dangerously' });
const probe = dom.window.navigationProbe;

assert.equal(probe.inspectPublicBridge({}).bridge, 'absent');
const stub = { openai: { callTool: () => calls.push('callTool'), openExternal: () => calls.push('openExternal') } };
const available = probe.inspectPublicBridge(stub);
assert.equal(available.bridge, 'present');
assert.equal(available.methods.openExternal, 'present');
assert.equal(available.nativeNavigation, 'unverified', 'open-link support must not imply native positioning');
assert.equal(available.navigationAttempted, false);
assert.deepEqual(calls, [], 'capability inspection must not invoke host actions');

const denied = {};
Object.defineProperty(denied, 'openai', { get() { throw new Error('unavailable'); } });
assert.equal(probe.inspectPublicBridge(denied).bridge, 'unreadable');

const doc = dom.window.document;
assert.equal(JSON.parse(doc.querySelector('#report').textContent).check, 1);
doc.querySelector('#check').click();
assert.equal(JSON.parse(doc.querySelector('#report').textContent).check, 2);
assert.match(doc.querySelector('#status').textContent, /未检测到/);
assert.match(doc.querySelector('#outcome').textContent, /尚未执行/);
assert.equal(doc.querySelectorAll('#methods tr').length, 12);
dom.window.close();
console.log('Probe checks passed: read-only inspection, missing/partial/unreadable bridge, no false navigation success, and recheck interaction.');
