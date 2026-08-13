//! The printed facts, as data anything can read.
//!
//! The client draws a board and a set of cards, and both are rules: how many
//! hexes there are, which of them are locations, how many coins of a unit the
//! box contains. Those numbers live in exactly one place — this crate — and this
//! module is how they leave it.
//!
//! What is *not* here is the card text and the art. Those are presentation, they
//! differ per language, and nothing in the rules reads them.

use crate::board::{board_for, hex_at, id_of, BoardSize};
use crate::decrees::DECREE_KEYS;
use crate::hex::pixel_center;
use crate::units::{Tactic, UNITS, UNIT_KEYS};
use serde_json::{json, Value};

pub fn catalog() -> Value {
    json!({
        "boards": {
            "2": board(BoardSize::Duel),
            "4": board(BoardSize::Team),
        },
        "units": units(),
        "decrees": DECREE_KEYS,
        // The half-turn that maps one side of the board onto the other, and the
        // two things built out of it: which locations each side is nearest, and
        // the Fortification Map Cards.
        "rotate180": board_for(BoardSize::Team)
            .hexes
            .iter()
            .map(|h| (id_of(*h), Value::from(id_of(crate::board::rotate180(*h)))))
            .collect::<serde_json::Map<_, _>>(),
        "duelLocationsBySide": crate::board::DUEL_LOCATIONS_BY_SIDE
            .iter()
            .map(|side| side.iter().map(|h| id_of(*h)).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        "fortificationLayouts": crate::board::FORTIFICATION_LAYOUTS
            .iter()
            .map(|layout| layout.iter().map(|h| id_of(*h)).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        "sets": crate::units::SET_KEYS,
        "coinsInBagPerUnit": crate::units::COINS_IN_BAG_PER_UNIT,
        "handSize": crate::setup::HAND_SIZE,
        "fortifications": {
            "total": crate::board::FORTIFICATIONS_TOTAL,
            "onBoard": crate::board::FORTIFICATIONS_ON_BOARD,
        },
    })
}

fn board(size: BoardSize) -> Value {
    let def = board_for(size);
    json!({
        "hexes": def.hexes.iter().map(|h| id_of(*h)).collect::<Vec<_>>(),
        "locations": def.locations.iter().map(|h| id_of(*h)).collect::<Vec<_>>(),
        "startingLocations": def
            .starting_locations
            .iter()
            .map(|team| team.iter().map(|h| id_of(*h)).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        "controlMarkers": def.control_markers,
        // The screen position of every hex centre at radius 1, so the client
        // scales rather than re-derives the geometry.
        "centres": def
            .hexes
            .iter()
            .map(|h| {
                let (x, y) = pixel_center(hex_at(*h), 1.0);
                json!({ "hex": id_of(*h), "x": x, "y": y })
            })
            .collect::<Vec<_>>(),
    })
}

fn units() -> Value {
    let mut out = serde_json::Map::new();
    for spec in UNITS.iter() {
        out.insert(
            UNIT_KEYS[spec.id as usize].into(),
            json!({
                "id": UNIT_KEYS[spec.id as usize],
                "set": spec.set.key(),
                "coins": spec.coins,
                "siegeTactic": spec.siege_tactic,
                "tactic": spec.tactic.map(tactic),
                "maxDeployed": crate::units::max_deployed(spec.id),
                "attributes": names(spec.attributes, &ATTRIBUTE_KEYS),
                "restrictions": names(spec.restrictions, &RESTRICTION_KEYS),
            }),
        );
    }
    Value::Object(out)
}

/// The set bits of a mask, as the names the cards are described by.
fn names(mask: u32, keys: &[&'static str]) -> Vec<&'static str> {
    keys.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, k)| *k).collect()
}

/// In bit order, which is what makes [`names`] a lookup rather than a match.
const ATTRIBUTE_KEYS: [&str; 19] = [
    "twoUnitsDeployed",
    "retaliate",
    "moveAfterAttack",
    "onlyAttackedByBolstered",
    "freeManeuverOnRecruit",
    "drawAndUseAfterControlOrAttack",
    "maneuverAgainForCoin",
    "deployNextToFriendly",
    "absorbHitFromSupply",
    "bolsterOnDeploy",
    "absorbHitForAlly",
    "shoveEnemyAfterManeuver",
    "moveAfterDeploy",
    "maneuverAfterProclaim",
    "buildFortOnMove",
    "burnSupplyAfterKillingPoisoned",
    "tacticOnRecruit",
    "deceiveAfterControl",
    "deceiveWhenAttacked",
];

const RESTRICTION_KEYS: [&str; 2] = ["noNormalAttack", "onlyAttackedByUnbolstered"];

/// The machine-readable half of a tactic — what the engine executes, which is
/// also what a client needs to explain a highlighted hex.
fn tactic(t: Tactic) -> Value {
    match t {
        Tactic::RangedAttack { min, max, straight_line, blocked } => json!({
            "kind": "rangedAttack", "min": min, "max": max,
            "straightLine": straight_line, "blocked": blocked,
        }),
        Tactic::ChargeAttack { min, max, straight_line } => json!({
            "kind": "chargeAttack", "min": min, "max": max, "straightLine": straight_line,
        }),
        Tactic::MultiMove { distance } => json!({ "kind": "multiMove", "distance": distance }),
        Tactic::GrantManeuver { attack, range } => json!({
            "kind": "grantManeuver",
            "maneuver": if attack { "attack" } else { "move" },
            "range": range,
        }),
        Tactic::ManeuverEachUnit => json!({ "kind": "maneuverEachUnit" }),
        Tactic::RoyalRedeploy { distance } => {
            json!({ "kind": "royalRedeploy", "distance": distance })
        }
        Tactic::BolsterAllyFromSupply => json!({ "kind": "bolsterAllyFromSupply" }),
        Tactic::ControlThenProclaim => json!({ "kind": "controlThenProclaim" }),
        Tactic::RecruitThenManeuver => json!({ "kind": "recruitThenManeuver" }),
        Tactic::AttackTwice => json!({ "kind": "attackTwice" }),
        Tactic::PushAlly => json!({ "kind": "pushAlly" }),
        Tactic::MoveThenAttackFort => json!({ "kind": "moveThenAttackFort" }),
        Tactic::MoveThenPoison => json!({ "kind": "moveThenPoison" }),
        Tactic::PoisonAtRange { min, max } => {
            json!({ "kind": "poisonAtRange", "min": min, "max": max })
        }
        Tactic::Infiltrate { distance } => json!({ "kind": "infiltrate", "distance": distance }),
        Tactic::Skirmish { distance } => json!({ "kind": "skirmish", "distance": distance }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names above are read out of a bit position, so a name added to the
    /// catalog in the wrong place would rename somebody else's attribute.
    #[test]
    fn every_attribute_a_card_has_is_named() {
        for spec in UNITS.iter() {
            let named = names(spec.attributes, &ATTRIBUTE_KEYS).len();
            assert_eq!(
                named,
                spec.attributes.count_ones() as usize,
                "{} has an attribute with no name",
                UNIT_KEYS[spec.id as usize]
            );
            let named = names(spec.restrictions, &RESTRICTION_KEYS).len();
            assert_eq!(named, spec.restrictions.count_ones() as usize);
        }
    }

    #[test]
    fn the_knight_is_only_attacked_by_bolstered_units() {
        let catalog = catalog();
        let knight = &catalog["units"]["knight"];
        assert_eq!(knight["attributes"][0], "onlyAttackedByBolstered");
        assert_eq!(catalog["units"]["archer"]["restrictions"][0], "noNormalAttack");
        assert_eq!(catalog["units"]["footman"]["maxDeployed"], 2);
    }
}
