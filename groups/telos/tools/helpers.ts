/**
 * Telos-Constantia helpers.
 *
 * Pure utilities used by mcp-server.ts: time, process spawn, frontmatter
 * parsing/serializing, atomic write, git config, commit+push, tool-response
 * shape, transcript message helpers.
 *
 * Deterministic logic — no behavior, no tool-handler state. Side effects are
 * narrow (file I/O, git subprocess) and signaled by the function name.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ---- Constants -------------------------------------------------------------

export const CONSTANTIA_PATH = '/workspace/extra/constantia';
export const TASKS_DIR = path.join(CONSTANTIA_PATH, 'tasks');
export const LOG_DIR = path.join(CONSTANTIA_PATH, 'log');
export const TELOS_LOG_DIR = path.join(LOG_DIR, 'telos');
export const SESSION_DIR = '/workspace/extra/telos-session';
export const TIMEZONE = 'America/Los_Angeles';

// ---- Time ------------------------------------------------------------------

export interface TimeNow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
}

export function nowPT(): TimeNow {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

export function ptDateOf(utcIso: string): string {
  const d = new Date(utcIso);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

export function shiftDate(yyyymmdd: string, days: number): string {
  const d = new Date(`${yyyymmdd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- Process ---------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export async function exec(
  cmd: string,
  args: string[],
  cwd: string = CONSTANTIA_PATH,
): Promise<ExecResult> {
  // @ts-expect-error Bun global is provided by the runtime
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}: exit ${code}\nstderr: ${stderr.trim()}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ---- Frontmatter -----------------------------------------------------------

export type Frontmatter = Record<string, string | null>;

export interface ParsedFile {
  fm: Frontmatter;
  body: string;
}

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === '') {
      lines.push(`${k}:`);
    } else if (v.includes(':') || v.includes('\n') || v.includes('"')) {
      // Quote when value could be misparsed by a YAML reader.
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

export function parseFrontmatter(text: string): ParsedFile {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter found at start of file');
  const fmText = match[1];
  const body = match[2];
  const fm: Frontmatter = {};
  for (const line of fmText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val === '') {
      fm[key] = null;
    } else if (val.startsWith('"') && val.endsWith('"')) {
      try {
        fm[key] = JSON.parse(val);
      } catch {
        fm[key] = val;
      }
    } else {
      fm[key] = val;
    }
  }
  return { fm, body };
}

// ---- Files -----------------------------------------------------------------

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  // Atomic write: write to .tmp, then rename. Rename is atomic on POSIX, so
  // a process kill mid-write leaves either the old file intact or the new
  // file complete — never a half-written target.
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export async function nextTaskId(): Promise<string> {
  const files = await fs.readdir(TASKS_DIR);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^TASK-(\d{3})\.md$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `TASK-${String(max + 1).padStart(3, '0')}`;
}

// ---- Git -------------------------------------------------------------------

let gitConfigDone = false;

export async function ensureGitConfig(): Promise<void> {
  if (gitConfigDone) return;
  // --local writes to .git/config of the constantia repo only.
  await exec('git', ['config', '--local', 'user.name', 'Telos']);
  await exec('git', ['config', '--local', 'user.email', 'telos@guya']);
  gitConfigDone = true;
}

export interface CommitResult {
  sha: string;
  pushed: boolean;
  pushError?: string;
}

export async function commitAndPush(message: string): Promise<CommitResult> {
  await ensureGitConfig();
  await exec('git', ['add', '-A']);
  await exec('git', ['commit', '-m', message]);
  const { stdout: sha } = await exec('git', ['rev-parse', 'HEAD']);
  try {
    await exec('git', ['push', 'origin', 'main']);
    return { sha, pushed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sha, pushed: false, pushError: msg.slice(0, 500) };
  }
}

// ---- Tool response shape ---------------------------------------------------

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function ok(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

export function err(text: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

export function formatResult(headline: string, result: CommitResult): string {
  let out = `${headline}\nCommit: ${result.sha}\nPushed: ${result.pushed}`;
  if (!result.pushed && result.pushError) out += `\nPush error: ${result.pushError}`;
  return out;
}

// ---- Transcript helpers ----------------------------------------------------

export interface DBRow {
  timestamp: string;
  kind: string;
  content: string;
}

export interface ParsedMsg {
  direction: 'in' | 'out';
  timestamp: string;
  text: string;
}

export function extractText(jsonContent: string): string {
  try {
    const parsed = JSON.parse(jsonContent);
    if (typeof parsed?.text === 'string') return parsed.text;
    if (typeof parsed === 'string') return parsed;
    return JSON.stringify(parsed).slice(0, 500);
  } catch {
    return jsonContent.slice(0, 500);
  }
}
