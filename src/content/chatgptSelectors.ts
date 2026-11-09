export const SELECTORS = {
  assistantAuthor: '[data-message-author-role="assistant"]',
  conversationTurn: 'article[data-testid^="conversation-turn"], article',
  copyButton: '[data-testid="copy-turn-action-button"], button[aria-label*="Copy" i], button[aria-label*="复制"]',
  messageContent: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] [class*="markdown"], [data-message-author-role="assistant"]',
} as const;

export function findAssistantMessages(root: ParentNode = document): HTMLElement[] {
  const found = new Set<HTMLElement>();
  root.querySelectorAll<HTMLElement>(SELECTORS.assistantAuthor).forEach((author) => {
    const container = author.closest<HTMLElement>(SELECTORS.conversationTurn) ?? author;
    found.add(container);
  });
  return [...found];
}

export function isAssistantMessage(element: Element): boolean {
  return element.matches(SELECTORS.assistantAuthor) || Boolean(element.querySelector(SELECTORS.assistantAuthor));
}

export function getAssistantContent(message: HTMLElement): HTMLElement | null {
  return message.querySelector<HTMLElement>(SELECTORS.messageContent)
    ?? (message.matches(SELECTORS.assistantAuthor) ? message : null);
}

export function getMessageId(message: HTMLElement, fallbackText: string): string {
  return message.dataset.messageId
    ?? message.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
    ?? message.getAttribute('data-testid')
    ?? `fallback-${simpleHash(fallbackText)}`;
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
