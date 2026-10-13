import { describe, expect, it } from 'vitest';

import { containerLogLevel, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('containerLogLevel', () => {
  it('promotes container WARN: lines so they reach the host error log', () => {
    expect(
      containerLogLevel('[poll-loop] WARN: turn ended with no outbound message for chat m1 — text written before…'),
    ).toBe('warn');
  });

  it('keeps ordinary container output at debug', () => {
    expect(containerLogLevel('[poll-loop] Processing 1 message(s), kinds: chat-sdk')).toBe('debug');
    expect(containerLogLevel('[poll-loop] Result: (empty)')).toBe('debug');
  });
});
