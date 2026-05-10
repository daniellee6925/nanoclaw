/**
 * Telos-Constantia MCP server.
 *
 * Hand-rolled stdio JSON-RPC (no @modelcontextprotocol/sdk dep). Seven tools:
 *
 *   - assign_task             create tasks/TASK-NNN.md, commit, push
 *   - accept_proposal         flip proposed→assigned, commit, push
 *   - grade_task              update tasks/TASK-NNN.md to terminal state, commit, push
 *   - write_evidence          create evidence/EVD-NNN.md (calibrated), commit, push
 *   - do_nothing              log no-op section to today's tick log, commit, push
 *   - write_reflection        nightly synthesized reflection log, commit, push
 *   - read_today_transcript   read user/agent DM transcript from session dbs
 *
 * Action tools (assign_task / grade_task / accept_proposal / write_evidence /
 * do_nothing) all append a section to today's `log/telos/YYYY-MM-DD-tick.md`
 * so the daily trail is symmetric. write_reflection lands at
 * `log/telos/YYYY-MM-DD-reflection.md`.
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
 *
 * Pure helpers (time, exec, frontmatter, atomic write, git config, commit,
 * tool-response shape, transcript text parsing) live in ./helpers.ts.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
// @ts-expect-error bun:sqlite is provided by the Bun runtime
import { Database } from 'bun:sqlite';

import {
  CONSTANTIA_PATH,
  CURRICULA_DIR,
  EVIDENCE_DIR,
  LEARN_DIR,
  PROPOSALS_DIR,
  REMINDERS_DIR,
  TASKS_FILES_DIR,
  TELOS_LOG_DIR,
  SESSION_DIR,
  commitAndPush,
  err,
  extractText,
  formatResult,
  nextEvidenceId,
  nextLearnId,
  nextProposalId,
  nextReminderId,
  nextTaskId,
  nowPT,
  ok,
  parseFrontmatter,
  ptDateOf,
  serializeFrontmatter,
  shiftDate,
  writeAtomic,
  type DBRow,
  type Frontmatter,
  type ParsedMsg,
  type ToolResponse,
} from './helpers';

// ---- Tool handlers ----------------------------------------------------------

interface AssignTaskArgs {
  pillar: number | 'none';
  priority: 1 | 2 | 3;
  purpose: string;
  acceptance: string;
  context: string;
}

// Direct task assignment (no prior proposal). Writes tasks/tasks/P-NNN.md.
// Post 2026-05-08 reorg: priority is plain numeric 1|2|3 (no T/P prefix).
async function assignTask(args: AssignTaskArgs): Promise<ToolResponse> {
  if (args.pillar !== 'none' && ![1, 2, 3].includes(args.pillar as number)) {
    return err('pillar must be 1, 2, 3, or "none"');
  }
  if (![1, 2, 3].includes(args.priority as number)) {
    return err('priority must be 1, 2, or 3');
  }
  if (!args.purpose || args.purpose.length < 10) return err('purpose must be ≥10 chars');
  if (!args.acceptance || args.acceptance.length < 10) return err('acceptance must be ≥10 chars');

  const id = await nextTaskId(); // → P-NNN
  const { date } = nowPT();

  const fm: Frontmatter = {
    id,
    status: 'assigned',
    pillar: String(args.pillar),
    priority: String(args.priority),
    assigned: date,
    assigned_by: 'telos',
    purpose: args.purpose,
    acceptance: args.acceptance,
    grade: null,
    grade_evidence: null,
  };

  const body = `\n\n## Context\n\n${args.context}\n`;
  const filePath = path.join(TASKS_FILES_DIR, `${id}.md`);
  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const headline = args.purpose.split('\n')[0].slice(0, 60);
  await appendTickLogSection(
    'assign_task',
    `**Pillar:** ${args.pillar}\n**Priority:** ${args.priority}\n**Purpose:** ${headline}\n**Acceptance:** ${args.acceptance.split('\n')[0].slice(0, 100)}`,
    id,
  );
  const result = await commitAndPush(`task(assign): ${id} — ${headline}`);
  return ok(formatResult(`Created ${id} (pillar ${args.pillar}, priority ${args.priority})`, result));
}

interface GradeTaskArgs {
  task_id: string;
  outcome: 'graded' | 'abandoned';
  grade?: 'A' | 'B' | 'C';
  grade_evidence?: string;
  abandonment_reason?: string;
}

// Grade or abandon a P-task. Post 2026-05-08 reorg: 'rejected' is for proposals
// only; for tasks the terminal-without-grade state is 'abandoned'.
async function gradeTask(args: GradeTaskArgs): Promise<ToolResponse> {
  if (!/^P-\d{3}$/.test(args.task_id)) return err('task_id must match P-NNN');
  if (args.outcome !== 'graded' && args.outcome !== 'abandoned') {
    return err('outcome must be "graded" or "abandoned"');
  }
  if (args.outcome === 'graded') {
    if (!['A', 'B', 'C'].includes(args.grade ?? '')) {
      return err('grade must be A, B, or C when outcome=graded');
    }
    if (!args.grade_evidence || args.grade_evidence.length < 10) {
      return err('grade_evidence must be ≥10 chars when outcome=graded');
    }
  } else {
    if (!args.abandonment_reason || args.abandonment_reason.length < 10) {
      return err('abandonment_reason must be ≥10 chars when outcome=abandoned');
    }
  }

  const filePath = path.join(TASKS_FILES_DIR, `${args.task_id}.md`);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return err(`Task ${args.task_id} not found at ${filePath}`);
  }

  const { fm, body } = parseFrontmatter(content);
  if (fm.status === 'graded' || fm.status === 'abandoned') {
    return err(`Task ${args.task_id} is already in terminal state: ${fm.status}`);
  }

  fm.status = args.outcome;
  if (args.outcome === 'graded') {
    fm.grade = args.grade!;
    fm.grade_evidence = args.grade_evidence!;
  } else {
    fm.abandonment_reason = args.abandonment_reason!;
  }

  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const summary =
    args.outcome === 'graded'
      ? args.grade!
      : args.abandonment_reason!.split('\n')[0].slice(0, 50);
  const logBody =
    args.outcome === 'graded'
      ? `**Outcome:** graded ${args.grade}\n**Evidence:** ${args.grade_evidence!.split('\n')[0].slice(0, 200)}`
      : `**Outcome:** abandoned\n**Reason:** ${args.abandonment_reason!.split('\n')[0].slice(0, 200)}`;
  await appendTickLogSection(`grade_task (${args.outcome})`, logBody, args.task_id);
  const result = await commitAndPush(`task(${args.outcome}): ${args.task_id} — ${summary}`);
  const headline = `${args.task_id} ${args.outcome}${args.outcome === 'graded' ? ` (${args.grade})` : ''}`;
  return ok(formatResult(headline, result));
}

interface AcceptProposalArgs {
  proposal_id: string;
  // task target args
  priority?: 1 | 2 | 3;
  pillar?: number | 'none';
  acceptance?: string;
  // learn target args
  curriculum?: string;
  module?: string | number;
  success?: string;
  by?: string;
  // curriculum target args
  curriculum_id?: string; // filename slug; e.g., "bytebytego-systems"
  // shared
  context_addition?: string;
}

// Read T-### from PROPOSALS_DIR, inspect target field, spawn the right artifact:
//   target=task       → new P-### in TASKS_FILES_DIR
//   target=learn      → new L-### in LEARN_DIR
//   target=curriculum → new file in CURRICULA_DIR (body of T-### becomes content)
// In all cases the T-### itself is updated to status=accepted (audit trail).
async function acceptProposal(args: AcceptProposalArgs): Promise<ToolResponse> {
  if (!/^T-\d{3}$/.test(args.proposal_id)) return err('proposal_id must match T-NNN');

  const proposalPath = path.join(PROPOSALS_DIR, `${args.proposal_id}.md`);
  let content: string;
  try {
    content = await fs.readFile(proposalPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return err(`Proposal ${args.proposal_id} not found at ${proposalPath}`);
  }

  const { fm: pfm, body: pbody } = parseFrontmatter(content);
  if (pfm.status !== 'proposed') {
    return err(
      `Proposal ${args.proposal_id} is in status "${pfm.status}", not "proposed". Already accepted or rejected.`,
    );
  }

  const target = pfm.target;
  if (target !== 'task' && target !== 'learn' && target !== 'curriculum') {
    return err(`Proposal ${args.proposal_id} has invalid target "${target}" (must be task|learn|curriculum)`);
  }

  const { date } = nowPT();
  let spawnedId = '';
  let spawnedPath = '';
  let headline = '';

  if (target === 'task') {
    if (!args.priority || ![1, 2, 3].includes(args.priority as number)) {
      return err('target=task accept requires priority (1, 2, or 3) — re-grade fresh, do not auto-carry the proposal hint');
    }
    const pillar = args.pillar ?? pfm.target_pillar;
    if (pillar !== 'none' && ![1, 2, 3].includes(Number(pillar))) {
      return err('pillar must be 1, 2, 3, or "none"');
    }
    if (!args.acceptance || args.acceptance.length < 10) {
      return err('target=task accept requires acceptance (≥10 chars, artifact-verifiable)');
    }

    spawnedId = await nextTaskId(); // P-NNN
    spawnedPath = path.join(TASKS_FILES_DIR, `${spawnedId}.md`);
    const taskFm: Frontmatter = {
      id: spawnedId,
      status: 'assigned',
      pillar: String(pillar),
      priority: String(args.priority),
      assigned: date,
      assigned_by: 'telos',
      proposed_by: pfm.proposed_by ?? 'guya',
      proposed_from: args.proposal_id,
      purpose: pfm.purpose,
      acceptance: args.acceptance,
      grade: null,
      grade_evidence: null,
    };
    const ctxNote = args.context_addition
      ? `\n\n## Accepted from ${args.proposal_id} (${date})\n\n${args.context_addition}\n`
      : `\n\n## Accepted from ${args.proposal_id} (${date})\n`;
    await writeAtomic(spawnedPath, serializeFrontmatter(taskFm) + pbody.trimEnd() + ctxNote);
    headline = (pfm.purpose ?? '').split('\n')[0].slice(0, 60);
  } else if (target === 'learn') {
    if (!args.priority || ![1, 2, 3].includes(args.priority as number)) {
      return err('target=learn accept requires priority (1, 2, or 3)');
    }
    const pillar = args.pillar ?? pfm.target_pillar;
    if (pillar !== 'none' && ![1, 2, 3].includes(Number(pillar))) {
      return err('pillar must be 1, 2, 3, or "none"');
    }
    if (!args.curriculum) return err('target=learn accept requires curriculum (id, e.g. "bytebytego-systems")');
    if (args.module === undefined || args.module === null) return err('target=learn accept requires module (number or name)');
    if (!args.success || args.success.length < 10) return err('target=learn accept requires success (≥10 chars, knowledge-check criterion)');
    if (!args.by || !/^\d{4}-\d{2}-\d{2}$/.test(args.by)) return err('target=learn accept requires by (YYYY-MM-DD due date)');

    // Verify curriculum file exists
    const curriculumPath = path.join(CURRICULA_DIR, `${args.curriculum}.md`);
    try {
      await fs.access(curriculumPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return err(`Curriculum "${args.curriculum}" not found at ${curriculumPath}. Author it first or check the id.`);
    }

    spawnedId = await nextLearnId(); // L-NNN
    spawnedPath = path.join(LEARN_DIR, `${spawnedId}.md`);
    const learnFm: Frontmatter = {
      id: spawnedId,
      status: 'assigned',
      pillar: String(pillar),
      priority: String(args.priority),
      curriculum: args.curriculum,
      module: String(args.module),
      success: args.success,
      by: args.by,
      assigned: date,
      assigned_by: 'telos',
      proposed_from: args.proposal_id,
      grade: null,
      grade_evidence: null,
    };
    const ctxNote = args.context_addition
      ? `\n\n## Accepted from ${args.proposal_id} (${date})\n\n${args.context_addition}\n\n## Notes\n`
      : `\n\n## Accepted from ${args.proposal_id} (${date})\n\n## Notes\n`;
    await writeAtomic(spawnedPath, serializeFrontmatter(learnFm) + pbody.trimEnd() + ctxNote);
    headline = (pfm.purpose ?? `${args.curriculum} module ${args.module}`).split('\n')[0].slice(0, 60);
  } else {
    // target === 'curriculum'
    if (!args.curriculum_id || !/^[a-z0-9-]+$/.test(args.curriculum_id)) {
      return err('target=curriculum accept requires curriculum_id (lowercase-kebab slug, e.g. "ddia-deep")');
    }
    spawnedPath = path.join(CURRICULA_DIR, `${args.curriculum_id}.md`);
    try {
      await fs.access(spawnedPath);
      return err(`Curriculum "${args.curriculum_id}" already exists at ${spawnedPath}. Pick a different id or edit the existing file directly.`);
    } catch (e) {
      // ENOENT is the desired case — file should not yet exist. Any other
      // error (e.g. EACCES on an unreadable existing file) MUST throw —
      // silently proceeding to writeAtomic would overwrite it.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    // Body of proposal becomes the curriculum content. Strip the proposal context section if present.
    await writeAtomic(spawnedPath, pbody.trimStart());
    spawnedId = args.curriculum_id;
    headline = (pfm.purpose ?? args.curriculum_id).split('\n')[0].slice(0, 60);
  }

  // Mark proposal as accepted (preserve as audit trail)
  pfm.status = 'accepted';
  pfm.accepted_at = date;
  pfm.accepted_into = spawnedId;
  await writeAtomic(proposalPath, serializeFrontmatter(pfm) + pbody);

  await appendTickLogSection(
    'accept_proposal',
    `**Proposal:** ${args.proposal_id}\n**Target:** ${target}\n**Spawned:** ${spawnedId}\n**Headline:** ${headline}${args.context_addition ? `\n**Note:** ${args.context_addition.split('\n')[0].slice(0, 200)}` : ''}`,
    args.proposal_id,
  );
  const result = await commitAndPush(`accept(${target}): ${args.proposal_id} → ${spawnedId} — ${headline}`);
  return ok(formatResult(`Accepted ${args.proposal_id} as ${target} → ${spawnedId}`, result));
}

// ---- Phase 2b new tools ----------------------------------------------------

interface ProposeTaskArgs {
  target: 'task' | 'learn' | 'curriculum';
  target_pillar: number | 'none';
  target_priority: 1 | 2 | 3;
  purpose: string;
  context: string;
  proposed_by?: 'telos' | 'guya' | 'daniel';
}

// Create a proposal in tasks/proposals/T-NNN.md. The proposal is just an idea —
// acceptance turns it into the right artifact (P-task, L-task, or curriculum).
// target_priority is a HINT; acceptProposal forces a fresh re-grade.
async function proposeTask(args: ProposeTaskArgs): Promise<ToolResponse> {
  if (!['task', 'learn', 'curriculum'].includes(args.target)) {
    return err('target must be one of: task, learn, curriculum');
  }
  if (args.target_pillar !== 'none' && ![1, 2, 3].includes(Number(args.target_pillar))) {
    return err('target_pillar must be 1, 2, 3, or "none"');
  }
  if (![1, 2, 3].includes(args.target_priority as number)) {
    return err('target_priority must be 1, 2, or 3');
  }
  if (!args.purpose || args.purpose.length < 10) return err('purpose must be ≥10 chars');

  const id = await nextProposalId(); // T-NNN
  const { date } = nowPT();
  const author = args.proposed_by ?? 'telos';

  const fm: Frontmatter = {
    id,
    status: 'proposed',
    target: args.target,
    pillar: String(args.target_pillar), // pillar of the proposal itself; same as target by default
    target_priority: String(args.target_priority),
    target_pillar: String(args.target_pillar),
    proposed_by: author,
    proposed_at: date,
    purpose: args.purpose,
  };

  // For target=curriculum, the context arg IS the curriculum draft — write it
  // directly without wrapping in a "## Context" section. acceptProposal will
  // promote the body verbatim into curricula/, so wrapping would produce a
  // curriculum file that starts with "## Context" instead of its own heading.
  // For target=task or learn, wrap context as a Context section so the proposal
  // body is recognizably a proposal, not the artifact-to-be.
  const body =
    args.target === 'curriculum'
      ? `\n\n${args.context}\n`
      : `\n\n## Context\n\n${args.context}\n`;
  const filePath = path.join(PROPOSALS_DIR, `${id}.md`);
  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const headline = args.purpose.split('\n')[0].slice(0, 60);
  await appendTickLogSection(
    'propose_task',
    `**Target:** ${args.target}\n**Target priority:** ${args.target_priority}\n**Target pillar:** ${args.target_pillar}\n**Purpose:** ${headline}`,
    id,
  );
  const result = await commitAndPush(`propose(${args.target}): ${id} — ${headline}`);
  return ok(formatResult(`Proposed ${id} (target=${args.target}, target_priority=${args.target_priority})`, result));
}

interface AssignLearnArgs {
  pillar: number | 'none';
  priority: 1 | 2 | 3;
  curriculum: string;
  module: string | number;
  success: string;
  by: string;
  context: string;
}

// Direct learn-task assignment (no prior proposal). Writes tasks/learn/L-NNN.md.
async function assignLearn(args: AssignLearnArgs): Promise<ToolResponse> {
  if (args.pillar !== 'none' && ![1, 2, 3].includes(Number(args.pillar))) {
    return err('pillar must be 1, 2, 3, or "none"');
  }
  if (![1, 2, 3].includes(args.priority as number)) {
    return err('priority must be 1, 2, or 3');
  }
  if (!args.curriculum) return err('curriculum required (id, e.g. "bytebytego-systems")');
  if (args.module === undefined || args.module === null) return err('module required (number or name)');
  if (!args.success || args.success.length < 10) return err('success must be ≥10 chars (knowledge-check criterion)');
  if (!args.by || !/^\d{4}-\d{2}-\d{2}$/.test(args.by)) return err('by must be YYYY-MM-DD');

  // Verify curriculum file exists
  const curriculumPath = path.join(CURRICULA_DIR, `${args.curriculum}.md`);
  try {
    await fs.access(curriculumPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return err(`Curriculum "${args.curriculum}" not found at ${curriculumPath}. Author it first or check the id.`);
  }

  const id = await nextLearnId(); // L-NNN
  const { date } = nowPT();

  const fm: Frontmatter = {
    id,
    status: 'assigned',
    pillar: String(args.pillar),
    priority: String(args.priority),
    curriculum: args.curriculum,
    module: String(args.module),
    success: args.success,
    by: args.by,
    assigned: date,
    assigned_by: 'telos',
    grade: null,
    grade_evidence: null,
  };

  const body = `\n\n## Context\n\n${args.context}\n\n## Notes\n`;
  const filePath = path.join(LEARN_DIR, `${id}.md`);
  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const headline = `${args.curriculum} module ${args.module}`.slice(0, 60);
  await appendTickLogSection(
    'assign_learn',
    `**Pillar:** ${args.pillar}\n**Priority:** ${args.priority}\n**Curriculum:** ${args.curriculum}\n**Module:** ${args.module}\n**Due:** ${args.by}\n**Success:** ${args.success.split('\n')[0].slice(0, 200)}`,
    id,
  );
  const result = await commitAndPush(`learn(assign): ${id} — ${headline}`);
  return ok(formatResult(`Created ${id} (${args.curriculum} module ${args.module}, due ${args.by})`, result));
}

interface AddReminderArgs {
  title: string;
  schedule_type: 'once' | 'cron';
  schedule_at?: string; // ISO timestamp; required when type=once
  schedule_expr?: string; // cron expression; required when type=cron
  context?: string;
  added_by?: 'daniel' | 'telos';
}

// Add a reminder. schedule_type=once → schedule_at required; type=cron → schedule_expr required.
// One-shot starts pending; cron starts active.
async function addReminder(args: AddReminderArgs): Promise<ToolResponse> {
  if (!args.title || args.title.length < 3) return err('title must be ≥3 chars');
  if (args.schedule_type !== 'once' && args.schedule_type !== 'cron') {
    return err('schedule_type must be "once" or "cron"');
  }
  let initialStatus: string;
  if (args.schedule_type === 'once') {
    if (!args.schedule_at) return err('schedule_type=once requires schedule_at (ISO timestamp)');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(args.schedule_at)) {
      return err('schedule_at must be ISO format YYYY-MM-DDTHH:MM (with optional seconds + tz)');
    }
    initialStatus = 'pending';
  } else {
    if (!args.schedule_expr) return err('schedule_type=cron requires schedule_expr (e.g. "0 18 * * *")');
    // Permissive cron-shape check: 5 whitespace-separated tokens.
    if (args.schedule_expr.trim().split(/\s+/).length !== 5) {
      return err('schedule_expr must have 5 fields (min hour day month dayofweek)');
    }
    initialStatus = 'active';
  }

  const id = await nextReminderId(); // R-NNN
  const { date } = nowPT();
  const author = args.added_by ?? 'daniel';

  const fm: Frontmatter = {
    id,
    title: args.title,
    status: initialStatus,
    schedule_type: args.schedule_type,
    added_by: author,
    added_at: date,
    last_fired: null,
  };
  if (args.schedule_type === 'once') {
    fm.schedule_at = args.schedule_at!;
  } else {
    fm.schedule_expr = args.schedule_expr!;
  }

  const body = args.context ? `\n\n## Context\n\n${args.context}\n` : '\n';
  const filePath = path.join(REMINDERS_DIR, `${id}.md`);
  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const scheduleDesc =
    args.schedule_type === 'once' ? `once at ${args.schedule_at}` : `cron ${args.schedule_expr}`;
  await appendTickLogSection(
    'add_reminder',
    `**Title:** ${args.title}\n**Schedule:** ${scheduleDesc}\n**Added by:** ${author}`,
    id,
  );
  const result = await commitAndPush(`reminder(add): ${id} — ${args.title.slice(0, 60)}`);
  return ok(formatResult(`Added ${id} (${args.title}, ${scheduleDesc})`, result));
}

interface GradeLearnArgs {
  learn_id: string;
  outcome: 'graded' | 'abandoned';
  grade?: 'A' | 'B' | 'C';
  grade_evidence?: string;
  abandonment_reason?: string;
}

// Grade or abandon an L-task. Same shape as gradeTask but for learn lifecycle.
async function gradeLearn(args: GradeLearnArgs): Promise<ToolResponse> {
  if (!/^L-\d{3}$/.test(args.learn_id)) return err('learn_id must match L-NNN');
  if (args.outcome !== 'graded' && args.outcome !== 'abandoned') {
    return err('outcome must be "graded" or "abandoned"');
  }
  if (args.outcome === 'graded') {
    if (!['A', 'B', 'C'].includes(args.grade ?? '')) {
      return err('grade must be A, B, or C when outcome=graded');
    }
    if (!args.grade_evidence || args.grade_evidence.length < 10) {
      return err('grade_evidence must be ≥10 chars when outcome=graded — cite the knowledge-check answer that met success');
    }
  } else {
    if (!args.abandonment_reason || args.abandonment_reason.length < 10) {
      return err('abandonment_reason must be ≥10 chars when outcome=abandoned');
    }
  }

  const filePath = path.join(LEARN_DIR, `${args.learn_id}.md`);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return err(`Learn task ${args.learn_id} not found at ${filePath}`);
  }

  const { fm, body } = parseFrontmatter(content);
  if (fm.status === 'graded' || fm.status === 'abandoned') {
    return err(`Learn task ${args.learn_id} is already in terminal state: ${fm.status}`);
  }

  fm.status = args.outcome;
  if (args.outcome === 'graded') {
    fm.grade = args.grade!;
    fm.grade_evidence = args.grade_evidence!;
  } else {
    fm.abandonment_reason = args.abandonment_reason!;
  }

  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const summary =
    args.outcome === 'graded'
      ? args.grade!
      : args.abandonment_reason!.split('\n')[0].slice(0, 50);
  const logBody =
    args.outcome === 'graded'
      ? `**Outcome:** graded ${args.grade}\n**Curriculum:** ${fm.curriculum} module ${fm.module}\n**Evidence:** ${args.grade_evidence!.split('\n')[0].slice(0, 200)}`
      : `**Outcome:** abandoned\n**Reason:** ${args.abandonment_reason!.split('\n')[0].slice(0, 200)}`;
  await appendTickLogSection(`grade_learn (${args.outcome})`, logBody, args.learn_id);
  const result = await commitAndPush(`learn(${args.outcome}): ${args.learn_id} — ${summary}`);
  const headline = `${args.learn_id} ${args.outcome}${args.outcome === 'graded' ? ` (${args.grade})` : ''}`;
  return ok(formatResult(headline, result));
}

interface ReadCurriculumArgs {
  curriculum: string;
}

// Read the full content of a curriculum file. Used by learn-tick prompts to
// surface module content when introducing or grading an L-task.
async function readCurriculum(args: ReadCurriculumArgs): Promise<ToolResponse> {
  if (!args.curriculum || !/^[a-z0-9-]+$/.test(args.curriculum)) {
    return err('curriculum must be a lowercase-kebab slug (e.g. "bytebytego-systems")');
  }
  const filePath = path.join(CURRICULA_DIR, `${args.curriculum}.md`);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return err(`Curriculum "${args.curriculum}" not found at ${filePath}. List existing: ls tasks/learn/curricula/`);
  }
  return ok(content);
}

interface WriteEvidenceArgs {
  category: 'strength' | 'weakness' | 'habit' | 'growth' | 'decision';
  confidence: 'tentative' | 'medium' | 'high';
  source: string;
  observation: string;
  assessment: string;
}

const EVIDENCE_CATEGORIES = ['strength', 'weakness', 'habit', 'growth', 'decision'] as const;
const CONFIDENCE_LEVELS = ['tentative', 'medium', 'high'] as const;

async function writeEvidence(args: WriteEvidenceArgs): Promise<ToolResponse> {
  if (!EVIDENCE_CATEGORIES.includes(args.category)) {
    return err(`category must be one of: ${EVIDENCE_CATEGORIES.join(', ')}`);
  }
  if (!CONFIDENCE_LEVELS.includes(args.confidence)) {
    return err(`confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if (!args.source || args.source.length < 3) return err('source must be ≥3 chars');
  if (!args.observation || args.observation.length < 10) return err('observation must be ≥10 chars');
  if (!args.assessment || args.assessment.length < 10) return err('assessment must be ≥10 chars');

  // Calibration rule: self-reported claims (especially Daniel's bootstrap
  // habit/strength claims) cannot be high or medium confidence until validated
  // by observation. Force tentative + flag ground_truth_pending so future
  // queries can find unvalidated evidence.
  if (args.source === 'self-report' && args.confidence !== 'tentative') {
    return err(
      "source='self-report' requires confidence='tentative' (calibration rule — self-report is hypothesis, not ground truth, until observed)",
    );
  }

  const id = await nextEvidenceId();
  const { date } = nowPT();

  const fm: Frontmatter = {
    id,
    category: args.category,
    date,
    source: args.source,
    confidence: args.confidence,
  };
  if (args.source === 'self-report') {
    fm.ground_truth_pending = 'true';
  }

  const body = `\n\n## Observation\n\n${args.observation}\n\n## Assessment\n\n${args.assessment}\n`;
  const filePath = path.join(EVIDENCE_DIR, `${id}.md`);
  await writeAtomic(filePath, serializeFrontmatter(fm) + body);

  const headline = args.observation.split('\n')[0].slice(0, 60);
  await appendTickLogSection(
    'write_evidence',
    `**Evidence:** ${id}\n**Category:** ${args.category}\n**Source:** ${args.source}\n**Confidence:** ${args.confidence}${fm.ground_truth_pending ? ' (ground-truth-pending)' : ''}\n**Observation:** ${headline}`,
  );
  const result = await commitAndPush(`evidence(${args.category}): ${id} — ${headline}`);
  return ok(formatResult(`Recorded ${id} (${args.category}, ${args.confidence})`, result));
}

interface DoNothingArgs {
  reason: string;
  next_check?: string;
}

// Append a section to today's tick log (`log/telos/YYYY-MM-DD-tick.md`).
// Called by every action tool (assign_task / grade_task / accept_proposal /
// write_evidence / do_nothing) so the daily trail is symmetric — actions
// don't leave less trace than no-ops. Creates the file with frontmatter if
// missing.
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
  } catch (e) {
    // ENOENT is the intended case — file absent, safe to write. Any other
    // access error (permissions, IO failure) means we cannot prove the file
    // is absent; fail loud rather than risk overwriting unreadable content.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
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
    // If inbound opened but outbound failed, close inbound so the file handle
    // doesn't leak until process exit. Both undefined-checks are needed —
    // the failing constructor leaves its target undefined, the prior one set.
    if (inbound) inbound.close();
    if (outbound) outbound.close();
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

// ---- Tool registry ----------------------------------------------------------

const TOOLS = [
  {
    name: 'assign_task',
    description:
      'Create a new P-task in tasks/tasks/P-NNN.md with structured frontmatter. Auto-increments NNN, validates pillar (1/2/3/none) and priority (1/2/3 numeric — no T/P prefix post 2026-05-08 reorg), commits, pushes. Use when the tick decision is to add new work for Daniel directly (no prior proposal). At equal priority, pillar work wins over pillar=none. To create a proposal instead, use propose_task. To accept a Guya-proposed T-task, use accept_proposal.',
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
          type: 'integer',
          enum: [1, 2, 3],
          description: '1=next thing displaces standing work, 2=real work no urgency floor, 3=backburner only when blocked',
        },
        purpose: { type: 'string', minLength: 10, description: 'Why this task — specific, ties to a pillar gap or names the cross-cutting need. Not generic.' },
        acceptance: { type: 'string', minLength: 10, description: 'Binary completion criteria — verifiable by artifact (commit, file, test output).' },
        context: { type: 'string', description: 'Background, links, scope. Goes in the body section of the task file.' },
      },
    },
  },
  {
    name: 'grade_task',
    description:
      'Grade or abandon a P-task in terminal state. Reads existing tasks/tasks/P-NNN.md, updates frontmatter only (preserves body), commits, pushes. outcome="graded" requires grade (A/B/C) and grade_evidence. outcome="abandoned" requires abandonment_reason. Post-reorg note: "rejected" is for proposals only; for tasks the terminal-without-grade state is "abandoned".',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'outcome'],
      properties: {
        task_id: { type: 'string', pattern: '^P-\\d{3}$', description: 'e.g. P-001' },
        outcome: { type: 'string', enum: ['graded', 'abandoned'] },
        grade: { type: 'string', enum: ['A', 'B', 'C'], description: 'Required when outcome=graded' },
        grade_evidence: { type: 'string', minLength: 10, description: 'Required when outcome=graded — cite artifact (commit SHA, file path) + rubric criterion met.' },
        abandonment_reason: { type: 'string', minLength: 10, description: 'Required when outcome=abandoned — specific reason, not "not done".' },
      },
    },
  },
  {
    name: 'accept_proposal',
    description:
      'Accept a T-proposal in tasks/proposals/T-NNN.md and spawn the right artifact based on its target field. target=task spawns P-NNN (requires priority + acceptance, optional pillar override). target=learn spawns L-NNN (requires priority + curriculum + module + success + by). target=curriculum promotes the proposal body into tasks/learn/curricula/<curriculum_id>.md. The T-NNN itself is marked status=accepted (audit trail). Pick priority fresh — the proposal hint is informational, not a contract.',
    inputSchema: {
      type: 'object',
      required: ['proposal_id'],
      properties: {
        proposal_id: { type: 'string', pattern: '^T-\\d{3}$', description: 'e.g. T-005' },
        priority: { type: 'integer', enum: [1, 2, 3], description: 'Required for target=task or target=learn. Plain numeric.' },
        pillar: {
          oneOf: [{ type: 'integer', enum: [1, 2, 3] }, { type: 'string', enum: ['none'] }],
          description: 'Optional override of target_pillar from the proposal.',
        },
        acceptance: { type: 'string', minLength: 10, description: 'Required for target=task — artifact-verifiable completion criterion.' },
        curriculum: { type: 'string', description: 'Required for target=learn — curriculum id (e.g. "bytebytego-systems"). File must exist.' },
        module: { description: 'Required for target=learn — module number or name.', oneOf: [{ type: 'string' }, { type: 'integer' }] },
        success: { type: 'string', minLength: 10, description: 'Required for target=learn — knowledge-check criterion for grading.' },
        by: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Required for target=learn — due date YYYY-MM-DD.' },
        curriculum_id: { type: 'string', pattern: '^[a-z0-9-]+$', description: 'Required for target=curriculum — filename slug, e.g. "ddia-deep".' },
        context_addition: { type: 'string', description: 'Optional note explaining what was tightened on accept.' },
      },
    },
  },
  {
    name: 'propose_task',
    description:
      'Propose work for Daniel\'s consideration — writes T-NNN.md to tasks/proposals/. The proposal is just an idea; accept_proposal turns it into the right artifact (P-task, L-task, or curriculum). target_priority is a HINT — accept_proposal forces a fresh re-grade. Use when surfacing an opportunity that isn\'t ready to be assigned outright (needs Daniel\'s input on shape/timing).',
    inputSchema: {
      type: 'object',
      required: ['target', 'target_pillar', 'target_priority', 'purpose', 'context'],
      properties: {
        target: { type: 'string', enum: ['task', 'learn', 'curriculum'], description: 'What this proposal will spawn on accept.' },
        target_pillar: {
          oneOf: [{ type: 'integer', enum: [1, 2, 3] }, { type: 'string', enum: ['none'] }],
          description: '1=LLM serving + inference, 2=Production agentic systems, 3=Eval methodology, "none"=cross-cutting.',
        },
        target_priority: { type: 'integer', enum: [1, 2, 3], description: 'Hint — re-graded at accept time.' },
        purpose: { type: 'string', minLength: 10, description: 'Why this proposal — specific, ties to a gap.' },
        context: { type: 'string', description: 'Background, links, scope. Body of the proposal file.' },
        proposed_by: { type: 'string', enum: ['telos', 'guya', 'daniel'], description: 'Optional — defaults to "telos".' },
      },
    },
  },
  {
    name: 'assign_learn',
    description:
      'Assign a learn task directly (no prior proposal) — writes L-NNN.md to tasks/learn/. References a curriculum by id (filename without .md) plus a module within it. success is the knowledge-check criterion grade_learn evaluates against. by is the due date. Verifies the curriculum file exists before writing.',
    inputSchema: {
      type: 'object',
      required: ['pillar', 'priority', 'curriculum', 'module', 'success', 'by', 'context'],
      properties: {
        pillar: {
          oneOf: [{ type: 'integer', enum: [1, 2, 3] }, { type: 'string', enum: ['none'] }],
          description: '1=LLM serving + inference, 2=Production agentic systems, 3=Eval methodology, "none"=cross-cutting.',
        },
        priority: { type: 'integer', enum: [1, 2, 3], description: '1=urgent, 2=normal, 3=backburner.' },
        curriculum: { type: 'string', description: 'Curriculum id (filename in tasks/learn/curricula/, without .md).' },
        module: { description: 'Module number or name within the curriculum.', oneOf: [{ type: 'string' }, { type: 'integer' }] },
        success: { type: 'string', minLength: 10, description: 'Knowledge-check criterion for grading — what Daniel must demonstrate.' },
        by: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Due date YYYY-MM-DD.' },
        context: { type: 'string', description: 'Background — why this module now, links, scope. Body of the L-task file.' },
      },
    },
  },
  {
    name: 'add_reminder',
    description:
      'Add a reminder — writes R-NNN.md to tasks/reminders/. schedule_type=once requires schedule_at (ISO timestamp); schedule_type=cron requires schedule_expr (5-field cron). The launchd-driven check_reminders.sh script polls these and inserts messages into the life-session inbound.db when due. One-shot starts pending; cron starts active.',
    inputSchema: {
      type: 'object',
      required: ['title', 'schedule_type'],
      properties: {
        title: { type: 'string', minLength: 3, description: 'Short reminder title — what the reminder is for.' },
        schedule_type: { type: 'string', enum: ['once', 'cron'], description: 'one-shot fire vs recurring cron.' },
        schedule_at: { type: 'string', description: 'ISO timestamp YYYY-MM-DDTHH:MM[:SS][±HH:MM]. Required when schedule_type=once.' },
        schedule_expr: { type: 'string', description: '5-field cron expression. Required when schedule_type=cron.' },
        context: { type: 'string', description: 'Optional — background or note about why this reminder exists.' },
        added_by: { type: 'string', enum: ['daniel', 'telos'], description: 'Optional — defaults to "daniel".' },
      },
    },
  },
  {
    name: 'grade_learn',
    description:
      'Grade or abandon an L-task in tasks/learn/L-NNN.md. outcome=graded requires grade (A/B/C) and grade_evidence (cite the knowledge-check answer that met success). outcome=abandoned requires abandonment_reason. Same lifecycle shape as grade_task but for learn. Use at the 10pm learn tick when L-task success criteria have been met (or stalled past due).',
    inputSchema: {
      type: 'object',
      required: ['learn_id', 'outcome'],
      properties: {
        learn_id: { type: 'string', pattern: '^L-\\d{3}$', description: 'e.g. L-001' },
        outcome: { type: 'string', enum: ['graded', 'abandoned'] },
        grade: { type: 'string', enum: ['A', 'B', 'C'], description: 'Required when outcome=graded.' },
        grade_evidence: { type: 'string', minLength: 10, description: 'Required when outcome=graded — cite the knowledge-check Q + Daniel\'s answer that met success.' },
        abandonment_reason: { type: 'string', minLength: 10, description: 'Required when outcome=abandoned — specific reason.' },
      },
    },
  },
  {
    name: 'read_curriculum',
    description:
      'Read the full content of a curriculum file at tasks/learn/curricula/<curriculum>.md. Read-only — no commit, no push. Use when introducing a learn-task to surface module content, or when grading to ground the knowledge check in the original material.',
    inputSchema: {
      type: 'object',
      required: ['curriculum'],
      properties: {
        curriculum: { type: 'string', pattern: '^[a-z0-9-]+$', description: 'Curriculum id (filename slug, e.g. "bytebytego-systems").' },
      },
    },
  },
  {
    name: 'write_evidence',
    description:
      "Record a formal evidence entry at evidence/EVD-NNN.md — auto-incremented ID, structured frontmatter (category, date=today PT, source, confidence), Observation + Assessment sections in the body. Use to promote a reflection's evidence_candidate into a durable claim, or to log an in-tick observation strong enough to anchor a profile/* update.\n\nCalibration rule (load-bearing): self-reported claims (Daniel said X about himself, no observation yet) must use source='self-report' AND confidence='tentative' — the tool auto-stamps ground_truth_pending: true so they're queryable later for validation. Self-report is hypothesis, not ground truth. To upgrade confidence later, write a NEW evidence entry citing the observational source (a log entry, commit SHA, etc.) — do not edit the original.\n\nSource conventions: file path (e.g., 'log/telos/2026-05-06-tick.md', 'log/guya/...-bootstrap-...md') — pre-commit verifies it exists; commit SHA (e.g., 'ca38dac') for code/decision evidence; or the literal 'self-report' for unvalidated claims. Categories: strength | weakness | habit | growth | decision. evidence/MANIFEST.md is auto-regenerated by post-commit hook.",
    inputSchema: {
      type: 'object',
      required: ['category', 'confidence', 'source', 'observation', 'assessment'],
      properties: {
        category: {
          type: 'string',
          enum: ['strength', 'weakness', 'habit', 'growth', 'decision'],
          description:
            'strength = capability demonstrated; weakness = gap demonstrated; habit = recurring behavior with frequency; growth = before/after delta; decision = a call Daniel made worth recording for pattern tracking.',
        },
        confidence: {
          type: 'string',
          enum: ['tentative', 'medium', 'high'],
          description:
            "tentative = single instance OR self-report; medium = 2-3 corroborating instances OR strong single artifact; high = ≥3 instances across time OR direct artifact + outcome. Self-report sources MUST be tentative.",
        },
        source: {
          type: 'string',
          minLength: 3,
          description:
            "Where the evidence comes from. File path (must exist — pre-commit checks): 'log/telos/YYYY-MM-DD-tick.md', 'log/guya/...md', 'evidence/EVD-NNN.md'. Commit SHA: 'ca38dac' for code/decision artifacts. Literal 'self-report' for Daniel-stated claims not yet observed (auto-flags ground_truth_pending).",
        },
        observation: {
          type: 'string',
          minLength: 10,
          description:
            'What was actually seen, said, or done — concrete, quotable, free of interpretation. Not the meaning, the raw material.',
        },
        assessment: {
          type: 'string',
          minLength: 10,
          description:
            "Your interpretation — what the observation means about Daniel (or about Telos's own behavior). This is where the evidence becomes useful for profile/* updates.",
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
  propose_task: proposeTask,
  assign_learn: assignLearn,
  add_reminder: addReminder,
  grade_learn: gradeLearn,
  read_curriculum: readCurriculum,
  write_evidence: writeEvidence,
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
