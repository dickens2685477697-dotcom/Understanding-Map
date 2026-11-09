import { beforeEach, describe, expect, it } from 'vitest';
import { detectLanguage, extractMessageText } from './messageExtractor';
import { findAssistantMessages, getMessageId, isAssistantMessage } from './chatgptSelectors';

describe('ChatGPT message extraction', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('finds only assistant turns and preserves block boundaries', () => {
    document.body.innerHTML = `
      <article data-testid="conversation-turn-1"><div data-message-author-role="user"><p>User text</p></div></article>
      <article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown"><h2>Heading</h2><p>Paragraph</p><ul><li>First</li><li>Second</li></ul><pre><code>const x = 1;</code></pre><button>Copy</button></div></div></article>`;
    const found = findAssistantMessages();
    expect(found).toHaveLength(1);
    expect(isAssistantMessage(found[0])).toBe(true);
    expect(extractMessageText(found[0])).toBe('Heading\n\nParagraph\n\nFirst\n\nSecond\n\nconst x = 1;');
  });

  it('uses stable attributes before a deterministic text fallback', () => {
    const message = document.createElement('article');
    message.dataset.messageId = 'server-id';
    expect(getMessageId(message, 'text')).toBe('server-id');
    delete message.dataset.messageId;
    expect(getMessageId(message, 'same text')).toBe(getMessageId(message, 'same text'));
  });

  it('detects the dominant response language', () => {
    expect(detectLanguage('这是一个中文回答，包含清晰的结构。')).toBe('zh');
    expect(detectLanguage('This response is mostly written in English.')).toBe('en');
  });
});
