import { describe, expect, it } from 'vitest';
import { GraphValidationError, validateGraph } from './responseGraph';

const node = (id: string, parentId: string | null) => ({
  id, type: 'claim', title: id, summary: `Summary ${id}`, detail: '', parentId, sourceText: '',
});

describe('validateGraph', () => {
  it('accepts a hierarchy and a forest', () => {
    expect(validateGraph({ responseTitle: 'Title', responseSummary: 'Summary', nodes: [node('a', null), node('b', 'a'), node('c', null)] }).nodes).toHaveLength(3);
  });

  it('rejects duplicate ids', () => {
    expect(() => validateGraph({ responseTitle: 'Title', responseSummary: 'Summary', nodes: [node('a', null), node('a', null)] })).toThrow(GraphValidationError);
  });

  it('rejects missing parents', () => {
    expect(() => validateGraph({ responseTitle: 'Title', responseSummary: 'Summary', nodes: [node('a', null), node('b', 'missing')] })).toThrow(/Missing parent/);
  });

  it('rejects cycles and rootless graphs', () => {
    expect(() => validateGraph({ responseTitle: 'Title', responseSummary: 'Summary', nodes: [node('a', 'b'), node('b', 'a')] })).toThrow(/root/);
    expect(() => validateGraph({ responseTitle: 'Title', responseSummary: 'Summary', nodes: [node('root', null), node('a', 'b'), node('b', 'a')] })).toThrow(/cycle/);
  });

  it('rejects more than fifteen nodes and invalid JSON-shaped input', () => {
    expect(() => validateGraph({ responseTitle: 'Title', responseSummary: 'Summary', nodes: Array.from({ length: 16 }, (_, i) => node(String(i), null)) })).toThrow();
    expect(() => validateGraph('not json')).toThrow();
  });
});
