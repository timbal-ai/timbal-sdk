import { describe, test, expect } from 'bun:test';
import { parseSSELine } from '../lib/functions/sse';

describe('parseSSELine', () => {
  // ── Null / empty cases ──

  test('returns null for empty string', () => {
    expect(parseSSELine('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(parseSSELine('   ')).toBeNull();
  });

  test('returns null for [DONE] sentinel', () => {
    expect(parseSSELine('[DONE]')).toBeNull();
  });

  test('returns null for data: [DONE]', () => {
    expect(parseSSELine('data: [DONE]')).toBeNull();
  });

  test('returns null for unparseable data', () => {
    expect(parseSSELine('not json at all %%!')).toBeNull();
  });

  // ── Standard JSON ──

  test('parses a JSON object', () => {
    expect(parseSSELine('{"type":"text","value":"hello"}')).toEqual({ type: 'text', value: 'hello' });
  });

  test('strips "data: " prefix before parsing JSON', () => {
    expect(parseSSELine('data: {"type":"text","value":"hello"}')).toEqual({ type: 'text', value: 'hello' });
  });

  test('parses JSON with nested objects', () => {
    const input = '{"result":{"id":1,"name":"test"}}';
    expect(parseSSELine(input)).toEqual({ result: { id: 1, name: 'test' } });
  });

  test('parses JSON with array values', () => {
    const input = '{"items":[1,2,3]}';
    expect(parseSSELine(input)).toEqual({ items: [1, 2, 3] });
  });

  test('trims leading/trailing whitespace before parsing', () => {
    expect(parseSSELine('  {"ok":true}  ')).toEqual({ ok: true });
  });

  // ── Python dict repr fallback ──

  test('converts single quotes to double quotes', () => {
    expect(parseSSELine("{'type':'text'}")).toEqual({ type: 'text' });
  });

  test('converts None to null', () => {
    expect(parseSSELine("{'value':None}")).toEqual({ value: null });
  });

  test('converts True to true', () => {
    expect(parseSSELine("{'done':True}")).toEqual({ done: true });
  });

  test('converts False to false', () => {
    expect(parseSSELine("{'active':False}")).toEqual({ active: false });
  });

  test('handles mixed Python repr fields', () => {
    expect(parseSSELine("{'ok':True,'error':None,'retried':False}")).toEqual({
      ok: true,
      error: null,
      retried: false,
    });
  });

  test('handles Python repr with data: prefix', () => {
    expect(parseSSELine("data: {'type':'chunk','done':False}")).toEqual({
      type: 'chunk',
      done: false,
    });
  });
});
