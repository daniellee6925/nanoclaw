import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

function addDestination(name: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ($name, $name, 'channel', 'discord', $platformId, NULL)`,
    )
    .run({ $name: name, $platformId: `chan-${name}` });
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

// Only a turn's final text (the `result` event) is dispatched — text written
// before or between tool calls never leaves the container. Agents that reply
// first and then use tools (e.g. to update notes) silently lose the reply
// unless the prompt says so. Regression: Telos's 2026-10-13 L1 correction.
describe('sending-messages prompt states the final-text delivery rule', () => {
  it('single destination: says only text after the last tool call is delivered', () => {
    addDestination('discord-test');
    const prompt = buildSystemPromptAddendum();
    expect(prompt).toContain('after your last tool call');
    expect(prompt).toContain('send_message');
  });

  it('multiple destinations: says <message> blocks are only read from the final text', () => {
    addDestination('discord-a');
    addDestination('discord-b');
    const prompt = buildSystemPromptAddendum();
    expect(prompt).toContain('after your last tool call');
  });
});
