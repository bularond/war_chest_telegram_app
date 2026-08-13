/**
 * What the lab decides, apart from the games that inform it.
 *
 * `lab-cli.ts` is the loop: read the plan, play the match, write the journal.
 * This is the part that turns a proposal into a configuration and refuses a plan
 * that cannot mean what it says — the two places where a mistake is silent
 * rather than loud. A wrong verdict announces itself; a proposal that quietly
 * changes nothing plays several hundred games between two identical bots and
 * reports an honest-looking REJECT.
 *
 * It lives here for the same reason `sprt.ts` and `spsa.ts` do: anything that
 * decides something in this project has to be checkable without playing a
 * match.
 */

import { BASE_WEIGHTS, DEFAULT_SEARCH, type EvalWeights } from '@wc/bots';
import type { DraftMode, UnitSet } from '@wc/shared';
import type { SearchKnobs } from './bot-spec.js';

export type WeightKey = Exclude<keyof EvalWeights, 'version'>;

/** Weights and the knobs they were measured under: one thing, tuned together. */
export interface Config {
  readonly weights: EvalWeights;
  readonly knobs: SearchKnobs;
}

/**
 * One thing to try. `set` and `knobs` are absolute; `scale` is relative to
 * whatever the baseline holds when the experiment comes up, which is what a
 * descent step means.
 */
export interface Proposal {
  readonly id: string;
  readonly note?: string;
  readonly set?: Partial<Record<WeightKey, number>>;
  readonly knobs?: SearchKnobs;
  readonly scale?: { readonly key: WeightKey; readonly factor: number };
  /** A search knob scaled instead of set: same idea, rounded where it must be. */
  readonly scaleKnob?: { readonly key: 'exploration' | 'rolloutDepth'; readonly factor: number };
  readonly elo1?: number;
  /** Overrides `--max-games` for this one experiment. */
  readonly maxGames?: number;
  /**
   * `random` deals the units and keeps the draft out of the measurement, which
   * is what a question about the middlegame wants. A question about the *draft*
   * needs `draft`, and so does anything that claims to be about how the bot
   * plays a real game: a lobby deals a draft unless told otherwise.
   */
  readonly draftMode?: DraftMode;
  /**
   * Which boxes are on the table. Everything so far has been measured on the
   * base game alone, while a lobby can put all three expansions out — so a
   * weight accepted here is a weight accepted for one of the games the app
   * offers, not for all of them.
   */
  readonly sets?: readonly UnitSet[];
  /**
   * Play the current baseline against what the night started from, and change
   * nothing whatever the answer.
   *
   * A chain of accepted steps does not add up to a known gain — each step was
   * measured against the one before it, on its own deals, and SPRT says "better
   * than that" rather than "better by this much". The only honest number for the
   * night as a whole comes from playing the two ends against each other on deals
   * neither of them was chosen on.
   */
  readonly against?: 'root';
}


/** What the search uses when a knob is not set, so a step can scale from it. */
export const DEFAULT_KNOBS = {
  exploration: DEFAULT_SEARCH.exploration,
  rolloutDepth: DEFAULT_SEARCH.rolloutDepth,
} as const;

/** Applies a proposal to the current baseline. Null if it cannot mean anything. */
export function resolve(base: Config, p: Proposal): { config: Config; change: string } | null {
  let weights = base.weights;
  let knobs = base.knobs;
  const parts: string[] = [];

  if (p.scale) {
    const from = weights[p.scale.key] ?? 0;
    // A weight pinned at zero cannot be scaled into existence; turning a feature
    // on is what `set` is for.
    if (from === 0) return null;
    const to = Number((from * p.scale.factor).toFixed(4));
    weights = { ...weights, [p.scale.key]: to };
    parts.push(`${p.scale.key} ${from} → ${to}`);
  }
  if (p.scaleKnob) {
    const { key, factor } = p.scaleKnob;
    const from = (knobs[key] ?? DEFAULT_KNOBS[key]) as number;
    // Rollout depth is a count of plies; a fractional one is not a thing, and
    // neither is a depth of zero — that is a different search, not a smaller
    // step of this one. The exploration constant has no such floor: it lives
    // below 1 and always has, so the guard has to know which knob it is looking
    // at. It did not, and every descent step on exploration was silently
    // discarded as "nothing to change" — with a REJECT and no games played,
    // which reads in the report exactly like a real verdict.
    const to = key === 'rolloutDepth' ? Math.round(from * factor) : Number((from * factor).toFixed(4));
    if (to === from) return null;
    if (key === 'rolloutDepth' && to < 1) return null;
    if (to <= 0) return null;
    knobs = { ...knobs, [key]: to };
    parts.push(`${key} ${from} → ${to}`);
  }
  // A key already at its target is skipped, not fatal. A proposal that sets one
  // weight and finds it already set has nothing to do — but a proposal that sets
  // twelve at once, as a fitted vector does, will always agree with the baseline
  // about *something*, and throwing the whole thing away over that would
  // silently drop the experiment and report it as "nothing to change".
  for (const [key, value] of Object.entries(p.set ?? {})) {
    if ((weights[key as WeightKey] ?? 0) === value) continue;
    parts.push(`${key} ${weights[key as WeightKey] ?? 0} → ${value}`);
    weights = { ...weights, [key]: value };
  }
  for (const [key, value] of Object.entries(p.knobs ?? {})) {
    if ((knobs as Record<string, unknown>)[key] === value) continue;
    parts.push(`${key} ${String((knobs as Record<string, unknown>)[key] ?? 'default')} → ${String(value)}`);
    knobs = { ...knobs, [key]: value };
  }
  // Nothing moved at all: that is the "nothing to change" case, and the only one.
  if (parts.length === 0) return null;

  return {
    config: { weights: { ...weights, version: `${base.weights.version}+${p.id}` }, knobs },
    change: parts.join(', '),
  };
}

/**
 * Reads the plan the way the queue will, and complains about anything that
 * cannot mean what it says.
 *
 * The plan is a JSON file edited by hand, often at three in the morning, and a
 * typo in it does not fail — `{"set": {"mateiral": 1}}` adds a key nothing reads
 * and quietly plays several hundred games between two identical bots. That is
 * the most expensive kind of mistake this thing can make, so it is worth half a
 * second at startup.
 */
export function checkPlan(proposals: readonly Proposal[]): string[] {
  // Against what the code knows, not against what happens to be in the baseline
  // file: a feature added since that file was written is a real weight, and a
  // proposal is exactly how it gets switched on for the first time.
  const weightKeys = new Set(Object.keys(BASE_WEIGHTS));
  const knobKeys = new Set([
    'iterations',
    'rolloutDepth',
    'exploration',
    'checkEvery',
    'quickRollouts',
    'draftBy',
    'firstPlay',
    'levelLeaves',
    'rolloutNoise',
    'rankTactics',
  ]);
  const modes = new Set(['random', 'draft', 'ban']);
  const boxes = new Set(['base', 'nobility', 'siege', 'nightfall']);
  const seen = new Set<string>();
  const bad: string[] = [];

  for (const p of proposals) {
    if (!p.id) bad.push('a proposal with no id');
    else if (seen.has(p.id)) bad.push(`${p.id}: two proposals share this id, and the second will never run`);
    seen.add(p.id);
    for (const key of Object.keys(p.set ?? {})) {
      if (!weightKeys.has(key)) bad.push(`${p.id}: "${key}" is not a weight`);
    }
    for (const key of Object.keys(p.knobs ?? {})) {
      if (!knobKeys.has(key)) bad.push(`${p.id}: "${key}" is not a search knob`);
    }
    if (p.scale && !weightKeys.has(p.scale.key)) bad.push(`${p.id}: "${p.scale.key}" is not a weight`);
    if (p.draftMode && !modes.has(p.draftMode)) bad.push(`${p.id}: "${p.draftMode}" is not a draft mode`);
    for (const set of p.sets ?? []) if (!boxes.has(set)) bad.push(`${p.id}: "${set}" is not a box`);
    if (p.against && p.against !== 'root') bad.push(`${p.id}: "against" can only be "root"`);
    if (!p.set && !p.knobs && !p.scale && !p.scaleKnob && !p.against) {
      bad.push(`${p.id}: changes nothing and asks nothing`);
    }
  }
  return bad;
}

