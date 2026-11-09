import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { vi } from 'vitest';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverMock, configurable: true });
