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
            }),
        );
    }
    Value::Object(out)
}

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
