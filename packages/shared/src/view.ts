/**
 * The shape of the redacted state a single player is allowed to see.
 *
 * The redaction itself is a rule and happens in `wc-core`; what is here is the
 * type, so the client can read a view without a rules engine anywhere near it.
 *
 * War Chest has three kinds of hidden information: the contents of a bag, the
 * coins in an opponent's hand, and coins discarded facedown. Everything else —
 * the board, both discard piles' face-up coins, supply counts — is open.
 */

import type { DecreeInPlay } from './decrees.js';
import type { BotLevel } from './opponents.js';
import type { HexId } from './hex.js';
import type {
  DraftMode,
  GameAction,
  GamePhase,
  GameState,
  LogEntry,
  PendingStep,
  Seat,
  Team,
  UnitStack,
} from './types.js';
import type { CoinId, UnitId, UnitSet } from './units.js';

export interface PlayerView {
  readonly seat: Seat;
  readonly team: Team;
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
  /** Set when this seat is played by the computer, at the level shown. */
  readonly bot?: BotLevel;
  readonly units: readonly UnitId[];
  readonly bagCount: number;
  readonly handCount: number;
  /** Present only for the viewing player. */
  readonly hand?: readonly CoinId[];
  /**
   * What is in the viewing player's own bag — their own coins, which they are
   * entitled to know. Sorted, never in bag order: coins are drawn off the end,
   * so the real order is the list of their next draws.
   */
  readonly bag?: readonly CoinId[];
  /** Facedown coins show as `null` to everyone except their owner. */
  readonly discard: readonly { readonly coin: CoinId | null; readonly faceUp: boolean }[];
  readonly supply: Readonly<Partial<Record<UnitId, number>>>;
  /** Coins destroyed on the board, which the Reinforce decree can call back. */
  readonly removed: Readonly<Partial<Record<UnitId, number>>>;
  /** Proclamation Seals left; 0 unless Nobility is in play. */
  readonly seals: number;
  readonly markersRemaining: number;
  readonly hasInitiative: boolean;
}

export interface GameView {
  readonly id: string;
  readonly size: 2 | 4;
  readonly phase: GamePhase;
  readonly round: number;
  readonly turn: Seat;
  /** Who owes the next action; differs from `turn` for a defender's choice. */
  readonly acting: Seat;
  readonly you: Seat;
  readonly players: readonly PlayerView[];
  readonly units: Readonly<Record<HexId, UnitStack>>;
  readonly control: Readonly<Record<HexId, Team>>;
  readonly pending: readonly PendingStep[];
  /** Public: the Initiative Marker changes hands at most once a round. */
  readonly initiativeMovedThisRound: boolean;
  readonly decrees: readonly DecreeInPlay[];
  readonly forts: Readonly<Record<HexId, true>>;
  readonly fortSupply: number;
  readonly draftMode: DraftMode;
  readonly sets: readonly UnitSet[];
  readonly draftPool: readonly UnitId[];
  readonly banned: readonly UnitId[];
  readonly log: readonly LogEntry[];
  readonly winner: Team | null;
  /** Legal actions for `you`, empty when it is not your turn. */
  readonly legal: readonly GameAction[];
}
