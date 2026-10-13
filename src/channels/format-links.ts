/**
 * format-links.ts — make links in Discord bot messages clickable.
 *
 * Calling spec:
 *   renderDiscordLink(label, url) → string
 *     Pure. How one link should read in a plain Discord message: the bare URL
 *     for autolinks, `label: url` otherwise, the plain address for mailto.
 *   useBareDiscordLinks(adapter) → boolean
 *     Side effect: patches the adapter's link-node rendering so every outbound
 *     message (post and edit) uses renderDiscordLink. Returns false — patching
 *     nothing — if the adapter's internals no longer match.
 *
 * Why: the Chat SDK Discord adapter renders outbound `{ markdown }` by parsing
 * it (GFM, which autolinks bare URLs) and re-serializing every link node as a
 * masked link `[text](url)`. Discord does not render masked links in plain bot
 * messages — and never renders one whose label is itself a URL — so every link
 * arrived as dead text and Daniel had to copy URLs by hand. Discord DOES
 * auto-link bare `https://…` URLs, so link nodes are rendered as bare or
 * labelled URLs instead.
 *
 * This has to happen at the AST → Discord step. The first fix for issue #3
 * rewrote the markdown string before posting; the adapter re-parsed it and
 * wrapped the now-bare URLs right back into `[url](url)`.
 *
 * Relies on adapter internals (`formatConverter`, `nodeToDiscordMarkdown`) of
 * the pinned @chat-adapter/discord version. format-links.test.ts renders
 * through a real adapter instance, so an upgrade that moves them fails there.
 */
import { DiscordFormatConverter, type createDiscordAdapter } from '@chat-adapter/discord';
import { getNodeChildren, isLinkNode } from 'chat';

type MdNode = Parameters<typeof getNodeChildren>[0];
type NodeRenderer = (node: MdNode) => string;

export function renderDiscordLink(label: string, url: string): string {
  if (url.startsWith('mailto:')) return url.slice('mailto:'.length);
  const text = label.trim();
  // Autolinks: the label is the URL itself, or a scheme-less "www.x" for "http://www.x".
  if (!text || text === url || url.endsWith(`://${text}`)) return url;
  return `${text}: ${url}`;
}

// Label as written, without the adapter's text-node rewrites (e.g. "@user" →
// "<@user>"), so an autolinked URL containing "@" is still recognized as one.
function plainText(node: MdNode): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  return getNodeChildren(node).map(plainText).join('');
}

export function useBareDiscordLinks(adapter: ReturnType<typeof createDiscordAdapter>): boolean {
  const converter = (adapter as unknown as { formatConverter?: unknown }).formatConverter;
  if (!(converter instanceof DiscordFormatConverter)) return false;
  const target = converter as unknown as { nodeToDiscordMarkdown?: NodeRenderer };
  if (typeof target.nodeToDiscordMarkdown !== 'function') return false;

  const base = target.nodeToDiscordMarkdown.bind(converter);
  // Assigned on the instance so the converter's own recursive calls
  // (`this.nodeToDiscordMarkdown(child)`) also route through it.
  target.nodeToDiscordMarkdown = (node) => {
    if (isLinkNode(node)) return renderDiscordLink(plainText(node), node.url);
    if (node.type === 'image') return renderDiscordLink(node.alt ?? '', node.url);
    return base(node);
  };
  return true;
}
