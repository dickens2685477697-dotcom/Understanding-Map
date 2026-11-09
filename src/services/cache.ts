import type { CachedGraph } from '../types/messages';

const CACHE_PREFIX = 'graphCache:';

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cacheKey(messageId: string): string {
  return `${CACHE_PREFIX}${messageId}`;
}

export async function getCachedGraph(messageId: string, responseHash: string): Promise<CachedGraph | null> {
  const key = cacheKey(messageId);
  const stored = await chrome.storage.local.get(key) as Record<string, CachedGraph | undefined>;
  const cached = stored[key];
  return cached?.responseHash === responseHash && cached.conversationUrl === location.href ? cached : null;
}

export async function setCachedGraph(value: CachedGraph): Promise<void> {
  await chrome.storage.local.set({ [cacheKey(value.messageId)]: value });
}
