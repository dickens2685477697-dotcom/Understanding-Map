// Run with Harness's Electron Node runtime. Uses a temporary, isolated storage root.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceDefinition, emptyMap, mergeSummary, validateMap } from './core.js';

const resources = process.argv[2];
if (!resources) throw new Error('Pass the installed Harness Resources directory');
const load = name => import(pathToFileURL(join(resources, 'app.asar/dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await load('cordis');
const { SessionStore } = await load('dsh-session');
const { SessionProjectionRegistry } = await load('dsh-session-projection');
const { DomainFacility } = await load('dsh-storage-domain');
const { JsonStorageBackend } = await load('dsh-storage-json');

const root = await mkdtemp(join(tmpdir(), 'understanding-map-dsh-'));
const ctx = new Context();
const backend = new JsonStorageBackend(root);
let domain;
try {
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  const handle = await ctx.sessionProjections.register(sourceDefinition);
  const session = ctx.sessions.create('understanding-map-smoke');
  session.append('turn/start', { turn: 0 });
  session.append('user/message', { id: 'test-message', role: 'user', content: [{ type: 'text', text: '只用于测试的消息' }], source: { kind: 'user', rpcId: 'test-request' } }, { surfaceOp: 'append' });
  const source = handle.stateOf(session);
  assert.equal(source.messages.length, 1);
  assert.equal(source.messages[0].rpcId, 'test-request');
  assert.equal(ctx.sessionProjections.snapshot(session).values.understandingMapSource.count, 1);
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit: () => {}, logger: { warn() {} } }, { backend: 'json' });
  const spec = { name: 'understanding_map_deepseek', version: 1, tables: { maps: { valueSchema: { parse: validateMap } } } };
  domain = await facility.open(spec);
  const map = mergeSummary(emptyMap(session.id), source.messages, { topics: [], nodes: [{ id: 'test-message', summary: '验证地图读取与保存', parent: null, topic_id: null }] });
  await domain.table('maps').put(session.id, map);
  await domain.close(); domain = null;
  domain = await facility.open(spec);
  assert.deepEqual(domain.table('maps').get(session.id), map);
  console.log('Actual Harness runtime: session projection, wire snapshot, JSON storage and reopen passed');
} finally {
  await domain?.close();
  await backend.close();
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
