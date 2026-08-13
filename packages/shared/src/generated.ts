/**
 * The printed facts, generated from `wc-core`.
 *
 * Do not edit: `node scripts/generate-shared.mjs` writes this file, and
 * `npm run guard` fails if it is out of date. The numbers here are rules —
 * a hex list, a coin count, what a tactic does — and the rules live in Rust.
 * Everything a person chose rather than a rule fixed (names, card text,
 * colours, art) is hand-written in `units.ts` and `decrees.ts` instead.
 */

import type { AttributeId, RestrictionId, TacticSpec, UnitId, UnitSet } from './units.js';
import type { HexId } from './hex.js';
import type { DecreeId } from './decrees.js';

/** Unit types, in the order every packed key and fitted vector assumes. */
export const UNIT_IDS: readonly UnitId[] = ["swordsman","archer","pikeman","cavalry","crossbowman","lancer","lightCavalry","scout","knight","marshal","mercenary","berserker","ensign","footman","warriorPriest","royalGuard","herald","earl","bishop","bannerman","trebuchet","siegeTower","sapper","warWagon","assassin","saboteur","infiltrator","skirmisher"];

export const UNIT_SETS: readonly UnitSet[] = ["base","nobility","siege","nightfall"];
export const DECREE_IDS: readonly DecreeId[] = ["sacrifice","guard","march","enlist","redeploy","spy","reinforce"];

/** Coins of each type that start in a player's bag when the unit is drafted. */
export const COINS_IN_BAG_PER_UNIT = 2;
export const HAND_SIZE = 3;
export const FORTIFICATIONS_TOTAL = 7;
export const FORTIFICATIONS_ON_BOARD = 4;

/** What the engine executes for each card, and the caps it enforces. */
export interface UnitFacts {
  readonly set: UnitSet;
  /** Total coins of this type in the game. */
  readonly coins: number;
  readonly tactic?: TacticSpec;
  /** A Siege Tactic may only be used while the unit is bolstered. */
  readonly siegeTactic: boolean;
  readonly attributes: readonly AttributeId[];
  readonly restrictions: readonly RestrictionId[];
  /** Units of this type one player may have deployed at once. */
  readonly maxDeployed: number;
}

export const UNIT_FACTS: Readonly<Record<UnitId, UnitFacts>> = {
  swordsman: { set: "base", coins: 5, siegeTactic: false, attributes: ["moveAfterAttack"], restrictions: [], maxDeployed: 1 },
  archer: { set: "base", coins: 4, tactic: {"kind":"rangedAttack","min":2,"max":2,"straightLine":false,"blocked":false} as TacticSpec, siegeTactic: false, attributes: [], restrictions: ["noNormalAttack"], maxDeployed: 1 },
  pikeman: { set: "base", coins: 4, siegeTactic: false, attributes: ["retaliate"], restrictions: [], maxDeployed: 1 },
  cavalry: { set: "base", coins: 4, tactic: {"kind":"chargeAttack","min":1,"max":1,"straightLine":false} as TacticSpec, siegeTactic: false, attributes: [], restrictions: [], maxDeployed: 1 },
  crossbowman: { set: "base", coins: 5, tactic: {"kind":"rangedAttack","min":2,"max":2,"straightLine":true,"blocked":true} as TacticSpec, siegeTactic: false, attributes: [], restrictions: [], maxDeployed: 1 },
  lancer: { set: "base", coins: 4, tactic: {"kind":"chargeAttack","min":1,"max":2,"straightLine":true} as TacticSpec, siegeTactic: false, attributes: [], restrictions: ["noNormalAttack"], maxDeployed: 1 },
  lightCavalry: { set: "base", coins: 5, tactic: {"kind":"multiMove","distance":2} as TacticSpec, siegeTactic: false, attributes: [], restrictions: [], maxDeployed: 1 },
  scout: { set: "base", coins: 5, siegeTactic: false, attributes: ["deployNextToFriendly"], restrictions: [], maxDeployed: 1 },
  knight: { set: "base", coins: 4, siegeTactic: false, attributes: ["onlyAttackedByBolstered"], restrictions: [], maxDeployed: 1 },
  marshal: { set: "base", coins: 5, tactic: {"kind":"grantManeuver","maneuver":"attack","range":2} as TacticSpec, siegeTactic: false, attributes: [], restrictions: [], maxDeployed: 1 },
  mercenary: { set: "base", coins: 5, siegeTactic: false, attributes: ["freeManeuverOnRecruit"], restrictions: [], maxDeployed: 1 },
  berserker: { set: "base", coins: 5, siegeTactic: false, attributes: ["maneuverAgainForCoin"], restrictions: [], maxDeployed: 1 },
  ensign: { set: "base", coins: 5, tactic: {"kind":"grantManeuver","maneuver":"move","range":2} as TacticSpec, siegeTactic: false, attributes: [], restrictions: [], maxDeployed: 1 },
  footman: { set: "base", coins: 5, tactic: {"kind":"maneuverEachUnit"} as TacticSpec, siegeTactic: false, attributes: ["twoUnitsDeployed"], restrictions: [], maxDeployed: 2 },
  warriorPriest: { set: "base", coins: 4, siegeTactic: false, attributes: ["drawAndUseAfterControlOrAttack"], restrictions: [], maxDeployed: 1 },
  royalGuard: { set: "base", coins: 5, tactic: {"kind":"royalRedeploy","distance":2} as TacticSpec, siegeTactic: false, attributes: ["absorbHitFromSupply"], restrictions: [], maxDeployed: 1 },
  herald: { set: "nobility", coins: 5, tactic: {"kind":"bolsterAllyFromSupply"} as TacticSpec, siegeTactic: false, attributes: ["maneuverAfterProclaim"], restrictions: [], maxDeployed: 1 },
  earl: { set: "nobility", coins: 5, tactic: {"kind":"controlThenProclaim"} as TacticSpec, siegeTactic: false, attributes: ["moveAfterDeploy"], restrictions: [], maxDeployed: 1 },
  bishop: { set: "nobility", coins: 5, tactic: {"kind":"recruitThenManeuver"} as TacticSpec, siegeTactic: false, attributes: [], restrictions: ["onlyAttackedByUnbolstered"], maxDeployed: 1 },
  bannerman: { set: "nobility", coins: 4, siegeTactic: false, attributes: ["shoveEnemyAfterManeuver"], restrictions: [], maxDeployed: 1 },
  trebuchet: { set: "siege", coins: 5, tactic: {"kind":"rangedAttack","min":2,"max":3,"straightLine":true,"blocked":false} as TacticSpec, siegeTactic: true, attributes: [], restrictions: ["noNormalAttack"], maxDeployed: 1 },
  siegeTower: { set: "siege", coins: 5, tactic: {"kind":"attackTwice"} as TacticSpec, siegeTactic: true, attributes: ["bolsterOnDeploy"], restrictions: [], maxDeployed: 1 },
  sapper: { set: "siege", coins: 5, tactic: {"kind":"moveThenAttackFort"} as TacticSpec, siegeTactic: false, attributes: ["buildFortOnMove"], restrictions: [], maxDeployed: 1 },
  warWagon: { set: "siege", coins: 4, tactic: {"kind":"pushAlly"} as TacticSpec, siegeTactic: true, attributes: ["absorbHitForAlly"], restrictions: [], maxDeployed: 1 },
  assassin: { set: "nightfall", coins: 4, tactic: {"kind":"moveThenPoison"} as TacticSpec, siegeTactic: false, attributes: ["burnSupplyAfterKillingPoisoned"], restrictions: [], maxDeployed: 1 },
  saboteur: { set: "nightfall", coins: 5, tactic: {"kind":"poisonAtRange","min":1,"max":2} as TacticSpec, siegeTactic: false, attributes: ["tacticOnRecruit"], restrictions: [], maxDeployed: 1 },
  infiltrator: { set: "nightfall", coins: 5, tactic: {"kind":"infiltrate","distance":1} as TacticSpec, siegeTactic: false, attributes: ["deceiveAfterControl"], restrictions: [], maxDeployed: 1 },
  skirmisher: { set: "nightfall", coins: 4, tactic: {"kind":"skirmish","distance":2} as TacticSpec, siegeTactic: false, attributes: ["deceiveWhenAttacked"], restrictions: [], maxDeployed: 1 },
};

export interface BoardFacts {
  readonly hexes: readonly HexId[];
  readonly locations: readonly HexId[];
  /** Locations each seat's team starts the game controlling. */
  readonly startingLocations: readonly (readonly HexId[])[];
  /** Control markers a side must place to win. */
  readonly controlMarkers: number;
}

export const DUEL_BOARD: BoardFacts = {
  hexes: ["2,1","2,2","2,3","2,4","3,0","3,1","3,2","3,3","3,4","4,0","4,1","4,2","4,3","4,4","4,5","5,-1","5,0","5,1","5,2","5,3","5,4","5,5","6,0","6,1","6,2","6,3","6,4","6,5","7,0","7,1","7,2","7,3","7,4","8,1","8,2","8,3","8,4"],
  locations: ["2,3","3,1","3,4","4,0","4,3","6,2","6,5","7,0","7,3","8,2"],
  startingLocations: [["4,0","7,0"],["3,4","6,5"]],
  controlMarkers: 6,
};

export const TEAM_BOARD: BoardFacts = {
  hexes: ["0,2","0,3","1,1","1,2","1,3","2,1","2,2","2,3","2,4","3,0","3,1","3,2","3,3","3,4","4,0","4,1","4,2","4,3","4,4","4,5","5,-1","5,0","5,1","5,2","5,3","5,4","5,5","6,0","6,1","6,2","6,3","6,4","6,5","7,0","7,1","7,2","7,3","7,4","8,1","8,2","8,3","8,4","9,1","9,2","9,3","10,2","10,3"],
  locations: ["0,3","1,1","2,3","3,1","3,4","4,0","4,3","6,2","6,5","7,0","7,3","8,2","9,3","10,2"],
  startingLocations: [["4,0","7,0","1,1"],["3,4","6,5","9,3"]],
  controlMarkers: 8,
};

/** The half-turn that maps one side of the board onto the other. */
const ROTATED: Readonly<Record<HexId, HexId>> = {"0,2":"10,3","0,3":"10,2","1,1":"9,3","1,2":"9,2","1,3":"9,1","2,1":"8,4","2,2":"8,3","2,3":"8,2","2,4":"8,1","3,0":"7,4","3,1":"7,3","3,2":"7,2","3,3":"7,1","3,4":"7,0","4,0":"6,5","4,1":"6,4","4,2":"6,3","4,3":"6,2","4,4":"6,1","4,5":"6,0","5,-1":"5,5","5,0":"5,4","5,1":"5,3","5,2":"5,2","5,3":"5,1","5,4":"5,0","5,5":"5,-1","6,0":"4,5","6,1":"4,4","6,2":"4,3","6,3":"4,2","6,4":"4,1","6,5":"4,0","7,0":"3,4","7,1":"3,3","7,2":"3,2","7,3":"3,1","7,4":"3,0","8,1":"2,4","8,2":"2,3","8,3":"2,2","8,4":"2,1","9,1":"1,3","9,2":"1,2","9,3":"1,1","10,2":"0,3","10,3":"0,2"};
export function rotate180(hex: HexId): HexId {
  const other = ROTATED[hex];
  if (other === undefined) throw new Error(`${hex} is not a hex on the printed board`);
  return other;
}

/** The five duel locations nearest each side — `a` the top half, `b` the bottom. */
export const DUEL_LOCATIONS_BY_SIDE: readonly [readonly HexId[], readonly HexId[]] =
  [["3,1","4,0","6,2","7,0","8,2"],["2,3","3,4","4,3","6,5","7,3"]] as [readonly HexId[], readonly HexId[]];

/** Every Fortification Map Card: two per side, mirrored. */
export const FORTIFICATION_LAYOUTS: readonly (readonly HexId[])[] = [["3,1","4,0","7,3","6,5"],["3,1","6,2","7,3","4,3"],["3,1","7,0","7,3","3,4"],["3,1","8,2","7,3","2,3"],["4,0","6,2","6,5","4,3"],["4,0","7,0","6,5","3,4"],["4,0","8,2","6,5","2,3"],["6,2","7,0","4,3","3,4"],["6,2","8,2","4,3","2,3"],["7,0","8,2","3,4","2,3"]];

/**
 * Where each hex sits on screen at radius 1, so the client scales rather than
 * re-derives the layout. Flat-top hexes in columns, odd columns half a hex
 * lower — the printed board, which is what `board.ts` was reconstructed from.
 */
export const HEX_CENTRES: Readonly<Record<HexId, { readonly x: number; readonly y: number }>> = {
  "0,2": { x: 0, y: 3.464102 },
  "0,3": { x: 0, y: 5.196152 },
  "1,1": { x: 1.5, y: 2.598076 },
  "1,2": { x: 1.5, y: 4.330127 },
  "1,3": { x: 1.5, y: 6.062178 },
  "2,1": { x: 3, y: 1.732051 },
  "2,2": { x: 3, y: 3.464102 },
  "2,3": { x: 3, y: 5.196152 },
  "2,4": { x: 3, y: 6.928203 },
  "3,0": { x: 4.5, y: 0.866025 },
  "3,1": { x: 4.5, y: 2.598076 },
  "3,2": { x: 4.5, y: 4.330127 },
  "3,3": { x: 4.5, y: 6.062178 },
  "3,4": { x: 4.5, y: 7.794229 },
  "4,0": { x: 6, y: 0 },
  "4,1": { x: 6, y: 1.732051 },
  "4,2": { x: 6, y: 3.464102 },
  "4,3": { x: 6, y: 5.196152 },
  "4,4": { x: 6, y: 6.928203 },
  "4,5": { x: 6, y: 8.660254 },
  "5,-1": { x: 7.5, y: -0.866025 },
  "5,0": { x: 7.5, y: 0.866025 },
  "5,1": { x: 7.5, y: 2.598076 },
  "5,2": { x: 7.5, y: 4.330127 },
  "5,3": { x: 7.5, y: 6.062178 },
  "5,4": { x: 7.5, y: 7.794229 },
  "5,5": { x: 7.5, y: 9.526279 },
  "6,0": { x: 9, y: 0 },
  "6,1": { x: 9, y: 1.732051 },
  "6,2": { x: 9, y: 3.464102 },
  "6,3": { x: 9, y: 5.196152 },
  "6,4": { x: 9, y: 6.928203 },
  "6,5": { x: 9, y: 8.660254 },
  "7,0": { x: 10.5, y: 0.866025 },
  "7,1": { x: 10.5, y: 2.598076 },
  "7,2": { x: 10.5, y: 4.330127 },
  "7,3": { x: 10.5, y: 6.062178 },
  "7,4": { x: 10.5, y: 7.794229 },
  "8,1": { x: 12, y: 1.732051 },
  "8,2": { x: 12, y: 3.464102 },
  "8,3": { x: 12, y: 5.196152 },
  "8,4": { x: 12, y: 6.928203 },
  "9,1": { x: 13.5, y: 2.598076 },
  "9,2": { x: 13.5, y: 4.330127 },
  "9,3": { x: 13.5, y: 6.062178 },
  "10,2": { x: 15, y: 3.464102 },
  "10,3": { x: 15, y: 5.196152 },
};
