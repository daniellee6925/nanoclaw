# 10am tick — realtime voice-AI brief

Scheduled turn; Daniel did not ping you. **One message out, ≤1900 chars (a single `send_message`).** Two parts: what's new, and one thing to catch up on.

## 1. Ground

- `memory/realtime/tracked.md` — watch list, Daniel's interest signals, catch-up backlog, `bootstrapped:` flag.
- `memory/realtime/sent.md` — everything already sent. Never resend an item. A genuinely new development on an old story is fine — say what changed.
- `user.md` → engine context — what "matters for his engine" means concretely.
- **News window:** from the most recent date in `sent.md` until now, capped at 7 days. Empty `sent.md` → the last 7 days.

## 2. Bootstrap (only when `bootstrapped: no`)

Before the normal brief, build the catch-up backlog: 10–15 things someone building a realtime voice API in late 2026 must know. Cover major realtime model/API releases of the past ~12 months, techniques that became standard, and architecture shifts (e.g. cascaded vs speech-to-speech, semantic turn detection). Verify each one with WebSearch. Order by importance to his engine. Write them to the backlog, then set `bootstrapped: yes`.

## 3. Scan for news

Run targeted WebSearch queries across the watch list — roughly 6–10 searches, named products and techniques, not "AI news today." Open primary sources (vendor changelog/blog, release notes, paper, GitHub release) with WebFetch before you trust a claim. Check publication dates; keep only items inside the window.

Keep an item only if you can write a concrete *why you care* line for his engine. **0–3 items.** Zero is a valid result.

## 4. Pick the catch-up item

The top unchecked backlog item. Include it unless three heavy news items already fill the budget. While scanning, if you find something older than the window that he should know, add it to the backlog in priority order — don't send it as news.

## 5. Compose

```
**Realtime — {Mon} {MMM D}**

**New since {last brief date}:**
- **{headline}** — {what happened, 1 sentence, with the concrete number if there is one}. Why you care: {1 sentence tied to his engine}. {URL}

**Catch up:** **{topic}** — {2–3 sentences: what it is, why it matters for his engine, what to look at}. {URL}
```

When there's no news: replace the list with `Nothing worth your time since {date}.` and keep the catch-up section.

Voice: numbers over adjectives (latency in ms, price per minute, languages, model size). Mark vendor-reported benchmarks as `vendor-reported`. No hype words ("exciting", "game-changing", "huge"). No greeting, no sign-off.

## 6. Send, then write memory

1. `send_message` the brief.
2. `sent.md`: append one line per item sent — `{YYYY-MM-DD} | news | {headline} | {URL}` and `{YYYY-MM-DD} | catch-up | {topic} | {URL}`.
3. `tracked.md`: check off the catch-up item; add newly found backlog items; add any new player worth watching to the watch list.
4. Prune `sent.md` lines older than 90 days.
5. End the turn with no text — only `<internal>` notes if anything. Final text is posted to the chat.

If WebSearch is failing entirely, send one line — `Realtime brief skipped: web search unavailable.` — and stop. Don't compose from memory.
