/**
 * Telos-Constantia MCP server.
 *
 * Hand-rolled stdio JSON-RPC (no @modelcontextprotocol/sdk dep). Five tools:
 *
 *   - assign_task             create tasks/TASK-NNN.md, commit, push
 *   - accept_proposal         flip proposed→assigned, commit, push
 *   - grade_task              update tasks/TASK-NNN.md to terminal state, commit, push
 *   - do_nothing              log no-op section to today's tick log, commit, push
 *   - write_reflection        nightly synthesized reflection log, commit, push
 *   - read_today_transcript   read user/agent DM transcript from session dbs
 *
 * Action tools (assign_task / grade_task / accept_proposal / do_nothing) all
 * append a section to today's `log/telos/YYYY-MM-DD-tick.md` so the daily trail
 * is symmetric. write_reflection lands at `log/telos/YYYY-MM-DD-reflection.md`.
 *
 * Push failures DO NOT fail the tool — the file write + commit is durable
 * state. The tool returns `pushed: false` so Telos can mention it in its
 * response and Daniel can manually `git push` to recover.
 *
 * Constantia path is hardcoded (`/workspace/extra/constantia`). Single repo.
 * Session db dir is hardcoded (`/workspace/extra/telos-session`) — mounted
 * read-only by container.json so read_today_transcript can read the agent's
 * own message history.
 *
 * Git auth uses the constantia-deploy-key bind-mounted at
 * `/workspace/extra/ssh-key/constantia-deploy-key`. GIT_SSH_COMMAND is set
 * via container.json mcpServers env so git push uses the deploy key.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
// @ts-expect-error bun:sqlite is provided by the Bun runtime
import { Database } from 'bun:sqlite';

const CONSTANTIA_PATH = '/workspace/extra/constantia';
const TASKS_DIR = path.join(CONSTANTIA_PATH, 'tasks');
const LOG_DIR = path.join(CONSTANTIA_PATH, 'log');
const TELOS_LOG_DIR = path.join(LOG_DIR, 'telos');
const SESSION_DIR = '/workspace/extra/telos-session';
const TIMEZONE = 'America/Los_Angeles';

// ---- Helpers ----------------------------------------------------------------

interface TimeNow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
}

function nowPT(): TimeNow {
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

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function exec(cmd: string, args: string[], cwd: string = CONSTANTIA_PATH): Promise<ExecResult> {
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

type Frontmatter = Record<string, string | null>;

function serializeFrontmatter(fm: Frontmatter): string {
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

interface ParsedFile {
  fm: Frontmatter;
  body: string;
}

function parseFrontmatter(text: string): ParsedFile {
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

async function writeAtomic(filePath: string, content: string): Promise<void> {
  // Atomic write: write to .tmp, then rename. Rename is atomic on POSIX, so
  // a process kill mid-write leaves either the old file intact or the new
  // file complete — never a half-written target.
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

async function nextTaskId(): Promise<string> {
  const files = await fs.readdir(TASKS_DIR);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^TASK-(\d{3})\.md$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `TASK-${String(max + 1).padStart(3, '0')}`;
}

let gitConfigDone = false;

async function ensureGitConfig(): Promise<void> {
  if (gitConfigDone) return;
  // --local writes to .git/config of the constantia repo only.
  await exec('git', ['config', '--local', 'user.name', 'Telos']);
  await exec('git', ['config', '--local', 'user.email', 'telos@guya']);
  gitConfigDone = true;
}

interface CommitResult {
  sha: string;
  pushed: boolean;
  pushError?: string;
}

async function commitAndPush(message: string): Promise<CommitResult> {
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

// ---- Tool handlers ----------------------------------------------------------

interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

interface AssignTaskArgs {
  pillar: number | 'none';
  priority: 'P1' | 'P2' | 'P3';
  purpose: string;
  acceptance: string;
  context: string;
}

async function assignTask(args: AssignTaskArgs): Promise<ToolResponse> {
  if (args.pillar !== 'none' && ![1, 2, 3].includes(args.pillar as number)) {
    return err('pillar must be 1, 2, 3, or "none"');
  }
  if (!['P1', 'P2', 'P3'].includes(args.priority)) {
    return err('priority must be P1, P2, or P3');
  }
  if (!args.purpose || args.purpose.length < 10) return err('purpose must be ≥10 chars');
  if (!args.acceptance || args.acceptance.length < 10) return err('acceptance must be ≥10 chars');

  const id = await nextTaskId();
  const { date } = nowPT();

  const fm: Frontmatter = {
    id,
    status: 'assigned',
    pillar: String(args.pillar),
    priority: args.priority,
    assigned: date,
    assigned_by: 'telos',
    proposed_by: 'telos',
    purpose: args.purpose,
    acceptance: args.acceptance,
    grade: null,
    grade_evidence: null,
    rejection_reason: null,
  };

  const body = `\n\n## Context\n\n${args.context}\n`;
  const filePath = path.join(TASKS_DIR, `${id}.md`);
  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const headline = args.purpose.split('\n')[0].slice(0, 60);
  await appendTickLogSection(
    'assign_task',
    `**Pillar:** ${args.pillar}\n**Priority:** ${args.priority}\n**Purpose:** ${headline}\n**Acceptance:** ${args.acceptance.split('\n')[0].slice(0, 100)}`,
    id,
  );
  const result = await commitAndPush(`task(assign): ${id} — ${headline}`);
  return ok(formatResult(`Created ${id} (pillar ${args.pillar}, ${args.priority})`, result));
}

interface GradeTaskArgs {
  task_id: string;
  outcome: 'graded' | 'rejected';
  grade?: 'A' | 'B' | 'C';
  grade_evidence?: string;
  rejection_reason?: string;
}

async function gradeTask(args: GradeTaskArgs): Promise<ToolResponse> {
  if (!/^TASK-\d{3}$/.test(args.task_id)) return err('task_id must match TASK-NNN');
  if (args.outcome !== 'graded' && args.outcome !== 'rejected') {
    return err('outcome must be "graded" or "rejected"');
  }
  if (args.outcome === 'graded') {
    if (!['A', 'B', 'C'].includes(args.grade ?? '')) {
      return err('grade must be A, B, or C when outcome=graded');
    }
    if (!args.grade_evidence || args.grade_evidence.length < 10) {
      return err('grade_evidence must be ≥10 chars when outcome=graded');
    }
  } else {
    if (!args.rejection_reason || args.rejection_reason.length < 10) {
      return err('rejection_reason must be ≥10 chars when outcome=rejected');
    }
  }

  const filePath = path.join(TASKS_DIR, `${args.task_id}.md`);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return err(`Task ${args.task_id} not found at ${filePath}`);
  }

  const { fm, body } = parseFrontmatter(content);
  if (fm.status === 'graded' || fm.status === 'rejected') {
    return err(`Task ${args.task_id} is already in terminal state: ${fm.status}`);
  }

  fm.status = args.outcome;
  if (args.outcome === 'graded') {
    fm.grade = args.grade!;
    fm.grade_evidence = args.grade_evidence!;
  } else {
    fm.rejection_reason = args.rejection_reason!;
  }

  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const summary =
    args.outcome === 'graded'
      ? args.grade!
      : args.rejection_reason!.split('\n')[0].slice(0, 50);
  const logBody =
    args.outcome === 'graded'
      ? `**Outcome:** graded ${args.grade}\n**Evidence:** ${args.grade_evidence!.split('\n')[0].slice(0, 200)}`
      : `**Outcome:** rejected\n**Reason:** ${args.rejection_reason!.split('\n')[0].slice(0, 200)}`;
  await appendTickLogSection(`grade_task (${args.outcome})`, logBody, args.task_id);
  const result = await commitAndPush(`task(${args.outcome}): ${args.task_id} — ${summary}`);
  const headline = `${args.task_id} ${args.outcome}${args.outcome === 'graded' ? ` (${args.grade})` : ''}`;
  return ok(formatResult(headline, result));
}

interface AcceptProposalArgs {
  task_id: string;
  priority: 'P1' | 'P2' | 'P3';
  pillar?: number | 'none';
  purpose?: string;
  acceptance?: string;
  context_addition?: string;
}

async function acceptProposal(args: AcceptProposalArgs): Promise<ToolResponse> {
  if (!/^TASK-\d{3}$/.test(args.task_id)) return err('task_id must match TASK-NNN');
  if (!['P1', 'P2', 'P3'].includes(args.priority)) {
    return err('priority must be P1, P2, or P3 (T → P conversion is unbound — pick fresh based on portfolio)');
  }

  const filePath = path.join(TASKS_DIR, `${args.task_id}.md`);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return err(`Task ${args.task_id} not found at ${filePath}`);
  }

  const { fm, body } = parseFrontmatter(content);
  if (fm.status !== 'proposed') {
    return err(
      `Task ${args.task_id} is in status "${fm.status}", not "proposed". Use grade_task to change a non-proposed state.`,
    );
  }

  if (args.pillar !== undefined) {
    if (args.pillar !== 'none' && ![1, 2, 3].includes(args.pillar as number)) {
      return err('pillar must be 1, 2, 3, or "none"');
    }
    fm.pillar = String(args.pillar);
  }
  if (args.purpose !== undefined) {
    if (args.purpose.length < 10) return err('purpose must be ≥10 chars');
    fm.purpose = args.purpose;
  }
  if (args.acceptance !== undefined) {
    if (args.acceptance.length < 10) return err('acceptance must be ≥10 chars');
    fm.acceptance = args.acceptance;
  }

  const { date } = nowPT();
  fm.status = 'assigned';
  fm.priority = args.priority;
  fm.assigned = date;
  fm.assigned_by = 'telos';
  // Preserve proposed_by — that's history.

  let newBody = body;
  if (args.context_addition && args.context_addition.length > 0) {
    newBody = body.trimEnd() + `\n\n## Accepted by Telos (${date})\n\n${args.context_addition}\n`;
  }

  await writeAtomic(filePath, serializeFrontmatter(fm) + newBody);

  const headline = (fm.purpose ?? '').split('\n')[0].slice(0, 60);
  await appendTickLogSection(
    'accept_proposal',
    `**Pillar:** ${fm.pillar}\n**Priority:** ${args.priority}\n**Purpose:** ${headline}${args.context_addition ? `\n**Note:** ${args.context_addition.split('\n')[0].slice(0, 200)}` : ''}`,
    args.task_id,
  );
  const result = await commitAndPush(`task(accept): ${args.task_id} — ${headline}`);
  return ok(formatResult(`Accepted ${args.task_id} (pillar ${fm.pillar}, ${args.priority})`, result));
}

interface DoNothingArgs {
  reason: string;
  next_check?: string;
}

// Append a section to today's tick log (`log/telos/YYYY-MM-DD-tick.md`).
// Called by every action tool (assign_task / grade_task / accept_proposal /
// do_nothing) so the daily trail is symmetric — actions don't leave less
// trace than no-ops. Creates the file with frontmatter if missing.
async function appendTickLogSection(
  action: string,
  body: string,
  taskId?: string,
): Promise<void> {
  const { date, time } = nowPT();
  const filePath = path.join(TELOS_LOG_DIR, `${date}-tick.md`);

  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    // ENOENT is the intended case — initialize with frontmatter. Any other
    // read error (permissions, IO failure) means the file IS there but
    // unreadable; silently overwriting would destroy existing entries.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await fs.mkdir(TELOS_LOG_DIR, { recursive: true });
    const fm: Frontmatter = {
      date,
      author: 'telos',
      session_project: 'tick',
      tasks_progressed: '[]',
      tasks_proposed: '[]',
    };
    existing = serializeFrontmatter(fm) + '\n\n';
  }

  const taskLine = taskId ? `**Task:** ${taskId}\n` : '';
  const section = `## Tick ${time} PT — ${action}\n\n${taskLine}${body}\n\n`;
  await writeAtomic(filePath, existing + section);
}

async function doNothing(args: DoNothingArgs): Promise<ToolResponse> {
  if (!args.reason || args.reason.length < 20) return err('reason must be ≥20 chars');

  const body = `**Reason:** ${args.reason}\n\n**Next check:** ${args.next_check ?? '—'}`;
  await appendTickLogSection('no-op', body);

  const { date, time } = nowPT();
  const headline = args.reason.split('\n')[0].slice(0, 60);
  const result = await commitAndPush(`tick(no-op): ${headline}`);
  return ok(formatResult(`Logged no-op tick at ${time}\nLog: log/telos/${date}-tick.md`, result));
}

interface WriteReflectionArgs {
  what_happened: string;
  key_decisions: string;
  patterns_observed: string;
  what_daniel_should_take_away: string;
  what_telos_should_change: string;
  evidence_candidates: string;
  open_threads: string;
  next_priorities: string;
  tasks_progressed?: string[];
  tasks_proposed?: string[];
}

const REFLECTION_FIELDS = [
  'what_happened',
  'key_decisions',
  'patterns_observed',
  'what_daniel_should_take_away',
  'what_telos_should_change',
  'evidence_candidates',
  'open_threads',
  'next_priorities',
] as const;

const REFLECTION_HEADINGS: Record<typeof REFLECTION_FIELDS[number], string> = {
  what_happened: 'What happened',
  key_decisions: 'Key decisions',
  patterns_observed: 'Patterns observed',
  what_daniel_should_take_away: 'What Daniel should take away',
  what_telos_should_change: 'What Telos should change',
  evidence_candidates: 'Evidence candidates',
  open_threads: 'Open threads',
  next_priorities: 'Next-tick priorities',
};

async function writeReflection(args: WriteReflectionArgs): Promise<ToolResponse> {
  for (const f of REFLECTION_FIELDS) {
    const v = args[f];
    if (typeof v !== 'string' || v.length < 10) {
      return err(`${f} must be a string ≥10 chars`);
    }
  }

  const { date } = nowPT();
  const filePath = path.join(TELOS_LOG_DIR, `${date}-reflection.md`);

  // Refuse to silently overwrite an existing reflection — if today's
  // reflection already exists, the operator should rename or delete it
  // before re-running. Avoids cron double-fire wiping the first run.
  try {
    await fs.access(filePath);
    return err(
      `Reflection already exists for ${date} at log/telos/${date}-reflection.md. Delete or rename the existing file before re-running.`,
    );
  } catch {
    // Not present — good, proceed.
  }

  const fm: Frontmatter = {
    date,
    author: 'telos',
    session_project: 'reflection',
    tasks_progressed: JSON.stringify(args.tasks_progressed ?? []),
    tasks_proposed: JSON.stringify(args.tasks_proposed ?? []),
  };

  const sections = REFLECTION_FIELDS.map(
    (f) => `## ${REFLECTION_HEADINGS[f]}\n\n${args[f]}\n`,
  ).join('\n');
  const body = `\n\n${sections}`;

  await fs.mkdir(TELOS_LOG_DIR, { recursive: true });
  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const result = await commitAndPush(`reflection: ${date}`);
  return ok(formatResult(`Wrote reflection for ${date}\nLog: log/telos/${date}-reflection.md`, result));
}

interface ReadTranscriptArgs {
  date?: string;
}

interface DBRow {
  timestamp: string;
  kind: string;
  content: string;
}

interface ParsedMsg {
  direction: 'in' | 'out';
  timestamp: string;
  text: string;
}

function ptDateOf(utcIso: string): string {
  const d = new Date(utcIso);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

function extractText(jsonContent: string): string {
  try {
    const parsed = JSON.parse(jsonContent);
    if (typeof parsed?.text === 'string') return parsed.text;
    if (typeof parsed === 'string') return parsed;
    return JSON.stringify(parsed).slice(0, 500);
  } catch {
    return jsonContent.slice(0, 500);
  }
}

function shiftDate(yyyymmdd: string, days: number): string {
  const d = new Date(`${yyyymmdd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function readTodayTranscript(args: ReadTranscriptArgs): Promise<ToolResponse> {
  const date = args.date ?? nowPT().date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('date must be YYYY-MM-DD');

  const inboundPath = path.join(SESSION_DIR, 'inbound.db');
  const outboundPath = path.join(SESSION_DIR, 'outbound.db');
  try {
    await fs.access(inboundPath);
    await fs.access(outboundPath);
  } catch {
    return err(
      `Session DBs not found at ${SESSION_DIR}. Mount may not be configured — check container.json additionalMounts.`,
    );
  }

  // Query a UTC window wider than the PT day, then filter to PT date in code
  // (handles PDT/PST offset cleanly without hardcoding).
  const windowStart = `${shiftDate(date, -1)}T12:00:00.000Z`;
  const windowEnd = `${shiftDate(date, 1)}T12:00:00.000Z`;

  let inbound: any;
  let outbound: any;
  try {
    inbound = new Database(inboundPath, { readonly: true });
    outbound = new Database(outboundPath, { readonly: true });
  } catch (e) {
    return err(`Failed to open session DBs: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const inboundRows = inbound
      .query<DBRow, [string, string]>(
        `SELECT timestamp, kind, content FROM messages_in
         WHERE kind = 'chat-sdk' AND timestamp >= ? AND timestamp < ?
         ORDER BY timestamp ASC`,
      )
      .all(windowStart, windowEnd);

    const outboundRows = outbound
      .query<DBRow, [string, string]>(
        `SELECT timestamp, kind, content FROM messages_out
         WHERE timestamp >= ? AND timestamp < ?
         ORDER BY timestamp ASC`,
      )
      .all(windowStart, windowEnd);

    const messages: ParsedMsg[] = [];
    for (const r of inboundRows) {
      if (ptDateOf(r.timestamp) !== date) continue;
      messages.push({ direction: 'in', timestamp: r.timestamp, text: extractText(r.content) });
    }
    for (const r of outboundRows) {
      if (ptDateOf(r.timestamp) !== date) continue;
      messages.push({ direction: 'out', timestamp: r.timestamp, text: extractText(r.content) });
    }
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (messages.length === 0) {
      return ok(`No transcript messages found for ${date} PT.`);
    }

    const lines = messages.map((m) => {
      const speaker = m.direction === 'in' ? 'Daniel' : 'Telos';
      return `[${m.timestamp}] ${speaker}: ${m.text}`;
    });
    return ok(`Transcript for ${date} PT (${messages.length} messages):\n\n${lines.join('\n')}`);
  } finally {
    inbound.close();
    outbound.close();
  }
}

function formatResult(headline: string, result: CommitResult): string {
  let out = `${headline}\nCommit: ${result.sha}\nPushed: ${result.pushed}`;
  if (!result.pushed && result.pushError) out += `\nPush error: ${result.pushError}`;
  return out;
}

// ---- Tool registry ----------------------------------------------------------

const TOOLS = [
  {
    name: 'assign_task',
    description:
      'Create a new task in Constantia (tasks/TASK-NNN.md) with structured frontmatter. Auto-increments NNN, validates pillar (1/2/3/none) and priority (P1/P2/P3), commits, pushes. Use when the tick decision is to add new work for Daniel. At equal priority, pillar work wins over pillar=none.',
    inputSchema: {
      type: 'object',
      required: ['pillar', 'priority', 'purpose', 'acceptance', 'context'],
      properties: {
        pillar: {
          oneOf: [
            { type: 'integer', enum: [1, 2, 3] },
            { type: 'string', enum: ['none'] },
          ],
          description: '1=LLM serving + inference, 2=Production agentic systems, 3=Eval methodology, "none"=cross-cutting / non-growth work that still has to ship',
        },
        priority: {
          type: 'string',
          enum: ['P1', 'P2', 'P3'],
          description: 'P1=next thing displaces standing work, P2=real work no urgency floor, P3=backburner only when blocked',
        },
        purpose: {
          type: 'string',
          minLength: 10,
          description: 'Why this task — specific, ties to a pillar gap (or names the cross-cutting need if pillar=none). Not generic.',
        },
        acceptance: {
          type: 'string',
          minLength: 10,
          description: 'Binary completion criteria — verifiable by artifact (commit, file, test output).',
        },
        context: {
          type: 'string',
          description: 'Background, links, scope. Goes in the body section of the task file.',
        },
      },
    },
  },
  {
    name: 'grade_task',
    description:
      'Grade or reject a task in terminal state. Reads existing TASK-NNN.md, updates frontmatter only (preserves body), commits, pushes. outcome="graded" requires grade (A/B/C) and grade_evidence. outcome="rejected" requires rejection_reason.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'outcome'],
      properties: {
        task_id: { type: 'string', pattern: '^TASK-\\d{3}$', description: 'e.g. TASK-001' },
        outcome: { type: 'string', enum: ['graded', 'rejected'] },
        grade: {
          type: 'string',
          enum: ['A', 'B', 'C'],
          description: 'Required when outcome=graded',
        },
        grade_evidence: {
          type: 'string',
          minLength: 10,
          description:
            'Required when outcome=graded — point at artifact (commit SHA, file path) + the rubric criterion that was met.',
        },
        rejection_reason: {
          type: 'string',
          minLength: 10,
          description: 'Required when outcome=rejected — specific reason, not "not done".',
        },
      },
    },
  },
  {
    name: 'accept_proposal',
    description:
      'Accept a Guya-proposed task — flips status from "proposed" to "assigned", sets assigned_by=telos, assigned=today, and stamps priority (P1/P2/P3). Required: priority. T → P conversion is unbound — pick P fresh based on current portfolio, not the proposal\'s T value. Optionally rewrite pillar/purpose/acceptance to sharpen the task. Use during proposed-task triage when the proposal is worth tracking. For pillar=none proposals, the rubric criterion does not apply — accept on: concrete artifact-verifiable acceptance, not a duplicate, makes sense given Daniel\'s priorities. Reject vague or misaligned proposals via grade_task with outcome=rejected.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'priority'],
      properties: {
        task_id: { type: 'string', pattern: '^TASK-\\d{3}$', description: 'e.g. TASK-005' },
        priority: {
          type: 'string',
          enum: ['P1', 'P2', 'P3'],
          description: 'P-tier stamp on accept. Pick fresh — the proposal\'s T value is a hint, not a contract. P1=next thing displaces standing work, P2=real work no urgency floor, P3=backburner only when blocked.',
        },
        pillar: {
          oneOf: [
            { type: 'integer', enum: [1, 2, 3] },
            { type: 'string', enum: ['none'] },
          ],
          description: 'Optional override if Guya filed under the wrong pillar (or to flip pillar↔none).',
        },
        purpose: {
          type: 'string',
          minLength: 10,
          description: 'Optional rewrite — sharpen the rubric anchor (pillar 1/2/3) or the cross-cutting need (pillar=none).',
        },
        acceptance: {
          type: 'string',
          minLength: 10,
          description: 'Optional rewrite — make the criterion verifiable by artifact.',
        },
        context_addition: {
          type: 'string',
          description: 'Optional appended note explaining why you accepted (or what you tightened).',
        },
      },
    },
  },
  {
    name: 'write_reflection',
    description:
      "Write today's nightly reflection to log/telos/YYYY-MM-DD-reflection.md. Eight required sections: what_happened, key_decisions, patterns_observed, what_daniel_should_take_away, what_telos_should_change, evidence_candidates, open_threads, next_priorities. All ≥10 chars; if a section has nothing to say, say that explicitly (e.g., 'No patterns crossed threshold today.'). Refuses to overwrite an existing reflection for the same day. Use only from the nightly reflection prompt — not from action ticks.",
    inputSchema: {
      type: 'object',
      required: [
        'what_happened',
        'key_decisions',
        'patterns_observed',
        'what_daniel_should_take_away',
        'what_telos_should_change',
        'evidence_candidates',
        'open_threads',
        'next_priorities',
      ],
      properties: {
        what_happened: { type: 'string', minLength: 10, description: 'Factual narrative — ticks fired, tasks moved, shape of the day. Not interpretive.' },
        key_decisions: { type: 'string', minLength: 10, description: 'Decisions made today with reasoning (which proposals you accepted/rejected and why).' },
        patterns_observed: { type: 'string', minLength: 10, description: 'Recurring behavior, pillar-tagged. Apply goal.md threshold (3-in-2-weeks active, 2-week absence). Say "none crossed threshold" if true.' },
        what_daniel_should_take_away: { type: 'string', minLength: 10, description: 'Direct, specific observations about Daniel — growth signals, behavior patterns. No generic praise.' },
        what_telos_should_change: { type: 'string', minLength: 10, description: 'Self-accountability — where you miscalibrated today, voice slips, judgment errors, missed signals. Two-sided: not just observing Daniel, also yourself.' },
        evidence_candidates: { type: 'string', minLength: 10, description: 'Observations that may become formal evidence claims later. Flag, do not assert. Say "none" if true.' },
        open_threads: { type: 'string', minLength: 10, description: 'Unresolved items — stale tasks, deferred decisions, things Daniel raised that did not get answered.' },
        next_priorities: { type: 'string', minLength: 10, description: "What the 9am tick should focus on tomorrow." },
        tasks_progressed: { type: 'array', items: { type: 'string' }, description: 'Optional. Task IDs that moved status today.' },
        tasks_proposed: { type: 'array', items: { type: 'string' }, description: 'Optional. Task IDs proposed/created today.' },
      },
    },
  },
  {
    name: 'read_today_transcript',
    description:
      "Read your DM transcript with Daniel for a given PT day. Returns merged inbound/outbound messages sorted by timestamp. Use at the start of the nightly reflection to ground in actual conversation, not just what you wrote down. Read-only, no commit, no push. Returns empty if no messages that day.",
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Optional PT date YYYY-MM-DD. Defaults to today PT.' },
      },
    },
  },
  {
    name: 'do_nothing',
    description:
      "Log an explicit no-op tick decision. Appends a timestamped section to today's log/YYYY-MM-DD-telos-tick.md (creates if missing). Use when state is healthy and no action is the highest-leverage choice. This is the default tick decision — action without reason is noise.",
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: {
          type: 'string',
          minLength: 20,
          description: 'Why no action is best — what was observed, what was decided against.',
        },
        next_check: {
          type: 'string',
          description:
            'Optional: when/what to re-evaluate (e.g. "if Pillar 1 still silent in 3 days, escalate").',
        },
      },
    },
  },
] as const;

const HANDLERS: Record<string, (args: any) => Promise<ToolResponse>> = {
  assign_task: assignTask,
  grade_task: gradeTask,
  accept_proposal: acceptProposal,
  write_reflection: writeReflection,
  read_today_transcript: readTodayTranscript,
  do_nothing: doNothing,
};

// ---- JSON-RPC stdio loop ----------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: any;
}

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req: JsonRpcRequest): Promise<void> {
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'telos-constantia', version: '0.1.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
    return;
  }

  if (req.method === 'tools/call') {
    const name = req.params?.name as string;
    const handler = HANDLERS[name];
    if (!handler) {
      send({ jsonrpc: '2.0', id: req.id, result: err(`Unknown tool: ${name}`) });
      return;
    }
    try {
      const result = await handler(req.params?.arguments ?? {});
      send({ jsonrpc: '2.0', id: req.id, result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      send({ jsonrpc: '2.0', id: req.id, result: err(msg) });
    }
    return;
  }

  // Notifications (e.g. "notifications/initialized") — no response required.
  if (req.method?.startsWith('notifications/')) return;

  send({
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  });
}

let buffer = '';
// Serialize handler invocations through a promise chain so two rapid-fire
// tool calls never race on shared state (next-NNN computation, log file
// append, git config). Telos sends one call at a time in practice, but the
// stdin event loop doesn't enforce that.
let tail: Promise<void> = Promise.resolve();
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    tail = tail
      .then(() => handle(req))
      .catch((e) => {
        console.error(`[telos-constantia] Unhandled error: ${e}`);
      });
  }
});

process.stdin.on('end', () => process.exit(0));
console.error('[telos-constantia] MCP server ready, constantia path:', CONSTANTIA_PATH);
