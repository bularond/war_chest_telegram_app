/**
 * The 16 base-game unit types, plus the Royal Coin.
 *
 * Card text, coin counts and colours are transcribed from the actual cards and
 * the print-and-play coin art. The coin counts sum to 74, which is exactly the
 * "74 Unit Coins" in the rulebook's component list — a useful cross-check.
 *
 * Each entry carries the printed text (for the UI) and a machine-readable spec
 * (for the rules engine).
 */

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

export const UNIT_SETS: readonly UnitSet[] = ['base', 'nobility', 'siege', 'nightfall'];

/**
 * Whether the engine can actually run a set. The card data and coin art for all
 * four boxes are in place; a set only opens up once its mechanics are too, so a
 * lobby can never deal a unit whose tactic would silently do nothing.
 */
export const SET_READY: Readonly<Record<UnitSet, boolean>> = {
  base: true,
  nobility: true,
  siege: true,
  nightfall: true,
};

export const SET_NAMES: Readonly<Record<UnitSet, LocalizedText>> = {
  base: { en: 'Base game', ru: 'Базовая игра' },
  nobility: { en: 'Nobility', ru: 'Знать' },
  siege: { en: 'Siege', ru: 'Осада' },
  nightfall: { en: 'Nightfall', ru: 'Ночная вылазка' },
};

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
  /**
   * Attack a unit between `min` and `max` spaces away. `straightLine` requires
   * the shot to run down one of the six directions; `blocked` says whether a
   * unit in the way stops it.
   */
  | {
      readonly kind: 'rangedAttack';
      readonly min: number;
      readonly max: number;
      readonly straightLine: boolean;
      readonly blocked: boolean;
    }
  /** Move between `min` and `max` spaces, then attack an adjacent enemy. */
  | {
      readonly kind: 'chargeAttack';
      readonly min: number;
      readonly max: number;
      readonly straightLine: boolean;
    }
  /** Move exactly `distance` spaces, each step into an empty hex. */
  | { readonly kind: 'multiMove'; readonly distance: number }
  /** Let a friendly unit within `range` perform a normal move or attack. */
  | { readonly kind: 'grantManeuver'; readonly maneuver: 'move' | 'attack'; readonly range: number }
  /** Perform one maneuver with each of your units of this type. */
  | { readonly kind: 'maneuverEachUnit' }
  /**
   * Royal Guard: played with the Royal Coin, not a unit coin — move up to
   * `distance` spaces, ending on an empty location you control.
   */
  | { readonly kind: 'royalRedeploy'; readonly distance: number }
  /** Herald: bolster an adjacent unbolstered friendly unit from the supply. */
  | { readonly kind: 'bolsterAllyFromSupply' }
  /** Earl: control a location, then proclaim without spending a Seal. */
  | { readonly kind: 'controlThenProclaim' }
  /** Bishop: recruit, then either move or attack. */
  | { readonly kind: 'recruitThenManeuver' }
  /** Siege Tower: attack twice. */
  | { readonly kind: 'attackTwice' }
  /** War Wagon: push an adjacent ally one space and follow into its space. */
  | { readonly kind: 'pushAlly' }
  /** Sapper: move, then attack a Fortification. */
  | { readonly kind: 'moveThenAttackFort' }
  /** Assassin: move, then poison an adjacent unit. */
  | { readonly kind: 'moveThenPoison' }
  /** Saboteur: poison a unit `min`..`max` spaces away. */
  | { readonly kind: 'poisonAtRange'; readonly min: number; readonly max: number }
  /** Infiltrator: move onto an enemy-controlled location and take it. */
  | { readonly kind: 'infiltrate'; readonly distance: number }
  /** Skirmisher: move `distance` spaces, ending next to an enemy. */
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
  /** Total coins of this type in the game: 2 start in the bag, the rest are supply. */
  readonly coins: number;
  /** Disc colour of the printed coin, sampled from the coin art. */
  readonly color: string;
  /** File under `/coins` holding the coin image. */
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

const U = (d: UnitDefinition): UnitDefinition => d;

export const UNITS: Readonly<Record<UnitId, UnitDefinition>> = {
  swordsman: U({
    id: 'swordsman',
    set: 'base',
    name: { en: 'Swordsman', ru: 'Мечник' },
    coins: 5,
    color: '#364f7c',
    art: 'swordsman',
    attributes: ['moveAfterAttack'],
    restrictions: [],
    text: {
      attribute: {
        en: 'After the Swordsman attacks, it may move.',
        ru: 'После атаки мечник может сделать ход.',
      },
    },
  }),

  archer: U({
    id: 'archer',
    set: 'base',
    name: { en: 'Archer', ru: 'Лучник' },
    coins: 4,
    color: '#68b199',
    art: 'archer',
    tactic: { kind: 'rangedAttack', min: 2, max: 2, straightLine: false, blocked: false },
    attributes: [],
    restrictions: ['noNormalAttack'],
    text: {
      tactic: {
        en: 'TACTIC: Attack a unit two spaces away. The intervening space may be occupied by a unit.',
        ru: 'ТАКТИКА: атакуйте отряд через одну клетку. Клетка между ними может быть занята.',
      },
      restriction: {
        en: 'The Archer can only attack by using its tactic.',
        ru: 'Лучник может атаковать только своей тактикой.',
      },
    },
  }),

  pikeman: U({
    id: 'pikeman',
    set: 'base',
    name: { en: 'Pikeman', ru: 'Пикинёр' },
    coins: 4,
    color: '#d8b448',
    art: 'pikeman',
    attributes: ['retaliate'],
    restrictions: [],
    text: {
      attribute: {
        en: 'When the Pikeman is attacked by an adjacent unit, remove a coin from that unit.',
        ru: 'Когда пикинёра атакует соседний отряд, снимите с этого отряда монету.',
      },
    },
  }),

  cavalry: U({
    id: 'cavalry',
    set: 'base',
    name: { en: 'Cavalry', ru: 'Кавалерия' },
    coins: 4,
    color: '#d48242',
    art: 'cavalry',
    tactic: { kind: 'chargeAttack', min: 1, max: 1, straightLine: false },
    attributes: [],
    restrictions: [],
    text: {
      tactic: { en: 'TACTIC: Move and then attack.', ru: 'ТАКТИКА: сделайте ход, затем атакуйте.' },
    },
  }),

  crossbowman: U({
    id: 'crossbowman',
    set: 'base',
    name: { en: 'Crossbowman', ru: 'Арбалетчик' },
    coins: 5,
    color: '#9b5b63',
    art: 'crossbowman',
    tactic: { kind: 'rangedAttack', min: 2, max: 2, straightLine: true, blocked: true },
    attributes: [],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Attack a unit two spaces away in a straight line. The intervening space cannot be occupied by a unit.',
        ru: 'ТАКТИКА: атакуйте отряд через одну клетку по прямой. Клетка между ними должна быть пуста.',
      },
    },
  }),

  lancer: U({
    id: 'lancer',
    set: 'base',
    name: { en: 'Lancer', ru: 'Копейщик' },
    coins: 4,
    color: '#df4b3e',
    art: 'lancer',
    tactic: { kind: 'chargeAttack', min: 1, max: 2, straightLine: true },
    attributes: [],
    restrictions: ['noNormalAttack'],
    text: {
      tactic: {
        en: 'TACTIC: Move one or two spaces and then attack, all in a straight line.',
        ru: 'ТАКТИКА: пройдите одну или две клетки и атакуйте — всё по одной прямой.',
      },
      restriction: {
        en: 'The Lancer can only attack by using its tactic.',
        ru: 'Копейщик может атаковать только своей тактикой.',
      },
    },
  }),

  lightCavalry: U({
    id: 'lightCavalry',
    set: 'base',
    name: { en: 'Light Cavalry', ru: 'Лёгкая кавалерия' },
    coins: 5,
    color: '#9cb96b',
    art: 'light_cavalry',
    tactic: { kind: 'multiMove', distance: 2 },
    attributes: [],
    restrictions: [],
    text: {
      tactic: { en: 'TACTIC: Move two spaces.', ru: 'ТАКТИКА: пройдите две клетки.' },
    },
  }),

  scout: U({
    id: 'scout',
    set: 'base',
    name: { en: 'Scout', ru: 'Разведчик' },
    coins: 5,
    color: '#0470b0',
    art: 'scout',
    attributes: ['deployNextToFriendly'],
    restrictions: [],
    text: {
      attribute: {
        en: 'The Scout may be deployed adjacent to any friendly unit.',
        ru: 'Разведчика можно развернуть рядом с любым дружественным отрядом.',
      },
    },
  }),

  knight: U({
    id: 'knight',
    set: 'base',
    name: { en: 'Knight', ru: 'Рыцарь' },
    coins: 4,
    color: '#009ed1',
    art: 'knight',
    attributes: ['onlyAttackedByBolstered'],
    restrictions: [],
    text: {
      attribute: {
        en: 'The Knight can only be attacked by units that are bolstered.',
        ru: 'Рыцаря могут атаковать только усиленные отряды.',
      },
    },
  }),

  marshal: U({
    id: 'marshal',
    set: 'base',
    name: { en: 'Marshal', ru: 'Маршал' },
    coins: 5,
    color: '#c56647',
    art: 'marshal',
    tactic: { kind: 'grantManeuver', maneuver: 'attack', range: 2 },
    attributes: [],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Choose a friendly unit that is within two spaces of the Marshal. The chosen unit attacks, if able.',
        ru: 'ТАКТИКА: выберите дружественный отряд в двух клетках от маршала. Этот отряд атакует, если может.',
      },
    },
  }),

  mercenary: U({
    id: 'mercenary',
    set: 'base',
    name: { en: 'Mercenary', ru: 'Наёмник' },
    coins: 5,
    color: '#912c31',
    art: 'mercenary',
    attributes: ['freeManeuverOnRecruit'],
    restrictions: [],
    text: {
      attribute: {
        en: 'After you recruit a Mercenary, you may maneuver your Mercenary unit.',
        ru: 'Наняв наёмника, вы можете сделать манёвр своим наёмником.',
      },
    },
  }),

  berserker: U({
    id: 'berserker',
    set: 'base',
    name: { en: 'Berserker', ru: 'Берсерк' },
    coins: 5,
    color: '#3d895a',
    art: 'berserker',
    attributes: ['maneuverAgainForCoin'],
    restrictions: [],
    text: {
      attribute: {
        en: 'After the Berserker maneuvers, you may maneuver it again by discarding a bolstered coin from the Berserker unit. You may do this multiple times, but you may not remove the final coin.',
        ru: 'После манёвра берсерка вы можете сделать ещё один манёвр, сбросив с него монету усиления. Так можно повторять, но последнюю монету снять нельзя.',
      },
    },
  }),

  ensign: U({
    id: 'ensign',
    set: 'base',
    name: { en: 'Ensign', ru: 'Знаменосец' },
    coins: 5,
    color: '#bfc367',
    art: 'ensign',
    tactic: { kind: 'grantManeuver', maneuver: 'move', range: 2 },
    attributes: [],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Choose a friendly unit within two spaces of the Ensign. The chosen unit performs a normal move to a space within two spaces of the Ensign.',
        ru: 'ТАКТИКА: выберите дружественный отряд в двух клетках от знаменосца. Он делает обычный ход на клетку, которая тоже в двух клетках от знаменосца.',
      },
    },
  }),

  footman: U({
    id: 'footman',
    set: 'base',
    name: { en: 'Footman', ru: 'Пехотинец' },
    coins: 5,
    color: '#009199',
    art: 'footman',
    tactic: { kind: 'maneuverEachUnit' },
    attributes: ['twoUnitsDeployed'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Perform one maneuver with each Footman unit on the board.',
        ru: 'ТАКТИКА: сделайте по одному манёвру каждым своим пехотинцем на поле.',
      },
      attribute: {
        en: 'Two Footman units may be deployed at a time.',
        ru: 'Одновременно можно держать развёрнутыми двух пехотинцев.',
      },
    },
  }),

  warriorPriest: U({
    id: 'warriorPriest',
    set: 'base',
    name: { en: 'Warrior Priest', ru: 'Воин-жрец' },
    coins: 4,
    color: '#745665',
    art: 'warrior_priest',
    attributes: ['drawAndUseAfterControlOrAttack'],
    restrictions: [],
    text: {
      attribute: {
        en: 'After the Warrior Priest attacks or controls, draw one coin from your bag and immediately use it to take any action.',
        ru: 'После того как воин-жрец атаковал или захватил локацию, возьмите монету из мешка и сразу разыграйте её любым действием.',
      },
    },
  }),

  royalGuard: U({
    id: 'royalGuard',
    set: 'base',
    name: { en: 'Royal Guard', ru: 'Королевская гвардия' },
    coins: 5,
    color: '#dd7c7b',
    art: 'royal_guard',
    tactic: { kind: 'royalRedeploy', distance: 2 },
    attributes: ['absorbHitFromSupply'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Discard the Royal Coin to move the Royal Guard up to 2 spaces to a location that you control.',
        ru: 'ТАКТИКА: сбросьте королевскую монету, чтобы переставить гвардию на две клетки на свою локацию.',
      },
      attribute: {
        en: 'When the Royal Guard is attacked, you may remove a Royal Guard coin from the supply rather than from its unit.',
        ru: 'Когда гвардию атакуют, можно снять монету гвардии из запаса, а не из самого отряда.',
      },
    },
  }),

  // ── Nobility ──────────────────────────────────────────────────────────────

  herald: U({
    id: 'herald',
    set: 'nobility',
    name: { en: 'Herald', ru: 'Герольд' },
    coins: 5,
    color: '#e0a83c',
    art: 'herald',
    tactic: { kind: 'bolsterAllyFromSupply' },
    attributes: ['maneuverAfterProclaim'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Bolster one adjacent unbolstered friendly unit with a coin from the supply.',
        ru: 'ТАКТИКА: усильте соседний неусиленный дружественный отряд монетой из его запаса.',
      },
      attribute: {
        en: 'After you proclaim, the Herald may maneuver.',
        ru: 'После того как вы огласили указ, герольд может сделать манёвр.',
      },
    },
  }),

  earl: U({
    id: 'earl',
    set: 'nobility',
    name: { en: 'Earl', ru: 'Граф' },
    coins: 5,
    color: '#2f6b4f',
    art: 'earl',
    tactic: { kind: 'controlThenProclaim' },
    attributes: ['moveAfterDeploy'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Control a location and then proclaim without placing a Seal, even if the Decree already has your seal.',
        ru: 'ТАКТИКА: захватите локацию и огласите указ, не тратя печать, — даже если ваша печать на нём уже стоит.',
      },
      attribute: {
        en: 'After the Earl is deployed it may move.',
        ru: 'Сразу после развёртывания граф может сделать ход.',
      },
    },
  }),

  bishop: U({
    id: 'bishop',
    set: 'nobility',
    name: { en: 'Bishop', ru: 'Епископ' },
    coins: 5,
    color: '#6b3fa0',
    art: 'bishop',
    tactic: { kind: 'recruitThenManeuver' },
    attributes: [],
    restrictions: ['onlyAttackedByUnbolstered'],
    text: {
      tactic: {
        en: 'TACTIC: Recruit and then either move or attack.',
        ru: 'ТАКТИКА: наймите монету, затем сделайте ход или атакуйте.',
      },
      restriction: {
        en: 'The Bishop cannot be attacked by units that are bolstered.',
        ru: 'Епископа не могут атаковать усиленные отряды.',
      },
    },
  }),

  bannerman: U({
    id: 'bannerman',
    set: 'nobility',
    name: { en: 'Bannerman', ru: 'Знаменосец знати' },
    coins: 4,
    color: '#12657c',
    art: 'bannerman',
    attributes: ['shoveEnemyAfterManeuver'],
    restrictions: [],
    text: {
      attribute: {
        en: 'After the Bannerman maneuvers you may move one adjacent enemy unit one space.',
        ru: 'После манёвра знаменосца вы можете сдвинуть один соседний вражеский отряд на клетку.',
      },
    },
  }),

  // ── Siege ─────────────────────────────────────────────────────────────────

  trebuchet: U({
    id: 'trebuchet',
    set: 'siege',
    name: { en: 'Trebuchet', ru: 'Требушет' },
    coins: 5,
    color: '#6b4a2f',
    art: 'trebuchet',
    tactic: { kind: 'rangedAttack', min: 2, max: 3, straightLine: true, blocked: false },
    siegeTactic: true,
    attributes: [],
    restrictions: ['noNormalAttack'],
    text: {
      tactic: {
        en: 'SIEGE TACTIC: Attack a unit two or three spaces away in a straight line. The intervening spaces may be occupied by a unit.',
        ru: 'ОСАДНАЯ ТАКТИКА: атакуйте отряд через одну или две клетки по прямой. Клетки между ними могут быть заняты.',
      },
      restriction: {
        en: 'The Trebuchet can only attack by using its tactic.',
        ru: 'Требушет может атаковать только своей тактикой.',
      },
    },
  }),

  siegeTower: U({
    id: 'siegeTower',
    set: 'siege',
    name: { en: 'Siege Tower', ru: 'Осадная башня' },
    coins: 5,
    color: '#7fb6d9',
    art: 'siege_tower',
    tactic: { kind: 'attackTwice' },
    siegeTactic: true,
    attributes: ['bolsterOnDeploy'],
    restrictions: [],
    text: {
      tactic: { en: 'SIEGE TACTIC: Attack twice.', ru: 'ОСАДНАЯ ТАКТИКА: атакуйте дважды.' },
      attribute: {
        en: 'When you deploy the Siege Tower, you may immediately bolster it with a coin from the supply.',
        ru: 'Развернув осадную башню, вы можете сразу усилить её монетой из запаса.',
      },
    },
  }),

  sapper: U({
    id: 'sapper',
    set: 'siege',
    name: { en: 'Sapper', ru: 'Сапёр' },
    coins: 5,
    color: '#5a6fc0',
    art: 'sapper',
    tactic: { kind: 'moveThenAttackFort' },
    attributes: ['buildFortOnMove'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Move and then attack a Fortification.',
        ru: 'ТАКТИКА: сделайте ход, затем атакуйте укрепление.',
      },
      attribute: {
        en: 'When the Sapper moves to a location without a Fortification, you may place a Fortification from the supply on the location.',
        ru: 'Когда сапёр приходит на локацию без укрепления, вы можете поставить туда укрепление из запаса.',
      },
    },
  }),

  warWagon: U({
    id: 'warWagon',
    set: 'siege',
    name: { en: 'War Wagon', ru: 'Боевой фургон' },
    coins: 4,
    color: '#b6203a',
    art: 'war_wagon',
    tactic: { kind: 'pushAlly' },
    siegeTactic: true,
    attributes: ['absorbHitForAlly'],
    restrictions: [],
    text: {
      tactic: {
        en: 'SIEGE TACTIC: Move an adjacent friendly unit and then move the War Wagon into the vacated space.',
        ru: 'ОСАДНАЯ ТАКТИКА: сдвиньте соседний дружественный отряд и займите фургоном освободившуюся клетку.',
      },
      attribute: {
        en: 'When an adjacent friendly unit is attacked, you may remove a coin from the War Wagon unit rather than from the attacked unit.',
        ru: 'Когда атакуют соседний дружественный отряд, монету можно снять с фургона, а не с него.',
      },
    },
  }),

  // ── Nightfall ─────────────────────────────────────────────────────────────

  assassin: U({
    id: 'assassin',
    set: 'nightfall',
    name: { en: 'Assassin', ru: 'Убийца' },
    coins: 4,
    color: '#8e1f47',
    art: 'assassin',
    tactic: { kind: 'moveThenPoison' },
    attributes: ['burnSupplyAfterKillingPoisoned'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Move and then poison an adjacent unit.',
        ru: 'ТАКТИКА: сделайте ход, затем отравите соседний отряд.',
      },
      attribute: {
        en: 'After the Assassin attacks a poisoned unit, you may take a coin of the attacked unit from the supply and remove it from the game.',
        ru: 'Атаковав отравленный отряд, убийца может изъять монету этого отряда из его запаса — она выбывает из игры.',
      },
    },
  }),

  saboteur: U({
    id: 'saboteur',
    set: 'nightfall',
    name: { en: 'Saboteur', ru: 'Диверсант' },
    coins: 5,
    color: '#d63b7a',
    art: 'saboteur',
    tactic: { kind: 'poisonAtRange', min: 1, max: 2 },
    attributes: ['tacticOnRecruit'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Poison a unit one or two spaces away. If two spaces, the intervening space may be occupied by a unit.',
        ru: 'ТАКТИКА: отравите отряд на расстоянии одной или двух клеток. Клетка между ними может быть занята.',
      },
      attribute: {
        en: "After you recruit a Saboteur, you may use the Saboteur's tactic.",
        ru: 'Наняв диверсанта, вы можете сразу применить его тактику.',
      },
    },
  }),

  infiltrator: U({
    id: 'infiltrator',
    set: 'nightfall',
    name: { en: 'Infiltrator', ru: 'Лазутчик' },
    coins: 5,
    color: '#5c5f66',
    art: 'infiltrator',
    tactic: { kind: 'infiltrate', distance: 1 },
    attributes: ['deceiveAfterControl'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Move ending in a location controlled by an opponent and then control that location.',
        ru: 'ТАКТИКА: перейдите на локацию под контролем соперника и захватите её.',
      },
      attribute: {
        en: 'After the Infiltrator controls, you may deceive your opponent.',
        ru: 'Захватив локацию, лазутчик может подбросить сопернику обманную монету.',
      },
    },
  }),

  skirmisher: U({
    id: 'skirmisher',
    set: 'nightfall',
    name: { en: 'Skirmisher', ru: 'Застрельщик' },
    coins: 4,
    color: '#8a8d93',
    art: 'skirmisher',
    tactic: { kind: 'skirmish', distance: 2 },
    attributes: ['deceiveWhenAttacked'],
    restrictions: [],
    text: {
      tactic: {
        en: 'TACTIC: Move two spaces, ending in a space adjacent to an enemy unit.',
        ru: 'ТАКТИКА: пройдите две клетки и остановитесь рядом с вражеским отрядом.',
      },
      attribute: {
        en: 'When the Skirmisher is attacked, you may deceive your opponent. If you do, the attack does not remove a coin.',
        ru: 'Когда застрельщика атакуют, он может подбросить обманную монету — тогда атака не снимает монету.',
      },
    },
  }),
};

export const UNIT_IDS: readonly UnitId[] = Object.keys(UNITS) as UnitId[];

/** Unit types available when these sets are switched on. */
export function unitsForSets(sets: readonly UnitSet[]): UnitId[] {
  return UNIT_IDS.filter((id) => sets.includes(UNITS[id].set));
}

export const ROYAL_COIN_NAME: LocalizedText = { en: 'Royal Coin', ru: 'Королевская монета' };
export const ROYAL_COIN_COLOR = '#c9a227';

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

/** Coins of each type that start in a player's bag when they draft that unit. */
export const COINS_IN_BAG_PER_UNIT = 2;

/** Unit types drafted per player, by table size. */
export const UNITS_PER_PLAYER: Readonly<Record<2 | 4, number>> = { 2: 4, 4: 3 };

export function hasAttribute(unit: UnitId, attr: AttributeId): boolean {
  return UNITS[unit].attributes.includes(attr);
}

export function hasRestriction(unit: UnitId, r: RestrictionId): boolean {
  return UNITS[unit].restrictions.includes(r);
}

/** Units a player may have deployed at once — 1, except the Footman's 2. */
export function maxDeployed(unit: UnitId): number {
  return hasAttribute(unit, 'twoUnitsDeployed') ? 2 : 1;
}
