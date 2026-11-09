import { afterEach, describe, expect, it, vi } from 'vitest';
import { structureWithOpenAI } from './openAIProvider';

const validGraph = {
  responseTitle: 'Title', responseSummary: 'Summary',
  nodes: [{ id: 'root', type: 'claim', title: 'Claim', summary: 'Summary', detail: '', parentId: null, sourceText: 'Source' }],
};

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI provider', () => {
  it('requests strict structured output and validates it', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.store).toBe(false);
      expect(body.text.format.type).toBe('json_schema');
      expect(body.text.format.strict).toBe(true);
      return new Response(JSON.stringify({ output_text: JSON.stringify(validGraph) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(structureWithOpenAI('key', 'model', 'Source', 'en')).resolves.toMatchObject(validGraph);
  });

  it.each([[401, 'authentication'], [429, 'rate_limit']] as const)('maps HTTP %s to %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Failure' } }), { status })));
    await expect(structureWithOpenAI('key', 'model', 'text', 'en')).rejects.toMatchObject({ code });
  });

  it('classifies network failures and malformed output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(structureWithOpenAI('key', 'model', 'text', 'en')).rejects.toMatchObject({ code: 'network' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output_text: '{}' }), { status: 200 })));
    await expect(structureWithOpenAI('key', 'model', 'text', 'en')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
