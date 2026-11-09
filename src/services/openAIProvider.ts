import { validateGraph, type ResponseGraph } from '../types/responseGraph';
import type { StructureErrorCode } from '../types/messages';

export class ProviderError extends Error {
  constructor(public readonly code: StructureErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

const GRAPH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['responseTitle', 'responseSummary', 'nodes'],
  properties: {
    responseTitle: { type: 'string' },
    responseSummary: { type: 'string' },
    nodes: {
      type: 'array', minItems: 1, maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'title', 'summary', 'detail', 'parentId', 'sourceText'],
        properties: {
          id: { type: 'string' },
          type: {
            type: 'string',
            enum: ['question', 'claim', 'explanation', 'evidence', 'example', 'comparison', 'limitation', 'conclusion', 'recommendation', 'step', 'definition'],
          },
          title: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
          parentId: { type: ['string', 'null'] },
          sourceText: { type: 'string' },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are an information structure parser.
Convert one AI response into a compact semantic graph. Structure the argument; do not merely split paragraphs.
Identify logical roles such as question, claim, explanation, evidence, example, comparison, limitation, conclusion, recommendation, step, or definition.

Rules:
1. Preserve meaning and never add claims absent from the response.
2. Build a hierarchy using parentId. Include at least one root with parentId null.
3. Prefer 3-5 nodes under 500 characters, 5-8 under 1500, 7-12 under 3000, and no more than 15 otherwise.
4. Titles must be brief; summaries must be one sentence.
5. detail contains the useful supporting content for that node.
6. sourceText must be an exact, contiguous excerpt from the supplied response whenever possible. A conceptual root may use an empty sourceText.
7. Use the dominant language of the response unless the request explicitly supplies another language.
8. Return only data matching the supplied JSON schema.`;

interface ResponsesPayload {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  error?: { message?: string };
}

function extractOutputText(payload: ResponsesPayload): string {
  if (payload.output_text) return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'refusal' || content.refusal) {
        throw new ProviderError('model_refusal', content.refusal ?? 'The model refused this request.');
      }
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  throw new ProviderError('invalid_response', 'The model returned no structured output.');
}

export async function structureWithOpenAI(
  apiKey: string,
  model: string,
  content: string,
  language: string,
): Promise<ResponseGraph> {
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        store: false,
        input: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Output language: ${language}\n\nAI response:\n${content}` },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'response_graph',
            strict: true,
            schema: GRAPH_JSON_SCHEMA,
          },
        },
      }),
    });
  } catch {
    throw new ProviderError('network', 'Could not reach the OpenAI API. Check your connection.');
  }

  const payload = await response.json().catch(() => ({})) as ResponsesPayload;
  if (!response.ok) {
    const message = payload.error?.message ?? `OpenAI API request failed (${response.status}).`;
    if (response.status === 401 || response.status === 403) throw new ProviderError('authentication', message);
    if (response.status === 429) throw new ProviderError('rate_limit', message);
    throw new ProviderError('unknown', message);
  }

  try {
    return validateGraph(JSON.parse(extractOutputText(payload)));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('invalid_response', error instanceof Error ? error.message : 'Invalid structured response.');
  }
}
