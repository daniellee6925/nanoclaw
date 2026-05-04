/**
 * Telos-Constantia MCP server.
 *
 * Hand-rolled stdio JSON-RPC (no @modelcontextprotocol/sdk dep) — keeps the
 * surface area tiny and avoids npm install at container spawn. Three tools:
 *
 *   - assign_task    create tasks/TASK-NNN.md, commit, push
 *   - grade_task     update tasks/TASK-NNN.md to terminal state, commit, push
 *   - do_nothing     append no-op section to today's tick log, commit, push
 *
 * Push failures DO NOT fail the tool — the file write + commit is durable
 * state. The tool returns `pushed: false` so Telos can mention it in its
 * response and Daniel can manually `git push` to recover.
 *
 * Constantia path is hardcoded (`/workspace/extra/constantia`). Single repo,
 * no need for env-var configurability.
 *
 * Git auth uses the constantia-deploy-key bind-mounted at
 * `/workspace/extra/ssh-key/constantia-deploy-key`. GIT_SSH_COMMAND is set
 * via container.json mcpServers env so git push uses the deploy key.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const CONSTANTIA_PATH = '/workspace/extra/constantia';
const TASKS_DIR = path.join(CONSTANTIA_PATH, 'tasks');
const LOG_DIR = path.join(CONSTANTIA_PATH, 'log');
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
  pillar: number;
  purpose: string;
  acceptance: string;
  context: string;
}

async function assignTask(args: AssignTaskArgs): Promise<ToolResponse> {
  if (![1, 2, 3].includes(args.pillar)) return err('pillar must be 1, 2, or 3');
  if (!args.purpose || args.purpose.length < 10) return err('purpose must be ≥10 chars');
  if (!args.acceptance || args.acceptance.length < 10) return err('acceptance must be ≥10 chars');

  const id = await nextTaskId();
  const { date } = nowPT();

  const fm: Frontmatter = {
    id,
    status: 'assigned',
    pillar: String(args.pillar),
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
  const result = await commitAndPush(`task(assign): ${id} — ${headline}`);
  return ok(formatResult(`Created ${id} (pillar ${args.pillar})`, result));
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
  const result = await commitAndPush(`task(${args.outcome}): ${args.task_id} — ${summary}`);
  const headline = `${args.task_id} ${args.outcome}${args.outcome === 'graded' ? ` (${args.grade})` : ''}`;
  return ok(formatResult(headline, result));
}

interface DoNothingArgs {
  reason: string;
  next_check?: string;
}

async function doNothing(args: DoNothingArgs): Promise<ToolResponse> {
  if (!args.reason || args.reason.length < 20) return err('reason must be ≥20 chars');

  const { date, time } = nowPT();
  const filePath = path.join(LOG_DIR, `${date}-telos-tick.md`);

  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    // ENOENT is the intended case — initialize with frontmatter. Any other
    // read error (permissions, IO failure) means the file IS there but
    // unreadable; silently overwriting would destroy existing entries.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const fm: Frontmatter = {
      date,
      author: 'telos',
      session_project: 'tick',
      tasks_progressed: '[]',
      tasks_proposed: '[]',
    };
    existing = serializeFrontmatter(fm) + '\n\n';
  }

  const section = `## Tick ${time} PT — no-op\n\n**Reason:** ${args.reason}\n\n**Next check:** ${args.next_check ?? '—'}\n\n`;
  await writeAtomic(filePath, existing + section);

  const headline = args.reason.split('\n')[0].slice(0, 60);
  const result = await commitAndPush(`tick(no-op): ${headline}`);
  return ok(formatResult(`Logged no-op tick at ${time}\nLog: log/${date}-telos-tick.md`, result));
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
      'Create a new task in Constantia (tasks/TASK-NNN.md) with structured frontmatter. Auto-increments NNN, validates pillar (1/2/3), commits, pushes. Use when the tick decision is to add new work for Daniel.',
    inputSchema: {
      type: 'object',
      required: ['pillar', 'purpose', 'acceptance', 'context'],
      properties: {
        pillar: {
          type: 'integer',
          enum: [1, 2, 3],
          description: '1=LLM serving + inference, 2=Production agentic systems, 3=Eval methodology',
        },
        purpose: {
          type: 'string',
          minLength: 10,
          description: 'Why this task — specific, ties to a pillar gap. Not generic.',
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
