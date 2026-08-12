/**
 * Difficulty levels for a computer opponent.
 *
 * The names live here, next to the rules, because both the server and the
 * client have to agree on them; the bots themselves live in `@wc/bots`, which
 * neither the rules nor the client depend on.
 *
 * `BOT_READY` is what this build can actually play. A level that is not ready
 * must never reach the menu, exactly as with the expansion sets.
 */

import type { LocalizedText } from './units.js';

export type BotLevel = 'easy' | 'medium' | 'hard';

export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];

export const BOT_READY: Readonly<Record<BotLevel, boolean>> = {
  easy: true,
  medium: true,
  hard: true,
};

export const BOT_LEVEL_NAMES: Readonly<Record<BotLevel, LocalizedText>> = {
  easy: { en: 'Easy', ru: 'Простой' },
  medium: { en: 'Medium', ru: 'Средний' },
  hard: { en: 'Hard', ru: 'Сложный' },
};

/** A stable id for a bot's seat, so a reconnecting player finds the same table. */
export function botUserId(level: BotLevel): string {
  return `bot:${level}`;
}

export function isBotUserId(userId: string): boolean {
  return userId.startsWith('bot:');
}
