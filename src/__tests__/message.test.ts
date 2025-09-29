import { test, expect, describe } from 'bun:test';
import { TimbalMessage, MessageContentFactory } from '../lib/message';
import type { TextContent, ToolResultContent } from '../types';

describe('TimbalMessage', () => {
  describe('from()', () => {
    test('should return the same instance if already a TimbalMessage', () => {
      const original = new TimbalMessage('user', [{ type: 'text', text: 'hello' }]);
      const result = TimbalMessage.from(original);

      expect(result).toBe(original);
    });

    test('should create message from string', () => {
      const message = TimbalMessage.from('Hello world');

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    test('should create message from number', () => {
      const message = TimbalMessage.from(42);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({ type: 'text', text: '42' });
    });

    test('should create message from object with role and content', () => {
      const message = TimbalMessage.from({
        role: 'assistant',
        content: 'Hi there!',
      });

      expect(message.role).toBe('assistant');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({ type: 'text', text: 'Hi there!' });
    });

    test('should default to user role when not specified', () => {
      const message = TimbalMessage.from({
        content: 'No role specified',
      });
      console.log(message);

      expect(message.role).toBe('user');
      expect(message.content[0]).toEqual({ type: 'text', text: 'No role specified' });
    });

    test('should handle array content', () => {
      const message = TimbalMessage.from({
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      });

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(2);
      expect(message.content[0]).toEqual({ type: 'text', text: 'First part' });
      expect(message.content[1]).toEqual({ type: 'text', text: 'Second part' });
    });

    test('should handle complex content with tool use', () => {
      const message = TimbalMessage.from({
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll analyze this for you" },
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'analyze_data',
            input: { data: 'sample data' },
          },
        ],
      });

      expect(message.role).toBe('assistant');
      expect(message.content).toHaveLength(2);
      expect(message.content[0]).toEqual({ type: 'text', text: "I'll analyze this for you" });
      expect(message.content[1]).toEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'analyze_data',
        input: { data: 'sample data' },
      });
    });

    test('should handle tool result content', () => {
      const message = TimbalMessage.from({
        role: 'tool',
        content: {
          type: 'tool_result',
          id: 'call_123',
          content: [{ type: 'text', text: 'Analysis complete' }],
        },
      });

      expect(message.role).toBe('tool');
      expect(message.content).toHaveLength(1);
      const toolResult = message.content[0] as ToolResultContent;
      expect(toolResult.type).toBe('tool_result');
      expect(toolResult.id).toBe('call_123');
      expect(toolResult.content).toHaveLength(1);
      expect(toolResult.content[0]).toEqual({ type: 'text', text: 'Analysis complete' });
    });

    test('should handle direct content array', () => {
      const contentArray = [
        { type: 'text', text: 'First message' },
        { type: 'text', text: 'Second message' },
      ];
      const message = TimbalMessage.from(contentArray);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(2);
      expect(message.content[0]).toEqual({ type: 'text', text: 'First message' });
      expect(message.content[1]).toEqual({ type: 'text', text: 'Second message' });
    });

    test('should handle direct content array with mixed types', () => {
      const contentArray = [
        { type: 'text', text: 'Text content' },
        {
          type: 'tool_use',
          id: 'call_456',
          name: 'search',
          input: { query: 'test' },
        },
      ];
      const message = TimbalMessage.from(contentArray);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(2);
      expect(message.content[0]).toEqual({ type: 'text', text: 'Text content' });
      expect(message.content[1]).toEqual({
        type: 'tool_use',
        id: 'call_456',
        name: 'search',
        input: { query: 'test' },
      });
    });

    test('should handle direct content array with primitive values', () => {
      const contentArray = ['Hello', 42, true];
      const message = TimbalMessage.from(contentArray);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(3);
      expect(message.content[0]).toEqual({ type: 'text', text: 'Hello' });
      expect(message.content[1]).toEqual({ type: 'text', text: '42' });
      expect(message.content[2]).toEqual({ type: 'text', text: 'true' });
    });

    test('should handle random object without role or content', () => {
      const randomObj = { name: 'John', age: 30, active: true };
      const message = TimbalMessage.from(randomObj);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({
        type: 'text',
        text: '{"name":"John","age":30,"active":true}',
      });
    });

    test('should handle object with only role property', () => {
      const objWithRole = { role: 'assistant', someData: 'value' };
      const message = TimbalMessage.from(objWithRole);

      expect(message.role).toBe('assistant');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({
        type: 'text',
        text: '{"role":"assistant","someData":"value"}',
      });
    });

    test('should handle empty object', () => {
      const emptyObj = {};
      const message = TimbalMessage.from(emptyObj);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({ type: 'text', text: '{}' });
    });

    test('should handle nested object structures', () => {
      const nestedObj = {
        user: { id: 123, profile: { name: 'Alice' } },
        metadata: { timestamp: '2024-01-01', tags: ['important'] },
      };
      const message = TimbalMessage.from(nestedObj);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({
        type: 'text',
        text: '{"user":{"id":123,"profile":{"name":"Alice"}},"metadata":{"timestamp":"2024-01-01","tags":["important"]}}',
      });
    });

    test('should handle object with null and undefined values', () => {
      const objWithNulls = {
        nullValue: null,
        undefinedValue: undefined,
        validValue: 'test',
      };
      const message = TimbalMessage.from(objWithNulls);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({
        type: 'text',
        text: '{"nullValue":null,"validValue":"test"}',
      });
    });

    test('should handle object with mixed data types', () => {
      const mixedObj = {
        string: 'hello',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: true },
      };
      const message = TimbalMessage.from(mixedObj);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0]).toEqual({
        type: 'text',
        text: '{"string":"hello","number":42,"boolean":true,"array":[1,2,3],"object":{"nested":true}}',
      });
    });

    test('should handle object with function properties', () => {
      const objWithFunction = {
        name: 'test',
        handler: function () {
          return 'hello';
        },
        arrow: () => 'world',
      };
      const message = TimbalMessage.from(objWithFunction);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      // Functions are omitted in JSON.stringify
      expect(message.content[0]).toEqual({
        type: 'text',
        text: '{"name":"test"}',
      });
    });

    test('should handle object with Date and special objects', () => {
      const date = new Date('2024-01-01T00:00:00Z');
      const objWithDate = {
        timestamp: date,
        regex: /test/g,
        error: new Error('test error'),
      };
      const message = TimbalMessage.from(objWithDate);

      expect(message.role).toBe('user');
      expect(message.content).toHaveLength(1);
      expect(message.content[0].type).toBe('text');
      // Just verify it's a valid JSON string containing the date
      const textContent = message.content[0] as TextContent;
      const parsed = JSON.parse(textContent.text);
      expect(parsed.timestamp).toBe('2024-01-01T00:00:00.000Z');
    });

    test('should handle circular reference objects by throwing error', () => {
      const circularObj: any = { name: 'test' };
      circularObj.self = circularObj;

      // JSON.stringify throws on circular references, which is expected
      expect(() => {
        TimbalMessage.from(circularObj);
      }).toThrow('JSON.stringify cannot serialize cyclic structures');
    });
  });

  describe('collectText()', () => {
    test('should collect text from text content', () => {
      const message = new TimbalMessage('user', [
        { type: 'text', text: 'First part' },
        { type: 'text', text: 'Second part' },
      ]);

      const collected = message.collectText();
      expect(collected).toBe('First part\n\nSecond part\n\n');
    });

    test('should ignore non-text content', () => {
      const message = new TimbalMessage('user', [
        { type: 'text', text: 'Text content' },
        {
          type: 'tool_use',
          id: 'call_123',
          name: 'analyze',
          input: {},
        },
      ]);

      const collected = message.collectText();
      expect(collected).toBe('Text content\n\n');
    });

    test('should return empty string when no text content', () => {
      const message = new TimbalMessage('user', [
        {
          type: 'tool_use',
          id: 'call_123',
          name: 'analyze',
          input: {},
        },
      ]);

      const collected = message.collectText();
      expect(collected).toBe('');
    });
  });
});

describe('MessageContentFactory.from()', () => {
  test('should return content as-is if it already has type', () => {
    const content: TextContent = { type: 'text', text: 'hello' };
    const result = MessageContentFactory.from(content);

    expect(result).toBe(content);
  });

  test('should convert string to text content', () => {
    const result = MessageContentFactory.from('Hello world');

    expect(result).toEqual({ type: 'text', text: 'Hello world' });
  });

  test('should handle text content object', () => {
    const result = MessageContentFactory.from({
      type: 'text',
      text: 'Hello world',
    });

    expect(result).toEqual({ type: 'text', text: 'Hello world' });
  });

  test('should handle thinking content object', () => {
    const result = MessageContentFactory.from({
      type: 'thinking',
      thinking: 'Let me think...',
    });

    expect(result).toEqual({ type: 'thinking', thinking: 'Let me think...' });
  });

  test('should handle tool use content object', () => {
    const result = MessageContentFactory.from({
      type: 'tool_use',
      id: 'call_123',
      name: 'analyze',
      input: { data: 'test' },
    });

    expect(result).toEqual({
      type: 'tool_use',
      id: 'call_123',
      name: 'analyze',
      input: { data: 'test' },
    });
  });

  test('should handle tool result content object', () => {
    const result = MessageContentFactory.from({
      type: 'tool_result',
      id: 'call_123',
      content: [{ type: 'text', text: 'Result' }],
    });

    expect(result).toEqual({
      type: 'tool_result',
      id: 'call_123',
      content: [{ type: 'text', text: 'Result' }],
    });
  });

  test('should handle tool result with single content item', () => {
    const result = MessageContentFactory.from({
      type: 'tool_result',
      id: 'call_123',
      content: { type: 'text', text: 'Single result' },
    });

    expect(result).toEqual({
      type: 'tool_result',
      id: 'call_123',
      content: [{ type: 'text', text: 'Single result' }],
    });
  });

  test('should handle tool result with thinking content', () => {
    const result = MessageContentFactory.from({
      type: 'tool_result',
      id: 'call_123',
      content: [
        { type: 'thinking', thinking: 'Processing...' },
        { type: 'text', text: 'Done!' },
      ],
    });

    expect(result).toEqual({
      type: 'tool_result',
      id: 'call_123',
      content: [
        { type: 'thinking', thinking: 'Processing...' },
        { type: 'text', text: 'Done!' },
      ],
    });
  });

  test('should handle file content object', () => {
    const fileUrl = 'https://example.com/file.txt';
    const result = MessageContentFactory.from({
      type: 'file',
      file: fileUrl,
    });

    expect(result).toEqual({
      type: 'file',
      file: fileUrl,
    });
  });

  test('should convert unknown objects to text', () => {
    const result = MessageContentFactory.from({ some: 'object', without: 'type' });

    expect(result).toEqual({
      type: 'text',
      text: '{"some":"object","without":"type"}',
    });
  });

  test('should convert numbers to text', () => {
    const result = MessageContentFactory.from(42);

    expect(result).toEqual({ type: 'text', text: '42' });
  });

  test('should convert booleans to text', () => {
    const result = MessageContentFactory.from(true);

    expect(result).toEqual({ type: 'text', text: 'true' });
  });
});
