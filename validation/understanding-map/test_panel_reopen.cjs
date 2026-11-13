const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const html = readFileSync('validation/understanding-map/live-panel.html', 'utf8');
  let data = { version:1, topics:[{id:'map',label:'地图的呈现方式',parent_id:null}], nodes:[
    {id:'u1',turn_id:'t1',role:'user',summary:'提出理解地图',topic_id:'map',parent_ids:[]},
    {id:'a1',turn_id:'t1',role:'assistant',summary:'AI 回复摘要',topic_id:'map',parent_ids:['u1']},
  ]};
  const items = new Map();
  const storage = { getItem:k=>items.has(k)?items.get(k):null, setItem:(k,v)=>items.set(k,String(v)), removeItem:k=>items.delete(k) };
  let tick, lastScroll;
  function page(url) {
    return new JSDOM(html, { url, runScripts:'dangerously', pretendToBeVisual:true, beforeParse(window) {
      Object.defineProperty(window,'localStorage',{value:storage});
      Object.defineProperty(window,'scrollY',{value:0,writable:true});
      window.scrollTo=(x,y)=>{window.scrollY=y;lastScroll=y};
      window.requestAnimationFrame=fn=>{fn();return 1};
      window.setInterval=fn=>{tick=fn;return 1};
      window.fetch=async url=>url.startsWith('node-source?')
        ? {ok:true,json:async()=>({id:'u1',text:'用户消息原文'})}
        : {ok:true,text:async()=>JSON.stringify(data)};
    }});
  }
  let dom=page('http://example.test/session-a/live-panel.html?debug=1');
  await new Promise(resolve=>setTimeout(resolve,0));
  let d=dom.window.document;
  d.querySelector('[data-mode="time"]').click();
  d.querySelector('.time-leaf[data-node-id="u1"]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  dom.window.scrollY=480;
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();

  dom=page('http://example.test/session-a/live-panel.html?debug=1');
  await new Promise(resolve=>setTimeout(resolve,0));
  d=dom.window.document;
  assert.equal(d.querySelector('[data-mode="time"]').getAttribute('aria-pressed'),'true','view mode is restored');
  assert.equal(d.querySelector('.time-leaf[data-node-id="u1"]').getAttribute('aria-pressed'),'true','selected node is restored');
  assert.equal(d.querySelector('#source-panel').hidden,false,'source preview is restored');
  assert.equal(d.querySelector('#source-text').textContent,'用户消息原文');
  assert.equal(lastScroll,480,'scroll position is restored');
  assert.equal(d.querySelectorAll('.time-leaf').length,1,'only user summaries are visible');

  d.querySelector('[data-mode="outline"]').click();
  let group=[...d.querySelectorAll('summary')].find(x=>x.textContent==='地图的呈现方式').parentElement;
  group.open=false;
  group.dispatchEvent(new dom.window.Event('toggle'));
  data={...data,nodes:[...data.nodes,{id:'u2',turn_id:'t2',role:'user',summary:'新的节点',topic_id:'map',parent_ids:['u1']}]};
  await tick();
  group=[...d.querySelectorAll('summary')].find(x=>x.textContent==='地图的呈现方式').parentElement;
  assert.equal(group.open,false,'manual collapse survives a data refresh');
  assert.equal(d.querySelectorAll('.outline-leaf').length,2,'new and prior nodes remain in the DOM');
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();

  dom=page('http://example.test/session-a/live-panel.html?debug=1');
  await new Promise(resolve=>setTimeout(resolve,0));
  d=dom.window.document;
  group=[...d.querySelectorAll('summary')].find(x=>x.textContent==='地图的呈现方式').parentElement;
  assert.equal(group.open,false,'collapse choice survives reopening');
  assert.equal(d.querySelectorAll('.outline-leaf').length,2);
  dom.window.close();

  dom=page('http://example.test/session-b/live-panel.html?debug=1');
  await new Promise(resolve=>setTimeout(resolve,0));
  d=dom.window.document;
  assert.equal(d.querySelector('[data-mode="outline"]').getAttribute('aria-pressed'),'true','other sessions use independent settings');
  assert.equal(d.querySelector('#source-panel').hidden,true);
  dom.window.close();
  items.set('understanding-map:panel:v1:/session-a/live-panel.html', JSON.stringify({mode:'time',selectedId:'a1',sourceOpen:true}));
  dom=page('http://example.test/session-a/live-panel.html?debug=1');
  await new Promise(resolve=>setTimeout(resolve,0));
  d=dom.window.document;
  assert.equal(d.querySelector('#source-panel').hidden,true,'a previously selected AI response stays hidden');
  assert.equal(d.querySelectorAll('.time-leaf').length,2);
  dom.window.close();
  console.log('Reopening restores view, selection, source, scroll and collapsed state; sessions stay isolated.');
})().catch(error=>{console.error(error);process.exitCode=1});
