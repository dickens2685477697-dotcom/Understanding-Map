import { z } from 'zod';

export const NODE_TYPES = [
  'question', 'claim', 'explanation', 'evidence', 'example', 'comparison',
  'limitation', 'conclusion', 'recommendation', 'step', 'definition',
] as const;

export type ResponseNodeType = (typeof NODE_TYPES)[number];

export const responseNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(500),
  detail: z.string().max(10_000),
  parentId: z.string().nullable(),
  sourceText: z.string(),
  sourceStart: z.number().int().nonnegative().nullable().optional(),
  sourceEnd: z.number().int().nonnegative().nullable().optional(),
});

export const responseGraphSchema = z.object({
  responseTitle: z.string().min(1).max(160),
  responseSummary: z.string().min(1).max(1_000),
  nodes: z.array(responseNodeSchema).min(1).max(15),
});

export type ResponseNode = z.infer<typeof responseNodeSchema>;
export type ResponseGraph = z.infer<typeof responseGraphSchema>;

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export function validateGraph(input: unknown): ResponseGraph {
  const graph = responseGraphSchema.parse(input);
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) throw new GraphValidationError(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  if (!graph.nodes.some((node) => node.parentId === null)) {
    throw new GraphValidationError('Graph must contain at least one root node.');
  }
  for (const node of graph.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) {
      throw new GraphValidationError(`Missing parent ${node.parentId} for ${node.id}`);
    }
  }

  const parentById = new Map(graph.nodes.map((node) => [node.id, node.parentId]));
  for (const node of graph.nodes) {
    const path = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor !== null) {
      if (path.has(cursor)) throw new GraphValidationError('Graph contains a cycle.');
      path.add(cursor);
      cursor = parentById.get(cursor) ?? null;
    }
  }
  return graph;
}
