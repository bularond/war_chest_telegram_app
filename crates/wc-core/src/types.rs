//! Game state, pending steps and actions.
//!
//! The shapes are the TypeScript ones, packed. Two things are worth knowing
//! before reading the engine:
//!
//! **A hex is a number.** `state.units` is not a map keyed by `"4,3"` but a
//! [`Board`] — a dense slot per board hex plus the list of occupied hexes *in
//! insertion order*, because a JavaScript object iterates in insertion order and
//! the Footman's tactic reads that order backwards.
//!
//! **An action is eight bytes.** One `Copy` struct with a slot per field any
//! action can carry, so a legal move list is a flat array the search can fill
//! without allocating.

use crate::board::{BoardSize, HexIdx, HEX_COUNT, NONE};
use crate::decrees::{DecreeId, DecreeInPlay};
use crate::rng::Rng;
use crate::units::{CoinId, UnitId, SetMask, UNIT_COUNT};
use arrayvec::ArrayVec;
use std::sync::Arc;

/// Index into `GameState.players`. Seat order is also turn order.
pub type Seat = u8;
/// 0 or 1. In a duel a team is one player; in a four-player game it is two.
pub type Team = u8;

/// The value a seat or team field takes when there is nobody.
pub const NO_SEAT: u8 = 255;

pub const MAX_SEATS: usize = 4;
/// A hand holds three coins, plus the Warrior Priest's draw sitting on top.
pub const MAX_HAND: usize = 8;
/// Four units a side in a duel, three each in a four-player game.
pub const MAX_UNITS: usize = 4;
/// Two Footmen plus one of everything else, on either side.
pub const MAX_STACKS: usize = 16;

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Poison {
    None = 0,
    Assassin,
    Saboteur,
}

impl Poison {
    #[inline]
    pub const fn is_some(self) -> bool {
        !matches!(self, Poison::None)
    }

    pub fn of(unit: UnitId) -> Poison {
        match unit {
            UnitId::Assassin => Poison::Assassin,
            UnitId::Saboteur => Poison::Saboteur,
            _ => Poison::None,
        }
    }

    pub fn key(self) -> Option<&'static str> {
        match self {
            Poison::None => None,
            Poison::Assassin => Some("assassin"),
            Poison::Saboteur => Some("saboteur"),
        }
    }
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct UnitStack {
    pub unit: UnitId,
    pub team: Team,
    /// Owning seat — matters for "your unit" in a four-player game.
    pub seat: Seat,
    /// Number of coins in the stack; 1 means unbolstered.
    pub coins: u8,
    pub poisoned_by: Poison,
}

/// Unit stacks by hex, iterating in the order they arrived.
///
/// The insertion order is not decoration. `applyTactic` walks a Footman's
/// stacks backwards so the first one to arrive maneuvers first, and JavaScript
/// gives that order for free; here it is kept by hand. A stack that moves is
/// deleted and re-inserted, so it goes to the back — exactly what
/// `delete units[from]; units[to] = stack` does.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Board {
    /// Occupied hexes, oldest first.
    order: ArrayVec<HexIdx, MAX_STACKS>,
    /// Slot in `order` for each board hex, or `NONE`.
    slot: [u8; HEX_COUNT],
    stacks: [Option<UnitStack>; HEX_COUNT],
}

impl Default for Board {
    fn default() -> Board {
        Board::new()
    }
}

impl Board {
    pub fn new() -> Board {
        Board { order: ArrayVec::new(), slot: [NONE; HEX_COUNT], stacks: [None; HEX_COUNT] }
    }

    #[inline]
    pub fn get(&self, hex: HexIdx) -> Option<&UnitStack> {
        self.stacks[hex as usize].as_ref()
    }

    #[inline]
    pub fn get_mut(&mut self, hex: HexIdx) -> Option<&mut UnitStack> {
        self.stacks[hex as usize].as_mut()
    }

    #[inline]
    pub fn occupied(&self, hex: HexIdx) -> bool {
        self.stacks[hex as usize].is_some()
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.order.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Occupied hexes in insertion order.
    #[inline]
    pub fn hexes(&self) -> &[HexIdx] {
        &self.order
    }

    /// Every stack in insertion order, with the hex it stands on.
    #[inline]
    pub fn iter(&self) -> impl Iterator<Item = (HexIdx, &UnitStack)> + '_ {
        self.order.iter().map(move |h| (*h, self.stacks[*h as usize].as_ref().unwrap()))
    }

    pub fn insert(&mut self, hex: HexIdx, stack: UnitStack) {
        if self.stacks[hex as usize].is_none() {
            self.slot[hex as usize] = self.order.len() as u8;
            self.order.push(hex);
        }
        self.stacks[hex as usize] = Some(stack);
    }

    pub fn remove(&mut self, hex: HexIdx) -> Option<UnitStack> {
        let stack = self.stacks[hex as usize].take()?;
        let at = self.slot[hex as usize] as usize;
        self.order.remove(at);
        self.slot[hex as usize] = NONE;
        for (i, h) in self.order.iter().enumerate().skip(at) {
            self.slot[*h as usize] = i as u8;
        }
        Some(stack)
    }

    /// Lifts a stack and puts it down again, so it goes to the back of the order.
    pub fn relocate(&mut self, from: HexIdx, to: HexIdx) {
        if let Some(stack) = self.remove(from) {
            self.insert(to, stack);
        }
    }

    pub fn clear(&mut self) {
        for h in self.order.drain(..) {
            self.stacks[h as usize] = None;
            self.slot[h as usize] = NONE;
        }
    }
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct DiscardEntry {
    pub coin: CoinId,
    /// Facedown coins are hidden from the opponent until the bag is refilled.
    pub face_up: bool,
}

/// Who is behind a seat. Not rules, and so kept out of the state the search
/// copies: it is shared by pointer and never written during a game.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SeatInfo {
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    /// Set when nobody is behind the seat.
    pub bot: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PlayerState {
    pub seat: Seat,
    pub team: Team,
    /// The unit types this player drafted, in pick order.
    pub units: ArrayVec<UnitId, MAX_UNITS>,
    /// Coins still in the bag, in draw order (draw from the end).
    pub bag: Vec<CoinId>,
    pub hand: ArrayVec<CoinId, MAX_HAND>,
    pub discard: Vec<DiscardEntry>,
    /// Coins of each drafted type still available to recruit.
    pub supply: [u8; UNIT_COUNT],
    /// Coins destroyed on the board. The Reinforce decree can call one back.
    pub removed: [u8; UNIT_COUNT],
    /// Proclamation Seals left to spend on Royal Decrees.
    pub seals: u8,
    /// Set while this player holds the marker; only one seat per game has it.
    pub has_initiative: bool,
}

impl PlayerState {
    pub fn new(seat: Seat, team: Team) -> PlayerState {
        PlayerState {
            seat,
            team,
            units: ArrayVec::new(),
            bag: Vec::new(),
            hand: ArrayVec::new(),
            discard: Vec::new(),
            supply: [0; UNIT_COUNT],
            removed: [0; UNIT_COUNT],
            seals: 0,
            has_initiative: false,
        }
    }

    #[inline]
    pub fn supply_of(&self, unit: UnitId) -> u8 {
        self.supply[unit as usize]
    }

    #[inline]
    pub fn removed_of(&self, unit: UnitId) -> u8 {
        self.removed[unit as usize]
    }

    #[inline]
    pub fn supply_total(&self) -> u32 {
        self.supply.iter().map(|n| *n as u32).sum()
    }

    #[inline]
    pub fn removed_total(&self) -> u32 {
        self.removed.iter().map(|n| *n as u32).sum()
    }

    #[inline]
    pub fn drafted(&self, unit: UnitId) -> bool {
        self.units.contains(&unit)
    }
}

// ---------------------------------------------------------------------------
// Pending steps
// ---------------------------------------------------------------------------

/// Which card put a step on the stack. Carried because the log and the client
/// read it; the engine branches on the step kind, never on this.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum StepSource {
    Swordsman = 0,
    Earl,
    Berserker,
    WarriorPriest,
    Footman,
    Mercenary,
    Herald,
    Marshal,
    Ensign,
    Enlist,
    Bishop,
    Saboteur,
}

impl StepSource {
    pub fn key(self) -> &'static str {
        match self {
            StepSource::Swordsman => "swordsman",
            StepSource::Earl => "earl",
            StepSource::Berserker => "berserker",
            StepSource::WarriorPriest => "warriorPriest",
            StepSource::Footman => "footman",
            StepSource::Mercenary => "mercenary",
            StepSource::Herald => "herald",
            StepSource::Marshal => "marshal",
            StepSource::Ensign => "ensign",
            StepSource::Enlist => "enlist",
            StepSource::Bishop => "bishop",
            StepSource::Saboteur => "saboteur",
        }
    }
}

/// Where a defender may take a hit instead of off the stack that was attacked.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct AbsorbOptions {
    /// Royal Guard: a coin out of its own supply.
    pub supply: bool,
    /// War Wagons standing next to the target, in adjacency order.
    pub wagons: ArrayVec<HexIdx, 6>,
    /// Skirmisher: a Decoy Coin planted on the opponent.
    pub decoy: bool,
}

impl AbsorbOptions {
    #[inline]
    pub fn is_empty(&self) -> bool {
        !self.supply && self.wagons.is_empty() && !self.decoy
    }
}

/// A decision the current player still owes before their turn ends. Steps are
/// resolved newest-first; optional ones can be skipped.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PendingStep {
    /// Swordsman / Earl: it may move.
    OptionalMove { hex: HexIdx, source: StepSource },
    /// Berserker: pay a coin off the stack to maneuver again.
    OptionalRepeat { hex: HexIdx },
    /// Warrior Priest: a coin was drawn and must be used right now. `None` only
    /// in a view built for anybody but its owner.
    MustUseCoin { coin: Option<CoinId> },
    /// Footman / Mercenary / Berserker / Herald / Earl: maneuver with this unit.
    ManeuverUnit { hex: HexIdx, source: StepSource, optional: bool },
    /// Marshal / Ensign: a friendly unit within range makes a normal maneuver.
    GrantManeuver { attack: bool, origin: HexIdx, range: u8, source: StepSource },
    /// Sacrifice / Guard: pick a friendly unit and attack with it.
    DecreeAttack { costs_coin: bool, from_own_location: bool },
    /// March: move a friendly bolstered unit.
    DecreeMove { require_bolstered: bool },
    /// Enlist / Bishop: take a coin from your supply.
    DecreeRecruit { source: StepSource },
    /// Redeploy: lift one of your units off the board…
    DecreeLift,
    /// …and put it back on a location you control.
    ///
    /// The counter travels with it: Nightfall says a poisoned unit may be
    /// redeployed and stays poisoned, and holding only the unit and the coins
    /// cured it in mid-air.
    DecreePlace { unit: UnitId, coins: u8, from: HexIdx, poisoned_by: Poison },
    /// Spy: look at an opponent's hand and maybe throw a coin away.
    DecreeSpy { target: Seat },
    /// Reinforce: call a destroyed coin back into your supply.
    DecreeReinforce,
    /// Herald: bolster an adjacent unbolstered ally from its supply.
    HeraldBolster { origin: HexIdx },
    /// Bannerman: shove one adjacent enemy a space.
    ShoveEnemy { origin: HexIdx },
    /// Bishop / Siege Tower: after acting, move or attack.
    ManeuverUnitLimited { hex: HexIdx, allow_move: bool, allow_attack: bool },
    /// Saboteur: having recruited one, use that unit's tactic for free.
    FreeTactic { unit: UnitId },
    /// Earl / Herald: proclaim a Decree, optionally without spending a Seal.
    Proclaim { free: bool },
    /// Assassin: burn a coin of the unit it just finished off.
    BurnSupply { unit: UnitId, owner: Seat },
    /// Infiltrator: plant a Decoy Coin on an opponent.
    Deceive { decoy: CoinId },
    /// Siege Tower: bolster itself from the supply the moment it lands.
    BolsterSelf { hex: HexIdx },
    /// Sapper: raise a Fortification on the location it just entered.
    BuildFort { hex: HexIdx, seat: Seat },
    /// Royal Guard / War Wagon / Skirmisher: the *defender* chooses whether to
    /// soak the hit, so `seat` names who answers.
    AbsorbHit {
        seat: Seat,
        target: HexIdx,
        by_hex: HexIdx,
        by_unit: UnitId,
        by_seat: Seat,
        options: AbsorbOptions,
    },
}

impl PendingStep {
    /// The seat that owes this decision when it is not the player whose turn it
    /// is — the `'seat' in step` test the TypeScript engine makes.
    #[inline]
    pub fn answering_seat(&self) -> Option<Seat> {
        match self {
            PendingStep::AbsorbHit { seat, .. } => Some(*seat),
            PendingStep::BuildFort { seat, .. } => Some(*seat),
            _ => None,
        }
    }

    /// The index this step's kind has in `moveKey`'s alphabet, one-based.
    pub fn key_index(&self) -> u64 {
        match self {
            PendingStep::OptionalMove { .. } => 1,
            PendingStep::OptionalRepeat { .. } => 2,
            PendingStep::MustUseCoin { .. } => 3,
            PendingStep::ManeuverUnit { .. } => 4,
            PendingStep::GrantManeuver { .. } => 5,
            PendingStep::DecreeAttack { .. } => 6,
            PendingStep::DecreeMove { .. } => 7,
            PendingStep::DecreeRecruit { .. } => 8,
            PendingStep::DecreeLift => 9,
            PendingStep::DecreePlace { .. } => 10,
            PendingStep::DecreeSpy { .. } => 11,
            PendingStep::DecreeReinforce => 12,
            PendingStep::HeraldBolster { .. } => 13,
            PendingStep::ShoveEnemy { .. } => 14,
            PendingStep::ManeuverUnitLimited { .. } => 15,
            PendingStep::FreeTactic { .. } => 16,
            PendingStep::Proclaim { .. } => 17,
            PendingStep::BurnSupply { .. } => 18,
            PendingStep::Deceive { .. } => 19,
            PendingStep::BolsterSelf { .. } => 20,
            PendingStep::BuildFort { .. } => 21,
            PendingStep::AbsorbHit { .. } => 22,
        }
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/// The kinds in the order `moveKey`'s alphabet has them.
#[derive(Copy, Clone, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum ActionKind {
    Deploy = 0,
    Bolster,
    ClaimInitiative,
    Recruit,
    Pass,
    Unpoison,
    ReturnDecoy,
    Move,
    Control,
    Attack,
    Proclaim,
    Tactic,
    FollowMove,
    FollowAttack,
    FollowControl,
    FollowRepeat,
    FollowRecruit,
    FollowLift,
    FollowPlace,
    FollowSpy,
    FollowReinforce,
    FollowBolster,
    FollowShove,
    FollowProclaim,
    FollowBuildFort,
    FollowAbsorb,
    FollowBurn,
    FollowDeceive,
    FollowTactic,
    Skip,
    Draft,
    Ban,
}

pub const ACTION_KIND_COUNT: u64 = 32;

pub const ACTION_KEYS: [&str; ACTION_KIND_COUNT as usize] = [
    "deploy",
    "bolster",
    "claimInitiative",
    "recruit",
    "pass",
    "unpoison",
    "returnDecoy",
    "move",
    "control",
    "attack",
    "proclaim",
    "tactic",
    "followMove",
    "followAttack",
    "followControl",
    "followRepeat",
    "followRecruit",
    "followLift",
    "followPlace",
    "followSpy",
    "followReinforce",
    "followBolster",
    "followShove",
    "followProclaim",
    "followBuildFort",
    "followAbsorb",
    "followBurn",
    "followDeceive",
    "followTactic",
    "skip",
    "draft",
    "ban",
];

impl ActionKind {
    pub fn key(self) -> &'static str {
        ACTION_KEYS[self as usize]
    }

    pub fn from_key(key: &str) -> Option<ActionKind> {
        let i = ACTION_KEYS.iter().position(|k| *k == key)?;
        Some(unsafe { std::mem::transmute::<u8, ActionKind>(i as u8) })
    }

    /// Whether this action spends a coin from hand — `isCoinAction`.
    #[inline]
    pub fn is_coin_action(self) -> bool {
        (self as u8) <= (ActionKind::Tactic as u8)
    }
}

/// Where a hit was taken from, for `followAbsorb`.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum AbsorbSource {
    Supply = 1,
    Wagon = 2,
    Decoy = 3,
}

/// A move, in eight bytes.
///
/// Every field an action can carry has a slot, and unused slots hold
/// [`NONE`]. That costs a few bytes over a tagged union and buys `Copy`,
/// equality, and a legal-move list that is a flat array of a fixed stride.
#[derive(Copy, Clone, PartialEq, Eq, Debug, Hash)]
pub struct Action {
    pub kind: ActionKind,
    /// Hand slot the coin comes out of, or `NONE`.
    pub coin: u8,
    /// `from`, `at` or `hex` — never two of them in one action.
    pub from: HexIdx,
    pub to: HexIdx,
    pub target: HexIdx,
    pub subject: HexIdx,
    /// Whichever small number the kind needs: a unit, a decree, a hand index, a
    /// seat, or an absorb source.
    pub arg: u8,
    _pad: u8,
}

impl Action {
    pub const fn bare(kind: ActionKind) -> Action {
        Action {
            kind,
            coin: NONE,
            from: NONE,
            to: NONE,
            target: NONE,
            subject: NONE,
            arg: NONE,
            _pad: 0,
        }
    }

    pub const fn coin(kind: ActionKind, coin: u8) -> Action {
        Action { coin, ..Action::bare(kind) }
    }

    /// The same fields under a different name — a paid tactic read as a free
    /// one, and back.
    #[inline]
    pub const fn as_kind(mut self, kind: ActionKind) -> Action {
        self.kind = kind;
        self
    }

    #[inline]
    pub const fn without_coin(mut self) -> Action {
        self.coin = NONE;
        self
    }

    #[inline]
    pub const fn with_from(mut self, hex: HexIdx) -> Action {
        self.from = hex;
        self
    }

    #[inline]
    pub const fn with_to(mut self, hex: HexIdx) -> Action {
        self.to = hex;
        self
    }

    #[inline]
    pub const fn with_target(mut self, hex: HexIdx) -> Action {
        self.target = hex;
        self
    }

    #[inline]
    pub const fn with_subject(mut self, hex: HexIdx) -> Action {
        self.subject = hex;
        self
    }

    #[inline]
    pub const fn with_arg(mut self, arg: u8) -> Action {
        self.arg = arg;
        self
    }

    #[inline]
    pub fn with_unit(self, unit: UnitId) -> Action {
        self.with_arg(unit as u8)
    }

    #[inline]
    pub fn with_decree(self, decree: DecreeId) -> Action {
        self.with_arg(decree as u8)
    }

    #[inline]
    pub fn unit(self) -> Option<UnitId> {
        UnitId::from_idx(self.arg as usize)
    }

    #[inline]
    pub fn decree(self) -> Option<DecreeId> {
        DecreeId::from_idx(self.arg as usize)
    }

    #[inline]
    pub fn is_coin_action(self) -> bool {
        self.kind.is_coin_action()
    }
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/// What a log entry says. The parameters each kind carries are spelled out where
/// the log is serialized; here they are just slots.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum LogKind {
    Ban = 0,
    Draft,
    RoundStart,
    Pass,
    Unpoison,
    ReturnDecoy,
    ClaimInitiative,
    Recruit,
    Deploy,
    Bolster,
    Move,
    Control,
    Attack,
    Tactic,
    Proclaim,
    Victory,
    RazeFort,
    Poison,
    Push,
    Sacrifice,
    Lift,
    Spy,
    Reinforce,
    Shove,
    Burn,
    Deceive,
    BuildFort,
    Absorb,
    AbsorbWagon,
    BerserkerRepeat,
    Stalemate,
}

impl LogKind {
    pub fn key(self) -> &'static str {
        match self {
            LogKind::Ban => "ban",
            LogKind::Draft => "draft",
            LogKind::RoundStart => "roundStart",
            LogKind::Pass => "pass",
            LogKind::Unpoison => "unpoison",
            LogKind::ReturnDecoy => "returnDecoy",
            LogKind::ClaimInitiative => "claimInitiative",
            LogKind::Recruit => "recruit",
            LogKind::Deploy => "deploy",
            LogKind::Bolster => "bolster",
            LogKind::Move => "move",
            LogKind::Control => "control",
            LogKind::Attack => "attack",
            LogKind::Tactic => "tactic",
            LogKind::Proclaim => "proclaim",
            LogKind::Victory => "victory",
            LogKind::RazeFort => "razeFort",
            LogKind::Poison => "poison",
            LogKind::Push => "push",
            LogKind::Sacrifice => "sacrifice",
            LogKind::Lift => "lift",
            LogKind::Spy => "spy",
            LogKind::Reinforce => "reinforce",
            LogKind::Shove => "shove",
            LogKind::Burn => "burn",
            LogKind::Deceive => "deceive",
            LogKind::BuildFort => "buildFort",
            LogKind::Absorb => "absorb",
            LogKind::AbsorbWagon => "absorbWagon",
            LogKind::BerserkerRepeat => "berserkerRepeat",
            LogKind::Stalemate => "stalemate",
        }
    }
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct LogEntry {
    pub round: u16,
    pub seat: Seat,
    pub kind: LogKind,
    /// `unit`, and for an attack the attacker.
    pub unit: u8,
    /// `target` — the unit that was hit.
    pub target_unit: u8,
    /// `hex`, `at` or the destination of a control.
    pub hex: HexIdx,
    pub from: HexIdx,
    pub to: HexIdx,
    pub decree: u8,
    pub team: u8,
    pub coin: u8,
}

impl LogEntry {
    pub fn new(round: u16, seat: Seat, kind: LogKind) -> LogEntry {
        LogEntry {
            round,
            seat,
            kind,
            unit: NONE,
            target_unit: NONE,
            hex: NONE,
            from: NONE,
            to: NONE,
            decree: NONE,
            team: NONE,
            coin: NONE,
        }
    }
}

/// The game log, plus the one thing a bot reads out of it.
///
/// `maneuverRecency` is the only consumer inside the search: it wants, per unit,
/// the position of the last move, control or attack this seat made. Keeping that
/// as a table means a determinization does not have to carry the log at all —
/// which is several hundred entries copied per search iteration, for a question
/// answered by 448 bytes.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Log {
    /// Entries, when the game is recording them. A search state records nothing.
    pub entries: Vec<LogEntry>,
    /// Entries written so far, recorded or not — the index `maneuverRecency` reads.
    pub length: u32,
    /// `last_maneuver[seat][unit] + 1`, or 0 for "never".
    pub last_maneuver: [[u32; UNIT_COUNT]; MAX_SEATS],
    pub recording: bool,
}

impl Default for Log {
    fn default() -> Log {
        Log::new(true)
    }
}

impl Log {
    pub fn new(recording: bool) -> Log {
        Log {
            entries: Vec::new(),
            length: 0,
            last_maneuver: [[0; UNIT_COUNT]; MAX_SEATS],
            recording,
        }
    }

    /// A maneuver is one of three things: move, control, attack.
    #[inline]
    fn is_maneuver(kind: LogKind) -> bool {
        matches!(kind, LogKind::Move | LogKind::Control | LogKind::Attack)
    }

    pub fn push(&mut self, entry: LogEntry) {
        if Log::is_maneuver(entry.kind) && entry.unit != NONE && (entry.seat as usize) < MAX_SEATS {
            self.last_maneuver[entry.seat as usize][entry.unit as usize] = self.length + 1;
        }
        if self.recording {
            self.entries.push(entry);
        }
        self.length += 1;
    }

    #[inline]
    pub fn recency(&self, seat: Seat, unit: UnitId) -> u32 {
        self.last_maneuver[seat as usize][unit as usize]
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.length = 0;
        self.last_maneuver = [[0; UNIT_COUNT]; MAX_SEATS];
    }
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Phase {
    Ban = 0,
    Draft,
    Playing,
    Finished,
}

impl Phase {
    pub fn key(self) -> &'static str {
        match self {
            Phase::Ban => "ban",
            Phase::Draft => "draft",
            Phase::Playing => "playing",
            Phase::Finished => "finished",
        }
    }

    pub fn from_key(key: &str) -> Option<Phase> {
        match key {
            "ban" => Some(Phase::Ban),
            "draft" => Some(Phase::Draft),
            "playing" => Some(Phase::Playing),
            "finished" => Some(Phase::Finished),
            _ => None,
        }
    }
}

/// `ban` is the tournament kit's elimination draft.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum DraftMode {
    Random = 0,
    Draft,
    Ban,
}

impl DraftMode {
    pub fn key(self) -> &'static str {
        match self {
            DraftMode::Random => "random",
            DraftMode::Draft => "draft",
            DraftMode::Ban => "ban",
        }
    }

    pub fn from_key(key: &str) -> Option<DraftMode> {
        match key {
            "random" => Some(DraftMode::Random),
            "draft" => Some(DraftMode::Draft),
            "ban" => Some(DraftMode::Ban),
            _ => None,
        }
    }
}

/// A control marker slot: the team holding the location, or `NO_SEAT`.
pub type ControlMap = [u8; HEX_COUNT];

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct GameState {
    pub id: Arc<str>,
    pub size: BoardSize,
    pub phase: Phase,
    pub round: u16,
    /// Seat to act.
    pub turn: Seat,
    pub players: ArrayVec<PlayerState, MAX_SEATS>,
    /// Who is behind each seat. Shared, never written after setup.
    pub seats: Arc<Vec<SeatInfo>>,
    pub units: Board,
    /// Control markers by location hex, keyed by owning team.
    pub control: ControlMap,
    /// Seat that will start the next round.
    pub initiative: Seat,
    /// The Initiative Marker may only change hands once per round.
    pub initiative_moved_this_round: bool,
    pub pending: Vec<PendingStep>,
    pub draft_mode: DraftMode,
    pub sets: SetMask,
    /// Royal Decrees face up this game; empty unless Nobility is in play.
    pub decrees: ArrayVec<DecreeInPlay, 4>,
    /// Hexes holding a Fortification; empty unless Siege is in play.
    pub forts: [bool; HEX_COUNT],
    /// Fortification coins left beside the board.
    pub fort_supply: u8,
    /// Unit cards still on the table during the draft, in pick order.
    pub draft_pool: Vec<UnitId>,
    /// Cards struck out during the elimination draft, for display.
    pub banned: Vec<UnitId>,
    pub log: Log,
    pub winner: Option<Team>,
    pub rng: Rng,
}

impl GameState {
    #[inline]
    pub fn player(&self, seat: Seat) -> &PlayerState {
        &self.players[seat as usize]
    }

    #[inline]
    pub fn player_mut(&mut self, seat: Seat) -> &mut PlayerState {
        &mut self.players[seat as usize]
    }

    #[inline]
    pub fn is_terminal(&self) -> bool {
        matches!(self.phase, Phase::Finished)
    }

    /// Who has to act right now. Usually the player whose turn it is, but a
    /// pending step may name someone else — the defender soaking a hit.
    #[inline]
    pub fn acting_seat(&self) -> Seat {
        match self.pending.last().and_then(PendingStep::answering_seat) {
            Some(seat) => seat,
            None => self.turn,
        }
    }

    #[inline]
    pub fn control_of(&self, hex: HexIdx) -> Option<Team> {
        let team = self.control[hex as usize];
        if team == NO_SEAT {
            None
        } else {
            Some(team)
        }
    }

    /// Control markers the team has not placed yet.
    pub fn markers_remaining(&self, team: Team) -> i32 {
        let placed = self.control.iter().filter(|t| **t == team).count() as i32;
        crate::board::board_for(self.size).control_markers as i32 - placed
    }

    /// The other side. In a duel that is the one other player.
    pub fn other_team(&self, team: Team) -> Team {
        match self.players.iter().find(|p| p.team != team) {
            Some(p) => p.team,
            None => {
                if team == 0 {
                    1
                } else {
                    0
                }
            }
        }
    }
}
