import { describe, expect, it } from 'vitest';

import { bareDiscordLinks } from './format-links.js';

describe('bareDiscordLinks', () => {
  it('rewrites a masked link to "label: url"', () => {
    expect(bareDiscordLinks('see [the PR](https://github.com/x/y/pull/1) now')).toBe(
      'see the PR: https://github.com/x/y/pull/1 now',
    );
  });

  it('emits a bare url when the label is empty', () => {
    expect(bareDiscordLinks('[](https://example.com)')).toBe('https://example.com');
  });

  it('emits a bare url when the label already equals the url', () => {
    expect(bareDiscordLinks('[https://example.com](https://example.com)')).toBe('https://example.com');
  });

  it('strips the leading "!" of an image link', () => {
    expect(bareDiscordLinks('![chart](https://example.com/c.png)')).toBe('chart: https://example.com/c.png');
  });

  it('rewrites multiple links in one string', () => {
    expect(bareDiscordLinks('[a](https://a.com) and [b](https://b.com)')).toBe('a: https://a.com and b: https://b.com');
  });

  it('leaves already-bare urls untouched', () => {
    expect(bareDiscordLinks('visit https://example.com today')).toBe('visit https://example.com today');
  });

  it('ignores non-http targets (anchors, relative, numeric)', () => {
    expect(bareDiscordLinks('[ref](#section)')).toBe('[ref](#section)');
    expect(bareDiscordLinks('[note](./doc.md)')).toBe('[note](./doc.md)');
    expect(bareDiscordLinks('arr[0](1)')).toBe('arr[0](1)');
  });

  it('does not touch a link inside an inline code span', () => {
    expect(bareDiscordLinks('use `[x](https://y.com)` literally')).toBe('use `[x](https://y.com)` literally');
  });

  it('does not touch a link inside a fenced code block', () => {
    const input = 'before\n```\n[x](https://y.com)\n```\nafter';
    expect(bareDiscordLinks(input)).toBe(input);
  });

  it('rewrites a link outside code while preserving a link inside code', () => {
    expect(bareDiscordLinks('[real](https://r.com) but `[fake](https://f.com)`')).toBe(
      'real: https://r.com but `[fake](https://f.com)`',
    );
  });

  it('returns text with no masked links unchanged (fast path)', () => {
    expect(bareDiscordLinks('plain text, no links here')).toBe('plain text, no links here');
  });

  it('handles empty string', () => {
    expect(bareDiscordLinks('')).toBe('');
  });

  it('is idempotent — running twice equals running once', () => {
    const input = 'see [the PR](https://github.com/x/y/pull/1) and `[code](https://c.com)`';
    const once = bareDiscordLinks(input);
    expect(bareDiscordLinks(once)).toBe(once);
  });
});
