import { useEffect, useRef, useState } from 'react';
import type { ResponseGraph, ResponseNode } from '../types/responseGraph';
import { ResponseCanvas } from './ResponseCanvas';

export type CanvasSession =
  | { status: 'loading'; title: string }
  | { status: 'error'; title: string; message: string; missingKey: boolean }
  | { status: 'ready'; graph: ResponseGraph };

interface CanvasAppProps {
  session: CanvasSession;
  onClose: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  onLocate: (node: ResponseNode) => void;
}

const MIN_WIDTH = 360;
const MAX_WIDTH = 720;

export function CanvasApp({ session, onClose, onRetry, onOpenSettings, onLocate }: CanvasAppProps) {
  const [width, setWidth] = useState(() => Math.min(460, window.innerWidth - 40));
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragStart.current) return;
      const max = Math.min(MAX_WIDTH, window.innerWidth - 24);
      setWidth(Math.max(Math.min(MIN_WIDTH, max), Math.min(max, dragStart.current.width + dragStart.current.x - event.clientX)));
    };
    const up = () => { dragStart.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const title = session.status === 'ready' ? session.graph.responseTitle : session.title;
  return (
    <div className="canvas-shell" style={{ width }}>
      <div
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(event) => { dragStart.current = { x: event.clientX, width }; }}
      />
      <header className="canvas-header">
        <div><div className="eyebrow">Response Canvas</div><h1>{title}</h1></div>
        <button className="icon-button" onClick={onClose} aria-label="Close canvas">×</button>
      </header>
      {session.status === 'loading' && (
        <div className="state-view loading-view">
          <div className="spinner" />
          <h2>Structuring response...</h2>
          <p>Finding the main ideas and relationships.</p>
          <div className="skeleton"><i /><i /><i /></div>
        </div>
      )}
      {session.status === 'error' && (
        <div className="state-view error-view">
          <div className="error-mark">!</div>
          <h2>Unable to structure this response</h2>
          <p>{session.message}</p>
          <div className="state-actions">
            {session.missingKey && <button className="primary-button" onClick={onOpenSettings}>Open Settings</button>}
            <button className={session.missingKey ? 'secondary-button' : 'primary-button'} onClick={onRetry}>Retry</button>
          </div>
        </div>
      )}
      {session.status === 'ready' && (
        <>
          <div className="canvas-summary">{session.graph.responseSummary}</div>
          <ResponseCanvas graph={session.graph} onLocate={onLocate} />
        </>
      )}
    </div>
  );
}
