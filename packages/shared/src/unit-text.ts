/**
 * What each card says, and what it looks like.
 *
 * Transcribed from the printed cards and the print-and-play coin art. This
 * is the half of a unit that is *not* a rule: no engine reads a name, a
 * colour or a sentence of card text, and every one of them changes with the
 * language. The half that is a rule — coin counts, tactics, attributes — is
 * generated from `wc-core` into `generated.ts` and merged in `units.ts`.
 */

import type { LocalizedText, UnitId } from './units.js';

export interface UnitText {
  readonly name: LocalizedText;
  /** Disc colour of the printed coin, sampled from the coin art. */
  readonly color: string;
  /** File under `/coins` holding the coin image. */
  readonly art: string;
  readonly text: {
    readonly tactic?: LocalizedText;
    readonly attribute?: LocalizedText;
    readonly restriction?: LocalizedText;
  };
}

export const UNIT_TEXT: Readonly<Record<UnitId, UnitText>> = {
  swordsman: {
    name: {"en":"Swordsman","ru":"Мечник"},
    color: "#364f7c",
    art: "swordsman",
    text: {"attribute":{"en":"After the Swordsman attacks, it may move.","ru":"После атаки мечник может сделать ход."}},
  },
  archer: {
    name: {"en":"Archer","ru":"Лучник"},
    color: "#68b199",
    art: "archer",
    text: {"tactic":{"en":"TACTIC: Attack a unit two spaces away. The intervening space may be occupied by a unit.","ru":"ТАКТИКА: атакуйте отряд через одну клетку. Клетка между ними может быть занята."},"restriction":{"en":"The Archer can only attack by using its tactic.","ru":"Лучник может атаковать только своей тактикой."}},
  },
  pikeman: {
    name: {"en":"Pikeman","ru":"Пикинёр"},
    color: "#d8b448",
    art: "pikeman",
    text: {"attribute":{"en":"When the Pikeman is attacked by an adjacent unit, remove a coin from that unit.","ru":"Когда пикинёра атакует соседний отряд, снимите с этого отряда монету."}},
  },
  cavalry: {
    name: {"en":"Cavalry","ru":"Кавалерия"},
    color: "#d48242",
    art: "cavalry",
    text: {"tactic":{"en":"TACTIC: Move and then attack.","ru":"ТАКТИКА: сделайте ход, затем атакуйте."}},
  },
  crossbowman: {
    name: {"en":"Crossbowman","ru":"Арбалетчик"},
    color: "#9b5b63",
    art: "crossbowman",
    text: {"tactic":{"en":"TACTIC: Attack a unit two spaces away in a straight line. The intervening space cannot be occupied by a unit.","ru":"ТАКТИКА: атакуйте отряд через одну клетку по прямой. Клетка между ними должна быть пуста."}},
  },
  lancer: {
    name: {"en":"Lancer","ru":"Копейщик"},
    color: "#df4b3e",
    art: "lancer",
    text: {"tactic":{"en":"TACTIC: Move one or two spaces and then attack, all in a straight line.","ru":"ТАКТИКА: пройдите одну или две клетки и атакуйте — всё по одной прямой."},"restriction":{"en":"The Lancer can only attack by using its tactic.","ru":"Копейщик может атаковать только своей тактикой."}},
  },
  lightCavalry: {
    name: {"en":"Light Cavalry","ru":"Лёгкая кавалерия"},
    color: "#9cb96b",
    art: "light_cavalry",
    text: {"tactic":{"en":"TACTIC: Move two spaces.","ru":"ТАКТИКА: пройдите две клетки."}},
  },
  scout: {
    name: {"en":"Scout","ru":"Разведчик"},
    color: "#0470b0",
    art: "scout",
    text: {"attribute":{"en":"The Scout may be deployed adjacent to any friendly unit.","ru":"Разведчика можно развернуть рядом с любым дружественным отрядом."}},
  },
  knight: {
    name: {"en":"Knight","ru":"Рыцарь"},
    color: "#009ed1",
    art: "knight",
    text: {"attribute":{"en":"The Knight can only be attacked by units that are bolstered.","ru":"Рыцаря могут атаковать только усиленные отряды."}},
  },
  marshal: {
    name: {"en":"Marshal","ru":"Маршал"},
    color: "#c56647",
    art: "marshal",
    text: {"tactic":{"en":"TACTIC: Choose a friendly unit that is within two spaces of the Marshal. The chosen unit attacks, if able.","ru":"ТАКТИКА: выберите дружественный отряд в двух клетках от маршала. Этот отряд атакует, если может."}},
  },
  mercenary: {
    name: {"en":"Mercenary","ru":"Наёмник"},
    color: "#912c31",
    art: "mercenary",
    text: {"attribute":{"en":"After you recruit a Mercenary, you may maneuver your Mercenary unit.","ru":"Наняв наёмника, вы можете сделать манёвр своим наёмником."}},
  },
  berserker: {
    name: {"en":"Berserker","ru":"Берсерк"},
    color: "#3d895a",
    art: "berserker",
    text: {"attribute":{"en":"After the Berserker maneuvers, you may maneuver it again by discarding a bolstered coin from the Berserker unit. You may do this multiple times, but you may not remove the final coin.","ru":"После манёвра берсерка вы можете сделать ещё один манёвр, сбросив с него монету усиления. Так можно повторять, но последнюю монету снять нельзя."}},
  },
  ensign: {
    name: {"en":"Ensign","ru":"Знаменосец"},
    color: "#bfc367",
    art: "ensign",
    text: {"tactic":{"en":"TACTIC: Choose a friendly unit within two spaces of the Ensign. The chosen unit performs a normal move to a space within two spaces of the Ensign.","ru":"ТАКТИКА: выберите дружественный отряд в двух клетках от знаменосца. Он делает обычный ход на клетку, которая тоже в двух клетках от знаменосца."}},
  },
  footman: {
    name: {"en":"Footman","ru":"Пехотинец"},
    color: "#009199",
    art: "footman",
    text: {"tactic":{"en":"TACTIC: Perform one maneuver with each Footman unit on the board.","ru":"ТАКТИКА: сделайте по одному манёвру каждым своим пехотинцем на поле."},"attribute":{"en":"Two Footman units may be deployed at a time.","ru":"Одновременно можно держать развёрнутыми двух пехотинцев."}},
  },
  warriorPriest: {
    name: {"en":"Warrior Priest","ru":"Воин-жрец"},
    color: "#745665",
    art: "warrior_priest",
    text: {"attribute":{"en":"After the Warrior Priest attacks or controls, draw one coin from your bag and immediately use it to take any action.","ru":"После того как воин-жрец атаковал или захватил локацию, возьмите монету из мешка и сразу разыграйте её любым действием."}},
  },
  royalGuard: {
    name: {"en":"Royal Guard","ru":"Королевская гвардия"},
    color: "#dd7c7b",
    art: "royal_guard",
    text: {"tactic":{"en":"TACTIC: Discard the Royal Coin to move the Royal Guard up to 2 spaces to a location that you control.","ru":"ТАКТИКА: сбросьте королевскую монету, чтобы переставить гвардию на две клетки на свою локацию."},"attribute":{"en":"When the Royal Guard is attacked, you may remove a Royal Guard coin from the supply rather than from its unit.","ru":"Когда гвардию атакуют, можно снять монету гвардии из запаса, а не из самого отряда."}},
  },
  herald: {
    name: {"en":"Herald","ru":"Герольд"},
    color: "#e0a83c",
    art: "herald",
    text: {"tactic":{"en":"TACTIC: Bolster one adjacent unbolstered friendly unit with a coin from the supply.","ru":"ТАКТИКА: усильте соседний неусиленный дружественный отряд монетой из его запаса."},"attribute":{"en":"After you proclaim, the Herald may maneuver.","ru":"После того как вы огласили указ, герольд может сделать манёвр."}},
  },
  earl: {
    name: {"en":"Earl","ru":"Граф"},
    color: "#2f6b4f",
    art: "earl",
    text: {"tactic":{"en":"TACTIC: Control a location and then proclaim without placing a Seal, even if the Decree already has your seal.","ru":"ТАКТИКА: захватите локацию и огласите указ, не тратя печать, — даже если ваша печать на нём уже стоит."},"attribute":{"en":"After the Earl is deployed it may move.","ru":"Сразу после развёртывания граф может сделать ход."}},
  },
  bishop: {
    name: {"en":"Bishop","ru":"Епископ"},
    color: "#6b3fa0",
    art: "bishop",
    text: {"tactic":{"en":"TACTIC: Recruit and then either move or attack.","ru":"ТАКТИКА: наймите монету, затем сделайте ход или атакуйте."},"restriction":{"en":"The Bishop cannot be attacked by units that are bolstered.","ru":"Епископа не могут атаковать усиленные отряды."}},
  },
  bannerman: {
    name: {"en":"Bannerman","ru":"Знаменосец знати"},
    color: "#12657c",
    art: "bannerman",
    text: {"attribute":{"en":"After the Bannerman maneuvers you may move one adjacent enemy unit one space.","ru":"После манёвра знаменосца вы можете сдвинуть один соседний вражеский отряд на клетку."}},
  },
  trebuchet: {
    name: {"en":"Trebuchet","ru":"Требушет"},
    color: "#6b4a2f",
    art: "trebuchet",
    text: {"tactic":{"en":"SIEGE TACTIC: Attack a unit two or three spaces away in a straight line. The intervening spaces may be occupied by a unit.","ru":"ОСАДНАЯ ТАКТИКА: атакуйте отряд через одну или две клетки по прямой. Клетки между ними могут быть заняты."},"restriction":{"en":"The Trebuchet can only attack by using its tactic.","ru":"Требушет может атаковать только своей тактикой."}},
  },
  siegeTower: {
    name: {"en":"Siege Tower","ru":"Осадная башня"},
    color: "#7fb6d9",
    art: "siege_tower",
    text: {"tactic":{"en":"SIEGE TACTIC: Attack twice.","ru":"ОСАДНАЯ ТАКТИКА: атакуйте дважды."},"attribute":{"en":"When you deploy the Siege Tower, you may immediately bolster it with a coin from the supply.","ru":"Развернув осадную башню, вы можете сразу усилить её монетой из запаса."}},
  },
  sapper: {
    name: {"en":"Sapper","ru":"Сапёр"},
    color: "#5a6fc0",
    art: "sapper",
    text: {"tactic":{"en":"TACTIC: Move and then attack a Fortification.","ru":"ТАКТИКА: сделайте ход, затем атакуйте укрепление."},"attribute":{"en":"When the Sapper moves to a location without a Fortification, you may place a Fortification from the supply on the location.","ru":"Когда сапёр приходит на локацию без укрепления, вы можете поставить туда укрепление из запаса."}},
  },
  warWagon: {
    name: {"en":"War Wagon","ru":"Боевой фургон"},
    color: "#b6203a",
    art: "war_wagon",
    text: {"tactic":{"en":"SIEGE TACTIC: Move an adjacent friendly unit and then move the War Wagon into the vacated space.","ru":"ОСАДНАЯ ТАКТИКА: сдвиньте соседний дружественный отряд и займите фургоном освободившуюся клетку."},"attribute":{"en":"When an adjacent friendly unit is attacked, you may remove a coin from the War Wagon unit rather than from the attacked unit.","ru":"Когда атакуют соседний дружественный отряд, монету можно снять с фургона, а не с него."}},
  },
  assassin: {
    name: {"en":"Assassin","ru":"Убийца"},
    color: "#8e1f47",
    art: "assassin",
    text: {"tactic":{"en":"TACTIC: Move and then poison an adjacent unit.","ru":"ТАКТИКА: сделайте ход, затем отравите соседний отряд."},"attribute":{"en":"After the Assassin attacks a poisoned unit, you may take a coin of the attacked unit from the supply and remove it from the game.","ru":"Атаковав отравленный отряд, убийца может изъять монету этого отряда из его запаса — она выбывает из игры."}},
  },
  saboteur: {
    name: {"en":"Saboteur","ru":"Диверсант"},
    color: "#d63b7a",
    art: "saboteur",
    text: {"tactic":{"en":"TACTIC: Poison a unit one or two spaces away. If two spaces, the intervening space may be occupied by a unit.","ru":"ТАКТИКА: отравите отряд на расстоянии одной или двух клеток. Клетка между ними может быть занята."},"attribute":{"en":"After you recruit a Saboteur, you may use the Saboteur's tactic.","ru":"Наняв диверсанта, вы можете сразу применить его тактику."}},
  },
  infiltrator: {
    name: {"en":"Infiltrator","ru":"Лазутчик"},
    color: "#5c5f66",
    art: "infiltrator",
    text: {"tactic":{"en":"TACTIC: Move ending in a location controlled by an opponent and then control that location.","ru":"ТАКТИКА: перейдите на локацию под контролем соперника и захватите её."},"attribute":{"en":"After the Infiltrator controls, you may deceive your opponent.","ru":"Захватив локацию, лазутчик может подбросить сопернику обманную монету."}},
  },
  skirmisher: {
    name: {"en":"Skirmisher","ru":"Застрельщик"},
    color: "#8a8d93",
    art: "skirmisher",
    text: {"tactic":{"en":"TACTIC: Move two spaces, ending in a space adjacent to an enemy unit.","ru":"ТАКТИКА: пройдите две клетки и остановитесь рядом с вражеским отрядом."},"attribute":{"en":"When the Skirmisher is attacked, you may deceive your opponent. If you do, the attack does not remove a coin.","ru":"Когда застрельщика атакуют, он может подбросить обманную монету — тогда атака не снимает монету."}},
  },
};

export const SET_NAMES_TEXT = {
  base: {
    en: "Base game",
    ru: "Базовая игра"
  },
  nobility: {
    en: "Nobility",
    ru: "Знать"
  },
  siege: {
    en: "Siege",
    ru: "Осада"
  },
  nightfall: {
    en: "Nightfall",
    ru: "Ночная вылазка"
  }
} as const;

export const ROYAL_COIN_NAME_TEXT: LocalizedText = {"en":"Royal Coin","ru":"Королевская монета"};
export const ROYAL_COIN_COLOR_TEXT = "#c9a227";
