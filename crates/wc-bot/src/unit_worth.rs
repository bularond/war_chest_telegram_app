//! What each unit is worth, measured.
//!
//! These tables started as a draft rule and are data, not policy — which is why
//! they live here rather than inside the bot that first read them. The draft
//! asks "which of these should I take"; the evaluation asks "was that trade
//! good" — the same number answers both.

use std::sync::LazyLock;
use wc_core::units::{UnitId, UNIT_COUNT, UNIT_IDS};

/// How often each base unit was on the winning side, measured rather than judged.
///
/// 2220 games of the search playing itself at 200 iterations a move, units dealt
/// at random, four a side — two runs pooled. A unit's number is confounded by
/// the three it was dealt alongside and the four it faced, so this ranks units
/// under random partners: the right first question, and not the last one.
///
/// **It has to be measured under the player it is for.** The same count under
/// the heuristic gives a different order and twice the spread — the heuristic
/// cannot use the Royal Coin, so it calls the Royal Guard weak, and that is a
/// fact about the heuristic. Strength is a property of the player holding the
/// unit.
pub static MEASURED_VALUE: LazyLock<[Option<f64>; UNIT_COUNT]> = LazyLock::new(|| {
    let mut t = [None; UNIT_COUNT];
    let mut set = |u: UnitId, v: f64| t[u as usize] = Some(v);
    set(UnitId::LightCavalry, 0.598);
    set(UnitId::Scout, 0.593);
    set(UnitId::Cavalry, 0.573);
    set(UnitId::Mercenary, 0.553);
    set(UnitId::RoyalGuard, 0.528);
    set(UnitId::Pikeman, 0.516);
    set(UnitId::WarriorPriest, 0.508);
    set(UnitId::Crossbowman, 0.492);
    set(UnitId::Knight, 0.483);
    set(UnitId::Archer, 0.483);
    set(UnitId::Marshal, 0.468);
    set(UnitId::Lancer, 0.462);
    set(UnitId::Ensign, 0.445);
    set(UnitId::Berserker, 0.44);
    set(UnitId::Swordsman, 0.435);
    set(UnitId::Footman, 0.413);
    t
});

/// The same count over all 28 units, with the three expansions out: 3600 games
/// under `search@7`, about 1030 appearances each, ±3.0 points.
///
/// It is a different game, not an extension of the same one: a pool of eight
/// drawn from 28 asks a unit to beat different company than a pool drawn from
/// 16. What holds across both is the Light Cavalry on top and the Footman at the
/// bottom.
pub static MEASURED_VALUE_ALL: LazyLock<[Option<f64>; UNIT_COUNT]> = LazyLock::new(|| {
    let mut t = [None; UNIT_COUNT];
    let mut set = |u: UnitId, v: f64| t[u as usize] = Some(v);
    set(UnitId::LightCavalry, 0.651);
    set(UnitId::Skirmisher, 0.622);
    set(UnitId::Scout, 0.588);
    set(UnitId::Mercenary, 0.575);
    set(UnitId::SiegeTower, 0.573);
    set(UnitId::WarriorPriest, 0.542);
    set(UnitId::Bannerman, 0.534);
    set(UnitId::Herald, 0.53);
    set(UnitId::Earl, 0.525);
    set(UnitId::Cavalry, 0.52);
    set(UnitId::Pikeman, 0.515);
    set(UnitId::Infiltrator, 0.512);
    set(UnitId::RoyalGuard, 0.505);
    set(UnitId::Knight, 0.489);
    set(UnitId::Swordsman, 0.488);
    set(UnitId::Archer, 0.486);
    set(UnitId::WarWagon, 0.486);
    set(UnitId::Lancer, 0.484);
    set(UnitId::Assassin, 0.462);
    set(UnitId::Bishop, 0.46);
    set(UnitId::Berserker, 0.457);
    set(UnitId::Ensign, 0.446);
    set(UnitId::Sapper, 0.436);
    set(UnitId::Marshal, 0.434);
    set(UnitId::Crossbowman, 0.43);
    set(UnitId::Saboteur, 0.425);
    set(UnitId::Trebuchet, 0.423);
    set(UnitId::Footman, 0.416);
    t
});

/// The 660-game table the one above replaced, kept so the replacement can be
/// checked by reversal rather than believed.
pub static MEASURED_VALUE_ALL_660: LazyLock<[Option<f64>; UNIT_COUNT]> = LazyLock::new(|| {
    let mut t = [None; UNIT_COUNT];
    let mut set = |u: UnitId, v: f64| t[u as usize] = Some(v);
    set(UnitId::LightCavalry, 0.7);
    set(UnitId::Skirmisher, 0.606);
    set(UnitId::Bannerman, 0.594);
    set(UnitId::Mercenary, 0.586);
    set(UnitId::Pikeman, 0.582);
    set(UnitId::Herald, 0.544);
    set(UnitId::Scout, 0.542);
    set(UnitId::Earl, 0.538);
    set(UnitId::Cavalry, 0.518);
    set(UnitId::WarriorPriest, 0.513);
    set(UnitId::Infiltrator, 0.51);
    set(UnitId::RoyalGuard, 0.5);
    set(UnitId::Knight, 0.5);
    set(UnitId::SiegeTower, 0.494);
    set(UnitId::WarWagon, 0.492);
    set(UnitId::Bishop, 0.484);
    set(UnitId::Marshal, 0.469);
    set(UnitId::Archer, 0.465);
    set(UnitId::Ensign, 0.462);
    set(UnitId::Lancer, 0.459);
    set(UnitId::Trebuchet, 0.456);
    set(UnitId::Berserker, 0.449);
    set(UnitId::Crossbowman, 0.445);
    set(UnitId::Assassin, 0.44);
    set(UnitId::Sapper, 0.436);
    set(UnitId::Saboteur, 0.424);
    set(UnitId::Swordsman, 0.423);
    set(UnitId::Footman, 0.39);
    t
});

/// One table for the evaluation: the base-game number where there is one, the
/// 28-unit number otherwise.
///
/// The two disagree, and the reason is real — a unit drawn from a pool of 28
/// faces different company than one drawn from 16, which is why the draft keeps
/// both and picks by the pool it is looking at. The evaluation cannot do that:
/// it would mean a Knight being worth one thing on Monday and another on Tuesday
/// because a Siege box was opened, and every weight fitted against it would be
/// fitted against a moving number.
static MERGED: LazyLock<[f64; UNIT_COUNT]> = LazyLock::new(|| {
    let mut t = [0.5; UNIT_COUNT];
    for unit in UNIT_IDS {
        t[unit as usize] = MEASURED_VALUE[unit as usize]
            .or(MEASURED_VALUE_ALL[unit as usize])
            .unwrap_or(0.5);
    }
    t
});

/// A unit's strength on the scale the evaluation speaks: zero for an average
/// unit, about ±1 at the ends of the table.
///
/// The raw numbers are win rates around 0.5 with a spread of nine points either
/// way, so used directly they would need a weight ten times any other to say
/// anything. Dividing by the table's own half-spread puts the strongest unit
/// near +1 and the weakest near −1 — the same [−1, 1] every other feature lives
/// on. The divisor is computed from the table rather than written down, so
/// re-measuring the table cannot silently rescale the weight.
pub static UNIT_WORTH: LazyLock<[f64; UNIT_COUNT]> = LazyLock::new(|| {
    let values = &*MERGED;
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let half = (max - min) / 2.0;
    let scale = if half < 1e-6 { 1.0 } else { half };
    let mut t = [0.0; UNIT_COUNT];
    for unit in UNIT_IDS {
        t[unit as usize] = (values[unit as usize] - 0.5) / scale;
    }
    t
});

#[inline]
pub fn unit_worth(unit: UnitId) -> f64 {
    UNIT_WORTH[unit as usize]
}

/// A unit the table does not cover counts as average, not as worthless: a
/// missing measurement is not a measurement of zero.
#[inline]
pub fn measured(table: &[Option<f64>; UNIT_COUNT], unit: UnitId) -> f64 {
    table[unit as usize].unwrap_or(0.5)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The divisor is half the table's own spread, so the *span* is exactly two.
    /// Where that span sits is not symmetric and is not meant to be: the table's
    /// mean is a little above 0.5, so the top ends up further from zero than the
    /// bottom. The two numbers below are the TypeScript implementation's, to six
    /// places — this table is the one place the port could have drifted without
    /// any test noticing.
    #[test]
    fn the_scale_is_the_tables_own_spread() {
        let worth = &*UNIT_WORTH;
        let max = worth.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let min = worth.iter().copied().fold(f64::INFINITY, f64::min);
        assert!((max - min - 2.0).abs() < 1e-9, "span is {}", max - min);
        assert!((unit_worth(UnitId::Skirmisher) - 1.167464).abs() < 1e-6);
        assert!((unit_worth(UnitId::Footman) + 0.832536).abs() < 1e-6);
    }

    #[test]
    fn the_light_cavalry_leads_and_the_footman_trails() {
        assert!(unit_worth(UnitId::LightCavalry) > unit_worth(UnitId::Knight));
        assert!(unit_worth(UnitId::Footman) < unit_worth(UnitId::Knight));
    }
}
