import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

// Every loop a test starts is stopped — and awaited — before the DB closes.
// Abandoning a running loop let its follow-up poll timer fire after
// closeSessionDb(), throwing "unable to open database file" between tests.
afterEach(async () => {
  await Promise.all(running.splice(0).map((loop) => loop.stop()));
  closeSessionDb();
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const loop = startLoop(provider, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    await loop.stop();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const loop = startLoop(provider, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    await loop.stop();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const loop = startLoop(provider, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    await loop.stop();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

  });
});

describe('poll loop lifecycle', () => {
  it('resolves once its signal is aborted, so nothing touches the DB after teardown', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hi' }, { platformId: 'chan-1', channelType: 'discord' });
    const loop = startLoop(new MockProvider({}, () => 'hello'), 3000);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);

    const exited = await Promise.race([loop.stop().then(() => 'exited'), sleep(2500).then(() => 'still running')]);
    expect(exited).toBe('exited');
  });
});

describe('no-reply warning', () => {
  it('warns when a chat turn ends without any outbound message', async () => {
    const errors = spyOn(console, 'error');
    try {
      insertMessage('m-silent', { sender: 'Daniel', text: '81' }, { platformId: 'chan-1', channelType: 'discord' });
      // Empty result text: the reply was written before a tool call and dropped.
      const loop = startLoop(new MockProvider({}, () => ''), 3000);

      const warned = () => errors.mock.calls.some((c) => String(c[0]).includes('WARN:') && String(c[0]).includes('m-silent'));
      await waitFor(warned, 2000);
      await loop.stop();
    } finally {
      errors.mockRestore();
    }
  });

  it('warns for a follow-up pushed into a warm query whose reply is dropped (the 2026-10-13 incident)', async () => {
    const errors = spyOn(console, 'error');
    try {
      insertMessage('m-first', { sender: 'Daniel', text: 'question' }, { platformId: 'chan-1', channelType: 'discord' });
      // Replies to the first message; returns no text for the follow-up.
      const loop = startLoop(new MockProvider({}, (prompt) => (prompt.includes('follow-up') ? '' : 'answer')), 3000);
      await waitFor(() => getUndeliveredMessages().length > 0, 2000);

      insertMessage('m-followup', { sender: 'Daniel', text: 'follow-up' }, { platformId: 'chan-1', channelType: 'discord' });
      const warnings = () => errors.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('WARN:'));
      await waitFor(() => warnings().some((line) => line.includes('m-followup')), 2000);
      expect(warnings().some((line) => line.includes('m-first'))).toBe(false);
      await loop.stop();
    } finally {
      errors.mockRestore();
    }
  });

  it('does not warn when the turn delivers a reply', async () => {
    const errors = spyOn(console, 'error');
    try {
      insertMessage('m-ok', { sender: 'Daniel', text: '80' }, { platformId: 'chan-1', channelType: 'discord' });
      const loop = startLoop(new MockProvider({}, () => 'Correct.'), 3000);

      await waitFor(() => getUndeliveredMessages().length > 0, 2000);
      await sleep(100);
      await loop.stop();
      expect(errors.mock.calls.some((c) => String(c[0]).includes('WARN:'))).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('reply fallback', () => {
  const texts = () => getUndeliveredMessages().map((m) => JSON.parse(m.content).text as string);

  it('delivers the last reply text when a chat turn would otherwise send nothing (2026-10-13 incident)', async () => {
    const errors = spyOn(console, 'error');
    try {
      insertMessage('m-answer', { sender: 'Daniel', text: 'lower temp, tiny nucleus' }, { platformId: 'chan-1', channelType: 'discord' });
      // Reply written, then memory edits (tool calls), then only an internal note.
      const loop = startLoop(
        new MockProvider({}, () => ({ texts: ['Mechanism right. The randomness claim is wrong.'], result: '<internal>verdict logged</internal>' })),
        3000,
      );
      await waitFor(() => texts().length > 0, 2000);
      await sleep(100);
      await loop.stop();

      expect(texts()).toEqual(['Mechanism right. The randomness claim is wrong.']);
      expect(errors.mock.calls.some((c) => String(c[0]).includes('WARN:') && String(c[0]).includes('fallback'))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it('uses the last text block, not an earlier one', async () => {
    insertMessage('m-81', { sender: 'Daniel', text: '81' }, { platformId: 'chan-1', channelType: 'discord' });
    const loop = startLoop(new MockProvider({}, () => ({ texts: ['81 is right.', 'Correction: it is 80.'], result: '' })), 3000);
    await waitFor(() => texts().length > 0, 2000);
    await sleep(100);
    await loop.stop();
    expect(texts()).toEqual(['Correction: it is 80.']);
  });

  it('sends no fallback when the final text was delivered', async () => {
    insertMessage('m-ok', { sender: 'Daniel', text: 'q' }, { platformId: 'chan-1', channelType: 'discord' });
    const loop = startLoop(new MockProvider({}, () => ({ texts: ['scratch thought'], result: 'Final answer.' })), 3000);
    await waitFor(() => texts().length > 0, 2000);
    await sleep(100);
    await loop.stop();
    expect(texts()).toEqual(['Final answer.']);
  });

  it('never sends a fallback for a scheduled task turn', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES ('t-tick', 'task', datetime('now'), 'pending', 'chan-1', 'discord', NULL, ?)`,
      )
      .run(JSON.stringify({ prompt: 'run the tick', script: null }));
    let seen = false;
    const loop = startLoop(
      new MockProvider({}, () => {
        seen = true;
        return { texts: ['tick scratch work'], result: '<internal>done</internal>' };
      }),
      3000,
    );
    await waitFor(() => seen, 2000);
    await sleep(150);
    await loop.stop();
    expect(texts()).toEqual([]);
  });
});

interface RunningLoop {
  stop(): Promise<void>;
}
const running: RunningLoop[] = [];

// Start the real poll loop with an abort signal. stop() aborts and waits for
// runPollLoop to actually return; timeoutMs is a safety net for hung tests.
function startLoop(provider: MockProvider, timeoutMs: number): RunningLoop {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), timeoutMs);
  const done = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal }).finally(() => clearTimeout(safety));
  const loop = {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
  running.push(loop);
  return loop;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
