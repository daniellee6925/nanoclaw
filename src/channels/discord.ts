/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { useBareDiscordLinks } from './format-links.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    // The adapter re-serializes every link (bare URLs included) as a masked
    // [text](url), which Discord shows as dead text. Render links as bare /
    // labelled URLs Discord auto-links instead. See format-links.ts, issue #3.
    if (!useBareDiscordLinks(discordAdapter)) {
      log.error('Discord link fix not applied — @chat-adapter/discord internals changed; links will be unclickable');
    }
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      // Discord rejects messages >2000 chars. Without this the bridge silently
      // truncates long outputs (morning briefs, reflections, capture summaries).
      // splitForLimit() splits on paragraph → line → space → hard-char.
      // Re-applied 2026-05-19 (was dropped during the WORK/LIFE/LEARN session
      // split refactor) — see nanoclaw issue #1.
      maxTextLength: 2000,
    });
  },
});
