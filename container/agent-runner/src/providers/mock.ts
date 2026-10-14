import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * A scripted turn: text blocks the agent writes mid-turn (before/between tool
 * calls), then the turn's final result text.
 */
export interface MockTurn {
  texts?: string[];
  result: string | null;
}

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 * A factory returning a string yields just a result; returning a MockTurn
 * also yields its mid-turn `text` events first.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string) => string | MockTurn;

  constructor(_options: ProviderOptions = {}, responseFactory?: (prompt: string) => string | MockTurn) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;
    function* turn(prompt: string): Generator<ProviderEvent> {
      const response = responseFactory(prompt);
      if (typeof response === 'string') {
        yield { type: 'result', text: response };
        return;
      }
      for (const text of response.texts ?? []) yield { type: 'text', text };
      yield { type: 'result', text: response.result };
    }

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt
        yield { type: 'activity' };
        yield* turn(input.prompt);

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield* turn(msg);
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          yield* turn(msg);
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));
