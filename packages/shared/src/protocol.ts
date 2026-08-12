/** The WebSocket protocol between the Mini App and the server. */

import type { BoardSize } from './board.js';
import type { BotLevel } from './opponents.js';
import type { DraftMode, GameAction } from './types.js';
import type { UnitSet } from './units.js';
import type { GameView } from './view.js';

export interface Member {
  readonly userId: string;
  readonly displayName: string;
  /** Telegram profile photo, when the user has one and shares it. */
  readonly photoUrl?: string | null;
}

export interface LobbySummary {
  readonly code: string;
  readonly name: string;
  readonly host: string;
  readonly size: BoardSize;
  readonly draftMode: DraftMode;
  readonly sets: readonly UnitSet[];
  readonly players: number;
  readonly locked: boolean;
  readonly started: boolean;
}

export interface LobbyState {
  readonly code: string;
  readonly name: string;
  readonly host: string;
  readonly hostId: string;
  readonly size: BoardSize;
  readonly draftMode: DraftMode;
  readonly sets: readonly UnitSet[];
  readonly locked: boolean;
  readonly members: readonly Member[];
  readonly started: boolean;
}

export interface Profile {
  readonly userId: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly photoUrl: string | null;
  readonly wins: number;
  readonly losses: number;
  readonly history: readonly {
    readonly opponents: string;
    readonly tableName: string;
    readonly size: number;
    readonly won: boolean;
    readonly finishedAt: number;
  }[];
}

export type ClientMessage =
  | { readonly t: 'auth'; readonly initData: string; readonly devUser?: Member }
  | { readonly t: 'lobby.list' }
  | {
      readonly t: 'lobby.create';
      readonly name?: string;
      readonly size: BoardSize;
      readonly draftMode?: DraftMode;
      readonly sets?: readonly UnitSet[];
      readonly password?: string;
      /**
       * Sit down against the computer instead of opening the table to others.
       * The game starts at once; there is nobody to wait for.
       */
      readonly vsBot?: BotLevel;
    }
  | { readonly t: 'lobby.join'; readonly code: string; readonly password?: string }
  | { readonly t: 'lobby.leave' }
  | { readonly t: 'lobby.start' }
  | { readonly t: 'game.action'; readonly action: GameAction }
  | { readonly t: 'profile' };

export type ServerMessage =
  | {
      readonly t: 'auth.ok';
      readonly user: Member;
      readonly lobby: LobbyState | null;
      /** Sets this server can actually run. The client must not offer others. */
      readonly sets: readonly UnitSet[];
      /** Bot levels this server can actually play. Same rule as `sets`. */
      readonly bots: readonly BotLevel[];
    }
  | { readonly t: 'lobby.list'; readonly lobbies: readonly LobbySummary[] }
  | { readonly t: 'lobby.state'; readonly lobby: LobbyState | null }
  | { readonly t: 'game.view'; readonly view: GameView }
  | { readonly t: 'profile'; readonly profile: Profile }
  | { readonly t: 'error'; readonly code: string; readonly message: string };
