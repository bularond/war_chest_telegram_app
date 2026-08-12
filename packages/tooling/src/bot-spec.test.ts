/**
 * A bot description has one job: to arrive intact on the far side of a worker
 * boundary and build the bot it names. A knob that is silently dropped there
 * does not fail — it plays a match of the baseline against itself and reports
 * "no difference", which is the most expensive kind of wrong answer this
 * project can produce.
 */

import { createGame, createRng, publicStateFor, actingSeat } from '@wc/shared';
import { BASE_WEIGHTS } from '@wc/bots';
import { describe, expect, it } from 'vitest';
import { botFromSpec, specName, type BotSpec } from './bot-spec.js';

const view = () => {
  const state = createGame({
    id: 'spec',
    size: 2,
    seed: 4,
    draftMode: 'random',
    seats: [
      { userId: 'a', displayName: 'A' },
      { userId: 'b', displayName: 'B' },
    ],
  });
  return publicStateFor(state, actingSeat(state));
};

describe('bot specs', () => {
  it('survives being sent to a worker', () => {
    const spec: BotSpec = {
      kind: 'search',
      label: 'candidate',
      weights: { ...BASE_WEIGHTS, threat: 0.2 },
      knobs: { exploration: 0.45, rolloutDepth: 6, quickRollouts: true },
    };
    // `structuredClone` is what the boundary does to it.
    const there = structuredClone(spec) as BotSpec;
    expect(there).toEqual(spec);
    expect(specName(there)).toBe('candidate');
    expect(botFromSpec(there).name).toBe('candidate');
  });

  it('builds a bot that plays, with the cheap rollout policy and without', () => {
    const v = view();
    for (const quickRollouts of [false, true]) {
      const bot = botFromSpec({
        kind: 'search',
        label: `q${quickRollouts}`,
        weights: BASE_WEIGHTS,
        knobs: { iterations: 40, quickRollouts },
      });
      const action = bot.chooseMove(v, { rng: createRng(1), budget: { iterations: 40 } });
      expect(v.legal.some((a) => JSON.stringify(a) === JSON.stringify(action))).toBe(true);
    }
  });

  it('says which bot it could not find rather than quietly playing another', () => {
    expect(() => botFromSpec({ kind: 'named', name: 'nope' })).toThrow(/nope/);
  });
});
