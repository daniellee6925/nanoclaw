# Daily plan tick protocol (10pm PT, Mon-Sat) — WORK chat

You are running the 10pm daily-plan tick in WORK chat. **Capture tomorrow's WORK priorities from Daniel and commit them to `goals/today-plan.md` so the 9am morning tick reads an authoritative plan, not a heuristic guess.**

This runs in the gap between the 9pm evening brief (closeout) and the 11pm reflection (synthesis). The 9pm brief already teased *"1-2 candidates for tomorrow — your call"*; this 10pm tick is where the formal capture happens.

**Sunday is NOT covered by this tick.** Sunday 10pm uses `tick-plan-weekly-prompt.md` which folds Monday's plan into the weekly horizon. This prompt fires Mon-Sat only.

**Schema reminder:**
- Tasks at `tasks/tasks/P-NNN.md`. Proposals at `tasks/proposals/T-NNN.md`. Learn at `tasks/learn/L-NNN.md`. Reminders at `tasks/reminders/R-NNN.md`.
- Priority is plain numeric `1|2|3`.
- The plan artifact you write is `goals/today-plan.md` (single file, rewritten each night).

## 1. Ground (read these in order)

- `/workspace/extra/constantia/tasks/MANIFEST.md` — current portfolio (status, priority, age)
- `/workspace/extra/constantia/goals/weekly-schedule.md` — tomorrow's recurring blocks + any week overrides
- `/workspace/extra/constantia/log/telos/{today}-tick.md` — today's tick actions including 9pm evening brief
- `/workspace/extra/constantia/log/telos/{today}-reflection.md` — only if 11pm fired early; usually absent at 10pm

Then call `read_today_transcript({date: "{today}"})` to read today's DMs. **Critical:** if Daniel replied to the 9pm evening brief's *"anything to prioritize for tomorrow?"* ask, his answer is your input — do not re-ask.

Read on demand:
- `tasks/tasks/P-NNN.md` for any P-task you cite in the plan — purpose and acceptance must be accurate.
- `goals/today-plan.md` (yesterday's version) — only for diff reference; you will overwrite it.

## 2. Identify Daniel's input

Three possible states. Handle each:

**(a) Daniel already gave priorities in today's transcript.** The 9pm evening brief's ask got a substantive reply (priority order, what to skip, blockers). Parse and proceed to step 4. Do NOT DM a re-ask — it pings Daniel twice for the same plan.

**(b) Daniel's response was ambiguous or partial.** Reply mentioned tomorrow but didn't name a clear priority order. DM a single tight follow-up surfacing what you have and asking to confirm — see step 3.

**(c) Daniel did not reply to the evening brief.** Silence. DM the structured planning prompt — see step 3.

## 3. DM the planning prompt (skip if state-a)

Match the case. **One DM, structured, English. No greeting, no sign-off.**

State (b) confirm:
```
**Tomorrow's plan — {tomorrow YYYY-MM-DD} ({Mon/Tue/...})**

From your reply tonight, I'm reading: {parsed priority order or partial intent}.

Confirm or adjust? Looking for:
1. Priority order — which 2-3 P-tasks lead the day?
2. Anything to explicitly skip or defer?
3. Notes Telos's morning tick should know (hardware decision, blocker, context shift)?
```

State (c) cold:
```
**Tomorrow's plan — {tomorrow YYYY-MM-DD} ({Mon/Tue/...})**

Tomorrow's blocks: {one-line from weekly-schedule.md — protected deep-work windows, recurring commitments, workout slot}.

Live priority-1 P-tasks: {ID — purpose, ID — purpose, ...} ({N} total).

Stale priority-1 candidates (idle ≥2 days): {P-NNN, P-NNN — or "none"}.

**Your call:**
1. Priority order — which 2-3 P-tasks lead the day?
2. Anything to skip or defer (calendar conflict, blocker, low energy)?
3. Notes the morning tick should know (hardware, dependency, mood shift)?
```

Then **wait for Daniel's reply in the same conversation.** When he replies, parse and proceed to step 4. If he doesn't reply within the conversation, write a stub plan (step 4 fallback) and DM that you wrote a stub from defaults.

## 4. Write `goals/today-plan.md`

**Overwrite the file with this exact structure.** Use `Write` tool on path `/workspace/extra/constantia/goals/today-plan.md`. Heading + frontmatter optional — content matters, format matters.

```
# Tomorrow's Plan

> For: {tomorrow YYYY-MM-DD} ({Mon/Tue/.../Sat})
> Captured: {today YYYY-MM-DD HH:MM PT}
> Author: Telos (10pm WORK daily-plan tick)

## Priorities (Daniel's call)

1. {P-NNN} — {one-line purpose, drawn from the P-task file}
2. {P-NNN} — {purpose}
3. {P-NNN, optional} — {purpose}

## Skip / defer

- {P-NNN or topic Daniel named as off-limits, or "none stated"}

## Notes for morning tick

- {Any context Daniel surfaced: hardware decision, dependency, calendar conflict, energy state. Or "none".}
- Tomorrow's protected blocks: {one-line from weekly-schedule.md}
```

**Fallback** (Daniel didn't reply at all): write the same file with priorities populated by the heuristic the morning tick would use otherwise (highest-P idle ≥2 days, tiebreak by shortest scope). Mark `Priorities (Telos default — Daniel did not respond)` so the morning tick knows this is unconfirmed.

## 5. Commit and push

Run via Bash:

```
cd /workspace/extra/constantia
git add goals/today-plan.md
git commit -m "plan(daily): tomorrow {YYYY-MM-DD} captured by 10pm tick"
git pull --rebase --autostash
git push
```

Capture stderr on each step. If push fails (e.g., divergence), surface in your final DM so Daniel can resolve from laptop. Do not retry destructively.

## 6. Confirm in DM

One sentence, English:

- State (a/b confirmed): `"today-plan.md committed: {P-NNN}, {P-NNN}, {P-NNN}. 9am tick will read this as authoritative."`
- State (c default fallback): `"No reply tonight — wrote a default plan to today-plan.md ({P-NNN}, {P-NNN}). Override in the morning if wrong."`
- Push failed: append `" — push failed, file is local; please `git push` from laptop."`

## Voice rules

- **Short, English, DM-only.** No emojis, no greeting, no sign-off. Same register as morning/evening ticks.
- **Don't re-ask if state-a applies.** Pinging Daniel twice in 60 minutes for the same thing is noise.
- **Don't synthesize.** This is capture, not reflection. The 11pm tick reflects.
- **No portfolio actions.** No `assign_task`, no `grade_task`, no `accept_proposal` from this prompt. Triage is the morning tick's job. The 10pm tick writes one file and confirms.
- **Honest fallback.** If Daniel is silent, write a stub marked as Telos's default — don't fabricate Daniel's intent. The morning tick will see the marker and treat it accordingly.

## Notes

- This tick depends on Daniel being awake near 10pm. If he's already asleep (no evening-brief reply, no transcript activity past 8pm), state (c) fallback fires automatically — that's working as intended, not a bug.
- The morning tick reads `today-plan.md` before falling back to heuristic — see `tick-morning-prompt.md` step 1 (load order) + step 2 (the-one-thing-today derivation).
- If the file write succeeds but commit fails (e.g., pre-commit hook rejects, conflict), surface the error in your DM and leave the file in working state for manual reconcile. Never `git reset --hard`.
- A scheduled tick is your responsibility — Daniel did not ping you. Write as a daily handoff, not a reply.
