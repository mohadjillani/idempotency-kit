import { createHash } from 'node:crypto';

export interface Completion {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export class ProviderOverloaded extends Error {
  readonly retryAfterSeconds = 2;
  constructor() {
    super('The model provider is overloaded');
    this.name = 'ProviderOverloaded';
  }
}

export class ContentRefused extends Error {
  constructor() {
    super('The prompt was refused by the content filter');
    this.name = 'ContentRefused';
  }
}

export interface ProviderOptions {
  /** Simulated time between tokens. Default 15ms. */
  tokenLatencyMs?: number;
  /** Price per 1,000 tokens in hundredths of a cent, to keep the ledger integral. */
  pricePerThousand?: number;
}

// Typed as a non-empty tuple so the fallback below is a `string`.
const WORDS: readonly [string, ...string[]] = [
  'the',
  'model',
  'returns',
  'a',
  'different',
  'answer',
  'every',
  'time',
  'you',
  'ask',
  'it',
  'twice',
];

/**
 * A stand-in for a model provider, with the two properties that make this
 * example worth having.
 *
 * It is **non-deterministic**: the same prompt produces a different completion
 * on every call, the way sampling does. And it is **metered**: every call adds
 * to a token ledger whether or not the caller keeps the answer.
 *
 * Together those mean a retry is not free and not equivalent. A payment
 * charged twice is at least the same payment; a completion generated twice is
 * a second bill for a different answer.
 */
export class MockProvider {
  calls = 0;
  tokensBilled = 0;
  private readonly latency: number;
  private readonly price: number;
  /** Not seeded from the prompt: two calls with the same prompt must differ. */
  private sequence = 0;

  constructor(options: ProviderOptions = {}) {
    this.latency = options.tokenLatencyMs ?? 15;
    this.price = options.pricePerThousand ?? 150;
  }

  get costInHundredthsOfACent(): number {
    return Math.round((this.tokensBilled * this.price) / 1000);
  }

  /**
   * Streams a completion token by token.
   *
   * The billing happens as tokens are produced, not at the end, which is why
   * an aborted stream still costs something.
   */
  async *stream(prompt: string): AsyncGenerator<string, Completion> {
    this.calls += 1;
    if (prompt.includes('__overloaded__')) throw new ProviderOverloaded();
    if (prompt.includes('__refused__')) throw new ContentRefused();

    const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
    this.tokensBilled += promptTokens;

    const salt = this.sequence++;
    const digest = createHash('sha256')
      .update(`${prompt}:${String(salt)}`)
      .digest();
    const length = 4 + (digest.readUInt8(0) % 5);
    const produced: string[] = [];

    for (let index = 0; index < length; index += 1) {
      if (this.latency > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.latency));
      }
      // The fallback is unreachable — the index is taken modulo the length —
      // but writing it out is cheaper than an assertion that hides a real bug.
      const word = WORDS[digest.readUInt8(index + 1) % WORDS.length] ?? WORDS[0];
      produced.push(word);
      this.tokensBilled += 1;
      yield word;
    }

    return {
      text: produced.join(' '),
      promptTokens,
      completionTokens: produced.length,
    };
  }
}
