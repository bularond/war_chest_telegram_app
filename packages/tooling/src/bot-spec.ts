/**
 * How a bot is named on the far side of a worker boundary.
 *
 * A `Bot` is a closure and cannot be sent to a thread, so a match ships a
 * description instead and each worker builds its own. Everything here must
 * survive `structuredClone`: names, numbers and weight files, nothing else.
 */

import {
  BOTS,
  createHeuristicBot,
  createSearchBot,
  DEFAULT_WEIGHTS,
  type Bot,
  type EvalWeights,
  type SearchSettings,
} from '@wc/bots';

/** The parts of the search settings that are data rather than behaviour. */
export type SearchKnobs = Partial<
  Pick<
    SearchSettings,
    | 'iterations'
    | 'rolloutDepth'
    | 'exploration'
    | 'checkEvery'
    | 'firstPlay'
    | 'levelLeaves'
    | 'rolloutNoise'
    | 'unitKeys'
  >
> & {
  /**
   * Roll out with the cheap heuristic: it picks the kind of move the same way
   * and then chooses at random inside it, skipping the distance sweeps the
   * priority lists need. Worse moves per ply, several times more plies per
   * second — which of those the search would rather have is what the arena is
   * for. A `Bot` is a closure and cannot cross a worker boundary, so this is a
   * flag here and a bot on the far side.
   */
  readonly quickRollouts?: boolean;
  /**
   * How the opening is drafted. A lobby deals a draft by default, so this is a
   * real part of how the bot plays — and the only part every experiment so far
   * has been blind to, since matches are played on dealt units unless asked
   * otherwise.
   */
  readonly draftBy?: 'coins' | 'scarcity' | 'random' | 'measured' | 'measured-all' | 'measured-all-660';
  /**
   * Whether the rollout policy can reach the six cards whose tactic picks its
   * target on a follow-up step. Off is how it played until 13 August, when those
   * six were measured at 1401 chances and none taken.
   */
  readonly rankTactics?: boolean;
  /**
   * Whether the rollout policy draws over moves or over hand slots. Part of the
   * same idea as `unitKeys` above and measured with it: a move payable with
   * either of two identical coins is one move.
   */
  readonly uniformMoves?: boolean;
};

export type BotSpec =
  | { readonly kind: 'named'; readonly name: string }
  | {
      readonly kind: 'search';
      readonly label: string;
      readonly weights: EvalWeights;
      readonly knobs?: SearchKnobs;
    };

export function botFromSpec(spec: BotSpec): Bot {
  if (spec.kind === 'named') {
    const bot = BOTS[spec.name];
    if (!bot) throw new Error(`unknown bot "${spec.name}"`);
    return bot;
  }
  const { quickRollouts, draftBy, rankTactics, uniformMoves, ...knobs } = spec.knobs ?? {};
  const tuned = {
    ...(rankTactics === undefined ? {} : { rankTactics }),
    ...(uniformMoves === undefined ? {} : { uniformMoves }),
  };
  const policy = (over: Partial<typeof DEFAULT_WEIGHTS>, name: string) =>
    createHeuristicBot({ ...DEFAULT_WEIGHTS, ...tuned, ...over }, name);
  return createSearchBot(
    {
      ...knobs,
      weights: spec.weights,
      ...(quickRollouts || Object.keys(tuned).length > 0
        ? { rolloutBot: policy(quickRollouts ? { quick: true } : {}, quickRollouts ? 'quick' : 'policy') }
        : {}),
      ...(draftBy ? { draftBot: policy({ draftBy }, `draft-${draftBy}`) } : {}),
    },
    spec.label,
  );
}

export function specName(spec: BotSpec): string {
  return spec.kind === 'named' ? spec.name : spec.label;
}
