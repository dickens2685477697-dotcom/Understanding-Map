import type { ResponseNode } from '../types/responseGraph';

interface DetailPanelProps {
  node: ResponseNode;
  onClose: () => void;
  onLocate: () => void;
}

export function DetailPanel({ node, onClose, onLocate }: DetailPanelProps) {
  return (
    <aside className="detail-panel" aria-label="Node detail">
      <button className="icon-button detail-panel__close" onClick={onClose} aria-label="Close details">×</button>
      <div className="detail-panel__type">{node.type}</div>
      <h2>{node.title}</h2>
      <section>
        <h3>Summary</h3>
        <p>{node.summary}</p>
      </section>
      {node.detail && <section><h3>Detail</h3><p>{node.detail}</p></section>}
      {node.sourceText && <section><h3>Source</h3><blockquote>{node.sourceText}</blockquote></section>}
      <button className="primary-button" onClick={onLocate}>Locate in Response</button>
    </aside>
  );
}
