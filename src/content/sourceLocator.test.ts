import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findSourceElement, locateSource } from './sourceLocator';

describe('source locator', () => {
  beforeEach(() => {
    document.body.innerHTML = `<article><div data-message-author-role="assistant"><div class="markdown"><p>Opening context.</p><p id="target">Motion trigger has a clear state change.</p><p>Closing note.</p></div></div></article>`;
  });

  it('finds exact and whitespace-normalized source text', () => {
    const message = document.querySelector('article') as HTMLElement;
    expect(findSourceElement(message, 'Motion   trigger has a clear state change.')?.id).toBe('target');
  });

  it('falls back to the response content and highlights safely', () => {
    vi.useFakeTimers();
    const message = document.querySelector('article') as HTMLElement;
    expect(locateSource(message, 'Motion trigger has a clear state change.')).toBe(true);
    const target = document.getElementById('target')!;
    expect(target).toHaveClass('src-canvas-source-highlight');
    vi.advanceTimersByTime(1500);
    expect(target).not.toHaveClass('src-canvas-source-highlight');
    vi.useRealTimers();
  });
});
