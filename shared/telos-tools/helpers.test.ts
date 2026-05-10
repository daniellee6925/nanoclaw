/**
 * Unit tests for helpers.ts pure functions.
 *
 * Phase 1: pure functions only (no file I/O, no git, no subprocess). These
 * are the highest-leverage tests — round-trip parsers, date arithmetic,
 * tool-response shapes — because they're the most refactor-fragile code.
 *
 * File I/O (writeAtomic, nextTaskId) and git integration (commitAndPush
 * with its four error paths) are intentionally out of scope here. They
 * need temp dirs / temp git repos and belong in a Phase 2 test file when
 * the debt becomes painful.
 *
 * Run: cd shared/telos-tools && bun test helpers.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  serializeFrontmatter,
  parseFrontmatter,
  shiftDate,
  ptDateOf,
  extractText,
  ok,
  err,
  formatResult,
} from './helpers';

describe('serializeFrontmatter', () => {
  test('basic key-value pairs', () => {
    expect(serializeFrontmatter({ a: '1', b: '2' })).toBe('---\na: 1\nb: 2\n---');
  });

  test('null value emits bare key', () => {
    expect(serializeFrontmatter({ a: null })).toBe('---\na:\n---');
  });

  test('empty string emits bare key (matches null behavior)', () => {
    expect(serializeFrontmatter({ a: '' })).toBe('---\na:\n---');
  });

  test('value with embedded colon is quoted to survive YAML readers', () => {
    expect(serializeFrontmatter({ a: 'foo: bar' })).toBe('---\na: "foo: bar"\n---');
  });

  test('value with newline is quoted', () => {
    expect(serializeFrontmatter({ a: 'line1\nline2' })).toBe('---\na: "line1\\nline2"\n---');
  });

  test('value with double-quote is quoted and escaped', () => {
    expect(serializeFrontmatter({ a: 'foo "bar"' })).toBe('---\na: "foo \\"bar\\""\n---');
  });

  test('empty frontmatter object yields delimiters only', () => {
    expect(serializeFrontmatter({})).toBe('---\n---');
  });
});

describe('parseFrontmatter', () => {
  test('basic key-value with body', () => {
    const { fm, body } = parseFrontmatter('---\na: 1\nb: 2\n---\nhello world\n');
    expect(fm).toEqual({ a: '1', b: '2' });
    expect(body).toBe('hello world\n');
  });

  test('empty value parses as null', () => {
    const { fm } = parseFrontmatter('---\na:\n---\n');
    expect(fm.a).toBe(null);
  });

  test('quoted value is unquoted via JSON.parse', () => {
    const { fm } = parseFrontmatter('---\na: "foo: bar"\n---\n');
    expect(fm.a).toBe('foo: bar');
  });

  test('quoted value with escaped quote is unquoted', () => {
    const { fm } = parseFrontmatter('---\na: "foo \\"bar\\""\n---\n');
    expect(fm.a).toBe('foo "bar"');
  });

  test('throws clearly when no frontmatter delimiter', () => {
    expect(() => parseFrontmatter('hello world')).toThrow('No frontmatter found');
  });

  test('lines without colon are skipped, not erroneous', () => {
    const { fm } = parseFrontmatter('---\nno_colon_here\na: 1\n---\n');
    expect(fm).toEqual({ a: '1' });
  });

  test('body is empty string when delimiter is at file end', () => {
    const { body } = parseFrontmatter('---\na: 1\n---\n');
    expect(body).toBe('');
  });
});

describe('serialize ↔ parse round-trip', () => {
  test('preserves plain values', () => {
    const original = { id: 'TASK-001', status: 'assigned' };
    const { fm } = parseFrontmatter(serializeFrontmatter(original) + '\n');
    expect(fm).toEqual(original);
  });

  test('preserves values with embedded colons', () => {
    const original = { purpose: 'Has a colon: in it' };
    const { fm } = parseFrontmatter(serializeFrontmatter(original) + '\n');
    expect(fm).toEqual(original);
  });

  test('preserves null values', () => {
    const original = { grade: null, evidence: null };
    const { fm } = parseFrontmatter(serializeFrontmatter(original) + '\n');
    expect(fm).toEqual(original);
  });

  test('mixed null + colon-bearing values survive a cycle', () => {
    const original = {
      id: 'TASK-042',
      purpose: 'Validate jeonghwandaniellee.com/learn URL: an evidence anchor',
      grade: null,
    };
    const { fm } = parseFrontmatter(serializeFrontmatter(original) + '\n');
    expect(fm).toEqual(original);
  });
});

describe('shiftDate', () => {
  test('shift forward by one day', () => {
    expect(shiftDate('2026-05-05', 1)).toBe('2026-05-06');
  });

  test('shift backward by one day', () => {
    expect(shiftDate('2026-05-05', -1)).toBe('2026-05-04');
  });

  test('crosses month boundary forward', () => {
    expect(shiftDate('2026-05-31', 1)).toBe('2026-06-01');
  });

  test('crosses month boundary backward', () => {
    expect(shiftDate('2026-06-01', -1)).toBe('2026-05-31');
  });

  test('crosses year boundary', () => {
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('zero shift is identity', () => {
    expect(shiftDate('2026-05-05', 0)).toBe('2026-05-05');
  });
});

describe('ptDateOf', () => {
  test('UTC midnight maps to previous PT day during PDT', () => {
    // 2026-05-06 00:00 UTC = 2026-05-05 17:00 PDT (UTC-7)
    expect(ptDateOf('2026-05-06T00:00:00.000Z')).toBe('2026-05-05');
  });

  test('UTC noon maps to same PT day during PDT', () => {
    // 2026-05-06 12:00 UTC = 2026-05-06 05:00 PDT
    expect(ptDateOf('2026-05-06T12:00:00.000Z')).toBe('2026-05-06');
  });

  test('UTC during PST (winter) maps correctly', () => {
    // 2026-01-15 09:00 UTC = 2026-01-15 01:00 PST (UTC-8)
    expect(ptDateOf('2026-01-15T09:00:00.000Z')).toBe('2026-01-15');
    // 2026-01-15 07:00 UTC = 2026-01-14 23:00 PST
    expect(ptDateOf('2026-01-15T07:00:00.000Z')).toBe('2026-01-14');
  });

  test('crosses DST spring-forward boundary', () => {
    // 2026-03-08 02:00 PT — the DST transition. Before 2am PST = UTC-8; after 3am PDT = UTC-7.
    // 2026-03-08 09:00 UTC = 2026-03-08 01:00 PST (still on March 8 PT)
    expect(ptDateOf('2026-03-08T09:00:00.000Z')).toBe('2026-03-08');
  });
});

describe('extractText', () => {
  test('object with .text field unwraps to text', () => {
    expect(extractText('{"text":"hello"}')).toBe('hello');
  });

  test('object with .text and other fields prefers .text', () => {
    expect(extractText('{"text":"primary","other":"ignored"}')).toBe('primary');
  });

  test('JSON string value (not an object) returns the string', () => {
    expect(extractText('"just a string"')).toBe('just a string');
  });

  test('object without .text returns stringified JSON', () => {
    expect(extractText('{"foo":"bar"}')).toBe('{"foo":"bar"}');
  });

  test('invalid JSON returns the raw input', () => {
    expect(extractText('not json at all')).toBe('not json at all');
  });

  test('object output is truncated at exactly 500 chars', () => {
    const big = JSON.stringify({ payload: 'x'.repeat(2000) });
    expect(extractText(big)).toHaveLength(500);
  });

  test('raw fallback is truncated at exactly 500 chars', () => {
    const big = 'x'.repeat(2000);
    expect(extractText(big)).toHaveLength(500);
  });
});

describe('ok / err', () => {
  test('ok wraps text in MCP content shape', () => {
    expect(ok('done')).toEqual({ content: [{ type: 'text', text: 'done' }] });
  });

  test('err wraps text with Error: prefix and isError flag', () => {
    expect(err('bad')).toEqual({
      content: [{ type: 'text', text: 'Error: bad' }],
      isError: true,
    });
  });
});

describe('formatResult', () => {
  test('pushed=true emits two lines (no error line)', () => {
    expect(formatResult('headline', { sha: 'abc123', pushed: true })).toBe(
      'headline\nCommit: abc123\nPushed: true',
    );
  });

  test('pushed=false with pushError appends a fourth line', () => {
    expect(
      formatResult('headline', {
        sha: 'abc123',
        pushed: false,
        pushError: 'remote ahead',
      }),
    ).toBe('headline\nCommit: abc123\nPushed: false\nPush error: remote ahead');
  });

  test('pushed=false without pushError omits the error line', () => {
    expect(formatResult('headline', { sha: 'abc123', pushed: false })).toBe(
      'headline\nCommit: abc123\nPushed: false',
    );
  });
});
