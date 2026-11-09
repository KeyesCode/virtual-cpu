import type { Redis } from 'ioredis';

/** Flags outlive any experiment: a week is far longer than a campaign keeps one live. */
const FLAG_TTL_SECONDS = 7 * 24 * 60 * 60;

interface CancelMessage {
  readonly experimentId: string;
  readonly reason: string;
}

/**
 * Cancellation through Redis: a flag the processor checks between stages, and a message on a
 * channel that makes the worker running the experiment abort its stage (which kills the command
 * the stage started).
 */
export class Cancellation {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private flagKey(experimentId: string): string {
    return `${this.prefix}:cancel:${experimentId}`;
  }

  get channel(): string {
    return `${this.prefix}:cancel`;
  }

  /** Set the flag, then tell any worker running the experiment. */
  async request(experimentId: string, reason: string): Promise<void> {
    await this.redis.set(this.flagKey(experimentId), reason, 'EX', FLAG_TTL_SECONDS);
    const message: CancelMessage = { experimentId, reason };
    await this.redis.publish(this.channel, JSON.stringify(message));
  }

  /** The reason the experiment was cancelled, or null. */
  async check(experimentId: string): Promise<string | null> {
    return this.redis.get(this.flagKey(experimentId));
  }

  /**
   * Listen for cancel messages on a dedicated connection (a subscribed Redis connection can do
   * nothing else). Returns a function that stops listening.
   */
  async listen(
    subscriber: Redis,
    onCancel: (experimentId: string, reason: string) => void,
  ): Promise<() => Promise<void>> {
    const channel = this.channel;
    const handler = (from: string, payload: string) => {
      if (from !== channel) return;
      try {
        const message = JSON.parse(payload) as CancelMessage;
        onCancel(message.experimentId, message.reason);
      } catch {
        // A malformed message cancels nothing.
      }
    };
    subscriber.on('message', handler);
    await subscriber.subscribe(channel);
    return async () => {
      subscriber.off('message', handler);
      await subscriber.unsubscribe(channel);
    };
  }
}
