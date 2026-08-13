/**
 * Royal Decrees, from War Chest: Nobility.
 *
 * Three of the seven are dealt face up at setup. A player proclaims by
 * discarding the Royal Coin face up, placing one of their three Proclamation
 * Seals on a Decree and carrying out its ability — so each side gets each
 * Decree once per game. A Decree may not be chosen if its ability cannot be
 * fully carried out.
 */

import { DECREE_IDS } from './generated.js';
import type { LocalizedText } from './units.js';

export type DecreeId =
  | 'sacrifice'
  | 'guard'
  | 'march'
  | 'enlist'
  | 'redeploy'
  | 'spy'
  | 'reinforce';

export interface DecreeDefinition {
  readonly id: DecreeId;
  readonly name: LocalizedText;
  readonly text: LocalizedText;
}

export const DECREES: Readonly<Record<DecreeId, DecreeDefinition>> = {
  sacrifice: {
    id: 'sacrifice',
    name: { en: 'Sacrifice', ru: 'Жертва' },
    text: {
      en: 'Attack with a friendly unit, then remove a coin from the friendly unit.',
      ru: 'Атакуйте дружественным отрядом, затем снимите с него монету.',
    },
  },
  guard: {
    id: 'guard',
    name: { en: 'Guard', ru: 'Стража' },
    text: {
      en: 'Attack with a friendly unit that is on a location you control.',
      ru: 'Атакуйте дружественным отрядом, который стоит на вашей локации.',
    },
  },
  march: {
    id: 'march',
    name: { en: 'March', ru: 'Марш' },
    text: {
      en: 'Move a friendly bolstered unit.',
      ru: 'Сделайте ход усиленным дружественным отрядом.',
    },
  },
  enlist: {
    id: 'enlist',
    name: { en: 'Enlist', ru: 'Вербовка' },
    text: { en: 'Recruit twice.', ru: 'Наймите две монеты.' },
  },
  redeploy: {
    id: 'redeploy',
    name: { en: 'Redeploy', ru: 'Передислокация' },
    text: {
      en: 'Remove a friendly unit from the board and then deploy it.',
      ru: 'Снимите дружественный отряд с поля и разверните его заново.',
    },
  },
  spy: {
    id: 'spy',
    name: { en: 'Spy', ru: 'Шпион' },
    text: {
      en: "Look at an opponent's hand. You may discard one of their coins. If you do, they draw a new coin.",
      ru: 'Посмотрите руку соперника. Можете сбросить одну его монету — тогда он берёт новую.',
    },
  },
  reinforce: {
    id: 'reinforce',
    name: { en: 'Reinforce', ru: 'Подкрепление' },
    text: {
      en: 'Take one of your coins that has been removed from play and place it in your supply.',
      ru: 'Верните в свой запас одну свою монету, выбывшую из игры.',
    },
  },
};

export { DECREE_IDS };

/** Decrees dealt face up for a game, and Seals each side may spend. */
export const DECREES_IN_PLAY = 3;
export const SEALS_PER_SIDE = 3;

/** A Decree on the table, with the sides that have already used it. */
export interface DecreeInPlay {
  readonly id: DecreeId;
  /** Teams whose Seal is already on this Decree. */
  seals: number[];
}
