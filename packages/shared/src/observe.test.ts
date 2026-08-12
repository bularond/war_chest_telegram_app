/**
 * Determinization: what the bot is allowed to know, and that everything it
 * invents is consistent with it.
 *
 * The failure this guards against is a bot that plays well because it can see
 * the opponent's hand. The other failure is a sampler that produces a deal
 * nobody could actually hold — then the search optimises a game that is not
 * being played.
 */

import { describe, expect, it } from 'vitest';
import { STARTING_LOCATIONS } from './board.js';
import { applyAction, legalActions } from './engine.js';
import type { HexId } from './hex.js';
import { checkInvariants } from './invariants.js';
import { hiddenCoins, publicStateFor, sampleDeterminization } from './observe.js';
import { playRandomGame, randomPolicy } from './playout.js';
import { createRng } from './rng.js';
import { createGame } from './setup.js';
import { apply, isTerminal } from './state.js';
import type { GameAction, GameState, Seat } from './types.js';
import { isDecoy, UNITS, type CoinId, type UnitId, type UnitSet } from './units.js';
import { viewFor, type GameView } from './view.js';

function mid(seed: number, sets: readonly UnitSet[], plies: number): GameState {
  const { history } = playRandomGame({ seed, sets, maxPlies: plies }, createRng(seed));
  return history.at(-1) as GameState;
}

/** Everything the view states about the piles, as plain numbers. */
function shape(view: GameView) {
  return view.players.map((p) => ({
    bag: p.bagCount,
    hand: p.handCount,
    discard: p.discard.map((d) => ({ coin: d.coin, faceUp: d.faceUp })),
    supply: { ...p.supply },
    removed: { ...p.removed },
  }));
}

function count(coins: readonly CoinId[]): Map<CoinId, number> {
  const out = new Map<CoinId, number>();
  for (const c of coins) out.set(c, (out.get(c) ?? 0) + 1);
  return out;
}

describe('public state', () => {
  it('hides the bag, the opponent hand and facedown discards', () => {
    const state = mid(3, ['nobility'], 120);
    const view = publicStateFor(state, 0);

    expect(view.players[0]?.hand).toBeDefined();
    expect(view.players[1]?.hand).toBeUndefined();
    expect(view.players[1]?.bagCount).toBe(state.players[1]?.bag.length);
    const facedown = state.players[1]?.discard.filter((d) => !d.faceUp) ?? [];
    expect(view.players[1]?.discard.filter((d) => d.coin === null).length).toBe(facedown.length);
    // Nothing of the opponent's bag travels at all, contents or order.
    expect(view.players[1]?.bag).toBeUndefined();
  });

  it('gives players their own bag, but not the order they will draw it in', () => {
    const state = mid(3, ['nobility'], 120);
    const real = state.players[0]!.bag;
    const bag = publicStateFor(state, 0).players[0]?.bag;

    // Your own coins are yours to count…
    expect([...(bag ?? [])].sort()).toEqual([...real].sort());
    // …but coins are drawn off the end of the bag, so its order is the list of
    // your next draws. Sorted is the whole point.
    expect(bag).toEqual([...(bag ?? [])].sort());
  });
});

describe('the hidden coin tracker', () => {
  it('names the opponent’s hidden coins exactly', () => {
    for (const seed of [3, 8, 21]) {
      const state = mid(seed, ['nobility', 'siege'], 200);
      const view = publicStateFor(state, 0);
      for (const seat of [0, 1] as Seat[]) {
        const hidden = hiddenCoins(view, seat);
        const real = state.players[seat] as GameState['players'][number];
        const truth: CoinId[] = [...real.bag];
        if (seat !== 0) truth.push(...real.hand);
        for (const d of real.discard) if (!d.faceUp && seat !== 0) truth.push(d.coin);

        expect(hidden.unknown).toBe(0);
        expect(count(hidden.known)).toEqual(count(truth));
      }
    }
  });

  it('does not know which coin is where', () => {
    // The tracker returns a multiset; it must not accidentally be in draw order.
    const state = mid(5, [], 150);
    const view = publicStateFor(state, 0);
    const hidden = hiddenCoins(view, 1);
    expect(hidden.bagCount + hidden.handCount + hidden.facedownCount).toBe(hidden.known.length);
  });
});

describe('determinization', () => {
  it('produces states the view cannot tell apart from the real one', () => {
    for (const sets of [[], ['nobility'], ['siege'], ['nightfall']] as UnitSet[][]) {
      for (const seed of [4, 12]) {
        const state = mid(seed, sets, 200);
        if (isTerminal(state)) continue;
        const view = publicStateFor(state, 0);
        const rng = createRng(seed * 7);

        for (let i = 0; i < 20; i++) {
          const sampled = sampleDeterminization(view, rng);
          expect(checkInvariants(sampled)).toEqual([]);
          // Seen from the same seat, the invented state looks identical.
          const sampledView = viewFor(sampled, 0, []);
          expect(shape(sampledView)).toEqual(shape(view));
          expect(sampledView.units).toEqual(view.units);
          expect(sampledView.control).toEqual(view.control);
          expect(sampledView.pending).toEqual(view.pending);
          expect(sampledView.players[0]?.hand).toEqual(view.players[0]?.hand);
        }
      }
    }
  });

  it('deals only coins the player could own, and all of them', () => {
    const state = mid(9, ['nobility'], 250);
    const view = publicStateFor(state, 0);
    const rng = createRng(99);

    for (let i = 0; i < 30; i++) {
      const sampled = sampleDeterminization(view, rng);
      for (const p of sampled.players) {
        const owned = new Set<CoinId>([...p.units, 'royal']);
        for (const coin of [...p.bag, ...p.hand]) {
          expect(owned.has(coin)).toBe(true);
        }
        for (const unit of p.units) {
          const total =
            p.bag.filter((c) => c === unit).length +
            p.hand.filter((c) => c === unit).length +
            p.discard.filter((d) => d.coin === unit).length +
            Object.values(sampled.units).reduce(
              (n, s) => n + (s.seat === p.seat && s.unit === unit ? s.coins : 0),
              0,
            ) +
            (p.supply[unit] ?? 0) +
            (p.removed[unit] ?? 0);
          expect(total).toBe(UNITS[unit].coins);
        }
      }
    }
  });

  it('varies the deal it invents', () => {
    const state = mid(6, [], 180);
    const view = publicStateFor(state, 0);
    const rng = createRng(11);
    const hands = new Set<string>();
    for (let i = 0; i < 30; i++) {
      hands.add(JSON.stringify(sampleDeterminization(view, rng).players[1]?.hand));
    }
    expect(hands.size).toBeGreaterThan(1);
  });

  it('keeps our own hand and facedown discards exactly as they are', () => {
    const state = mid(15, [], 220);
    const view = publicStateFor(state, 1);
    const rng = createRng(15);
    for (let i = 0; i < 10; i++) {
      const sampled = sampleDeterminization(view, rng);
      expect(sampled.players[1]?.hand).toEqual(state.players[1]?.hand);
      expect(sampled.players[1]?.discard).toEqual(state.players[1]?.discard);
      // Our own bag is hidden from us too, so it is sampled like any other.
      expect(sampled.players[1]?.bag.length).toBe(state.players[1]?.bag.length);
    }
  });

  it('can be played on, which is the whole point', () => {
    const state = mid(18, ['nobility', 'siege', 'nightfall'], 200);
    if (isTerminal(state)) return;
    const view = publicStateFor(state, 0);
    const rng = createRng(18);
    let sampled = sampleDeterminization(view, rng);
    expect(sampled.round).toBe(state.round);

    // Both sides carry on from the invented deal, as a rollout would.
    for (let ply = 0; ply < 60 && !isTerminal(sampled); ply++) {
      sampled = apply(sampled, randomPolicy(sampled, rng));
      expect(checkInvariants(sampled)).toEqual([]);
    }
  });
});

describe('decoy coins', () => {
  // The Decoy is planted face up in a discard pile, so it is public — until a
  // refill shuffles it into the bag and it goes dark. Subtraction cannot name
  // it (it is nobody's printed coin), so the tracker counts the gap instead.
  it('accounts for a decoy that vanished into a bag', () => {
    const state = mid(4, ['nightfall'], 200);
    const foe = state.players[1] as GameState['players'][number];
    foe.bag.push('decoyInfiltrator');

    const view = publicStateFor(state, 0);
    const hidden = hiddenCoins(view, 1);
    expect(hidden.unknown).toBe(1);

    const rng = createRng(4);
    for (let i = 0; i < 10; i++) {
      const sampled = sampleDeterminization(view, rng);
      const p = sampled.players[1] as GameState['players'][number];
      // Which of the two decoys it is cannot be worked out — neither has been
      // seen — so any one of them is a fair guess. That there is exactly one
      // is not a guess.
      const decoys = [...p.bag, ...p.hand, ...p.discard.map((d) => d.coin)].filter(isDecoy);
      expect(decoys).toHaveLength(1);
      expect(checkInvariants(sampled)).toEqual([]);
    }
  });
});

describe('a coin that is on no pile at all', () => {
  it('accounts for a stack lifted by the Redeploy decree', () => {
    // The bug: mid-Redeploy the lifted stack sits on the pending step, on no
    // pile the tracker knew to look at, so the sum came up short and the view
    // was declared impossible. The bot was asked to think during a Redeploy and
    // died — twice in one night of tuning, which is how it was found.
    const g = createGame({
      id: 'lift',
      size: 2,
      seed: 3,
      sets: ['nobility'],
      seats: [
        { userId: 'a', displayName: 'A' },
        { userId: 'b', displayName: 'B' },
      ],
      fixedUnits: [
        ['swordsman', 'archer', 'knight', 'scout'],
        ['ensign', 'footman', 'cavalry', 'scout'],
      ],
    });
    g.decrees = [{ id: 'redeploy', seals: [] }, { id: 'spy', seals: [] }, { id: 'enlist', seals: [] }];
    g.players.forEach((p) => (p.seals = 3));
    g.turn = 0;

    // Three coins onto the board, moved rather than conjured: a position with
    // more coins than the cards print is one no game can reach, and the
    // determinizer is right to refuse it.
    const me = g.players[0]!;
    me.bag.push(...me.hand);
    me.hand = [];
    // A coin comes off the bag if it is there and out of the supply otherwise —
    // which is where the third Swordsman would have come from anyway, since a
    // stack of three is built by recruiting and bolstering.
    const takeCoin = (coin: CoinId) => {
      const at = me.bag.indexOf(coin);
      if (at !== -1) {
        me.bag.splice(at, 1);
        return;
      }
      const left = me.supply[coin as UnitId] ?? 0;
      expect(left).toBeGreaterThan(0);
      me.supply[coin as UnitId] = left - 1;
    };
    const start = STARTING_LOCATIONS.a[0] as HexId;
    for (let i = 0; i < 3; i++) takeCoin('swordsman');
    g.units[start] = { unit: 'swordsman', team: 0, seat: 0, coins: 3 };
    for (const coin of ['royal', 'archer'] as CoinId[]) {
      takeCoin(coin);
      me.hand.push(coin);
    }

    const proclaim = legalActions(g, 0).find((a) => a.type === 'proclaim' && a.decree === 'redeploy');
    expect(proclaim).toBeDefined();
    applyAction(g, 0, proclaim as GameAction);
    const lift = legalActions(g, 0).find((a) => a.type === 'followLift');
    expect(lift).toBeDefined();
    applyAction(g, 0, lift as GameAction);

    // The stack is off the board and not on any pile.
    expect(g.units[start]).toBeUndefined();
    expect(g.pending.some((s) => s.kind === 'decreePlace')).toBe(true);

    const view = publicStateFor(g, 0);
    expect(() => hiddenCoins(view, 0)).not.toThrow();
    const sample = sampleDeterminization(view, createRng(1));
    expect(checkInvariants(sample)).toEqual([]);
    // And from the other side of the table, where the lift is public but the
    // hand is not.
    expect(() => sampleDeterminization(publicStateFor(g, 1), createRng(2))).not.toThrow();
  });
});
