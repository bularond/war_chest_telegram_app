//! The 28 unit types, the Royal Coin and the two Decoy Coins.
//!
//! Card text lives beside the catalog in `catalog.rs`; what is here is the part
//! the rules engine executes. Coin counts, tactics, attributes and restrictions
//! are transcribed from the printed cards — the sums per box (74 base, 19
//! Nobility, 19 Siege, 18 Nightfall) are checked by a test at the bottom.

/// A unit type. The discriminants are the order of `UNIT_IDS` in the TypeScript
/// engine, which is what every packed key and every serialized weight vector
/// already assumes.
#[derive(Copy, Clone, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum UnitId {
    Swordsman = 0,
    Archer,
    Pikeman,
    Cavalry,
    Crossbowman,
    Lancer,
    LightCavalry,
    Scout,
    Knight,
    Marshal,
    Mercenary,
    Berserker,
    Ensign,
    Footman,
    WarriorPriest,
    RoyalGuard,
    // Nobility
    Herald,
    Earl,
    Bishop,
    Bannerman,
    // Siege
    Trebuchet,
    SiegeTower,
    Sapper,
    WarWagon,
    // Nightfall
    Assassin,
    Saboteur,
    Infiltrator,
    Skirmisher,
}

pub const UNIT_COUNT: usize = 28;

pub const UNIT_IDS: [UnitId; UNIT_COUNT] = {
    use UnitId::*;
    [
        Swordsman,
        Archer,
        Pikeman,
        Cavalry,
        Crossbowman,
        Lancer,
        LightCavalry,
        Scout,
        Knight,
        Marshal,
        Mercenary,
        Berserker,
        Ensign,
        Footman,
        WarriorPriest,
        RoyalGuard,
        Herald,
        Earl,
        Bishop,
        Bannerman,
        Trebuchet,
        SiegeTower,
        Sapper,
        WarWagon,
        Assassin,
        Saboteur,
        Infiltrator,
        Skirmisher,
    ]
};

impl UnitId {
    #[inline]
    pub const fn idx(self) -> usize {
        self as usize
    }

    #[inline]
    pub fn from_idx(i: usize) -> Option<UnitId> {
        UNIT_IDS.get(i).copied()
    }

    #[inline]
    pub fn spec(self) -> &'static UnitDefinition {
        &UNITS[self as usize]
    }

    pub fn key(self) -> &'static str {
        UNIT_KEYS[self as usize]
    }

    pub fn from_key(key: &str) -> Option<UnitId> {
        UNIT_KEYS.iter().position(|k| *k == key).and_then(UnitId::from_idx)
    }
}

/// The camelCase names the wire protocol and the weight files use.
pub const UNIT_KEYS: [&str; UNIT_COUNT] = [
    "swordsman",
    "archer",
    "pikeman",
    "cavalry",
    "crossbowman",
    "lancer",
    "lightCavalry",
    "scout",
    "knight",
    "marshal",
    "mercenary",
    "berserker",
    "ensign",
    "footman",
    "warriorPriest",
    "royalGuard",
    "herald",
    "earl",
    "bishop",
    "bannerman",
    "trebuchet",
    "siegeTower",
    "sapper",
    "warWagon",
    "assassin",
    "saboteur",
    "infiltrator",
    "skirmisher",
];

/// Which box a unit comes from. Lobbies pick which sets are in the draft.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum UnitSet {
    Base = 0,
    Nobility,
    Siege,
    Nightfall,
}

pub const UNIT_SETS: [UnitSet; 4] =
    [UnitSet::Base, UnitSet::Nobility, UnitSet::Siege, UnitSet::Nightfall];

pub const SET_KEYS: [&str; 4] = ["base", "nobility", "siege", "nightfall"];

impl UnitSet {
    pub const fn bit(self) -> u8 {
        1 << (self as u8)
    }

    pub fn key(self) -> &'static str {
        SET_KEYS[self as usize]
    }

    pub fn from_key(key: &str) -> Option<UnitSet> {
        SET_KEYS.iter().position(|k| *k == key).map(|i| UNIT_SETS[i])
    }
}

/// The sets on the table, as a bitmask. The base game is always included.
#[derive(Copy, Clone, PartialEq, Eq, Debug, Default)]
pub struct SetMask(pub u8);

impl SetMask {
    #[inline]
    pub const fn has(self, set: UnitSet) -> bool {
        self.0 & set.bit() != 0
    }

    #[inline]
    pub const fn with(self, set: UnitSet) -> SetMask {
        SetMask(self.0 | set.bit())
    }

    pub fn base() -> SetMask {
        SetMask(UnitSet::Base.bit())
    }

    pub fn iter(self) -> impl Iterator<Item = UnitSet> {
        UNIT_SETS.into_iter().filter(move |s| self.has(*s))
    }
}

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

/// Anything that can sit in a bag, hand or discard pile: a unit coin, the Royal
/// Coin, or one of the two Decoy Coins.
///
/// One byte, and the unit coins keep their `UnitId` discriminant so the
/// conversion in either direction is a cast.
#[derive(Copy, Clone, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
#[repr(transparent)]
pub struct CoinId(pub u8);

pub const ROYAL_COIN: CoinId = CoinId(UNIT_COUNT as u8);
pub const DECOY_INFILTRATOR: CoinId = CoinId(UNIT_COUNT as u8 + 1);
pub const DECOY_SKIRMISHER: CoinId = CoinId(UNIT_COUNT as u8 + 2);
/// Every coin name there is, for packing keys.
pub const COIN_KINDS: usize = UNIT_COUNT + 3;
pub const DECOYS: [CoinId; 2] = [DECOY_INFILTRATOR, DECOY_SKIRMISHER];

impl CoinId {
    #[inline]
    pub const fn unit(u: UnitId) -> CoinId {
        CoinId(u as u8)
    }

    #[inline]
    pub const fn is_unit(self) -> bool {
        (self.0 as usize) < UNIT_COUNT
    }

    #[inline]
    pub const fn is_decoy(self) -> bool {
        self.0 == DECOY_INFILTRATOR.0 || self.0 == DECOY_SKIRMISHER.0
    }

    #[inline]
    pub const fn is_royal(self) -> bool {
        self.0 == ROYAL_COIN.0
    }

    /// The unit this coin belongs to, or `None` for the Royal Coin and decoys.
    #[inline]
    pub fn as_unit(self) -> Option<UnitId> {
        if self.is_unit() {
            UnitId::from_idx(self.0 as usize)
        } else {
            None
        }
    }

    pub fn key(self) -> &'static str {
        match self.0 as usize {
            i if i < UNIT_COUNT => UNIT_KEYS[i],
            i if i == UNIT_COUNT => "royal",
            i if i == UNIT_COUNT + 1 => "decoyInfiltrator",
            _ => "decoySkirmisher",
        }
    }

    pub fn from_key(key: &str) -> Option<CoinId> {
        match key {
            "royal" => Some(ROYAL_COIN),
            "decoyInfiltrator" => Some(DECOY_INFILTRATOR),
            "decoySkirmisher" => Some(DECOY_SKIRMISHER),
            _ => UnitId::from_key(key).map(CoinId::unit),
        }
    }
}

/// The Decoy Coin a unit owns, if it owns one.
#[inline]
pub fn decoy_of(unit: UnitId) -> Option<CoinId> {
    match unit {
        UnitId::Infiltrator => Some(DECOY_INFILTRATOR),
        UnitId::Skirmisher => Some(DECOY_SKIRMISHER),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// What a card does
// ---------------------------------------------------------------------------

/// What a unit's TACTIC does, in a form the engine can execute.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Tactic {
    /// Attack a unit between `min` and `max` spaces away.
    RangedAttack { min: u8, max: u8, straight_line: bool, blocked: bool },
    /// Move between `min` and `max` spaces, then attack an adjacent enemy.
    ChargeAttack { min: u8, max: u8, straight_line: bool },
    /// Move exactly `distance` spaces, each step into an empty hex.
    MultiMove { distance: u8 },
    /// Let a friendly unit within `range` perform a normal move or attack.
    GrantManeuver { attack: bool, range: u8 },
    /// Perform one maneuver with each of your units of this type.
    ManeuverEachUnit,
    /// Royal Guard: played with the Royal Coin, not a unit coin.
    RoyalRedeploy { distance: u8 },
    /// Herald: bolster an adjacent unbolstered friendly unit from the supply.
    BolsterAllyFromSupply,
    /// Earl: control a location, then proclaim without spending a Seal.
    ControlThenProclaim,
    /// Bishop: recruit, then either move or attack.
    RecruitThenManeuver,
    /// Siege Tower: attack twice.
    AttackTwice,
    /// War Wagon: push an adjacent ally one space and follow into its space.
    PushAlly,
    /// Sapper: move, then attack a Fortification.
    MoveThenAttackFort,
    /// Assassin: move, then poison an adjacent unit.
    MoveThenPoison,
    /// Saboteur: poison a unit `min`..`max` spaces away.
    PoisonAtRange { min: u8, max: u8 },
    /// Infiltrator: move onto an enemy-controlled location and take it.
    Infiltrate { distance: u8 },
    /// Skirmisher: move `distance` spaces, ending next to an enemy.
    Skirmish { distance: u8 },
}

/// Unit attributes, as a bitmask. The names are the TypeScript `AttributeId`s.
pub mod attr {
    /// Footman: two units of this type may be deployed at once.
    pub const TWO_UNITS_DEPLOYED: u32 = 1 << 0;
    /// Pikeman: when attacked by an adjacent unit, the attacker also loses a coin.
    pub const RETALIATE: u32 = 1 << 1;
    /// Swordsman: after this unit attacks, it may move.
    pub const MOVE_AFTER_ATTACK: u32 = 1 << 2;
    /// Knight: may only be attacked by a bolstered unit.
    pub const ONLY_ATTACKED_BY_BOLSTERED: u32 = 1 << 3;
    /// Mercenary: recruiting this coin gives the deployed unit a free maneuver.
    pub const FREE_MANEUVER_ON_RECRUIT: u32 = 1 << 4;
    /// Warrior Priest: after it controls or attacks, draw a coin and use it now.
    pub const DRAW_AND_USE: u32 = 1 << 5;
    /// Berserker: after it maneuvers, spend a bolstered coin to maneuver again.
    pub const MANEUVER_AGAIN_FOR_COIN: u32 = 1 << 6;
    /// Scout: may be deployed next to any friendly unit.
    pub const DEPLOY_NEXT_TO_FRIENDLY: u32 = 1 << 7;
    /// Royal Guard: an attack may take a coin from the supply instead.
    pub const ABSORB_HIT_FROM_SUPPLY: u32 = 1 << 8;
    /// Siege Tower: may be bolstered from the supply the moment it deploys.
    pub const BOLSTER_ON_DEPLOY: u32 = 1 << 9;
    /// War Wagon: soaks a hit aimed at an adjacent friendly unit.
    pub const ABSORB_HIT_FOR_ALLY: u32 = 1 << 10;
    /// Bannerman: after it maneuvers, shove one adjacent enemy a space.
    pub const SHOVE_ENEMY_AFTER_MANEUVER: u32 = 1 << 11;
    /// Earl: may move straight after it is deployed.
    pub const MOVE_AFTER_DEPLOY: u32 = 1 << 12;
    /// Herald: may maneuver after you proclaim.
    pub const MANEUVER_AFTER_PROCLAIM: u32 = 1 << 13;
    /// Sapper: moving onto a bare location may raise a Fortification there.
    pub const BUILD_FORT_ON_MOVE: u32 = 1 << 14;
    /// Assassin: finishing off a poisoned unit burns one of its supply coins.
    pub const BURN_SUPPLY_AFTER_KILLING_POISONED: u32 = 1 << 15;
    /// Saboteur: recruiting one lets it poison immediately.
    pub const TACTIC_ON_RECRUIT: u32 = 1 << 16;
    /// Infiltrator: taking a location plants a Decoy Coin on the opponent.
    pub const DECEIVE_AFTER_CONTROL: u32 = 1 << 17;
    /// Skirmisher: a Decoy Coin can soak the attack entirely.
    pub const DECEIVE_WHEN_ATTACKED: u32 = 1 << 18;
}

pub mod restrict {
    /// Archer, Lancer, Trebuchet: cannot make a normal (adjacent) attack.
    pub const NO_NORMAL_ATTACK: u32 = 1 << 0;
    /// Bishop: the mirror of the Knight — only unbolstered units may attack it.
    pub const ONLY_ATTACKED_BY_UNBOLSTERED: u32 = 1 << 1;
}

pub struct UnitDefinition {
    pub id: UnitId,
    pub set: UnitSet,
    /// Total coins of this type in the game: 2 start in the bag, the rest supply.
    pub coins: u8,
    pub tactic: Option<Tactic>,
    /// A Siege Tactic may only be used while the unit is bolstered.
    pub siege_tactic: bool,
    pub attributes: u32,
    pub restrictions: u32,
}

const fn unit(
    id: UnitId,
    set: UnitSet,
    coins: u8,
    tactic: Option<Tactic>,
    siege_tactic: bool,
    attributes: u32,
    restrictions: u32,
) -> UnitDefinition {
    UnitDefinition { id, set, coins, tactic, siege_tactic, attributes, restrictions }
}

pub static UNITS: [UnitDefinition; UNIT_COUNT] = {
    use attr::*;
    use restrict::*;
    use Tactic::*;
    use UnitId as U;
    use UnitSet::{Base, Nightfall, Nobility, Siege};
    [
        unit(U::Swordsman, Base, 5, None, false, MOVE_AFTER_ATTACK, 0),
        unit(
            U::Archer,
            Base,
            4,
            Some(RangedAttack { min: 2, max: 2, straight_line: false, blocked: false }),
            false,
            0,
            NO_NORMAL_ATTACK,
        ),
        unit(U::Pikeman, Base, 4, None, false, RETALIATE, 0),
        unit(
            U::Cavalry,
            Base,
            4,
            Some(ChargeAttack { min: 1, max: 1, straight_line: false }),
            false,
            0,
            0,
        ),
        unit(
            U::Crossbowman,
            Base,
            5,
            Some(RangedAttack { min: 2, max: 2, straight_line: true, blocked: true }),
            false,
            0,
            0,
        ),
        unit(
            U::Lancer,
            Base,
            4,
            Some(ChargeAttack { min: 1, max: 2, straight_line: true }),
            false,
            0,
            NO_NORMAL_ATTACK,
        ),
        unit(U::LightCavalry, Base, 5, Some(MultiMove { distance: 2 }), false, 0, 0),
        unit(U::Scout, Base, 5, None, false, DEPLOY_NEXT_TO_FRIENDLY, 0),
        unit(U::Knight, Base, 4, None, false, ONLY_ATTACKED_BY_BOLSTERED, 0),
        unit(
            U::Marshal,
            Base,
            5,
            Some(GrantManeuver { attack: true, range: 2 }),
            false,
            0,
            0,
        ),
        unit(U::Mercenary, Base, 5, None, false, FREE_MANEUVER_ON_RECRUIT, 0),
        unit(U::Berserker, Base, 5, None, false, MANEUVER_AGAIN_FOR_COIN, 0),
        unit(
            U::Ensign,
            Base,
            5,
            Some(GrantManeuver { attack: false, range: 2 }),
            false,
            0,
            0,
        ),
        unit(U::Footman, Base, 5, Some(ManeuverEachUnit), false, TWO_UNITS_DEPLOYED, 0),
        unit(U::WarriorPriest, Base, 4, None, false, DRAW_AND_USE, 0),
        unit(
            U::RoyalGuard,
            Base,
            5,
            Some(RoyalRedeploy { distance: 2 }),
            false,
            ABSORB_HIT_FROM_SUPPLY,
            0,
        ),
        unit(
            U::Herald,
            Nobility,
            5,
            Some(BolsterAllyFromSupply),
            false,
            MANEUVER_AFTER_PROCLAIM,
            0,
        ),
        unit(U::Earl, Nobility, 5, Some(ControlThenProclaim), false, MOVE_AFTER_DEPLOY, 0),
        unit(
            U::Bishop,
            Nobility,
            5,
            Some(RecruitThenManeuver),
            false,
            0,
            ONLY_ATTACKED_BY_UNBOLSTERED,
        ),
        unit(U::Bannerman, Nobility, 4, None, false, SHOVE_ENEMY_AFTER_MANEUVER, 0),
        unit(
            U::Trebuchet,
            Siege,
            5,
            Some(RangedAttack { min: 2, max: 3, straight_line: true, blocked: false }),
            true,
            0,
            NO_NORMAL_ATTACK,
        ),
        unit(U::SiegeTower, Siege, 5, Some(AttackTwice), true, BOLSTER_ON_DEPLOY, 0),
        unit(U::Sapper, Siege, 5, Some(MoveThenAttackFort), false, BUILD_FORT_ON_MOVE, 0),
        unit(U::WarWagon, Siege, 4, Some(PushAlly), true, ABSORB_HIT_FOR_ALLY, 0),
        unit(
            U::Assassin,
            Nightfall,
            4,
            Some(MoveThenPoison),
            false,
            BURN_SUPPLY_AFTER_KILLING_POISONED,
            0,
        ),
        unit(
            U::Saboteur,
            Nightfall,
            5,
            Some(PoisonAtRange { min: 1, max: 2 }),
            false,
            TACTIC_ON_RECRUIT,
            0,
        ),
        unit(
            U::Infiltrator,
            Nightfall,
            5,
            Some(Infiltrate { distance: 1 }),
            false,
            DECEIVE_AFTER_CONTROL,
            0,
        ),
        unit(U::Skirmisher, Nightfall, 4, Some(Skirmish { distance: 2 }), false, DECEIVE_WHEN_ATTACKED, 0),
    ]
};

#[inline]
pub fn has_attribute(unit: UnitId, attribute: u32) -> bool {
    UNITS[unit as usize].attributes & attribute != 0
}

#[inline]
pub fn has_restriction(unit: UnitId, restriction: u32) -> bool {
    UNITS[unit as usize].restrictions & restriction != 0
}

/// Units a player may have deployed at once — 1, except the Footman's 2.
#[inline]
pub fn max_deployed(unit: UnitId) -> u8 {
    if has_attribute(unit, attr::TWO_UNITS_DEPLOYED) {
        2
    } else {
        1
    }
}

/// Unit types available when these sets are switched on, in catalog order.
pub fn units_for_sets(sets: SetMask) -> Vec<UnitId> {
    UNIT_IDS.into_iter().filter(|u| sets.has(u.spec().set)).collect()
}

/// Coins of each type that start in a player's bag when they draft that unit.
pub const COINS_IN_BAG_PER_UNIT: u8 = 2;

/// Unit types drafted per player, by table size.
#[inline]
pub const fn units_per_player(size: crate::board::BoardSize) -> usize {
    match size {
        crate::board::BoardSize::Duel => 4,
        crate::board::BoardSize::Team => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_coin_counts_match_the_component_lists() {
        let per_set = |set: UnitSet| -> u32 {
            UNITS.iter().filter(|u| u.set == set).map(|u| u.coins as u32).sum()
        };
        assert_eq!(per_set(UnitSet::Base), 74);
        assert_eq!(per_set(UnitSet::Nobility), 19);
        assert_eq!(per_set(UnitSet::Siege), 19);
        assert_eq!(per_set(UnitSet::Nightfall), 18);
    }

    #[test]
    fn the_catalog_is_indexed_by_its_own_ids() {
        for (i, u) in UNITS.iter().enumerate() {
            assert_eq!(u.id as usize, i);
            assert_eq!(UnitId::from_key(UNIT_KEYS[i]), Some(u.id));
        }
    }

    #[test]
    fn coins_round_trip_through_their_names() {
        for i in 0..COIN_KINDS {
            let coin = CoinId(i as u8);
            assert_eq!(CoinId::from_key(coin.key()), Some(coin));
        }
    }
}
