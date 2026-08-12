/**
 * The redacted state a single player is allowed to see.
 *
 * War Chest has three kinds of hidden information: the contents of a bag, the
 * coins in an opponent's hand, and coins discarded facedown. Everything else —
 * the board, both discard piles' face-up coins, supply counts — is open.
 */

import type { DecreeInPlay } from './decrees.js';
import type { BotLevel } from './opponents.js';
import { actingSeat, markersRemaining } from './engine.js';
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

export function viewFor(state: GameState, seat: Seat, legal: readonly GameAction[]): GameView {
  // The Spy decree lets the proclaimer look at a hand that is otherwise hidden,
  // so reveal exactly that hand for exactly as long as the step is unresolved.
  const spying = state.turn === seat ? state.pending[state.pending.length - 1] : undefined;
  const revealed = spying?.kind === 'decreeSpy' ? spying.target : null;

  return {
    id: state.id,
    size: state.size,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    acting: actingSeat(state),
    you: seat,
    players: state.players.map((p) => ({
      seat: p.seat,
      team: p.team,
      userId: p.userId,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl ?? null,
      ...(p.bot ? { bot: p.bot } : {}),
      units: [...p.units],
      bagCount: p.bag.length,
      handCount: p.hand.length,
      ...(p.seat === seat || p.seat === revealed ? { hand: [...p.hand] } : {}),
      discard: p.discard.map((d) => ({
        coin: d.faceUp || p.seat === seat ? d.coin : null,
        faceUp: d.faceUp,
      })),
      supply: { ...p.supply },
      removed: { ...p.removed },
      seals: p.seals,
      markersRemaining: markersRemaining(state, p.team),
      hasInitiative: p.hasInitiative,
    })),
    units: { ...state.units },
    control: { ...state.control },
    pending: [...state.pending],
    initiativeMovedThisRound: state.initiativeMovedThisRound,
    decrees: state.decrees.map((d) => ({ id: d.id, seals: [...d.seals] })),
    forts: { ...state.forts },
    fortSupply: state.fortSupply,
    draftMode: state.draftMode,
    sets: [...state.sets],
    draftPool: [...state.draftPool],
    banned: [...state.banned],
    log: [...state.log],
    winner: state.winner,
    legal: seat === actingSeat(state) ? legal : [],
  };
}
