import { sourceDefinition, emptyMap, validateMap, pendingMessages, mergeSummary, mergeTopicAssignments, parseSummary, summaryInstruction, classificationInstruction } from './core.js';

export const inject = ['sessions', 'sessionProjections', 'agents', 'commands', 'tools', 'llm', 'storageDomain'];

export async function apply(ctx) {
  const source = await ctx.sessionProjections.register(sourceDefinition);
  const domain = await ctx.storageDomain.open({
    name: 'understanding_map_deepseek', version: 1,
    tables: { maps: { valueSchema: { parse: validateMap } } },
  });
  const table = domain.table('maps');
  const jobs = new Map();
  const controller = new AbortController();
  ctx.effect(() => async () => {
    controller.abort();
    await Promise.allSettled([...jobs.values()]);
    await domain.close();
  });

  async function summarize(selection, signal, input) {
    const prepared = await ctx.llm.prepareCall(selection, signal, (controls, model) => {
      const effort = model.reasoning?.efforts?.[0];
      return { ...controls, maxTokens: Math.min(model.maxOutputTokens ?? 4096, 4096), ...(effort ? { reasoningEffort: effort.id } : {}) };
    });
    let text = '';
    let finished = false;
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }], signal })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish') {
        if (['error', 'aborted', 'max-tokens'].includes(chunk.reason?.kind)) throw new Error(`Summary stopped: ${chunk.reason.kind}`);
        finished = true;
      }
    }
    if (!finished) throw new Error('Summary stream ended without completion');
    return parseSummary(text);
  }

  async function refresh(agent, signal) {
    if (!agent?.session) throw new Error('A current Harness session is required');
    const session = agent.session;
    if (jobs.has(session.id)) return jobs.get(session.id);
    const task = (async () => {
      const messages = source.stateOf(session).messages;
      let map = table.get(session.id) ?? emptyMap(session.id);
      const pending = pendingMessages(map, messages);
      const unclassified = map.nodes.filter(node => !Object.hasOwn(node, 'topic_id'));
      if (!pending.length && !unclassified.length) return { map, added: 0, classified: 0 };
      const selection = agent.model.current();
      if (!selection) throw new Error('Choose a model in Harness first');
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal, AbortSignal.timeout(180000)]) : AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      for (let index = 0; index < unclassified.length; index += 16) {
        const batch = unclassified.slice(index, index + 16);
        const result = await summarize(selection, requestSignal, {
          instruction: classificationInstruction,
          topics: map.topics ?? [],
          messagesToClassify: batch.map(node => ({ id: node.id, summary: node.summary })),
          previousNodes: map.nodes.filter(node => Object.hasOwn(node, 'topic_id')).slice(-100).map(node => ({ id: node.id, summary: node.summary, topic_id: node.topic_id })),
        });
        map = mergeTopicAssignments(map, batch, result);
        requestSignal.throwIfAborted();
        await table.put(session.id, map);
      }
      for (let i = 0; i < pending.length; i += 16) {
        requestSignal.throwIfAborted();
        const batch = pending.slice(i, i + 16);
        const result = await summarize(selection, requestSignal, {
          instruction: summaryInstruction,
          topics: map.topics ?? [],
          previousNodes: map.nodes.slice(-100).map(n => ({ id: n.id, summary: n.summary, parent: n.parent, topic_id: n.topic_id })),
          newMessages: batch.map(m => ({ id: m.id, text: m.text })),
        });
        map = mergeSummary(map, batch, result);
        requestSignal.throwIfAborted();
        await table.put(session.id, map);
      }
      return { map, added: pending.length, classified: unclassified.length };
    })();
    jobs.set(session.id, task);
    try { return await task; } finally { if (jobs.get(session.id) === task) jobs.delete(session.id); }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'understanding-map', description: 'Refresh Understanding Map for this chat; no conversation model turn is created.',
    recordInput: false,
    handler: async ({ agent, signal }) => {
      try { return { kind: 'success', text: JSON.stringify(await refresh(agent, signal)) }; }
      catch (error) { return { kind: 'error', text: error.message }; }
    },
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'understanding_map_refresh', description: 'Update this chat’s Understanding Map, only when the user explicitly requests it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args, exec) => {
      if (!args || Object.keys(args).length) throw new Error('No arguments accepted');
      const result = await refresh(exec.agent, exec.signal);
      return JSON.stringify({ added: result.added, total: result.map.nodes.length });
    },
  }));
}
