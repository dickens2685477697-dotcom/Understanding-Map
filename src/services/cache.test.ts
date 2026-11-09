import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedGraph, hashText, setCachedGraph } from './cache';
import type { CachedGraph } from '../types/messages';

const storage = new Map<string, unknown>();
const graph = { responseTitle: 'T', responseSummary: 'S', nodes: [{ id: 'a', type: 'claim' as const, title: 'A', summary: 'S', detail: '', parentId: null, sourceText: '' }] };

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); }),
    } },
  });
});

describe('graph cache', () => {
  it('creates stable SHA-256 hashes', async () => {
    expect(await hashText('response')).toBe(await hashText('response'));
    expect(await hashText('response')).not.toBe(await hashText('changed'));
  });

  it('returns only matching URL and content hashes', async () => {
    const value: CachedGraph = { conversationUrl: location.href, messageId: 'm1', responseHash: 'h1', graph, createdAt: 1 };
    await setCachedGraph(value);
    expect(await getCachedGraph('m1', 'h1')).toEqual(value);
    expect(await getCachedGraph('m1', 'h2')).toBeNull();
  });
});
