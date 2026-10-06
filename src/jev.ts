import { protectOutboundData } from '@prjct.app/pi-secrets/privacy';
import { KEYRING_ACCOUNT, KEYRING_SERVICE, keyringStoreFromEntries, resolveKey, JEV_MODEL } from '@prjct.app/pi-tui-kit';
import type { Questions } from '@typesafe-ai/sdk';

/**
 * Jev: one typed judgement in about 300 ms, for a fraction of a cent.
 *
 * It never writes and never sits on the agent's path. Every caller here treats
 * it as optional: no key, a timeout or an error means the code does exactly
 * what it did before Jev existed.
 */
export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, unknown> };
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Jev = (state: unknown, questions: Questions, signal?: AbortSignal) => Promise<Record<string, JevAnswer>>;
export type ConnectJev = () => Promise<Jev | undefined>;

/** Pinned like pi-qa and pi-memory: a silent model swap would move every threshold. */
export { JEV_MODEL };
const TIMEOUT_MS = 8_000;

/** The one TypeSafe key every prjct extension shares: TYPESAFE_API_KEY, then the OS keyring. */
export const connectJev: ConnectJev = async () => {
  if (process.env.PI_SUBAGENTS_OFFLINE === '1') return undefined;
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const resolved = await resolveKey(keyringStoreFromEntries(new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT)));
    if (!resolved.key) return undefined;
    const { TypeSafeClient } = await import('@typesafe-ai/sdk');
    // One attempt: a decision that arrives late is worth less than the fallback.
    const client = new TypeSafeClient({ apiKey: resolved.key, defaultModel: JEV_MODEL, logLevel: 'off', timeout: TIMEOUT_MS, retry: { maxRetries: 0 } });
    return async (state, questions, signal) =>
      (await client.systemOne(await protectOutboundData({ state: state as never, questions }), { signal })).answers as unknown as Record<string, JevAnswer>;
  } catch {
    return undefined;
  }
};
