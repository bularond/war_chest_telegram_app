/** Game state and action shapes shared by the server, the engine and the UI. */

import type { BoardSize } from './board.js';
import type { HexId } from './hex.js';
import type { RngState } from './rng.js';
import type { DecreeId, DecreeInPlay } from './decrees.js';
import type { BotLevel } from './opponents.js';
import type { CoinId, DecoyId, UnitId, UnitSet } from './units.js';

/** Index into `GameState.players`. Seat order is also turn order. */
export type Seat = number;
/** 0 or 1. In a duel a team is one player; in a four-player game it is two. */
export type Team = number;

export interface CoinInDiscard {
  readonly coin: CoinId;
  /** Facedown coins are hidden from the opponent until the bag is refilled. */
  readonly faceUp: boolean;
}

export interface PlayerState {
  readonly seat: Seat;
  readonly team: Team;
  /** Stable id of the human behind the seat (Telegram user id, or a bot tag). */
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
  /** Set when nobody is behind the seat. Public: you know who you sat down with. */
  readonly bot?: BotLevel;
  /** The unit types this player drafted. */
  units: UnitId[];
  /** Coins still in the bag, in draw order (draw from the end). */
  bag: CoinId[];
  hand: CoinId[];
  discard: CoinInDiscard[];
  /** Coins of each drafted type still available to recruit. */
  supply: Partial<Record<UnitId, number>>;
  /** Coins destroyed on the board. The Reinforce decree can call one back. */
  removed: Partial<Record<UnitId, number>>;
  /** Proclamation Seals left to spend on Royal Decrees. */
  seals: number;
  /** Set while this player holds the marker; only one seat per game has it. */
  hasInitiative: boolean;
}

export interface UnitStack {
  readonly unit: UnitId;
  readonly team: Team;
  /** Owning seat — matters for "your unit" in a four-player game. */
  readonly seat: Seat;
  /** Number of coins in the stack; 1 means unbolstered. */
  coins: number;
  /** Which poisoner's counter is on this unit, if any. */
  poisonedBy?: 'assassin' | 'saboteur';
}

/**
 * A decision the current player still owes before their turn ends. Steps are
 * resolved newest-first; optional ones can be skipped.
 */
export type PendingStep =
  /** Swordsman: after attacking, it may move. */
  | { readonly kind: 'optionalMove'; readonly hex: HexId; readonly source: 'swordsman' | 'earl' }
  /** Berserker: pay a coin off the stack to maneuver again. */
  | { readonly kind: 'optionalRepeat'; readonly hex: HexId; readonly source: 'berserker' }
  /** Warrior Priest: a coin was drawn and must be used right now. */
  | { readonly kind: 'mustUseCoin'; readonly coin: CoinId; readonly source: 'warriorPriest' }
  /** Footman / Mercenary: maneuver with this specific unit, no coin spent. */
  | {
      readonly kind: 'maneuverUnit';
      readonly hex: HexId;
      readonly source: 'footman' | 'mercenary' | 'berserker' | 'herald' | 'earl';
      readonly optional: boolean;
    }
  /** Marshall / Ensign: a friendly unit within range makes a normal maneuver. */
  | {
      readonly kind: 'grantManeuver';
      readonly maneuver: 'move' | 'attack';
      readonly origin: HexId;
      readonly range: number;
      readonly source: 'marshal' | 'ensign';
    }
  /** Sacrifice / Guard: pick a friendly unit and attack with it. */
  | {
      readonly kind: 'decreeAttack';
      /** Sacrifice: the attacker loses a coin afterwards. */
      readonly costsCoin: boolean;
      /** Guard: only a unit standing on a location you control may act. */
      readonly fromOwnLocation: boolean;
    }
  /** March: move a friendly bolstered unit. */
  | { readonly kind: 'decreeMove'; readonly requireBolstered: boolean }
  /** Enlist / Bishop: take a coin from your supply. */
  | { readonly kind: 'decreeRecruit'; readonly source: 'enlist' | 'bishop' }
  /** Redeploy: lift one of your units off the board… */
  | { readonly kind: 'decreeLift' }
  /**
   * …and put it back on a location you control. `from` is where it was lifted
   * from, so a stack that has nowhere legal to land can go back.
   */
  | { readonly kind: 'decreePlace'; readonly unit: UnitId; readonly coins: number; readonly from: HexId }
  /** Spy: look at an opponent's hand and maybe throw a coin away. */
  | { readonly kind: 'decreeSpy'; readonly target: Seat }
  /** Reinforce: call a destroyed coin back into your supply. */
  | { readonly kind: 'decreeReinforce' }
  /** Herald: bolster an adjacent unbolstered ally from its supply. */
  | { readonly kind: 'heraldBolster'; readonly origin: HexId }
  /** Bannerman: shove one adjacent enemy a space. */
  | { readonly kind: 'shoveEnemy'; readonly origin: HexId }
  /** Bishop: after recruiting, move or attack. */
  | { readonly kind: 'maneuverUnitLimited'; readonly hex: HexId; readonly allow: readonly ('move' | 'attack')[] }
  /** Earl / Herald: proclaim a Decree, optionally without spending a Seal. */
  | { readonly kind: 'proclaim'; readonly free: boolean }
  /** Assassin: burn a coin of the unit it just finished off. */
  | { readonly kind: 'burnSupply'; readonly unit: UnitId; readonly owner: Seat }
  /** Infiltrator: plant a Decoy Coin on an opponent. */
  | { readonly kind: 'deceive'; readonly decoy: DecoyId }
  /** Siege Tower: bolster itself from the supply the moment it lands. */
  | { readonly kind: 'bolsterSelf'; readonly hex: HexId }
  /** Sapper: raise a Fortification on the location it just entered. */
  | { readonly kind: 'buildFort'; readonly hex: HexId; readonly seat: Seat }
  /**
   * Royal Guard / War Wagon: the *defender* chooses whether to soak the hit.
   * `seat` names who answers, which is not the player whose turn it is.
   */
  | {
      readonly kind: 'absorbHit';
      readonly seat: Seat;
      readonly target: HexId;
      /**
       * Who threw the punch. Carried on the step rather than looked up on the
       * board, because a Pikeman's retaliation can take the attacker off it
       * before the defender answers.
       */
      readonly by: { readonly hex: HexId; readonly unit: UnitId; readonly seat: Seat };
      readonly options: readonly (
        | { readonly from: 'supply' }
        | { readonly from: 'wagon'; readonly hex: HexId }
        | { readonly from: 'decoy' }
      )[];
    };

/**
 * `ban` is the tournament kit's elimination draft: two extra cards are dealt and
 * each side strikes one out before the draft proper.
 */
export type DraftMode = 'random' | 'draft' | 'ban';

export type GamePhase = 'ban' | 'draft' | 'playing' | 'finished';

export interface LogEntry {
  readonly round: number;
  readonly seat: Seat;
  /** Structured so the client can render it in any language. */
  readonly kind: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface GameState {
  readonly id: string;
  readonly size: BoardSize;
  phase: GamePhase;
  round: number;
  /** Seat to act. */
  turn: Seat;
  players: PlayerState[];
  /** Unit stacks by hex. */
  units: Record<HexId, UnitStack>;
  /** Control markers by location hex, keyed by owning team. */
  control: Record<HexId, Team>;
  /** Seat that will start the next round. */
  initiative: Seat;
  /** The Initiative Marker may only change hands once per round. */
  initiativeMovedThisRound: boolean;
  pending: PendingStep[];
  readonly draftMode: DraftMode;
  readonly sets: readonly UnitSet[];
  /** Royal Decrees face up this game; empty unless Nobility is in play. */
  decrees: DecreeInPlay[];
  /** Hexes holding a Fortification; empty unless Siege is in play. */
  forts: Record<HexId, true>;
  /** Fortification coins left beside the board. */
  fortSupply: number;
  /** Unit cards still on the table during the draft, in pick order. */
  draftPool: UnitId[];
  /** Cards struck out during the elimination draft, for display. */
  banned: UnitId[];
  log: LogEntry[];
  winner: Team | null;
  rng: RngState;
}

/** Actions that spend a coin from hand. */
export type CoinAction =
  | { readonly type: 'deploy'; readonly coin: number; readonly to: HexId }
  | { readonly type: 'bolster'; readonly coin: number; readonly at: HexId }
  | { readonly type: 'claimInitiative'; readonly coin: number }
  | { readonly type: 'recruit'; readonly coin: number; readonly unit: UnitId }
  | { readonly type: 'pass'; readonly coin: number }
  /** Discard a coin face up to lift a Poison Counter off your units. */
  | { readonly type: 'unpoison'; readonly coin: number }
  /** Play a Decoy Coin face up to send it back to its card. */
  | { readonly type: 'returnDecoy'; readonly coin: number }
  | { readonly type: 'move'; readonly coin: number; readonly from: HexId; readonly to: HexId }
  | { readonly type: 'control'; readonly coin: number; readonly at: HexId }
  | { readonly type: 'attack'; readonly coin: number; readonly from: HexId; readonly to: HexId }
  /** Discard the Royal Coin face up to use a Royal Decree. */
  | { readonly type: 'proclaim'; readonly coin: number; readonly decree: DecreeId }
  | {
      readonly type: 'tactic';
      readonly coin: number;
      readonly from: HexId;
      /** Where the unit ends up, for tactics that move. */
      readonly to?: HexId;
      /** What it hits, for tactics that attack. */
      readonly target?: HexId;
      /** Which friendly unit acts, for Marshall / Ensign. */
      readonly subject?: HexId;
    };

/** Actions that resolve a `PendingStep` and spend no coin. */
export type FollowUpAction =
  | { readonly type: 'followMove'; readonly from: HexId; readonly to: HexId }
  | { readonly type: 'followAttack'; readonly from: HexId; readonly to: HexId }
  | { readonly type: 'followControl'; readonly at: HexId }
  | { readonly type: 'followRepeat'; readonly hex: HexId }
  | { readonly type: 'followRecruit'; readonly unit: UnitId }
  | { readonly type: 'followLift'; readonly hex: HexId }
  | { readonly type: 'followPlace'; readonly to: HexId }
  /** Index into the spied hand; `index` and not `coin`, so the engine's
   *  "is this a coin action" check stays a simple property test. */
  | { readonly type: 'followSpy'; readonly index: number }
  | { readonly type: 'followReinforce'; readonly unit: UnitId }
  | { readonly type: 'followBolster'; readonly hex: HexId }
  | { readonly type: 'followShove'; readonly from: HexId; readonly to: HexId }
  | { readonly type: 'followProclaim'; readonly decree: DecreeId }
  | { readonly type: 'followBuildFort'; readonly hex: HexId }
  | { readonly type: 'followAbsorb'; readonly source: 'supply' | 'wagon' | 'decoy'; readonly hex?: HexId }
  | { readonly type: 'followBurn'; readonly unit: UnitId }
  | { readonly type: 'followDeceive'; readonly seat: Seat }
  | { readonly type: 'skip' };

export type DraftAction =
  | { readonly type: 'draft'; readonly unit: UnitId }
  | { readonly type: 'ban'; readonly unit: UnitId };

export type GameAction = CoinAction | FollowUpAction | DraftAction;

export function isCoinAction(a: GameAction): a is CoinAction {
  return 'coin' in a;
}
