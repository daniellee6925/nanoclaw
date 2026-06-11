/**
 * Tests for single-active-session enforcement + schedule carry-over.
 *
 * The bug these guard against: a channel's session was replaced (prompt
 * redeploy spawned a fresh session), the old session was marked `ended`, and
 * its recurring tick schedule — which lives only in the old session's
 * inbound.db — was stranded where the host sweep never looks. Days of silent
 * missed ticks. Supersede must move the schedule with the channel.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Override DATA_DIR so per-session inbound.db files land in /tmp, not ./data.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-supersede-test' };
});
// Prevent any Docker side effects pulled in transitively.
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { createSession, getSession, getActiveSessions } from './db/sessions.js';
import { initSessionFolder, inboundDbPath } from './session-manager.js';
import { openInboundDb } from './db/session-db.js';
import { insertTask, getLiveRecurring } from './modules/scheduling/db.js';
import { migrateRecurringSchedule, supersedeSession, reconcileChannelSessions } from './session-supersede.js';

const TEST_DIR = '/tmp/nanoclaw-supersede-test';

function now() {
  return new Date().toISOString();
}

/** Seed a recurring task directly into a session's inbound.db. */
function seedRecurringTask(agentGroupId: string, sessionId: string, taskId: string, processAfter: string) {
  const db = openInboundDb(inboundDbPath(agentGroupId, sessionId));
  try {
    insertTask(db, {
      id: taskId,
      processAfter,
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'Read tick-morning-prompt.md', script: null }),
    });
  } finally {
    db.close();
  }
}

function liveRecurring(agentGroupId: string, sessionId: string) {
  const db = openInboundDb(inboundDbPath(agentGroupId, sessionId));
  try {
    return getLiveRecurring(db);
  } finally {
    db.close();
  }
}

function makeSession(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: createdAt,
    ...overrides,
  });
  initSessionFolder('ag-1', id);
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Telos', folder: 'telos', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-work',
    name: 'work',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateRecurringSchedule', () => {
  it('moves a live recurring schedule into the target, preserving series/recurrence/next-fire', () => {
    makeSession('sess-old', now());
    makeSession('sess-new', now());
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');

    const migrated = migrateRecurringSchedule('ag-1', 'sess-old', 'ag-1', 'sess-new');
    expect(migrated).toBe(1);

    const target = liveRecurring('ag-1', 'sess-new');
    expect(target).toHaveLength(1);
    expect(target[0].series_id).toBe('task-morn');
    expect(target[0].recurrence).toBe('0 9 * * *');
    expect(target[0].process_after).toBe('2026-06-12T16:00:00.000Z');
    expect(target[0].status).toBe('pending');
  });

  it('retires the source rows so the schedule cannot fire from the dead session', () => {
    makeSession('sess-old', now());
    makeSession('sess-new', now());
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');

    migrateRecurringSchedule('ag-1', 'sess-old', 'ag-1', 'sess-new');

    expect(liveRecurring('ag-1', 'sess-old')).toHaveLength(0);
  });

  it('is idempotent — re-running migrates nothing and never duplicates', () => {
    makeSession('sess-old', now());
    makeSession('sess-new', now());
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');

    expect(migrateRecurringSchedule('ag-1', 'sess-old', 'ag-1', 'sess-new')).toBe(1);
    expect(migrateRecurringSchedule('ag-1', 'sess-old', 'ag-1', 'sess-new')).toBe(0);
    expect(liveRecurring('ag-1', 'sess-new')).toHaveLength(1);
  });

  it('skips a series the target already drives', () => {
    makeSession('sess-old', now());
    makeSession('sess-new', now());
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');
    seedRecurringTask('ag-1', 'sess-new', 'task-morn', '2026-06-12T16:00:00.000Z');

    expect(migrateRecurringSchedule('ag-1', 'sess-old', 'ag-1', 'sess-new')).toBe(0);
    expect(liveRecurring('ag-1', 'sess-new')).toHaveLength(1);
  });

  it('returns 0 when source and target are the same session', () => {
    makeSession('sess-old', now());
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');
    expect(migrateRecurringSchedule('ag-1', 'sess-old', 'ag-1', 'sess-old')).toBe(0);
  });

  it('returns 0 when the source session has no inbound.db (nothing to migrate)', () => {
    makeSession('sess-new', now());
    expect(migrateRecurringSchedule('ag-1', 'sess-ghost', 'ag-1', 'sess-new')).toBe(0);
  });

  it('throws rather than stranding a live schedule when the target inbound.db is missing', () => {
    makeSession('sess-old', now());
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');
    // sess-ghost has no folder/inbound.db — migrating into it would lose the schedule.
    expect(() => migrateRecurringSchedule('ag-1', 'sess-old', 'ag-1', 'sess-ghost')).toThrow(
      /target inbound.db missing/,
    );
    // Source schedule must be untouched — not retired.
    expect(liveRecurring('ag-1', 'sess-old')).toHaveLength(1);
  });
});

describe('supersedeSession', () => {
  it('ends the old session and carries its schedule to the survivor', () => {
    makeSession('sess-old', '2026-06-08T00:00:00.000Z');
    makeSession('sess-new', '2026-06-09T00:00:00.000Z');
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');

    const migrated = supersedeSession(getSession('sess-old')!, 'sess-new', 'ag-1');

    expect(migrated).toBe(1);
    expect(getSession('sess-old')!.status).toBe('closed');
    expect(getSession('sess-new')!.status).toBe('active');
    expect(liveRecurring('ag-1', 'sess-new')).toHaveLength(1);
  });

  it('does NOT close the old session if its schedule cannot be carried (target missing)', () => {
    makeSession('sess-old', now());
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');
    // Target session id has no folder — supersede must abort, not strand the schedule.
    expect(() => supersedeSession(getSession('sess-old')!, 'sess-ghost', 'ag-1')).toThrow();
    expect(getSession('sess-old')!.status).toBe('active');
    expect(liveRecurring('ag-1', 'sess-old')).toHaveLength(1);
  });
});

describe('reconcileChannelSessions', () => {
  it('collapses two active sessions for one channel, keeping the newest and moving the schedule', () => {
    makeSession('sess-old', '2026-06-08T00:00:00.000Z');
    makeSession('sess-new', '2026-06-09T00:00:00.000Z');
    seedRecurringTask('ag-1', 'sess-old', 'task-morn', '2026-06-12T16:00:00.000Z');

    const result = reconcileChannelSessions();

    expect(result.duplicateChannels).toBe(1);
    expect(result.superseded).toBe(1);
    expect(result.migrated).toBe(1);

    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('sess-new');
    expect(liveRecurring('ag-1', 'sess-new')).toHaveLength(1);
    expect(getSession('sess-old')!.status).toBe('closed');
  });

  it('is a no-op when each channel has a single active session', () => {
    makeSession('sess-solo', now());
    const result = reconcileChannelSessions();
    expect(result).toEqual({ duplicateChannels: 0, superseded: 0, migrated: 0 });
    expect(getActiveSessions()).toHaveLength(1);
  });
});
