/**
 * Persistence. Only what has to outlive a restart lives here: player profiles
 * and finished games. Lobbies and games in progress are in memory.
 *
 * Uses Node's built-in SQLite so the project has no native build step.
 */

import { DatabaseSync } from 'node:sqlite';

export interface UserRow {
  id: string;
  display_name: string;
  username: string | null;
  photo_url: string | null;
  wins: number;
  losses: number;
}

export interface HistoryRow {
  game_id: string;
  user_id: string;
  opponents: string;
  table_name: string;
  size: number;
  won: number;
  finished_at: number;
}

export interface BotRecordRow {
  level: string;
  bot_build: string;
  games: number;
  player_wins: number;
  draws: number;
  avg_plies: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        username     TEXT,
        photo_url    TEXT,
        wins         INTEGER NOT NULL DEFAULT 0,
        losses       INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS history (
        game_id     TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        opponents   TEXT NOT NULL,
        table_name  TEXT NOT NULL,
        size        INTEGER NOT NULL,
        won         INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        PRIMARY KEY (game_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS history_by_user ON history (user_id, finished_at DESC);
      CREATE TABLE IF NOT EXISTS bot_games (
        game_id     TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        level       TEXT NOT NULL,
        bot_build   TEXT NOT NULL,
        won         INTEGER NOT NULL,
        draw        INTEGER NOT NULL,
        plies       INTEGER NOT NULL,
        rounds      INTEGER NOT NULL,
        sets        TEXT NOT NULL,
        finished_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bot_games_by_level ON bot_games (level, bot_build, finished_at DESC);
    `);
  }

  upsertUser(u: {
    id: string;
    displayName: string;
    username?: string;
    photoUrl?: string;
  }): UserRow {
    this.db
      .prepare(
        `INSERT INTO users (id, display_name, username, photo_url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           username     = excluded.username,
           photo_url    = excluded.photo_url`,
      )
      .run(u.id, u.displayName, u.username ?? null, u.photoUrl ?? null);
    return this.getUser(u.id)!;
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  recordResult(entry: {
    gameId: string;
    userId: string;
    opponents: string;
    tableName: string;
    size: number;
    won: boolean;
    finishedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO history
           (game_id, user_id, opponents, table_name, size, won, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.gameId,
        entry.userId,
        entry.opponents,
        entry.tableName,
        entry.size,
        entry.won ? 1 : 0,
        entry.finishedAt,
      );
    this.db
      .prepare(
        entry.won
          ? 'UPDATE users SET wins = wins + 1 WHERE id = ?'
          : 'UPDATE users SET losses = losses + 1 WHERE id = ?',
      )
      .run(entry.userId);
  }

  /**
   * One row per finished game against the computer. Without the level and the
   * build there is no way to find out, a month from now, which change made Easy
   * unbeatable — so both are written down even though neither is needed today.
   */
  recordBotGame(entry: {
    gameId: string;
    userId: string;
    level: string;
    botBuild: string;
    won: boolean;
    draw: boolean;
    plies: number;
    rounds: number;
    sets: string;
    finishedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bot_games
           (game_id, user_id, level, bot_build, won, draw, plies, rounds, sets, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.gameId,
        entry.userId,
        entry.level,
        entry.botBuild,
        entry.won ? 1 : 0,
        entry.draw ? 1 : 0,
        entry.plies,
        entry.rounds,
        entry.sets,
        entry.finishedAt,
      );
  }

  /** How the levels are doing against real players. Read by hand, for now. */
  botRecord(): BotRecordRow[] {
    return this.db
      .prepare(
        `SELECT level, bot_build, COUNT(*) AS games,
                SUM(won) AS player_wins, SUM(draw) AS draws,
                AVG(plies) AS avg_plies
           FROM bot_games GROUP BY level, bot_build`,
      )
      .all() as unknown as BotRecordRow[];
  }

  history(userId: string, limit = 20): HistoryRow[] {
    return this.db
      .prepare('SELECT * FROM history WHERE user_id = ? ORDER BY finished_at DESC LIMIT ?')
      .all(userId, limit) as unknown as HistoryRow[];
  }
}
