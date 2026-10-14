import { describe, it, expect } from 'bun:test';

import { assistantText } from './claude.js';

describe('assistantText', () => {
  it('joins the text blocks of a top-level assistant message, skipping tool calls', () => {
    const message = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: 'Mechanism right.' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: {} },
          { type: 'text', text: 'Next question.' },
        ],
      },
    };
    expect(assistantText(message)).toBe('Mechanism right.\n\nNext question.');
  });

  it('ignores subagent messages — their text was never meant for the user', () => {
    const message = {
      type: 'assistant',
      parent_tool_use_id: 'toolu_123',
      message: { content: [{ type: 'text', text: 'subagent notes' }] },
    };
    expect(assistantText(message)).toBe('');
  });

  it('returns empty for non-assistant or text-less messages', () => {
    expect(assistantText({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })).toBe('');
    expect(assistantText({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '…' }] } })).toBe('');
  });
});
