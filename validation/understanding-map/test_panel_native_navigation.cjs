const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const html = fs.readFileSync('validation/understanding-map/live-panel.html', 'utf8');
  const requests = [];
  let navigationResponse = { status: 'dry_run', verified: false };
  let navigationJob = {};
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const dom = new JSDOM(html, {
    url: 'http://example.test/session/live-panel.html?debug=1', runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('understanding-map:panel:v1:/session/live-panel.html', JSON.stringify({
        selectedId: 'u1', sourceOpen: true,
      }));
      window.fetch = async (url, options) => {
        if (url === 'native-navigation') return { ok: true, json: async () => ({ enabled: true, mode: 'dry_run', navigation: navigationJob }) };
        if (url.startsWith('node-source?')) return { ok: true, json: async () => ({ text: '需要定位的原始消息' }) };
        if (url === 'navigate') {
          requests.push(options);
          return { ok: true, json: async () => navigationResponse };
        }
        return { ok: true, text: async () => JSON.stringify({ topics: [], nodes: [
          { id: 'u1', turn_id: 't1', role: 'user', summary: '第一轮' },
          { id: 'u2', turn_id: 't2', role: 'user', summary: '第二轮' },
        ] }) };
      };
      window.setInterval = () => 1;
    },
  });
  await settle();
  assert.equal(requests.length, 0, 'reopening a saved selection must not move native chat');
  assert.equal(dom.window.document.querySelector('#source-panel').hidden, false, 'development mode retains the source inspector');
  dom.window.document.querySelector('[data-node-id="u2"]').click();
  await settle();
  assert.equal(requests.length, 1, 'one node click emits one navigation request');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers['X-Understanding-Map-Action'], 'navigate');
  assert.deepEqual(JSON.parse(requests[0].body), { node_id: 'u2' }, 'original text and session ids are resolved on the server');
  assert.match(dom.window.document.querySelector('#source-help').textContent, /演练通过/);
  assert.doesNotMatch(dom.window.document.querySelector('#source-help').textContent, /已确认原文可见/);
  navigationResponse = { status: 'turn_revealed', verified: false, scope: 'current_window' };
  dom.window.document.querySelector('[data-node-id="u2"]').click();
  await settle();
  assert.match(dom.window.document.querySelector('#source-help').textContent, /当前聊天的原生进度导航/);
  navigationResponse = { status: 'focus_changed', verified: false, scope: 'current_window' };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.match(dom.window.document.querySelector('#source-help').textContent, /前台窗口已变化/);
  navigationResponse = { status: 'chat_unverified', verified: false, diagnostics: {
    focused_window: true, native_pages: 1, readable_addresses: 1, matching_pages: 0, scan_complete: true,
  } };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.match(dom.window.document.querySelector('#source-help').textContent, /页面 1，可读地址 1，匹配 0，扫描完整/);
  assert.doesNotMatch(dom.window.document.querySelector('#source-help').textContent, /已确认原文可见/);
  navigationResponse = { status: 'chat_unverified', verified: false, scope: 'current_window', diagnostics: {
    diagnostic_version: 2, focused_window: true, native_pages: 2, eligible_pages: 1,
    inspected_pages: 1, nested_pages: 1, readable_buttons: 48, labelled_buttons: 31,
    rail_buttons: 0, target_buttons: 0, rail_nodes: 350, rail_scan_complete: true,
    document_scan_complete: false, manual_accessibility: true, file_address_pages: 1,
    ax_read_errors: 2,
    unknown_address_pages: 1, private_url: 'private URL must not be displayed',
  } };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  let diagnosticText = dom.window.document.querySelector('#source-help').textContent;
  assert.match(diagnosticText, /未识别到当前聊天区域/);
  assert.match(diagnosticText, /诊断 2：候选 1\/2，按钮 48，带标签 31，导航 0，目标 0/);
  assert.match(diagnosticText, /页面扫描未完成，导航扫描完整，嵌套 1，读取失败 2，控件树请求已接受/);
  assert.match(diagnosticText, /文件地址 1，未知地址 1/);
  assert.doesNotMatch(diagnosticText, /已确认原文可见|private URL/);
  navigationResponse.diagnostics = {
    diagnostic_version: 2, native_pages: 1, eligible_pages: 1, nested_pages: 0,
    readable_buttons: 12, rail_buttons: 0, target_buttons: 0,
    rail_scan_complete: false, manual_accessibility: false,
    file_address_pages: -1, unknown_address_pages: 'private URL must not be displayed',
    labelled_buttons: 12001,
  };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  diagnosticText = dom.window.document.querySelector('#source-help').textContent;
  assert.match(diagnosticText, /导航扫描未完成，嵌套 0，控件树请求未接受/);
  assert.doesNotMatch(diagnosticText, /文件地址|未知地址|带标签|private URL|12001|已确认原文可见/);
  navigationResponse = { status: 'search_requested', verified: true, method: 'native_accessibility_find' };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.equal(dom.window.document.querySelector('#source-help').textContent, '已在当前聊天中查找原文，请核对定位位置');
  navigationResponse = {status:'search_requested',verified:false,diagnostics:{contextual_search:true}};
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.equal(dom.window.document.querySelector('#source-help').textContent, '已查找同轮上下文，尚未确认短消息位置');
  navigationResponse = {status:'context_revealed',verified:false};
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.equal(dom.window.document.querySelector('#source-help').textContent, '已定位到同轮回复，请核对这条短消息是否可见');
  navigationResponse = { status: 'find_unavailable', verified: false, diagnostics: {
    find_triggered: true, chat_scope_found: true, find_input_found: false,
    query_written: false, search_candidates: 2, query: 'private search text must not be displayed',
  } };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  diagnosticText = dom.window.document.querySelector('#source-help').textContent;
  assert.equal(diagnosticText, '未找到可用的原生聊天查找入口（查找已触发，聊天范围按钮已找到，输入框未找到，可用 2）');
  assert.doesNotMatch(diagnosticText, /已确认原文可见|private search text/);
  navigationResponse={status:'navigation_failed',verified:false,diagnostics:{navigation_error_code:11,find_stage:8}};
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.match(dom.window.document.querySelector('#source-help').textContent,/定位错误 11，步骤 8/);
  navigationResponse={status:'chat_unverified',verified:false,diagnostics:{diagnostic_version:3,native_pages:0,document_scan_complete:true,ax_read_errors:0}};
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.match(dom.window.document.querySelector('#source-help').textContent,/Windows 诊断：聊天区域 0，页面扫描完整/);
  navigationResponse={status:'find_unavailable',verified:false};
  navigationResponse.diagnostics = {
    find_triggered: false, chat_scope_found: true, chat_scope_pressed: true,
    chat_scope_selected: true, find_input_found: false, find_stage: 5,
    find_fields: 2, chat_named_fields: 1, search_candidates: 0,
    field_scan_complete: false, field_read_errors: 1,
  };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  diagnosticText = dom.window.document.querySelector('#source-help').textContent;
  assert.equal(diagnosticText, '未找到可用的原生聊天查找入口（复用已有查找，聊天范围按钮已找到，范围切换已请求，聊天范围已选中，输入框未找到，步骤 5，字段 2，聊天字段 1，可用 0，字段扫描未完成，读取失败 1）');
  assert.doesNotMatch(diagnosticText, /已确认原文可见/);
  navigationResponse.diagnostics = {
    find_triggered: false, chat_scope_found: true, chat_scope_pressed: true,
    find_input_found: true, focused_find_field: true, find_stage: 6, field_nodes: 18,
  };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  diagnosticText = dom.window.document.querySelector('#source-help').textContent;
  assert.match(diagnosticText, /焦点输入框已确认，步骤 6，已扫描 18/);
  assert.doesNotMatch(diagnosticText, /已确认原文可见/);
  navigationResponse.diagnostics = {
    find_triggered: false, chat_scope_found: 'private scope must not be displayed',
    find_input_found: 1,
  };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.equal(dom.window.document.querySelector('#source-help').textContent, '未找到可用的原生聊天查找入口（查找未触发）');
  navigationResponse = { status: 'source_unsearchable', verified: false };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.equal(dom.window.document.querySelector('#source-help').textContent, '这条消息缺少可唯一查找的片段，暂时无法精确定位');
  navigationResponse = { status: 'helper_failed', verified: false, diagnostics: {
    protocol_error: 2, helper_exit_code: 11, helper_crashed: true,
    helper_output_empty: true, helper_response_valid: false,
    stderr: 'private stderr must not be displayed', stdout: 'private stdout must not be displayed',
  } };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  diagnosticText = dom.window.document.querySelector('#source-help').textContent;
  assert.equal(diagnosticText, '本机辅助程序执行失败，请核对诊断信息（协议错误 2，退出码 11，程序已崩溃）');
  assert.doesNotMatch(diagnosticText, /private|已确认原文可见/);
  navigationResponse.diagnostics = { protocol_error: 'private code', helper_exit_code: -11, helper_crashed: 'private bool' };
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.equal(dom.window.document.querySelector('#source-help').textContent, '本机辅助程序执行失败，请核对诊断信息');
  for(const [status, message] of [
    ['invalid_source', '地图原文记录不可用，请刷新地图后重试'],
    ['invalid_request', '定位请求无效，请刷新地图后重试'],
  ]){
   navigationResponse = {status, verified:false};
   dom.window.document.querySelector('[data-node-id="u1"]').click();
   await settle();
   assert.equal(dom.window.document.querySelector('#source-help').textContent, message);
  }
  navigationResponse = {status:'pending',request_id:'current-navigation'};
  navigationJob = {status:'located',request_id:'earlier-navigation',verified:true};
  dom.window.document.querySelector('[data-node-id="u1"]').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.doesNotMatch(dom.window.document.querySelector('#source-help').textContent,/已确认原文可见/);
  navigationJob = {status:'located',request_id:'current-navigation',verified:true};
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(dom.window.document.querySelector('#source-help').textContent,'已确认原文可见');
  dom.window.close();

  const productionRequests = [];
  let productionSourceReads = 0;
  let productionResult = {status:'find_unavailable',verified:false,diagnostics:{find_stage:8,find_input_found:true}};
  const production = new JSDOM(html, {
    url:'http://example.test/session/live-panel.html',runScripts:'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('understanding-map:panel:v1:/session/live-panel.html',JSON.stringify({
        selectedId:'u1',sourceOpen:true,
      }));
      window.fetch=async (url,options)=>{
        if(url==='native-navigation')return {ok:true,json:async()=>({enabled:true,mode:'native'})};
        if(url.startsWith('node-source?')){
          productionSourceReads++;
          return {ok:true,json:async()=>({text:'原文检查内容'})};
        }
        if(url==='navigate'){
          productionRequests.push(JSON.parse(options.body));
          return {ok:true,json:async()=>productionResult};
        }
        if(url==='refresh')return {ok:true,json:async()=>({status:'unchanged'})};
        return {ok:true,text:async()=>JSON.stringify({topics:[],nodes:[
          {id:'u1',turn_id:'t1',role:'user',summary:'第一轮'},
          {id:'u2',turn_id:'t2',role:'user',summary:'第二轮'},
        ]})};
      };
      window.setInterval=()=>1;
    },
  });
  await settle();
  const document=production.window.document;
  assert.equal(document.querySelector('#source-panel').hidden,true,'normal mode ignores the old saved source-open preference');
  assert.equal(productionRequests.length,0,'restoring normal mode must not move native chat');
  document.querySelector('[data-node-id="u2"]').click();
  await settle();
  assert.deepEqual(productionRequests,[{node_id:'u2'}],'normal mode keeps the same server-resolved navigation request');
  assert.equal(document.querySelector('#source-panel').hidden,true,'normal node clicks keep the inspector hidden');
  assert.equal(document.querySelector('#navigation-status').textContent,'未能识别聊天查找框，请回到对应聊天后重试');
  assert.equal(document.querySelector('#navigation-status').hidden,false);
  assert.doesNotMatch(document.querySelector('#source-help').textContent,/步骤|字段|输入框已找到/,'normal mode does not render detailed diagnostics');
  for(const [status,message] of [
    ['navigation_failed','未能填入查找原文，请回到聊天后重试'],
    ['chat_unverified','未能确认当前聊天，请打开对应聊天后重试'],
    ['helper_unavailable','定位组件缺失，请重新安装最新版插件'],
  ]){
    productionResult={status,verified:false,diagnostics:{navigation_error_code:8,find_stage:6}};
    document.querySelector('[data-node-id="u1"]').click();
    await settle();
    assert.equal(document.querySelector('#navigation-status').textContent,message);
    assert.equal(document.querySelector('#source-panel').hidden,true);
    assert.doesNotMatch(document.querySelector('#navigation-status').textContent,/错误 8|步骤|字段/);
  }
  productionResult={status:'located',verified:true};
  document.querySelector('[data-node-id="u1"]').click();
  await settle();
  assert.equal(document.querySelector('#navigation-status').hidden,true,'successful navigation clears the temporary message');
  assert.equal(document.querySelector('#source-panel').hidden,true);
  assert.equal(productionSourceReads,0,'normal mode does not load the development source preview');
  production.window.close();
  console.log('Native navigation UI passed: normal mode hides the inspector and diagnostics, development mode retains them, and clicks keep scoped navigation requests.');
})().catch(error => { console.error(error); process.exitCode = 1; });
