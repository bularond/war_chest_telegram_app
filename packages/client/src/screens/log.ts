/** Turning structured log entries into Russian sentences, with cases. */

import { DECREES, UNITS, type DecreeId, type GameView, type LogEntry, type UnitId } from '@wc/shared';

/** Accusative of each unit name, so "вы двинули конницу" reads right. */
const ACCUSATIVE: Record<UnitId, string> = {
  swordsman: 'мечника',
  archer: 'лучника',
  pikeman: 'пикинёра',
  cavalry: 'кавалерию',
  crossbowman: 'арбалетчика',
  lancer: 'копейщика',
  lightCavalry: 'лёгкую кавалерию',
  scout: 'разведчика',
  knight: 'рыцаря',
  marshal: 'маршала',
  mercenary: 'наёмника',
  berserker: 'берсерка',
  ensign: 'знаменосца',
  footman: 'пехотинца',
  warriorPriest: 'воина-жреца',
  royalGuard: 'королевскую гвардию',
  herald: 'герольда',
  earl: 'графа',
  bishop: 'епископа',
  bannerman: 'знаменосца знати',
  trebuchet: 'требушет',
  siegeTower: 'осадную башню',
  sapper: 'сапёра',
  warWagon: 'боевой фургон',
  assassin: 'убийцу',
  saboteur: 'диверсанта',
  infiltrator: 'лазутчика',
  skirmisher: 'застрельщика',
};

function acc(unit: unknown): string {
  return typeof unit === 'string' && unit in ACCUSATIVE ? ACCUSATIVE[unit as UnitId] : 'отряд';
}

function nom(unit: unknown): string {
  return typeof unit === 'string' && unit in UNITS ? UNITS[unit as UnitId].name.ru : 'Отряд';
}

export function plural(n: number, one: string, few: string, many: string): string {
  const t = n % 10;
  const h = n % 100;
  if (t === 1 && h !== 11) return `${n} ${one}`;
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function coins(n: number): string {
  return plural(n, 'монета', 'монеты', 'монет');
}

/**
 * Verbs stay in the present tense on purpose: Telegram tells us nothing about a
 * player's gender, and Russian past-tense verbs would force us to guess.
 * "Марина С разворачивает" is correct for anyone; "развернул" is a coin flip.
 */
export function formatLog(entry: LogEntry, view: GameView): string {
  const mine = entry.seat === view.you;
  const who = mine ? 'Вы' : (view.players[entry.seat]?.displayName ?? 'Соперник');
  const v = (second: string, third: string) => (mine ? second : third);

  switch (entry.kind) {
    case 'roundStart':
      return `Раунд ${entry.round}`;
    case 'ban':
      return `${who} ${v('вычёркиваете', 'вычёркивает')} ${acc(entry.params.unit)}`;
    case 'draft':
      return `${who} ${v('берёте', 'берёт')} ${acc(entry.params.unit)}`;
    case 'deploy':
      return `${who} ${v('разворачиваете', 'разворачивает')} ${acc(entry.params.unit)}`;
    case 'bolster':
      return `${who} ${v('усиливаете', 'усиливает')} ${acc(entry.params.unit)}`;
    case 'move':
      return `${who} ${v('делаете ход', 'делает ход')}`;
    case 'attack':
      return `${who} ${v('атакуете', 'атакует')} ${acc(entry.params.target)}`;
    case 'control':
      return `${who} ${v('захватываете локацию', 'захватывает локацию')}`;
    case 'recruit':
      return `${who} ${v('нанимаете', 'нанимает')} ${acc(entry.params.unit)}`;
    case 'pass':
      return `${who} ${v('пасуете', 'пасует')}`;
    case 'claimInitiative':
      return `${who} ${v('забираете инициативу', 'забирает инициативу')}`;
    case 'proclaim': {
      const d = entry.params.decree;
      const name = typeof d === 'string' && d in DECREES ? DECREES[d as DecreeId].name.ru : 'указ';
      return `${who} ${v('оглашаете указ', 'оглашает указ')} «${name}»`;
    }
    case 'sacrifice':
      return 'Жертва: атакующий отряд теряет монету';
    case 'lift':
      return `${who} ${v('снимаете с поля', 'снимает с поля')} ${acc(entry.params.unit)}`;
    case 'spy':
      return `${who} ${v('подсматриваете руку и сбрасываете монету', 'подсматривает руку и сбрасывает монету')}`;
    case 'reinforce':
      return `${who} ${v('возвращаете в запас', 'возвращает в запас')} ${acc(entry.params.unit)}`;
    case 'shove':
      return `${who} ${v('оттесняете вражеский отряд', 'оттесняет вражеский отряд')}`;
    case 'absorb':
      return `${who} ${v('принимаете удар монетой из запаса', 'принимает удар монетой из запаса')}`;
    case 'poison':
      return `${who} ${v('травите', 'травит')} ${acc(entry.params.unit)}`;
    case 'unpoison':
      return `${who} ${v('снимаете яд с', 'снимает яд с')} ${acc(entry.params.unit)}`;
    case 'burn':
      return `${who} ${v('изымаете из запаса', 'изымает из запаса')} ${acc(entry.params.unit)}`;
    case 'deceive':
      return `${who} ${v('подбрасываете обманную монету', 'подбрасывает обманную монету')}`;
    case 'returnDecoy':
      return `${who} ${v('возвращаете обманную монету', 'возвращает обманную монету')}`;
    case 'absorbWagon':
      return `${who} ${v('принимаете удар фургоном', 'принимает удар фургоном')}`;
    case 'razeFort':
      return `${who} ${v('сносите укрепление', 'сносит укрепление')}`;
    case 'buildFort':
      return `${who} ${v('возводите укрепление', 'возводит укрепление')}`;
    case 'push':
      return `${who} ${v('толкаете свой отряд фургоном', 'толкает свой отряд фургоном')}`;
    case 'tactic':
      return `${nom(entry.params.unit)} — тактика`;
    case 'berserkerRepeat':
      return `${who} ${v('меняете монету на ещё один манёвр', 'меняет монету на ещё один манёвр')}`;
    case 'victory':
      return `${who} ${v('выставляете последний маркер — победа', 'выставляет последний маркер — победа')}`;
    case 'stalemate':
      return 'Монеты кончились у обоих — ничья';
    default:
      return entry.kind;
  }
}

export function logColor(entry: LogEntry, view: GameView): string {
  if (entry.kind === 'roundStart' || entry.kind === 'stalemate') return 'var(--color-neutral-500)';
  return entry.seat === view.you ? 'var(--side-you)' : 'var(--side-foe)';
}
