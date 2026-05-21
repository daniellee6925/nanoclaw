/**
 * format-links.ts — Discord outbound link sanitizer.
 *
 * Discord does not render Markdown masked links (`[text](url)`) in normal bot
 * messages — only inside embeds — so Telos's briefs and replies show the link
 * as literal, non-clickable text and Daniel has to copy-paste the URL by hand.
 * Discord DOES auto-link bare URLs (`https://…`) in plain messages.
 *
 * `bareDiscordLinks` rewrites `[text](url)` → `text: url` (or a bare `url` when
 * the label is empty or already equals the URL) so the link becomes clickable.
 * It's wired as the Discord channel's `transformOutboundText`, which the
 * chat-sdk bridge applies to all outbound text before delivery.
 *
 * Discord-specific by design: Slack uses `<url|text>` syntax and Telegram
 * renders Markdown links natively, so neither needs (or wants) this rewrite.
 *
 * See nanoclaw issue #3.
 */

// Markdown link or image: an optional leading "!" (image), then [label](url)
// where the target is an http(s) URL. Restricting the target to http(s) is
// deliberate — it matches exactly the case Discord would auto-link as a bare
// URL, and avoids mangling non-link bracket/paren sequences like "[0](1)" or
// anchor links like "[ref](#section)".
//
// Known limitation: the URL group stops at the first ")", so a URL containing
// balanced parens (e.g. a Wikipedia "..._(disambiguation)" link) loses its
// trailing paren. This is the standard regex-Markdown tradeoff and is rare in
// Telos's actual output (PRs, dashboards, issue links); punted per the issue.
const MD_LINK_RE = /!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

// Code spans must be left untouched — a URL inside an inline `code` span or a
// ``` fenced block is content, not a link to surface. Fenced blocks come first
// in the alternation so triple-backticks are consumed before the single-
// backtick inline form.
const CODE_SPAN_RE = /```[\s\S]*?```|`[^`]*`/g;

function rewriteLinks(segment: string): string {
  return segment.replace(MD_LINK_RE, (_match, label: string, url: string) => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === url) return url;
    return `${trimmed}: ${url}`;
  });
}

/**
 * Rewrite Markdown masked links to bare/labelled URLs that Discord auto-links,
 * leaving code spans (inline and fenced) untouched. Idempotent on text that
 * has no masked links — returns it unchanged with no allocation.
 */
export function bareDiscordLinks(text: string): string {
  if (!text) return text;
  // Fast path: "](" is a necessary substring of any masked link. If it's
  // absent, there's nothing to rewrite — skip the code-span walk entirely.
  if (!text.includes('](')) return text;

  let result = '';
  let lastIndex = 0;
  CODE_SPAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_SPAN_RE.exec(text)) !== null) {
    // Rewrite the non-code text preceding this code span, then append the
    // code span verbatim so anything inside it is preserved exactly.
    result += rewriteLinks(text.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  // Rewrite the trailing non-code remainder.
  result += rewriteLinks(text.slice(lastIndex));
  return result;
}
