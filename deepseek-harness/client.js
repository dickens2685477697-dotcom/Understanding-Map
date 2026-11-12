window.__ModuleLoader__.load({
  id: '@local/understanding-map-deepseek',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const ID = '@local/understanding-map-deepseek', KIND = 'understanding-map';
    // Match the Codex panel's typography, spacing, topic colors and SVG geometry.
    const css = `
      .um-ds {--um-bg:light-dark(#fff,#1e1f22);--um-fg:light-dark(#1d1e21,#eceef1);--um-muted:light-dark(#8b8e93,#a9adb4);--um-accent:light-dark(#3478f6,#77aaff);height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:8px;background:var(--um-bg);color:var(--um-fg);font:14px -apple-system,BlinkMacSystemFont,sans-serif}
      .um-ds button {border:0;background:transparent;color:var(--um-muted);padding:7px 10px;border-radius:9px;font:inherit;cursor:pointer}
      .um-ds button[aria-pressed=true] {background:var(--um-accent);color:light-dark(#fff,#111)}
      .um-ds button:disabled {opacity:.5;cursor:wait}
      .um-ds button:focus-visible,.um-ds summary:focus-visible {outline:2px solid var(--um-accent);outline-offset:2px}
      .um-ds .controls {display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
      .um-ds .hint,.um-ds .status {font-size:12px;color:var(--um-muted);line-height:1.5}
      .um-ds .status {margin-top:16px;overflow-wrap:anywhere}
      .um-ds .outline-group {margin-left:18px}
      .um-ds .outline-group summary {padding:8px 0;cursor:pointer}
      .um-ds .outline-group>summary {color:var(--topic-color,var(--um-fg))}
      .um-ds .outline-leaf {border-left:2px solid var(--topic-color,var(--um-muted));display:flex;gap:12px;align-items:baseline;padding:8px 10px 8px 24px}
      .um-ds .num {color:var(--topic-color,var(--um-muted));font-variant-numeric:tabular-nums;flex:0 0 25px}
      .um-ds .time-wrap {overflow-x:auto}
      .um-ds .time-layout {display:grid;min-width:max-content}
      .um-ds .time-graph {grid-row:1;grid-column:1}
      .um-ds .time-rows {grid-row:1;grid-column:2;display:grid}
      .um-ds .time-leaf {display:flex;gap:8px;padding:0 12px;min-width:260px;align-items:center}
      .um-ds button.node-button {width:100%;text-align:left;color:var(--um-fg);background:transparent;border-radius:6px;line-height:1.45}
      .um-ds button.node-button:hover {background:light-dark(#f2f4f7,#303237)}
      .um-ds button.node-button[aria-pressed=true] {background:light-dark(#eaf1ff,#243754);color:var(--um-fg)}
      .um-ds .node-label {min-width:0;overflow-wrap:anywhere}
      .um-ds .node-action {margin-left:auto;color:var(--um-muted);font-size:12px;white-space:nowrap;opacity:0}
      .um-ds button.node-button:hover .node-action,.um-ds button.node-button:focus-visible .node-action,.um-ds button.node-button[aria-pressed=true] .node-action {opacity:1}
      .um-ds .time-graph circle {cursor:pointer}
      .um-ds .time-graph circle:hover,.um-ds .time-graph circle[aria-pressed=true] {stroke:var(--topic-color,var(--um-accent));stroke-width:4;stroke-opacity:.25}
      .um-ds .source-panel {position:sticky;top:0;z-index:2;margin:0 0 12px;padding:12px;background:var(--um-bg);border:1px solid light-dark(#e2e4e8,#42454b);border-radius:10px;box-shadow:0 4px 12px light-dark(#0000000d,#00000040)}
      .um-ds .source-header {display:flex;align-items:center;justify-content:space-between;gap:8px}
      .um-ds .source-header strong {font-weight:600}
      .um-ds .source-header button {padding:2px 6px}
      .um-ds .source-text {max-height:150px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;line-height:1.55}
      .um-ds-open {font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 9px}
      .um-ds-source {display:block;flex:none;width:0;height:1px;scroll-margin-block:80px}
      .um-ds-source[data-active=true] {width:4px;height:24px;margin-inline-end:8px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
    `;

    function topicLevel(topics, topicId) {
      let topic = topics.get(topicId);
      if (!topic) return null;
      const seen = new Set([topicId]);
      let level = 0;
      while (topics.has(topic.parent_id) && !seen.has(topic.parent_id)) {
        seen.add(topic.parent_id);
        topic = topics.get(topic.parent_id);
        level++;
      }
      return level;
    }

    function topicStyle(topics, topicId) {
      const level = topicLevel(topics, topicId);
      if (level === null) return { '--topic-color': 'var(--um-muted)' };
      const lightness = (35 + 40 * level / (level + 2)).toFixed(1);
      const darkLightness = (60 + 26 * level / (level + 2)).toFixed(1);
      return { '--topic-color': `light-dark(hsl(216 78% ${lightness}%),hsl(216 85% ${darkLightness}%))` };
    }

    function MessageButton({ node, index, topics, selectedId, onSelect, t, className }) {
      return h('button', {
        type: 'button', className: `node-button ${className}`, style: topicStyle(topics, node.topic_id),
        'data-node-id': node.id, 'aria-pressed': selectedId === node.id,
        'aria-label': `${t('locate')} ${node.summary}`, onClick: () => onSelect(node),
      }, h('span', { className: 'num' }, String(index + 1).padStart(2, '0')),
      h('span', { className: 'node-label' }, node.summary), h('span', { className: 'node-action' }, t('locate')));
    }

    function Timeline({ map, topics, selectedId, onSelect, t }) {
      const nodes = map.nodes;
      const positions = nodes.map((node, index) => ({ x: 14 + (topicLevel(topics, node.topic_id) ?? 0) * 22, y: 24 + index * 48 }));
      const indexes = new Map(nodes.map((node, index) => [node.id, index]));
      const width = Math.max(64, ...positions.map(position => position.x + 18));
      const height = nodes.length * 48;
      const timePaths = nodes.slice(1).map((node, offset) => {
        const from = positions[offset];
        const to = positions[offset + 1];
        return h('path', { key: node.id, className: 'time-order', d: `M${from.x} ${from.y} L${to.x} ${to.y}`, fill: 'none', stroke: 'var(--um-muted)', strokeOpacity: .45, strokeDasharray: '3 4' });
      });
      const relationPaths = nodes.flatMap((node, index) => {
        const parent = indexes.get(node.parent);
        if (parent === undefined || parent >= index) return [];
        const from = positions[parent];
        const to = positions[index];
        const radius = Math.min(12, Math.abs(to.x - from.x), to.y - from.y);
        const sign = Math.sign(to.x - from.x);
        const path = from.x === to.x ? `M${from.x} ${from.y} V${to.y}` : `M${from.x} ${from.y} V${to.y - radius} Q${from.x} ${to.y} ${from.x + sign * radius} ${to.y} H${to.x}`;
        return [h('path', { key: node.id, className: 'message-relation', d: path, style: topicStyle(topics, node.topic_id), fill: 'none', stroke: 'var(--topic-color)', strokeOpacity: .85, strokeWidth: 1.5 })];
      });
      const circles = nodes.map((node, index) => h('circle', {
        key: node.id, cx: positions[index].x, cy: positions[index].y, r: 4,
        style: topicStyle(topics, node.topic_id), fill: 'var(--topic-color)', 'data-node-id': node.id,
        'aria-pressed': selectedId === node.id, onClick: () => onSelect(node),
      }, h('title', null, topics.get(node.topic_id)?.label ?? t('unassigned'))));
      return h('div', { className: 'time-wrap' }, h('div', { className: 'time-layout', style: { gridTemplateColumns: `${width}px auto` } },
        h('svg', { className: 'time-graph', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('timeHint') }, timePaths, relationPaths, circles),
        h('div', { className: 'time-rows', style: { gridTemplateRows: `repeat(${nodes.length},48px)` } }, nodes.map((node, index) => h(MessageButton, { key: node.id, node, index, topics, selectedId, onSelect, t, className: 'time-leaf' })))));
    }

    function Outline({ map, topics, selectedId, onSelect, t, collapsed, onToggle }) {
      const children = new Map();
      const items = new Map();
      const unassigned = [];
      for (const topic of topics.values()) {
        const parent = topics.has(topic.parent_id) ? topic.parent_id : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(topic);
      }
      map.nodes.forEach((node, index) => {
        const entry = { node, index };
        if (!topics.has(node.topic_id)) { unassigned.push(entry); return; }
        if (!items.has(node.topic_id)) items.set(node.topic_id, []);
        items.get(node.topic_id).push(entry);
      });
      function leaves(entries) {
        return entries.map(entry => h(MessageButton, { key: entry.node.id, ...entry, topics, selectedId, onSelect, t, className: 'outline-leaf' }));
      }
      function group(key, title, content, style) {
        return h('details', { key, className: 'outline-group', open: !collapsed.has(key), onToggle: event => onToggle(key, event.currentTarget.open) }, h('summary', { style }, title), content);
      }
      function topicGroup(topic) {
        return group(`topic:${topic.id}`, topic.label, [leaves(items.get(topic.id) ?? []), (children.get(topic.id) ?? []).map(topicGroup)], topicStyle(topics, topic.id));
      }
      const content = (children.get(null) ?? []).map(topicGroup);
      if (unassigned.length) content.push(group('unassigned', t('unassigned'), leaves(unassigned)));
      return group('root', 'Understanding Map', content);
    }

    function readPreferences(key) {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? '{}');
        return value && typeof value === 'object' ? value : {};
      } catch { return {}; }
    }
    return {
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.commands', 'sidebarRight', 'sidebarRightTabs', 'uiSession'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(ID, {
          zh: { open: '理解地图', refresh: '更新地图', working: '正在更新…', empty: '发送第一条消息后，刷新生成地图。', hint: '仅总结你的消息 · 点击返回原文', unchanged: '已是最新', updated: '地图已更新', jumped: '已定位原文', missing: '消息尚未挂载，无法定位原文', pending: '条新消息待更新', count: '条提问', outline: '按层级', time: '按时间', outlineHint: '深蓝为顶层，层级越深蓝色越浅，数字表示对话顺序', timeHint: '顶层靠左、深蓝，子层向右、颜色变浅。虚线表示时间顺序，实线表示已记录的承接', unassigned: '待归类', locate: '定位当前聊天', source: '对话原文', closeSource: '关闭原文' },
          en: { open: 'Understanding Map', refresh: 'Update map', working: 'Updating…', empty: 'Send a message, then refresh to create your map.', hint: 'Your messages only · Click to return to source', unchanged: 'Up to date', updated: 'Map updated', jumped: 'Source located', missing: 'The message has not mounted; navigation is unavailable', pending: 'new messages to update', count: 'prompts', outline: 'By hierarchy', time: 'By time', outlineHint: 'Darker blue marks top-level topics. Lighter blue marks deeper topics. Numbers retain conversation order.', timeHint: 'Deeper topics move right and become lighter. Dashed lines show time order. Solid lines show recorded message relations.', unassigned: 'Unassigned', locate: 'Locate in chat', source: 'Original message', closeSource: 'Close source' },
        }));
        const t = ctx.locale.bind(ID), anchors = new Map(), listeners = new Set();
        let target = null;
        function emit() { for (const fn of listeners) fn(); }
        const navSource = { getSnapshot: () => target, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
        function SourceMarker({ sessionId, matched }) {
          const ref = React.useRef(null);
          const request = React.useSyncExternalStore(navSource.subscribe, navSource.getSnapshot);
          const key = `${sessionId}:${matched}`;
          React.useEffect(() => {
            const element = ref.current;
            anchors.set(key, element);
            emit();
            return () => { if (anchors.get(key) === element) anchors.delete(key); };
          }, [key]);
          const active = request?.key === key;
          React.useLayoutEffect(() => {
            if (active) ref.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
          }, [active, request]);
          return h('span', { ref, className: 'um-ds-source', 'data-active': active, 'aria-hidden': true });
        }

        async function navigate(sessionId, node) {
          if (!node.rpcId) throw new Error(t('missing'));
          const session = ctx.sessions.binding(sessionId)?.session;
          if (!session || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) throw new Error('请先切回地图对应的聊天');
          await session.loadThrough(node.turnSeq ?? node.seq);
          const key = `${sessionId}:${node.rpcId}`;
          const request = { key, revision: (target?.revision ?? 0) + 1 };
          target = request;
          emit();
          // Source markers own their refs; no lookup of another plugin's DOM.
          for (let frame = 0; frame < 90; frame++) {
            if (target !== request) throw new Error('定位请求已更新');
            if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) throw new Error('聊天已切换，定位已取消');
            const element = anchors.get(key);
            if (element?.isConnected) {
              element.scrollIntoView({ block: 'center', behavior: 'instant' });
              return;
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          throw new Error(t('missing'));
        }

        async function refresh(sessionId) {
          const reply = await ctx.remote.commands.execute(sessionId, '/understanding-map', []);
          if (!reply.ok) throw new Error(reply.error?.message ?? 'Harness command failed');
          const result = reply.value?.result;
          if (result?.kind !== 'success') throw new Error(result?.text ?? 'Map command unavailable');
          return JSON.parse(result.text);
        }

        function Panel({ sessionId, useProjection, useTabInfo }) {
          const { tab } = useTabInfo();
          const count = useProjection('understandingMapSource')?.count ?? 0;
          const preferencesKey = `understanding-map:deepseek:v2:${sessionId}`;
          const [preferences] = React.useState(() => readPreferences(preferencesKey));
          const [map, setMap] = React.useState(null);
          const [busy, setBusy] = React.useState(false);
          const [status, setStatus] = React.useState('');
          const [active, setActive] = React.useState(preferences.selectedId ?? null);
          const [sourceOpen, setSourceOpen] = React.useState(preferences.sourceOpen === true);
          const [mode, setMode] = React.useState(preferences.mode === 'time' ? 'time' : 'outline');
          const [collapsed, setCollapsed] = React.useState(() => new Set(Array.isArray(preferences.collapsed) ? preferences.collapsed : []));
          const request = React.useRef(0);
          const navigationRequest = React.useRef(0);
          const mounted = React.useRef(true);
          const update = React.useCallback(async () => {
            const revision = ++request.current;
            setBusy(true); setStatus('');
            try {
              const result = await refresh(sessionId);
              if (!mounted.current || revision !== request.current) return;
              setMap(result.map);
              setStatus(t(result.added || result.classified ? 'updated' : 'unchanged'));
            } catch (error) { if (mounted.current && revision === request.current) setStatus(error.message); }
            finally { if (mounted.current && revision === request.current) setBusy(false); }
          }, [sessionId]);
          React.useEffect(() => {
            mounted.current = true; update();
            return () => { mounted.current = false; request.current++; };
          }, [update]);
          React.useEffect(() => {
            try { localStorage.setItem(preferencesKey, JSON.stringify({ mode, collapsed: [...collapsed], selectedId: active, sourceOpen })); } catch {}
          }, [preferencesKey, mode, collapsed, active, sourceOpen]);
          const onToggle = React.useCallback((key, open) => {
            setCollapsed(previous => {
              if (previous.has(key) === !open) return previous;
              const next = new Set(previous);
              if (open) next.delete(key); else next.add(key);
              return next;
            });
          }, []);
          async function onSelect(node) {
            if (!tab.visible) return;
            const revision = ++navigationRequest.current;
            setActive(node.id);
            setSourceOpen(true);
            try {
              await navigate(sessionId, node);
              if (mounted.current && revision === navigationRequest.current) setStatus(t('jumped'));
            } catch (error) {
              if (mounted.current && revision === navigationRequest.current) setStatus(error.message);
            }
          }
          const nodes = map?.nodes ?? [];
          const topics = new Map((map?.topics ?? []).map(topic => [topic.id, topic]));
          const selected = nodes.find(node => node.id === active);
          const viewProps = { map, topics, selectedId: active, onSelect, t };
          return h('section', { className: 'um-ds', 'aria-label': t('open') },
            h('style', null, css),
            h('div', { className: 'controls' },
              h('button', { 'data-mode': 'outline', 'aria-pressed': mode === 'outline', onClick: () => setMode('outline') }, t('outline')),
              h('button', { 'data-mode': 'time', 'aria-pressed': mode === 'time', onClick: () => setMode('time') }, t('time')),
              h('button', { disabled: busy, onClick: update }, t(busy ? 'working' : 'refresh')),
              h('span', { className: 'hint' }, t(mode === 'time' ? 'timeHint' : 'outlineHint'))),
            sourceOpen && selected && h('section', { className: 'source-panel', 'aria-label': t('source') },
              h('div', { className: 'source-header' }, h('strong', null, t('source')), h('button', { 'aria-label': t('closeSource'), onClick: () => { setSourceOpen(false); setActive(null); navigationRequest.current++; } }, '✕')),
              h('div', { className: 'source-text' }, selected.text)),
            h('div', { className: 'status', role: 'status' }, status),
            nodes.length ? mode === 'time' ? h(Timeline, viewProps) : h(Outline, { ...viewProps, collapsed, onToggle }) : h('div', { className: 'status' }, busy ? t('working') : t('empty')),
            h('div', { className: 'status' }, `${nodes.length} ${t('count')}`, count > nodes.length ? ` · ${count - nodes.length} ${t('pending')}` : ''));
        }

        function OpenButton({ sessionId }) {
          return h(React.Fragment, null, h('style', null, css), h('button', { className: 'um-ds-open', onClick: () => ctx.sidebarRight.openTab(KIND), title: t('hint') }, t('open')));
        }
        ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: KIND, title: () => t('open'), keepMounted: true }));
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, locale: ID }, Panel)));
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID, locale: ID }, () => h('span', null, t('open')))));
        // This auxiliary command owns no transcript UI; feedback stays in the map.
        ctx.effect(() => ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key: 'understanding-map' }, () => null)));
        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: ID, order: 50, locale: ID }, OpenButton)));
        ctx.effect(() => ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
          name: 'conversation.chat.user.before', id: ID,
          select: ({ source }) => source?.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId : null,
        }, SourceMarker)));
        ctx.effect(() => () => { anchors.clear(); listeners.clear(); target = null; });
      },
    };
  },
});
