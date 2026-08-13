/**
 * The 28 unit types, the Royal Coin and the two Decoy Coins.
 *
 * A unit is two halves. What the engine executes — how many coins the box
 * contains, what the tactic does, which attributes the card carries — is a rule,
 * and rules live in `wc-core`; it arrives here through `generated.ts`. What a
 * person reads — the name, the sentence, the colour, the art — is presentation
 * and is hand-written in `unit-text.ts`. This file is where the two meet, and
 * neither half is written twice.
 */

import {
  UNIT_FACTS,
  UNIT_IDS as GENERATED_UNIT_IDS,
  UNIT_SETS as GENERATED_UNIT_SETS,
  COINS_IN_BAG_PER_UNIT,
} from './generated.js';
import { ROYAL_COIN_COLOR_TEXT, ROYAL_COIN_NAME_TEXT, SET_NAMES_TEXT, UNIT_TEXT } from './unit-text.js';

export type UnitId =
  | 'swordsman'
  | 'archer'
  | 'pikeman'
  | 'cavalry'
  | 'crossbowman'
  | 'lancer'
  | 'lightCavalry'
  | 'scout'
  | 'knight'
  | 'marshal'
  | 'mercenary'
  | 'berserker'
  | 'ensign'
  | 'footman'
  | 'warriorPriest'
  | 'royalGuard'
  // Nobility
  | 'herald'
  | 'earl'
  | 'bishop'
  | 'bannerman'
  // Siege
  | 'trebuchet'
  | 'siegeTower'
  | 'sapper'
  | 'warWagon'
  // Nightfall
  | 'assassin'
  | 'saboteur'
  | 'infiltrator'
  | 'skirmisher';

/** Which box a unit comes from. Lobbies pick which sets are in the draft. */
export type UnitSet = 'base' | 'nobility' | 'siege' | 'nightfall';

export const UNIT_SETS: readonly UnitSet[] = GENERATED_UNIT_SETS;

/**
 * Whether the engine can actually run a set. A set only opens up once its
 * mechanics are in place, so a lobby can never deal a unit whose tactic would
 * silently do nothing.
 */
export const SET_READY: Readonly<Record<UnitSet, boolean>> = {
  base: true,
  nobility: true,
  siege: true,
  nightfall: true,
};

export const SET_NAMES: Readonly<Record<UnitSet, LocalizedText>> = SET_NAMES_TEXT;

/** The wild coin. It is not a unit and can never be deployed. */
export const ROYAL_COIN = 'royal' as const;
export type RoyalCoin = typeof ROYAL_COIN;

/**
 * Decoy Coins from Nightfall. The Skirmisher and the Infiltrator each own one;
 * it starts beside their card and gets planted in an opponent's discard pile.
 */
export const DECOYS = ['decoyInfiltrator', 'decoySkirmisher'] as const;
export type DecoyId = (typeof DECOYS)[number];

export const DECOY_OF: Readonly<Partial<Record<UnitId, DecoyId>>> = {
  infiltrator: 'decoyInfiltrator',
  skirmisher: 'decoySkirmisher',
};

/** Anything that can sit in a bag, hand or discard pile. */
export type CoinId = UnitId | RoyalCoin | DecoyId;

export function isDecoy(coin: CoinId): coin is DecoyId {
  return coin === 'decoyInfiltrator' || coin === 'decoySkirmisher';
}

export function isUnitId(coin: CoinId): coin is UnitId {
  return coin !== ROYAL_COIN && !isDecoy(coin);
}

export interface LocalizedText {
  readonly en: string;
  readonly ru: string;
}

/** What a unit's TACTIC does, in a form the engine can execute. */
export type TacticSpec =
  | {
      readonly kind: 'rangedAttack';
      readonly min: number;
      readonly max: number;
      readonly straightLine: boolean;
      readonly blocked: boolean;
    }
  | {
      readonly kind: 'chargeAttack';
      readonly min: number;
      readonly max: number;
      readonly straightLine: boolean;
    }
  | { readonly kind: 'multiMove'; readonly distance: number }
  | { readonly kind: 'grantManeuver'; readonly maneuver: 'move' | 'attack'; readonly range: number }
  | { readonly kind: 'maneuverEachUnit' }
  | { readonly kind: 'royalRedeploy'; readonly distance: number }
  | { readonly kind: 'bolsterAllyFromSupply' }
  | { readonly kind: 'controlThenProclaim' }
  | { readonly kind: 'recruitThenManeuver' }
  | { readonly kind: 'attackTwice' }
  | { readonly kind: 'pushAlly' }
  | { readonly kind: 'moveThenAttackFort' }
  | { readonly kind: 'moveThenPoison' }
  | { readonly kind: 'poisonAtRange'; readonly min: number; readonly max: number }
  | { readonly kind: 'infiltrate'; readonly distance: number }
  | { readonly kind: 'skirmish'; readonly distance: number };

export type AttributeId =
  /** Footman: two units of this type may be deployed at once. */
  | 'twoUnitsDeployed'
  /** Pikeman: when attacked *by an adjacent unit*, the attacker also loses a coin. */
  | 'retaliate'
  /** Swordsman: after this unit attacks, it may move. */
  | 'moveAfterAttack'
  /** Knight: may only be attacked by a bolstered unit. */
  | 'onlyAttackedByBolstered'
  /** Mercenary: recruiting this coin gives the deployed unit a free maneuver. */
  | 'freeManeuverOnRecruit'
  /** Warrior Priest: after it controls or attacks, draw a coin and use it now. */
  | 'drawAndUseAfterControlOrAttack'
  /** Berserker: after it maneuvers, spend a bolstered coin to maneuver again. */
  | 'maneuverAgainForCoin'
  /** Scout: may be deployed next to any friendly unit, not only onto a location. */
  | 'deployNextToFriendly'
  /** Royal Guard: an attack may take a coin from the supply instead of the stack. */
  | 'absorbHitFromSupply'
  /** Siege Tower: may be bolstered from the supply the moment it deploys. */
  | 'bolsterOnDeploy'
  /** War Wagon: soaks a hit aimed at an adjacent friendly unit. */
  | 'absorbHitForAlly'
  /** Bannerman: after it maneuvers, shove one adjacent enemy a space. */
  | 'shoveEnemyAfterManeuver'
  /** Earl: may move straight after it is deployed. */
  | 'moveAfterDeploy'
  /** Herald: may maneuver after you proclaim. */
  | 'maneuverAfterProclaim'
  /** Sapper: moving onto a bare location may raise a Fortification there. */
  | 'buildFortOnMove'
  /** Assassin: finishing off a poisoned unit also burns one of its supply coins. */
  | 'burnSupplyAfterKillingPoisoned'
  /** Saboteur: recruiting one lets it poison immediately. */
  | 'tacticOnRecruit'
  /** Infiltrator: taking a location plants a Decoy Coin on the opponent. */
  | 'deceiveAfterControl'
  /** Skirmisher: a Decoy Coin can soak the attack entirely. */
  | 'deceiveWhenAttacked';

export type RestrictionId =
  /** Archer, Lancer, Trebuchet: cannot make a normal (adjacent) attack. */
  | 'noNormalAttack'
  /** Bishop: the mirror of the Knight — only unbolstered units may attack it. */
  | 'onlyAttackedByUnbolstered';

export interface UnitDefinition {
  readonly id: UnitId;
  readonly set: UnitSet;
  readonly name: LocalizedText;
  /** Total coins of this type in the game: 2 start in the bag, the rest supply. */
  readonly coins: number;
  readonly color: string;
  readonly art: string;
  readonly tactic?: TacticSpec;
  /** A Siege Tactic may only be used while the unit is bolstered. */
  readonly siegeTactic?: boolean;
  readonly attributes: readonly AttributeId[];
  readonly restrictions: readonly RestrictionId[];
  readonly text: {
    readonly tactic?: LocalizedText;
    readonly attribute?: LocalizedText;
    readonly restriction?: LocalizedText;
  };
}

export const UNIT_IDS: readonly UnitId[] = GENERATED_UNIT_IDS;

export const UNITS: Readonly<Record<UnitId, UnitDefinition>> = Object.fromEntries(
  UNIT_IDS.map((id) => {
    const facts = UNIT_FACTS[id];
    const text = UNIT_TEXT[id];
    return [
      id,
      {
        id,
        set: facts.set,
        coins: facts.coins,
        ...(facts.tactic ? { tactic: facts.tactic } : {}),
        ...(facts.siegeTactic ? { siegeTactic: true } : {}),
        attributes: facts.attributes,
        restrictions: facts.restrictions,
        name: text.name,
        color: text.color,
        art: text.art,
        text: text.text,
      },
    ];
  }),
) as Readonly<Record<UnitId, UnitDefinition>>;

/** Unit types available when these sets are switched on. */
export function unitsForSets(sets: readonly UnitSet[]): UnitId[] {
  return UNIT_IDS.filter((id) => sets.includes(UNIT_FACTS[id].set));
}

export const ROYAL_COIN_NAME: LocalizedText = ROYAL_COIN_NAME_TEXT;
export const ROYAL_COIN_COLOR = ROYAL_COIN_COLOR_TEXT;

const DECOY_NAMES: Readonly<Record<DecoyId, LocalizedText>> = {
  decoyInfiltrator: { en: 'Decoy: Infiltrator', ru: 'Обманка: лазутчик' },
  decoySkirmisher: { en: 'Decoy: Skirmisher', ru: 'Обманка: застрельщик' },
};

export function coinName(coin: CoinId): LocalizedText {
  if (coin === ROYAL_COIN) return ROYAL_COIN_NAME;
  if (isDecoy(coin)) return DECOY_NAMES[coin];
  return UNITS[coin].name;
}

export function coinColor(coin: CoinId): string {
  if (coin === ROYAL_COIN) return ROYAL_COIN_COLOR;
  if (isDecoy(coin)) return '#5c5f66';
  return UNITS[coin].color;
}

/**
 * Path to the coin image. The Royal Coin is printed once per faction, so it
 * takes the seat's colour; unit coins look the same for both players.
 */
export function coinArt(coin: CoinId, faction: 'black' | 'white' = 'black'): string {
  if (coin === ROYAL_COIN) return `/coins/royal_coin_${faction}.png`;
  if (coin === 'decoyInfiltrator') return '/tokens/decoy_infiltrator.png';
  if (coin === 'decoySkirmisher') return '/tokens/decoy_skirmisher.png';
  return `/coins/${UNITS[coin].art}.png`;
}

export function hasAttribute(unit: UnitId, attr: AttributeId): boolean {
  return UNIT_FACTS[unit].attributes.includes(attr);
}

export function hasRestriction(unit: UnitId, r: RestrictionId): boolean {
  return UNIT_FACTS[unit].restrictions.includes(r);
}

/** Units a player may have deployed at once — 1, except the Footman's 2. */
export function maxDeployed(unit: UnitId): number {
  return UNIT_FACTS[unit].maxDeployed;
}

/** Unit types drafted per player, by table size. */
export const UNITS_PER_PLAYER: Readonly<Record<2 | 4, number>> = { 2: 4, 4: 3 };

export { COINS_IN_BAG_PER_UNIT };
