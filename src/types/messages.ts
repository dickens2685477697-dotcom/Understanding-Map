import type { ResponseGraph } from './responseGraph';

export type StructureErrorCode =
  | 'missing_api_key' | 'authentication' | 'rate_limit' | 'network'
  | 'invalid_response' | 'model_refusal' | 'unknown';

export interface StructureRequest {
  type: 'STRUCTURE_RESPONSE';
  payload: { content: string; language: string };
}

export interface OpenOptionsRequest { type: 'OPEN_OPTIONS' }

export type ExtensionRequest = StructureRequest | OpenOptionsRequest;

export type StructureResult =
  | { ok: true; graph: ResponseGraph }
  | { ok: false; code: StructureErrorCode; message: string };

export interface CachedGraph {
  conversationUrl: string;
  messageId: string;
  responseHash: string;
  graph: ResponseGraph;
  createdAt: number;
}

export interface ExtensionSettings {
  apiKey: string;
  model: string;
}

export const DEFAULT_MODEL = 'gpt-5.6-luna';
