/**
 * Writes `packages/shared/src/generated.ts` from the Rust catalog.
 *
 * The client draws a board and a set of cards, and most of what it needs to do
 * that is a rule: which hexes exist, which of them are locations, how many coins
 * of a unit the box contains, what a tactic does. None of that may be typed out
 * a second time in TypeScript — so it is generated from `wc-core`, which is the
 * one place those numbers live, and checked in so a browser build needs no
 * native module and no wasm.
 *
 * What is *not* generated is the card text, the colours and the art. Those are
 * presentation: they differ per language, nothing in the rules reads them, and
 * they stay hand-written in `units.ts` beside the table they belong to.
 *
 *   node scripts/generate-shared.mjs
 *
 * The file it writes is committed. `npm run guard` fails if it is stale, so a
 * change to a card in Rust cannot reach the client without passing through here.
 */

import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const target = path.join(root, 'packages/shared/src/generated.ts');

const require = createRequire(import.meta.url);
const core = require(path.join(root, 'packages/core-native/index.cjs'));
const catalog = JSON.parse(core.catalog());

const lines = [];
const w = (line = '') => lines.push(line);

w('/**');
w(' * The printed facts, generated from `wc-core`.');
w(' *');
w(' * Do not edit: `node scripts/generate-shared.mjs` writes this file, and');
w(' * `npm run guard` fails if it is out of date. The numbers here are rules —');
w(' * a hex list, a coin count, what a tactic does — and the rules live in Rust.');
w(' * Everything a person chose rather than a rule fixed (names, card text,');
w(' * colours, art) is hand-written in `units.ts` and `decrees.ts` instead.');
w(' */');
w();
w("import type { AttributeId, RestrictionId, TacticSpec, UnitId, UnitSet } from './units.js';");
w("import type { HexId } from './hex.js';");
w("import type { DecreeId } from './decrees.js';");
w();

const json = (v) => JSON.stringify(v);

w('/** Unit types, in the order every packed key and fitted vector assumes. */');
w(`export const UNIT_IDS: readonly UnitId[] = ${json(Object.keys(catalog.units))};`);
w();
w(`export const UNIT_SETS: readonly UnitSet[] = ${json(catalog.sets)};`);
w(`export const DECREE_IDS: readonly DecreeId[] = ${json(catalog.decrees)};`);
w();
w('/** Coins of each type that start in a player\'s bag when the unit is drafted. */');
w(`export const COINS_IN_BAG_PER_UNIT = ${catalog.coinsInBagPerUnit};`);
w(`export const HAND_SIZE = ${catalog.handSize};`);
w(`export const FORTIFICATIONS_TOTAL = ${catalog.fortifications.total};`);
w(`export const FORTIFICATIONS_ON_BOARD = ${catalog.fortifications.onBoard};`);
w();

w('/** What the engine executes for each card, and the caps it enforces. */');
w('export interface UnitFacts {');
w('  readonly set: UnitSet;');
w('  /** Total coins of this type in the game. */');
w('  readonly coins: number;');
w('  readonly tactic?: TacticSpec;');
w('  /** A Siege Tactic may only be used while the unit is bolstered. */');
w('  readonly siegeTactic: boolean;');
w('  readonly attributes: readonly AttributeId[];');
w('  readonly restrictions: readonly RestrictionId[];');
w('  /** Units of this type one player may have deployed at once. */');
w('  readonly maxDeployed: number;');
w('}');
w();
w('export const UNIT_FACTS: Readonly<Record<UnitId, UnitFacts>> = {');
for (const [id, u] of Object.entries(catalog.units)) {
  const parts = [
    `set: ${json(u.set)}`,
    `coins: ${u.coins}`,
    ...(u.tactic ? [`tactic: ${json(u.tactic)} as TacticSpec`] : []),
    `siegeTactic: ${u.siegeTactic}`,
    `attributes: ${json(u.attributes)}`,
    `restrictions: ${json(u.restrictions)}`,
    `maxDeployed: ${u.maxDeployed}`,
  ];
  w(`  ${id}: { ${parts.join(', ')} },`);
}
w('};');
w();

w('export interface BoardFacts {');
w('  readonly hexes: readonly HexId[];');
w('  readonly locations: readonly HexId[];');
w('  /** Locations each seat\'s team starts the game controlling. */');
w('  readonly startingLocations: readonly (readonly HexId[])[];');
w('  /** Control markers a side must place to win. */');
w('  readonly controlMarkers: number;');
w('}');
w();
for (const [size, board] of Object.entries(catalog.boards)) {
  const name = size === '2' ? 'DUEL_BOARD' : 'TEAM_BOARD';
  w(`export const ${name}: BoardFacts = {`);
  w(`  hexes: ${json(board.hexes)},`);
  w(`  locations: ${json(board.locations)},`);
  w(`  startingLocations: ${json(board.startingLocations)},`);
  w(`  controlMarkers: ${board.controlMarkers},`);
  w('};');
  w();
}

w('/** The half-turn that maps one side of the board onto the other. */');
w('const ROTATED: Readonly<Record<HexId, HexId>> = ' + json(catalog.rotate180) + ';');
w('export function rotate180(hex: HexId): HexId {');
w('  const other = ROTATED[hex];');
w('  if (other === undefined) throw new Error(`${hex} is not a hex on the printed board`);');
w('  return other;');
w('}');
w();
w('/** The five duel locations nearest each side — `a` the top half, `b` the bottom. */');
w('export const DUEL_LOCATIONS_BY_SIDE: readonly [readonly HexId[], readonly HexId[]] =');
w(`  ${json(catalog.duelLocationsBySide)} as [readonly HexId[], readonly HexId[]];`);
w();
w('/** Every Fortification Map Card: two per side, mirrored. */');
w(`export const FORTIFICATION_LAYOUTS: readonly (readonly HexId[])[] = ${json(catalog.fortificationLayouts)};`);
w();

const centres = catalog.boards['4'].centres;
w('/**');
w(' * Where each hex sits on screen at radius 1, so the client scales rather than');
w(' * re-derives the layout. Flat-top hexes in columns, odd columns half a hex');
w(' * lower — the printed board, which is what `board.ts` was reconstructed from.');
w(' */');
w('export const HEX_CENTRES: Readonly<Record<HexId, { readonly x: number; readonly y: number }>> = {');
for (const c of centres) {
  w(`  ${json(c.hex)}: { x: ${round(c.x)}, y: ${round(c.y)} },`);
}
w('};');
w();

function round(x) {
  return Number(x.toFixed(6));
}

const text = lines.join('\n');
const stale = !existsSync(target) || readFileSync(target, 'utf8') !== text;

if (process.argv.includes('--check')) {
  if (stale) {
    console.error('packages/shared/src/generated.ts is out of date — run node scripts/generate-shared.mjs');
    process.exit(1);
  }
  console.log('generated.ts is up to date');
} else {
  writeFileSync(target, text);
  console.log(`${path.relative(root, target)}: ${Object.keys(catalog.units).length} units, ${catalog.boards['4'].hexes.length} hexes`);
}
