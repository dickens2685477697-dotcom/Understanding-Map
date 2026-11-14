const {JSDOM}=require('jsdom');
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');

(async()=>{
 const html=readFileSync('validation/understanding-map/live-panel.html','utf8');
 let tick,posts=0,reads=0,failure=null,job={id:'job-1',status:'checking'};
 let nodes=[];
 const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
 const dom=new JSDOM(html,{url:'http://example.test/session/live-panel.html',runScripts:'dangerously',beforeParse(window){
  window.setInterval=fn=>{tick=fn;return 1};
  window.fetch=async(url,options)=>{
   if(url===failure){const error=new Error('未找到可用的 Python 3.9+，请安装后重启 Codex。');error.code='python_missing';throw error}
   if(url==='native-navigation')return {ok:true,json:async()=>({enabled:false})};
   if(url==='refresh'){
    posts++;
    assert.equal(options.method,'POST');
    assert.equal(options.headers['X-Understanding-Map-Action'],'refresh');
    assert.deepEqual(JSON.parse(options.body),{});
    return {ok:true,json:async()=>job};
   }
   if(url==='refresh-status')return {ok:true,json:async()=>job};
   reads++;
   return {ok:true,text:async()=>JSON.stringify({topics:[],nodes})};
  };
 }});
 await settle();
 const doc=dom.window.document;
 assert.equal(posts,1,'opening/reloading a panel starts one update check');
 assert.equal(doc.querySelector('#map-refresh').disabled,true);
 await tick();await tick();
 assert.equal(posts,1,'periodic result reads do not trigger model jobs');
 job={id:'job-1',status:'summarizing',added_messages:1};
 await tick();
 assert.match(doc.querySelector('#refresh-status').textContent,/正在整理 1 条/);
 nodes=[{id:'u1',turn_id:'t1',role:'user',summary:'新消息摘要'}];
 job={id:'job-1',status:'updated',added_messages:1};
 await tick();
 assert.equal(doc.querySelectorAll('.outline-leaf').length,1);
 assert.match(doc.querySelector('#refresh-status').textContent,/新增 1 条摘要/);
 assert.equal(doc.querySelector('#map-refresh').disabled,false);
 job={id:'job-2',status:'unchanged',added_messages:0};
 doc.querySelector('#map-refresh').click();await settle();
 assert.equal(posts,2);
 assert.match(doc.querySelector('#refresh-status').textContent,/暂无新增/);
 job={id:'job-3',status:'error',error:'model_timeout',private:'private detail'};
 doc.querySelector('#map-refresh').click();await settle();
 assert.match(doc.querySelector('#refresh-status').textContent,/摘要任务超时/);
 assert.doesNotMatch(doc.querySelector('#refresh-status').textContent,/private detail/);
 assert.equal(doc.querySelectorAll('.outline-leaf').length,1,'errors preserve the last displayed map');
 failure='refresh';
 doc.querySelector('#map-refresh').click();await settle();
 assert.match(doc.querySelector('#refresh-status').textContent,/Python 3.9/,'startup errors remain actionable');
 failure='map-view.json';await tick();
 assert.match(doc.querySelector('main>.status:last-child').textContent,/Python 3.9/,'read errors retain the startup diagnosis');
 failure=null;job={id:'job-4',status:'checking'};
 doc.querySelector('#map-refresh').click();await settle();
 failure='refresh-status';await tick();
 assert.match(doc.querySelector('#refresh-status').textContent,/Python 3.9/,'poll failures retain the startup diagnosis');
 assert.equal(doc.querySelectorAll('.outline-leaf').length,1,'a disconnected backend preserves the map');
 assert.ok(reads>0);
 dom.window.close();
 console.log('Refresh starts one job, polling stays read-only, completion reloads results, and failures allow retry.');
})().catch(error=>{console.error(error);process.exitCode=1});
