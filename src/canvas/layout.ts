import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { ResponseGraph, ResponseNode } from '../types/responseGraph';

export interface CanvasNodeData extends Record<string, unknown> {
  item: ResponseNode;
  overview: boolean;
  dimmed: boolean;
  selected: boolean;
}

export type CanvasFlowNode = Node<CanvasNodeData, 'semantic'>;

const NODE_WIDTH = 248;
const NODE_HEIGHT = 132;

export function layoutGraph(
  graph: ResponseGraph,
  overview: boolean,
  focusedId: string | null,
): { nodes: CanvasFlowNode[]; edges: Edge[] } {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: 'TB', ranksep: 58, nodesep: 36, marginx: 32, marginy: 32 });
  graph.nodes.forEach((node) => layout.setNode(node.id, { width: NODE_WIDTH, height: overview ? 72 : NODE_HEIGHT }));
  graph.nodes.forEach((node) => {
    if (node.parentId) layout.setEdge(node.parentId, node.id);
  });
  dagre.layout(layout);

  const focused = graph.nodes.find((node) => node.id === focusedId);
  const related = new Set<string>(focusedId ? [focusedId] : []);
  if (focused?.parentId) related.add(focused.parentId);
  graph.nodes.filter((node) => node.parentId === focusedId).forEach((node) => related.add(node.id));

  const nodes: CanvasFlowNode[] = graph.nodes.map((item) => {
    const point = layout.node(item.id);
    return {
      id: item.id,
      type: 'semantic',
      position: { x: point.x - NODE_WIDTH / 2, y: point.y - (overview ? 72 : NODE_HEIGHT) / 2 },
      data: {
        item,
        overview,
        dimmed: Boolean(focusedId && !related.has(item.id)),
        selected: focusedId === item.id,
      },
      draggable: true,
    };
  });
  const edges: Edge[] = graph.nodes.flatMap((node) => node.parentId ? [{
    id: `${node.parentId}-${node.id}`,
    source: node.parentId,
    target: node.id,
    type: 'smoothstep',
    className: focusedId && (!related.has(node.id) || !related.has(node.parentId)) ? 'is-dimmed' : '',
  }] : []);
  return { nodes, edges };
}
