import { useEffect, useMemo, useState } from 'react';
import {
  Background, Controls, ReactFlow, useEdgesState, useNodesState,
  type NodeMouseHandler, type Viewport,
} from '@xyflow/react';
import type { ResponseGraph, ResponseNode } from '../types/responseGraph';
import { CanvasNode } from './CanvasNode';
import { DetailPanel } from './DetailPanel';
import { layoutGraph, type CanvasFlowNode } from './layout';

interface ResponseCanvasProps {
  graph: ResponseGraph;
  onLocate: (node: ResponseNode) => void;
}

const nodeTypes = { semantic: CanvasNode };

export function ResponseCanvas({ graph, onLocate }: ResponseCanvasProps) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [overview, setOverview] = useState(false);
  const laidOut = useMemo(() => layoutGraph(graph, overview, focusedId), [graph, overview, focusedId]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>(laidOut.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(laidOut.edges);

  useEffect(() => {
    setNodes(laidOut.nodes);
    setEdges(laidOut.edges);
  }, [laidOut, setEdges, setNodes]);

  const selected = graph.nodes.find((node) => node.id === focusedId) ?? null;
  const onNodeClick: NodeMouseHandler<CanvasFlowNode> = (_event, node) => setFocusedId(node.id);
  const onMove = (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    setOverview((current) => viewport.zoom < 0.62 ? true : viewport.zoom > 0.7 ? false : current);
  };

  return (
    <div className="canvas-area">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={() => setFocusedId(null)}
        onMove={onMove}
        fitView
        minZoom={0.25}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {selected && <DetailPanel node={selected} onClose={() => setFocusedId(null)} onLocate={() => onLocate(selected)} />}
    </div>
  );
}
