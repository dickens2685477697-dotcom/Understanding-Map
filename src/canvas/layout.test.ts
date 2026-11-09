import { describe, expect, it } from 'vitest';
import { layoutGraph } from './layout';

const graph = {
  responseTitle: 'Title', responseSummary: 'Summary',
  nodes: [
    { id: 'root', type: 'question' as const, title: 'Root', summary: 'Root summary', detail: '', parentId: null, sourceText: '' },
    { id: 'child', type: 'claim' as const, title: 'Child', summary: 'Child summary', detail: '', parentId: 'root', sourceText: '' },
    { id: 'grandchild', type: 'evidence' as const, title: 'Evidence', summary: 'Evidence summary', detail: '', parentId: 'child', sourceText: '' },
    { id: 'other', type: 'limitation' as const, title: 'Other', summary: 'Other summary', detail: '', parentId: 'root', sourceText: '' },
  ],
};

describe('canvas layout', () => {
  it('creates derived edges and overview node data', () => {
    const result = layoutGraph(graph, true, null);
    expect(result.edges).toHaveLength(3);
    expect(result.nodes.every((node) => node.data.overview)).toBe(true);
  });

  it('keeps only the focus node, parent, and direct children undimmed', () => {
    const result = layoutGraph(graph, false, 'child');
    const dimmed = Object.fromEntries(result.nodes.map((node) => [node.id, node.data.dimmed]));
    expect(dimmed).toEqual({ root: false, child: false, grandchild: false, other: true });
  });
});
