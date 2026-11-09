import { createRoot, type Root } from 'react-dom/client';
import xyflowStyles from '@xyflow/react/dist/style.css?inline';
import canvasStyles from '../styles/canvas.css?inline';
import injectedStyles from '../styles/injected.css?inline';
import { CanvasApp, type CanvasSession } from '../canvas/CanvasApp';
import { detectLanguage, extractMessageText } from './messageExtractor';
import { findAssistantMessages, getMessageId, SELECTORS } from './chatgptSelectors';
import { locateSource } from './sourceLocator';
import { getCachedGraph, hashText, setCachedGraph } from '../services/cache';
import type { ExtensionRequest, StructureResult } from '../types/messages';
import type { ResponseGraph, ResponseNode } from '../types/responseGraph';

type ButtonState = 'default' | 'loading' | 'ready' | 'error';
interface MessageRecord {
  message: HTMLElement;
  button: HTMLButtonElement;
  messageId: string;
  text: string;
  hash: string;
  session?: CanvasSession;
}

const records = new Map<string, MessageRecord>();
let activeRecord: MessageRecord | null = null;
let host: HTMLDivElement | null = null;
let reactRoot: Root | null = null;
let scanTimer: number | null = null;

function injectPageStyles(): void {
  if (document.getElementById('structured-response-canvas-page-styles')) return;
  const style = document.createElement('style');
  style.id = 'structured-response-canvas-page-styles';
  style.textContent = injectedStyles;
  (document.head || document.documentElement).appendChild(style);
}

function ensureHost(): void {
  if (host && reactRoot) return;
  host = document.createElement('div');
  host.dataset.srcCanvasHost = '';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${xyflowStyles}\n${canvasStyles}`;
  const mount = document.createElement('div');
  shadow.append(style, mount);
  document.documentElement.appendChild(host);
  reactRoot = createRoot(mount);
}

function setButtonState(record: MessageRecord, state: ButtonState): void {
  const labels: Record<ButtonState, string> = {
    default: 'Structure', loading: 'Structuring...', ready: 'Open Canvas', error: 'Retry',
  };
  record.button.textContent = labels[state];
  record.button.disabled = state === 'loading';
  record.button.dataset.state = state;
}

function openPanel(record: MessageRecord): void {
  if (!record.session) return;
  activeRecord = record;
  ensureHost();
  if (host) host.style.display = 'block';
  reactRoot?.render(
    <CanvasApp
      session={record.session}
      onClose={() => { if (host) host.style.display = 'none'; }}
      onRetry={() => { void structureRecord(record, true); }}
      onOpenSettings={() => { void sendRuntimeMessage({ type: 'OPEN_OPTIONS' }); }}
      onLocate={(node) => locateNode(record, node)}
    />,
  );
}

function locateNode(record: MessageRecord, node: ResponseNode): void {
  locateSource(record.message, node.sourceText);
}

function addLocalOffsets(graph: ResponseGraph, text: string): ResponseGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (!node.sourceText) return { ...node, sourceStart: null, sourceEnd: null };
      const start = text.indexOf(node.sourceText);
      return {
        ...node,
        sourceStart: start >= 0 ? start : null,
        sourceEnd: start >= 0 ? start + node.sourceText.length : null,
      };
    }),
  };
}

function sendRuntimeMessage(request: ExtensionRequest): Promise<StructureResult | { ok: true }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, code: 'unknown', message: chrome.runtime.lastError.message ?? 'Extension messaging failed.' });
        return;
      }
      resolve(response);
    });
  });
}

async function structureRecord(record: MessageRecord, skipCache = false): Promise<void> {
  record.text = extractMessageText(record.message);
  if (!record.text) {
    record.session = { status: 'error', title: 'Response Canvas', message: 'No response text was found.', missingKey: false };
    setButtonState(record, 'error');
    openPanel(record);
    return;
  }
  record.hash = await hashText(record.text);
  record.session = { status: 'loading', title: 'Response Canvas' };
  setButtonState(record, 'loading');
  openPanel(record);

  if (!skipCache) {
    const cached = await getCachedGraph(record.messageId, record.hash);
    if (cached) {
      record.session = { status: 'ready', graph: cached.graph };
      setButtonState(record, 'ready');
      openPanel(record);
      return;
    }
  }

  const result = await sendRuntimeMessage({
    type: 'STRUCTURE_RESPONSE',
    payload: { content: record.text, language: detectLanguage(record.text) },
  }) as StructureResult;
  if (result.ok) {
    const graph = addLocalOffsets(result.graph, record.text);
    record.session = { status: 'ready', graph };
    setButtonState(record, 'ready');
    await setCachedGraph({
      conversationUrl: location.href,
      messageId: record.messageId,
      responseHash: record.hash,
      graph,
      createdAt: Date.now(),
    });
  } else {
    record.session = {
      status: 'error',
      title: 'Response Canvas',
      message: result.message,
      missingKey: result.code === 'missing_api_key',
    };
    setButtonState(record, 'error');
  }
  if (activeRecord === record) openPanel(record);
}

function buttonContainer(message: HTMLElement): HTMLElement {
  const copyButton = message.querySelector<HTMLElement>(SELECTORS.copyButton);
  return copyButton?.parentElement ?? message;
}

function injectButton(message: HTMLElement): void {
  if (message.querySelector('[data-src-canvas-button]')) return;
  const initialText = extractMessageText(message);
  if (!initialText) return;
  const messageId = getMessageId(message, initialText);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'src-canvas-action-button';
  button.dataset.srcCanvasButton = '';
  button.title = 'Open a semantic structure for this response';

  const previous = records.get(messageId);
  const record: MessageRecord = previous
    ? { ...previous, message, button, text: initialText }
    : { message, button, messageId, text: initialText, hash: '' };
  records.set(messageId, record);
  setButtonState(record, record.session?.status === 'ready' ? 'ready' : record.session?.status === 'error' ? 'error' : 'default');
  button.addEventListener('click', () => {
    if (record.session?.status === 'ready') openPanel(record);
    else void structureRecord(record);
  });
  buttonContainer(message).appendChild(button);
}

function scan(): void {
  scanTimer = null;
  try {
    findAssistantMessages().forEach(injectButton);
  } catch (error) {
    console.warn('[Structured Response Canvas] Could not scan messages.', error);
  }
}

function scheduleScan(): void {
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(scan, 350);
}

injectPageStyles();
scan();
new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
