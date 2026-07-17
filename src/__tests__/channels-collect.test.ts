import { describe, test, expect } from 'bun:test';
import { WorkforceTextCollector } from '../channels/collect';

describe('WorkforceTextCollector', () => {
  test('accumulates DELTA text_delta items (runtime vocabulary)', () => {
    const c = new WorkforceTextCollector();
    expect(c.push({ type: 'DELTA', item: { type: 'text_delta', text_delta: 'Hel' } })).toBe('Hel');
    expect(c.push({ type: 'DELTA', item: { type: 'text_delta', text_delta: 'lo' } })).toBe('Hello');
    expect(c.text).toBe('Hello');
  });

  test('ignores non-text delta items (tool_use, thinking)', () => {
    const c = new WorkforceTextCollector();
    expect(c.push({ type: 'DELTA', item: { type: 'tool_use', name: 'get_datetime', input: '' } })).toBeNull();
    expect(c.push({ type: 'DELTA', item: { type: 'thinking_delta', thinking_delta: 'hmm' } })).toBeNull();
    expect(c.text).toBe('');
  });

  test('top-level OUTPUT with Message content supersedes accumulation', () => {
    const c = new WorkforceTextCollector();
    c.push({ type: 'DELTA', item: { type: 'text_delta', text_delta: 'partial' } });
    const updated = c.push({
      type: 'OUTPUT',
      path: 'agent',
      output: { role: 'assistant', content: [{ type: 'text', text: 'The time is 13:37.' }] },
    });
    expect(updated).toBe('The time is 13:37.');
    expect(c.text).toBe('The time is 13:37.');
  });

  test('nested OUTPUTs (dotted path — tool results) are ignored', () => {
    const c = new WorkforceTextCollector();
    expect(
      c.push({ type: 'OUTPUT', path: 'agent.get_datetime', output: '2026-07-16 13:37:00' }),
    ).toBeNull();
    expect(c.text).toBe('');
  });

  test('OUTPUT with plain string output is used directly', () => {
    const c = new WorkforceTextCollector();
    expect(c.push({ type: 'OUTPUT', path: 'wf', output: 'done!' })).toBe('done!');
  });

  test('OUTPUT joins multiple text blocks and skips non-text blocks', () => {
    const c = new WorkforceTextCollector();
    c.push({
      type: 'OUTPUT',
      path: 'agent',
      output: {
        content: [
          { type: 'text', text: 'part one' },
          { type: 'tool_use', id: 't1', name: 'x' },
          { type: 'text', text: 'part two' },
        ],
      },
    });
    expect(c.text).toBe('part one\npart two');
  });

  test('legacy CHUNK strings accumulate', () => {
    const c = new WorkforceTextCollector();
    c.push({ type: 'CHUNK', chunk: 'a' });
    c.push({ type: 'CHUNK', chunk: 'b' });
    expect(c.text).toBe('ab');
  });

  test('lowercase simplified vocabulary still works', () => {
    const c = new WorkforceTextCollector();
    c.push({ type: 'delta', delta: 'hi ' });
    c.push({ type: 'delta', delta: 'there' });
    expect(c.text).toBe('hi there');
    c.push({ type: 'output', output: 'final' });
    expect(c.text).toBe('final');
  });

  test('START and unknown events are no-ops', () => {
    const c = new WorkforceTextCollector();
    expect(c.push({ type: 'START', status_text: 'Thinking...' })).toBeNull();
    expect(c.push({ weird: true })).toBeNull();
  });

  test('OUTPUT file blocks are collected into files', () => {
    const c = new WorkforceTextCollector();
    c.push({
      type: 'OUTPUT',
      path: 'agent',
      output: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'here is your chart' },
          { type: 'file', file: 'https://cdn.timbal.ai/x/chart.png', name: 'chart.png' },
          { type: 'file', file: 'data:application/pdf;base64,AAAA' },
        ],
      },
    });
    expect(c.text).toBe('here is your chart');
    expect(c.files).toEqual([
      { file: 'https://cdn.timbal.ai/x/chart.png', fileName: 'chart.png' },
      { file: 'data:application/pdf;base64,AAAA', fileName: undefined },
    ]);
  });

  test('a file-only OUTPUT yields files with empty text', () => {
    const c = new WorkforceTextCollector();
    const updated = c.push({
      type: 'OUTPUT',
      path: 'agent',
      output: { content: [{ type: 'file', file: 'https://cdn.test/a.pdf' }] },
    });
    // No text change to stream — but the file is captured.
    expect(updated).toBeNull();
    expect(c.text).toBe('');
    expect(c.files).toHaveLength(1);
  });

  test('nested OUTPUT files are ignored; malformed file blocks skipped', () => {
    const c = new WorkforceTextCollector();
    c.push({
      type: 'OUTPUT',
      path: 'agent.tool',
      output: { content: [{ type: 'file', file: 'https://cdn.test/tool-artifact.bin' }] },
    });
    expect(c.files).toHaveLength(0);
    c.push({
      type: 'OUTPUT',
      path: 'agent',
      output: { content: [{ type: 'file' }, { type: 'file', file: '' }, 'junk'] },
    });
    expect(c.files).toHaveLength(0);
  });
});
