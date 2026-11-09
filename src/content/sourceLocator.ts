import { getAssistantContent } from './chatgptSelectors';
import { normalizeExtractedText } from './messageExtractor';

const CANDIDATES = 'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, tr';
let activeHighlight: HTMLElement | null = null;
let highlightTimer: number | null = null;

function scoreCandidate(candidate: string, source: string): number {
  if (!candidate || !source) return 0;
  if (candidate.includes(source) || source.includes(candidate)) return Math.min(candidate.length, source.length) / Math.max(candidate.length, source.length);
  const sourceWords = new Set(source.toLowerCase().split(/\s+/).filter(Boolean));
  const candidateWords = new Set(candidate.toLowerCase().split(/\s+/).filter(Boolean));
  if (sourceWords.size === 0 || candidateWords.size === 0) return 0;
  let shared = 0;
  for (const word of sourceWords) if (candidateWords.has(word)) shared += 1;
  return shared / Math.max(sourceWords.size, candidateWords.size);
}

export function findSourceElement(message: HTMLElement, sourceText: string): HTMLElement | null {
  const content = getAssistantContent(message);
  if (!content) return null;
  const source = normalizeExtractedText(sourceText);
  if (!source) return content;
  const candidates = [...content.querySelectorAll<HTMLElement>(CANDIDATES)];
  let best: { element: HTMLElement; score: number } | null = null;
  for (const element of candidates) {
    const candidate = normalizeExtractedText(element.innerText || element.textContent || '');
    const score = scoreCandidate(candidate, source);
    if (score > (best?.score ?? 0)) best = { element, score };
    if (score >= 0.96) break;
  }
  return best && best.score >= 0.2 ? best.element : content;
}

export function locateSource(message: HTMLElement, sourceText: string): boolean {
  const target = findSourceElement(message, sourceText);
  if (!target) return false;
  if (activeHighlight) activeHighlight.classList.remove('src-canvas-source-highlight');
  if (highlightTimer !== null) window.clearTimeout(highlightTimer);
  activeHighlight = target;
  target.classList.add('src-canvas-source-highlight');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  highlightTimer = window.setTimeout(() => {
    target.classList.remove('src-canvas-source-highlight');
    if (activeHighlight === target) activeHighlight = null;
    highlightTimer = null;
  }, 1500);
  return true;
}
