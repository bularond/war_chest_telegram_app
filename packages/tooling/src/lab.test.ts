/**
 * The two decisions the lab makes without playing anything: what a proposal
 * means, and whether a plan means anything at all.
 *
 * Both fail quietly when they fail. A proposal that changes nothing plays
 * several hundred games between two identical bots and reports a REJECT that
 * looks exactly like a real one; a typo in a weight name adds a key nothing
 * reads and does the same. Every case below is one of those — a mistake that
 * costs half an hour of a night and leaves no mark.
 */

import { BASE_WEIGHTS } from '@wc/bots';
import { describe, expect, it } from 'vitest';
import { checkPlan, resolve, type Config, type Proposal } from './lab.js';

const base: Config = {
  weights: { ...BASE_WEIGHTS, version: 'eval@3', markers: 1, material: 0.7, reserve: 0.15, proximity: 0.4 },
  knobs: { exploration: 0.45 },
};

describe('what a proposal means', () => {
  it('sets a weight', () => {
    const out = resolve(base, { id: 'x', set: { reserve: 0.48 } });
    expect(out?.config.weights.reserve).toBe(0.48);
    expect(out?.change).toBe('reserve 0.15 → 0.48');
  });

  it('scales a weight against whatever the baseline holds now', () => {
    const out = resolve(base, { id: 'x', scale: { key: 'material', factor: 0.5 } });
    expect(out?.config.weights.material).toBe(0.35);
  });

  it('cannot scale a weight out of zero, because zero is a verdict', () => {
    expect(resolve(base, { id: 'x', scale: { key: 'bolster', factor: 2 } })).toBeNull();
  });

  it('keeps a rollout depth a whole number of plies', () => {
    const out = resolve(base, { id: 'x', scaleKnob: { key: 'rolloutDepth', factor: 1.5 } });
    expect(out?.config.knobs.rolloutDepth).toBe(18);
  });

  it('refuses a step too small to change anything', () => {
    expect(resolve(base, { id: 'x', scaleKnob: { key: 'rolloutDepth', factor: 1.01 } })).toBeNull();
  });

  it('runs a proposal that agrees with the baseline about some of it', () => {
    // The one that bit: a fitted vector sets every weight at once and will
    // always agree with the baseline about something. Dropping the whole
    // proposal over that would silently lose the experiment — and report it as
    // "nothing to change", which reads like a result.
    const out = resolve(base, { id: 'fit', set: { markers: 1, reserve: 0.48, material: 0.35 } });
    expect(out).not.toBeNull();
    expect(out?.config.weights.reserve).toBe(0.48);
    expect(out?.config.weights.material).toBe(0.35);
    // The key that already matched is not reported as a change, because it is not one.
    expect(out?.change).not.toContain('markers');
  });

  it('refuses a proposal that changes nothing at all', () => {
    expect(resolve(base, { id: 'x', set: { markers: 1 } })).toBeNull();
    expect(resolve(base, { id: 'x', knobs: { exploration: 0.45 } })).toBeNull();
    expect(resolve(base, { id: 'x' })).toBeNull();
  });

  it('leaves the baseline it was handed untouched', () => {
    const before = JSON.stringify(base);
    resolve(base, { id: 'x', set: { reserve: 0.9 }, knobs: { rolloutDepth: 3 } });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('stamps the candidate with what made it', () => {
    const out = resolve(base, { id: 'reserve-048', set: { reserve: 0.48 } });
    expect(out?.config.weights.version).toBe('eval@3+reserve-048');
  });
});

describe('whether a plan means anything', () => {
  const ok = (proposals: Proposal[]) => checkPlan(proposals);

  it('passes a plan that says what it means', () => {
    expect(
      ok([
        { id: 'a', set: { reserve: 0.4 } },
        { id: 'b', knobs: { exploration: 0.3 } },
        { id: 'c', against: 'root' },
        { id: 'd', sets: ['nobility'], draftMode: 'draft', knobs: { draftBy: 'scarcity' } },
      ]),
    ).toEqual([]);
  });

  it('catches a weight that does not exist', () => {
    expect(ok([{ id: 'typo', set: { mateiral: 1 } as never }])[0]).toContain('"mateiral" is not a weight');
  });

  it('knows the rollout noise knob, which is a knob and not a weight', () => {
    expect(ok([{ id: 'noise', knobs: { rolloutNoise: 0.15 } }])).toEqual([]);
    expect(ok([{ id: 'wrong', set: { rolloutNoise: 0.15 } as never }])[0]).toContain('is not a weight');
  });

  it('catches a knob that does not exist', () => {
    expect(ok([{ id: 'typo', knobs: { explore: 1 } as never }])[0]).toContain('is not a search knob');
  });

  it('catches a feature that exists in the code but not in this baseline file', () => {
    // The reverse mistake: `threat` is a real weight even though an older
    // weights file has no key for it, and a proposal is how it gets switched on.
    expect(ok([{ id: 'threat', set: { threat: 0.2 } }])).toEqual([]);
  });

  it('catches two proposals sharing an id, since the second would never run', () => {
    const bad = ok([
      { id: 'same', set: { reserve: 0.2 } },
      { id: 'same', set: { reserve: 0.3 } },
    ]);
    expect(bad[0]).toContain('never run');
  });

  it('catches a proposal that asks nothing', () => {
    expect(ok([{ id: 'empty' }])[0]).toContain('changes nothing');
  });

  it('catches a box and a draft mode that are not real', () => {
    expect(ok([{ id: 'x', sets: ['expansion'] as never, set: { reserve: 1 } }])[0]).toContain('is not a box');
    expect(ok([{ id: 'y', draftMode: 'shuffle' as never, set: { reserve: 1 } }])[0]).toContain(
      'is not a draft mode',
    );
  });
});

describe('scaling a search knob', () => {
  it('lets the exploration constant go below one', () => {
    // It lives below one — 0.45 is the accepted value — so a floor of 1 turned
    // every descent step on it into "nothing to change": a REJECT with no games
    // played, which reads like a verdict and is not one.
    const out = resolve(base, { id: 'x', scaleKnob: { key: 'exploration', factor: 2 } });
    expect(out?.config.knobs.exploration).toBe(0.9);
    const down = resolve(base, { id: 'y', scaleKnob: { key: 'exploration', factor: 0.5 } });
    expect(down?.config.knobs.exploration).toBe(0.225);
  });

  it('keeps a rollout depth at one ply or more', () => {
    const shallow: Config = { ...base, knobs: { ...base.knobs, rolloutDepth: 1 } };
    expect(resolve(shallow, { id: 'x', scaleKnob: { key: 'rolloutDepth', factor: 0.5 } })).toBeNull();
  });
});
