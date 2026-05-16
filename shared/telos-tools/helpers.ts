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
// Post 2026-05-08 reorg: tasks/ is split into 4 sibling dirs.
export const PROPOSALS_DIR = path.join(TASKS_DIR, 'proposals');
export const TASKS_FILES_DIR = path.join(TASKS_DIR, 'tasks');
export const LEARN_DIR = path.join(TASKS_DIR, 'learn');
export const CURRICULA_DIR = path.join(LEARN_DIR, 'curricula');
export const REMINDERS_DIR = path.join(TASKS_DIR, 'reminders');
export const EVIDENCE_DIR = path.join(CONSTANTIA_PATH, 'evidence');
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

// Generic next-ID generator — scans `dir` for files matching `${prefix}-NNN.md`
// and returns the next id. Idempotent: max+1 always; never reuses.
async function nextId(dir: string, prefix: string): Promise<string> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (e) {
    // ENOENT: dir doesn't exist yet (legitimate empty case — e.g., fresh
    // proposals/ before any T-### lands). Anything else (EACCES, EIO,
    // EPERM) is a real failure that must NOT silently produce prefix-001
    // collisions with existing files we couldn't read.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    files = [];
  }
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d{3})\\.md$`);
  for (const f of files) {
    const m = f.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export async function nextProposalId(): Promise<string> {
  return nextId(PROPOSALS_DIR, 'T');
}

export async function nextTaskId(): Promise<string> {
  return nextId(TASKS_FILES_DIR, 'P');
}

export async function nextLearnId(): Promise<string> {
  return nextId(LEARN_DIR, 'L');
}

export async function nextReminderId(): Promise<string> {
  return nextId(REMINDERS_DIR, 'R');
}

export async function nextEvidenceId(): Promise<string> {
  return nextId(EVIDENCE_DIR, 'EVD');
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
  committed: true;
}

/**
 * Stage the given paths, commit with the given message. Push is owned by the
 * host-side constantia-sync daemon (launchd job) — see ADR-024.
 *
 * `paths` must be the specific files this caller wrote (`-A` semantics within
 * each path, so deletions and additions both stage). Passing an empty array
 * is intentional only for "no file change, just record a commit object" cases
 * — almost certainly a caller bug otherwise.
 */
export async function commitOnly(
  message: string,
  paths: string[],
): Promise<CommitResult> {
  await ensureGitConfig();
  if (paths.length > 0) {
    await exec('git', ['add', '-A', '--', ...paths]);
  }
  await exec('git', ['commit', '-m', message]);
  const { stdout: sha } = await exec('git', ['rev-parse', 'HEAD']);
  return { sha, committed: true };
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
  return `${headline}\nCommit: ${result.sha}\nCommitted locally; constantia-sync daemon will push within 5s.`;
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
