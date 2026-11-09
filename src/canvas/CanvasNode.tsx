import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CanvasFlowNode } from './layout';

export function CanvasNode({ data }: NodeProps<CanvasFlowNode>) {
  const { item, overview, dimmed, selected } = data;
  return (
    <div className={`canvas-node ${dimmed ? 'is-dimmed' : ''} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {!overview && <div className="canvas-node__type">{item.type}</div>}
      <div className="canvas-node__title">{item.title}</div>
      {!overview && <div className="canvas-node__summary">{item.summary}</div>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
