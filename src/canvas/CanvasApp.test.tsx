import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasApp } from './CanvasApp';

const props = { onClose: vi.fn(), onRetry: vi.fn(), onOpenSettings: vi.fn(), onLocate: vi.fn() };

describe('CanvasApp states', () => {
  it('renders loading and closes', () => {
    render(<CanvasApp session={{ status: 'loading', title: 'Response Canvas' }} {...props} />);
    expect(screen.getByText('Structuring response...')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close canvas'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('offers settings and retry for a missing key', () => {
    render(<CanvasApp session={{ status: 'error', title: 'Response Canvas', message: 'Add a key.', missingKey: true }} {...props} />);
    fireEvent.click(screen.getByText('Open Settings'));
    fireEvent.click(screen.getByText('Retry'));
    expect(props.onOpenSettings).toHaveBeenCalled();
    expect(props.onRetry).toHaveBeenCalled();
  });
});
