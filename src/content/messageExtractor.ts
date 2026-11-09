import { getAssistantContent } from './chatgptSelectors';

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'TR']);
const SKIP_TAGS = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEXTAREA', 'INPUT']);

function collectText(node: Node, parts: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parts.push(node.textContent ?? '');
    return;
  }
  if (!(node instanceof HTMLElement) || SKIP_TAGS.has(node.tagName) || node.dataset.srcCanvasHost !== undefined) return;
  const block = BLOCK_TAGS.has(node.tagName);
  if (block) parts.push('\n');
  for (const child of node.childNodes) collectText(child, parts);
  if (block) parts.push('\n');
}

export function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractMessageText(message: HTMLElement): string {
  const content = getAssistantContent(message);
  if (!content) return '';
  const parts: string[] = [];
  collectText(content, parts);
  return normalizeExtractedText(parts.join(''));
}

export function detectLanguage(text: string): string {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > latin * 0.2 ? 'zh' : 'en';
}
