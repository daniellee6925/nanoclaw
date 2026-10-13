import { createDiscordAdapter } from '@chat-adapter/discord';
import { describe, expect, it } from 'vitest';

import { renderDiscordLink, useBareDiscordLinks } from './format-links.js';

// Render exactly as postMessage does — the adapter's own formatConverter
// .renderPostable({ markdown }). Testing a string transform in isolation is the
// seam that hid this bug: the adapter re-parses the text and re-wraps links.
function discordRender(markdown: string): string {
  const adapter = createDiscordAdapter({ botToken: 'test', publicKey: '0'.repeat(64), applicationId: '1' });
  expect(useBareDiscordLinks(adapter)).toBe(true);
  const { formatConverter } = adapter as unknown as {
    formatConverter: { renderPostable(message: { markdown: string }): string };
  };
  return formatConverter.renderPostable({ markdown });
}

describe('Discord outbound links (adapter render path)', () => {
  it('keeps a bare URL bare instead of re-wrapping it as [url](url)', () => {
    expect(discordRender('see https://example.com/a-b today')).toBe('see https://example.com/a-b today');
  });

  it('renders a masked link as "label: url"', () => {
    expect(discordRender('read [the post](https://example.com/p) now')).toBe(
      'read the post: https://example.com/p now',
    );
  });

  it('leaves an @ inside a URL alone (no <@mention> rewrite)', () => {
    expect(discordRender('by https://medium.com/@user/post')).toBe('by https://medium.com/@user/post');
  });

  it('keeps an image link as "alt: url" instead of dropping it', () => {
    expect(discordRender('![chart](https://example.com/c.png)')).toBe('chart: https://example.com/c.png');
  });

  it('leaves URLs inside code spans untouched', () => {
    expect(discordRender('code `https://x.com` here')).toBe('code `https://x.com` here');
  });

  it('leaves URLs inside fenced code blocks untouched', () => {
    expect(discordRender('```\ncurl https://x.com/api\n```')).toBe('```\ncurl https://x.com/api\n```');
  });

  it('unwraps every link in one message', () => {
    expect(discordRender('[a](https://a.com) and https://b.com')).toBe('a: https://a.com and https://b.com');
  });

  it('keeps surrounding formatting while unwrapping the link', () => {
    const out = discordRender('**Catch up:** **Topic** — two sentences. https://example.com/post');
    expect(out).toBe('**Catch up:** **Topic** — two sentences. https://example.com/post');
    expect(out).not.toContain('](');
  });
});

describe('renderDiscordLink', () => {
  it('emits the bare url when the label is empty or is the url itself', () => {
    expect(renderDiscordLink('', 'https://a.com')).toBe('https://a.com');
    expect(renderDiscordLink('https://a.com', 'https://a.com')).toBe('https://a.com');
  });

  it('emits the full url for a scheme-less autolink label', () => {
    expect(renderDiscordLink('www.a.com', 'http://www.a.com')).toBe('http://www.a.com');
  });

  it('emits the plain address for mailto links', () => {
    expect(renderDiscordLink('me@a.com', 'mailto:me@a.com')).toBe('me@a.com');
  });

  it('labels a link whose text differs from its url', () => {
    expect(renderDiscordLink(' the PR ', 'https://github.com/x/y/pull/1')).toBe(
      'the PR: https://github.com/x/y/pull/1',
    );
  });
});
