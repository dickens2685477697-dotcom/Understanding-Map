import { structureWithOpenAI, ProviderError } from '../services/openAIProvider';
import { DEFAULT_MODEL, type ExtensionRequest, type ExtensionSettings, type StructureResult } from '../types/messages';

async function handleStructure(content: string, language: string): Promise<StructureResult> {
  const settings = await chrome.storage.local.get(['apiKey', 'model']) as Partial<ExtensionSettings>;
  if (!settings.apiKey?.trim()) {
    return { ok: false, code: 'missing_api_key', message: 'Add your OpenAI API key in extension settings.' };
  }
  try {
    const graph = await structureWithOpenAI(settings.apiKey.trim(), settings.model?.trim() || DEFAULT_MODEL, content, language);
    return { ok: true, graph };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'unknown', message: error instanceof Error ? error.message : 'Unexpected extension error.' };
  }
}

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  if (request.type === 'OPEN_OPTIONS') {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (request.type === 'STRUCTURE_RESPONSE') {
    void handleStructure(request.payload.content, request.payload.language).then(sendResponse);
    return true;
  }
  return false;
});
