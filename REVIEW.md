# Внешнее ревью: codex

**Дата прогона:** 2026-08-13, 08:07–08:21 (+07)
**Инструмент:** `codex-cli 0.145.0`, модель `gpt-5.6-sol`, `model_reasoning_effort = "high"`
**Песочница:** `read-only` — codex не мог править файлы; сборка и тесты не запускались.

**Всё, что ниже под заголовками «Проход A» и «Проход B», написано codex, а не Claude.**
Текст приведён дословно, включая возможные ошибки в номерах строк. Замечания Claude —
только в отдельном разделе в конце.

## Команды

```bash
codex exec -s read-only -C /Users/bularond/Projects/war_chest_telegram \
  -o scratchpad/pass-a.md - < scratchpad/prompt-a.md      # проход A, движок

codex exec -s read-only -C /Users/bularond/Projects/war_chest_telegram \
  -o scratchpad/pass-b.md - < scratchpad/prompt-b.md      # проход B, бот
```

| | Проход A (движок) | Проход B (бот) |
| --- | --- | --- |
| Область | `packages/shared/src` | `packages/bots/src` |
| Время | 828 с | 543 с |
| Токенов | 248 107 | 180 558 |
| Сессия codex | `019ff8a8-9f2b-70b0-8401-2ffd80560864` | `019ff8a8-a693-77b2-9f2b-b63dfb4a78d1` |
| Находок | 8 | 5 |

---

# Проход A — движок правил (`packages/shared/src`)

*Вывод codex, дословно.*

# Findings

## 1. Warrior Priest’s drawn coin is exposed in the public view

- **Location:** [types.ts:51](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/types.ts:51), [observe.ts:28](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/observe.ts:28), [view.ts:122](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/view.ts:122)
- **Claimed contract:** `publicStateFor` returns the same redacted state a player may see; opponent hands and face-down coins remain hidden.
- **Actual behavior:** `mustUseCoin` stores the drawn coin’s identity in `PendingStep`, and `viewFor` copies the complete pending stack to every viewer.
- **Concrete case:** Warrior Priest attacks, draws an Archer coin, then intends to spend it on a face-down Recruit or Pass. Before that follow-up resolves, `publicStateFor(state, opponent)` contains `{ kind: "mustUseCoin", coin: "archer" }`. The opponent learns a coin that the eventual face-down action is supposed to conceal. The base rules do not make the Warrior Priest’s draw public; only its subsequent use may reveal it. [Official base rulebook](https://www.alderac.com/wp-content/uploads/2025/04/WarChest_BaseGame_Rulebook_Optimized.pdf)
- **Confidence:** High.
- **Stake:** **Information leak.**

## 2. The Saboteur’s recruit attribute is declared but never implemented

- **Location:** [units.ts:188](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/units.ts:188), [units.ts:715](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/units.ts:715), [engine.ts:1269](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1269), [engine.ts:1409](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1409)
- **Claimed contract:** The Saboteur has `tacticOnRecruit`: after recruiting a Saboteur, its tactic may be used immediately.
- **Actual behavior:** Neither normal recruitment nor free recruitment checks `tacticOnRecruit`. The only recruit-triggered attribute handled is the Mercenary’s `freeManeuverOnRecruit`. There is no other reference to `tacticOnRecruit` in the engine.
- **Concrete case:** A deployed Saboteur has an enemy one space away. Recruit a Saboteur coin. The expected optional poison tactic is never queued; play passes to the next seat.
- **Confidence:** High.
- **Stake:** **Rules correctness; an entire printed unit attribute is unreachable.**

## 3. Actions granted by tactics and Decrees bypass normal action side effects

- **Location:** [engine.ts:1223](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1223), [engine.ts:1276](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1276), [engine.ts:1292](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1292), [engine.ts:1409](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1409), [engine.ts:1424](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1424), [engine.ts:1437](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1437)
- **Claimed contract:** Emboldened Recruit, Deploy, and Move effects are normal actions and interact with attributes. The official Nobility FAQ explicitly confirms Mercenary after Enlist and Earl after Redeploy. [Official Nobility rules](https://www.alderac.com/wp-content/uploads/2019/08/WarChest_Nobility_Rules_Rulesheet_FINAL.pdf)
- **Actual behavior:**
  - `followRecruit` omits the Mercenary and Saboteur recruit hooks.
  - `followPlace` inserts a stack directly, omitting Earl’s free move and Siege Tower’s optional bolster.
  - Redeploy records only `unit` and `coins`, so a redeployed poisoned unit loses `poisonedBy` and is silently cured. Nightfall explicitly permits poisoned units to be deployed through Redeploy while their restrictions continue to apply. [Official Nightfall rules](https://www.alderac.com/wp-content/uploads/2025/03/WarChest_Nightfall_Rulebook.pdf)
  - Sapper’s `moveThenAttackFort` moves directly and only reports the later attack to `afterManeuver`, so its build-on-move attribute never triggers.
- **Concrete cases:**
  - Enlist recruits a deployed Mercenary: no free maneuver appears.
  - Redeploy a poisoned Earl: it returns unpoisoned and receives no post-deploy move.
  - A Sapper uses its tactic to enter a bare location and attack an adjacent fort while fort supply remains: no build choice appears.
- **Confidence:** High.
- **Stake:** **Rules correctness across Nobility, Siege, and Nightfall.**

## 4. Herald maneuvers before the proclaimed Decree, despite the comment saying “follows”

- **Location:** [engine.ts:264](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:264), especially [engine.ts:294](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:294) and [engine.ts:907](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:907)
- **Claimed contract:** “The Herald follows a proclamation with a maneuver of its own.” Proclaiming includes executing the selected Decree, and separate actions must fully resolve before another begins. [Official Nobility rules](https://www.alderac.com/wp-content/uploads/2019/08/WarChest_Nobility_Rules_Rulesheet_FINAL.pdf)
- **Actual behavior:** The Decree step is pushed first and the Herald step second. Because pending steps resolve newest-first, the Herald acts before the Decree.
- **Concrete case:** Sacrifice is legal because one unit can attack. The Herald maneuver moves that sole attacker out of range; Sacrifice then has no action and is skipped. Lines 907–911 explicitly describe this currently accepted sequence, even though the Decree was required to be fully executable and the Herald should not interrupt Proclaim.
- **Confidence:** High.
- **Stake:** **Rules correctness; materially changes Decree outcomes.**

## 5. Charge and ranged tactics use reduced attack/movement checks

- **Location:** [engine.ts:359](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:359), [engine.ts:546](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:546), [engine.ts:601](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:601), compared with [engine.ts:95](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:95) and [engine.ts:184](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:184)
- **Claimed contract:** Tactic attacks obey target restrictions, and multi-space movement obeys fortification entry/path rules. Fortifications can be targeted by any attack that could normally target a unit. [Official Siege rules](https://www.alderac.com/wp-content/uploads/2021/03/WarChest_Siege_1P_Rules_Rulesheet_FINAL.pdf)
- **Actual behavior:**
  - `canCharge` checks only enemy ownership and the Knight restriction. It omits the Bishop’s “only unbolstered attackers” restriction.
  - Lancer path checking looks only for units, not Fortifications, so it can pass through a fort or stop on an enemy fortified location.
  - Charge requires a real `state.units[target]`, and ranged tactics enumerate only `state.units`, making an empty Fortification untargetable by Cavalry/Lancer or Trebuchet/Archer/Crossbowman tactics.
- **Concrete cases:**
  - A bolstered Cavalry can charge and attack a Bishop, although bolstered units cannot attack it.
  - A Lancer can charge through a neutral Fortification.
  - A bolstered Trebuchet two spaces from an empty enemy Fortification gets no tactic targeting it.
- **Confidence:** High.
- **Stake:** **Rules correctness.**

## 6. Footman’s mandatory per-unit maneuvers are made optional

- **Location:** [units.ts:455](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/units.ts:455), [engine.ts:503](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:503), [engine.ts:1157](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:1157), [engine.ts:739](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:739)
- **Claimed contract:** “Perform one maneuver with each Footman unit on the board.”
- **Actual behavior:** Every generated Footman `maneuverUnit` step has `optional: true`, so `skip` is always legal even when that Footman has legal maneuvers.
- **Concrete case:** Both Footmen have open adjacent spaces. Use the Footman tactic, maneuver the first, then skip the second—or skip both entirely.
- **Confidence:** High.
- **Stake:** **Rules correctness; can avoid a required, potentially disadvantageous maneuver.**

## 7. Two four-player team resources are modeled per seat instead of per team

- **Location:** [setup.ts:122](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/setup.ts:122), [invariants.ts:169](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/invariants.ts:169), [engine.ts:647](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/engine.ts:647)
- **Claimed contract:** Four-player teammates share three Proclamation Seals, and a player cannot claim Initiative from their teammate. [Official Nobility rules](https://www.alderac.com/wp-content/uploads/2019/08/WarChest_Nobility_Rules_Rulesheet_FINAL.pdf), [official base rulebook](https://www.alderac.com/wp-content/uploads/2025/04/WarChest_BaseGame_Rulebook_Optimized.pdf)
- **Actual behavior:**
  - Setup gives every player three seals: six per team, twelve total. `sealsAreConserved` explicitly treats that incorrect total as invariant.
  - Claim Initiative checks only whether the acting player personally holds the marker, not whether their teammate holds it.
- **Concrete case:** In a four-player game, seat 0 holds Initiative and seat 2 is their teammate. Seat 2 is offered Claim Initiative and can transfer the marker within the same team. The same initial game accounts for twelve seals although the expansion contains and assigns six.
- **Confidence:** High.
- **Stake:** **Rules correctness / conservation.**

## 8. Determinization discards the known identity of a Decoy in the viewing player’s bag

- **Location:** [view.ts:39](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/view.ts:39), [observe.ts:113](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/observe.ts:113), [observe.ts:173](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/observe.ts:173)
- **Claimed contract:** The viewing player’s bag multiset is present in `PlayerView`; only draw order is unknown. `sampleDeterminization` should preserve everything the view shows.
- **Actual behavior:** `hiddenDecoys` checks visible hands and discards but not `p.bag`; `dealPlayer` likewise ignores `p.bag`. An own-bag Decoy becomes merely an unknown slot and may be replaced with the other Decoy identity or assigned to another seat.
- **Concrete case:** Seat 0’s public `bag` explicitly contains `decoyInfiltrator`, while `decoySkirmisher` remains beside its card. A sample can put `decoySkirmisher` in seat 0’s bag instead, changing which unit’s Decoy is considered unavailable.
- **Confidence:** High.
- **Stake:** **AI strength / incorrect information use, not an information leak.**

## Short notes on checked areas

- Every `TacticSpec.kind` appears in both large switches; the defects above are semantic disagreements rather than missing switch labels.
- Apart from the Warrior Priest pending payload, I found no direct opponent bag, hand, or face-down-discard identity leak in `hiddenCoins` or its subtraction logic.
- Ordinary coin, control-marker, and Fortification mutation paths appear conserved; the four-player seal invariant is the significant exception.
- One stale comment: [units.ts:185](/Users/bularond/Projects/war_chest_telegram/packages/shared/src/units.ts:185) says the Assassin burns supply only after “finishing off” a poisoned unit. The printed text and implementation trigger after any attack against a poisoned unit; the code is correct and the comment is not.

No files were modified and no tests or build commands were run.
---

# Проход B — компьютерный соперник (`packages/bots/src`)

*Вывод codex, дословно.*

## Findings

### 1. ISMCTS can merge decisions made by opposing players into the same edge

**File:** [packages/bots/src/ismcts.ts:155](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/ismcts.ts:155), [packages/bots/src/ismcts.ts:269](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/ismcts.ts:269), [packages/bots/src/ismcts.ts:283](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/ismcts.ts:283), [packages/bots/src/ismcts.ts:338](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/ismcts.ts:338)

**Claim:** Every edge’s value is from the perspective of the seat that chose it. The code correctly notes that the acting seat can differ between determinizations.

**Actual:** A node has one action-keyed edge map, regardless of who acts in a particular determinization. If the same action key is legal for different teams, their visits, values, availability, and child node are merged. Backup then alternates the sign according to the current actor, so the edge’s mean is no longer from one coherent perspective.

**Concrete case:** A Swordsman attacks a Skirmisher.

- If the Skirmisher’s matching Decoy is available in the sampled determinization, the defender receives `absorbHit`, where `{type: 'skip'}` means “take the hit.”
- If that Decoy is hidden elsewhere, the defender has no response and the Swordsman’s `optionalMove` is exposed, where the same `{type: 'skip'}` is chosen by the attacker and means “stay put.”

Both reach the same history node and the same `actionKey({type:'skip'})`, but are decisions by opposite teams with different successor states. The code fixed applying the action as the current actor, but not the shared statistics or child.

**Confidence:** High.  
**Stake:** Measurable strength loss, concentrated in hidden-information follow-up branches.

### 2. The Infiltrator’s control tactic is ranked as an ordinary move—even when it wins immediately

**File:** [packages/bots/src/heuristic.ts:204](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/heuristic.ts:204), [packages/bots/src/heuristic.ts:249](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/heuristic.ts:249), [packages/bots/src/heuristic.ts:349](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/heuristic.ts:349)

**Claim:** Tactics should be ranked by what they do, and winning control is the highest-priority drawer.

**Actual:** Only tactics lacking both `target` and `to` reach `bareTacticRank`. An Infiltrator tactic carries `to`, so `destinationOf` classifies it as rank-4 movement. Its declared `infiltrate` kind—which moves onto an enemy location and controls it—is never examined.

**Concrete case:** The bot has one control marker remaining and can use the Infiltrator tactic to enter an enemy-controlled location. That action wins immediately, but it receives `RANK.move`. Any ordinary attack, control, or deploy action outranks it, so the heuristic and rollout policy can knowingly pass up the win.

**Confidence:** High.  
**Stake:** Measurable strength loss; potentially a directly missed victory.

### 3. The Knight exception bolsters units that still cannot attack the Knight

**File:** [packages/bots/src/heuristic.ts:233](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/heuristic.ts:233), [packages/bots/src/heuristic.ts:311](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/heuristic.ts:311)

**Claim:** The exceptional bolster is chosen because it “opens” an otherwise illegal attack against a Knight.

**Actual:** `bolsterOpensAKnight` checks only that an unbolstered friendly stack is adjacent to a Knight. It does not check whether the friendly unit is capable of a normal attack.

**Concrete case:** An unbolstered Archer adjacent to a Knight, with an Archer coin in hand. The Archer has `noNormalAttack`, and its range-two tactic cannot hit the adjacent Knight. Bolstering therefore opens no attack, but receives rank 1.5 and can beat claiming a non-winning location, deploying, or moving.

The same false positive applies to other tactic-only attackers such as the Lancer and Trebuchet.

**Confidence:** High.  
**Stake:** Measurable strength loss in ordinary base-game positions.

### 4. Tied movement targets are resolved by board-array order, not uniformly

**File:** [packages/bots/src/heuristic.ts:446](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/heuristic.ts:446), [packages/bots/src/heuristic.ts:468](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/heuristic.ts:468)

**Claim:** The priority cascade preserves all candidates tied after its criteria; the final policy otherwise samples tied choices through the injected RNG.

**Actual:** `chooseTarget` takes `[0]` from the surviving cascade. The candidate list originates from the board’s fixed location order, so an unresolved tie becomes a permanent coordinate bias. The later random choice operates only after moves toward the other tied targets have already been filtered out.

**Concrete case:** On an otherwise open duel board, a unit at centre hex `5,2` is equally close to the neutral locations `4,3` and `6,2`. Both remain tied through all four target criteria. `4,3` occurs first in the board’s location array, so it is always selected; movement toward `6,2` is discarded before random selection.

**Confidence:** Medium-high. The behavior is certain; whether deterministic first-entry tie-breaking was deliberate is undocumented and conflicts with how final ties are handled elsewhere.  
**Stake:** Measurable but probably modest strength loss, plus systematic board-orientation bias.

### 5. `threatBalance` counts attacks that the defender’s restriction makes illegal

**File:** [packages/bots/src/eval.ts:399](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/eval.ts:399), [packages/bots/src/eval.ts:424](/Users/bularond/Projects/war_chest_telegram/packages/bots/src/eval.ts:424)

**Claim:** The feature measures stacks “standing where they can be hit” and distinguishes opponents that can actually swing.

**Actual:** It checks only whether the adjacent attacker has `noNormalAttack`. It does not apply target-side restrictions, notably the Knight’s “only attacked by bolstered” and Bishop’s “only attacked by unbolstered.”

**Concrete cases:**

- An unbolstered Swordsman beside a Knight is counted as threatening it, although that attack is illegal.
- A bolstered Swordsman beside a Bishop is likewise counted, although only an unbolstered unit may attack the Bishop.

**Confidence:** High.  
**Stake:** Dormant with the current zero `threat` weight—not a complaint about that zero—but the feature tested or fitted under a nonzero weight does not measure its documented quantity.

## Checked and found sound

- No production bot entry point receives a real `GameState`; search states originate from `sampleDeterminization(GameView, …)`. I found no real hidden-information leak.
- Outside the actor-aliasing case above, UCB uses child availability correctly, opponent edges maximize the opponent’s signed value, and rollout/terminal evaluations share the `[-1,1]` convention.
- The active `approach` term uses separate target-location sets for the two teams, and its scalar and vector implementations agree.
- Board-distance sweeps correctly allow occupied destinations while preventing traversal through occupied non-source squares.

No files were changed, and no build or test command was run.
---

# Замечания Claude (не codex)

Всё, что выше, — вывод codex. Ниже — только проверка ссылок и контекст; ни одна
находка здесь не правится и не додумывается за codex.

## Что я проверил по коду

- **A-1 (утечка `mustUseCoin`) — подтверждается по ссылкам.** `types.ts:67` действительно
  хранит `{ kind: 'mustUseCoin'; coin: CoinId; source: 'warriorPriest' }`, а `view.ts:122` —
  `pending: [...state.pending]` без фильтрации. Номер строки в `types.ts` codex назвал 51,
  фактически 67. Само наблюдение верно.
- **A-2 (`tacticOnRecruit`) — подтверждается.** Атрибут объявлен в `units.ts:188`, назначен
  Саботёру в `units.ts:723`, и во всём `packages/*/src` больше не встречается ни разу.
  `grep -rn tacticOnRecruit` даёт ровно две строки, обе в `units.ts`.
- **A-4 (Герольд) — код такой, но репозиторий про это знает.** Комментарий `engine.ts:294`
  говорит «Герольд *следует* за прокламацией», а шаг кладётся в стек после указа, то есть
  разбирается раньше него. Но комментарий на `engine.ts:906–911` описывает ровно эту
  последовательность как принятую («указ проклят, манёвр Герольда уводит единственного
  атакующего»). То есть это не незамеченное расхождение, а расхождение между двумя
  комментариями. Решать, какой из них прав по правилам, — не дело ревьюера.
- **A-7 (печати) — по коду сходится.** `setup.ts:128` — `for (const p of players) p.seals =
  SEALS_PER_SIDE`, то есть на команду вдвое больше. Верно ли это по правилам «Знати» для
  четверых — не проверял.
- **B-2 (Инфильтратор) — подтверждается.** `engine.ts:453` (`case 'infiltrate'`) отдаёт
  `{ type: 'tactic', coin, from, to }`, а `destinationOf` в `heuristic.ts:210` возвращает
  `to` для тактики без `target`. Значит `rankOf` кладёт инфильтрацию в `RANK.move`, минуя
  `bareTacticRank`, и надбавка `winningControl` до неё не доходит. Это ровно тот класс
  ошибки, что описан в комментарии на `heuristic.ts:349` про шесть карт, — тем же способом,
  но на другой карте.
- **B-4 (`chooseTarget`) — подтверждается.** `heuristic.ts:480` — каскад заканчивается
  `])[0]`, то есть берётся первый по порядку доски, а не случайный из оставшихся.

## Чего я не проверял

Номера строк в остальных находках я выборочно не сверял. Пункты A-3, A-5, A-6, A-8, B-1,
B-3, B-5 приведены как есть.

## Оговорки к самому прогону

- Проход A ходил в веб за официальными PDF (базовый рулбук, «Знать», «Осада», «Ночная
  вылазка») и ссылается на них в находках. Ссылки не проверял — они на `alderac.com`.
- Ни один тест и ни одна сборка не запускались: `-s read-only` этого и не позволил бы,
  и в промпте это было запрещено прямо.
