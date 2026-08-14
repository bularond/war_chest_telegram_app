//! The wire shape: everything here reads and writes the exact JSON the
//! TypeScript engine used, hex ids as `"col,row"` and all.
//!
//! It exists for three callers — the conformance harness that compares the two
//! engines, the Node binding, and the browser build — and for none of them is it
//! on a hot path. Correctness of the shape is the whole job.

use crate::board::{id_of, index_of_id, HexIdx, NONE};
use crate::decrees::{DecreeId, DecreeInPlay};
use crate::rng::Rng;
use crate::types::*;
use crate::units::*;
use crate::view::{GameView, PlayerView};
use crate::units::UNIT_COUNT;
use arrayvec::ArrayVec;
use serde_json::{json, Map, Value};
use std::sync::Arc;

type Obj = Map<String, Value>;

fn obj() -> Obj {
    Map::new()
}

fn hex(h: HexIdx) -> Value {
    Value::String(id_of(h))
}

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

pub fn state_to_json(state: &GameState) -> Value {
    let mut out = obj();
    out.insert("id".into(), json!(state.id.as_ref()));
    out.insert("size".into(), json!(state.size.seats()));
    out.insert("phase".into(), json!(state.phase.key()));
    out.insert("round".into(), json!(state.round));
    out.insert("turn".into(), json!(state.turn));
    out.insert(
        "players".into(),
        Value::Array(
            state
                .players
                .iter()
                .map(|p| player_to_json(p, state.seats.get(p.seat as usize)))
                .collect(),
        ),
    );
    out.insert("units".into(), Value::Object(units_to_json(&state.units)));
    out.insert("control".into(), Value::Object(control_to_json(&state.control)));
    out.insert("initiative".into(), json!(state.initiative));
    out.insert("initiativeMovedThisRound".into(), json!(state.initiative_moved_this_round));
    out.insert("pending".into(), Value::Array(state.pending.iter().map(step_to_json).collect()));
    out.insert("draftMode".into(), json!(state.draft_mode.key()));
    out.insert("sets".into(), json!(sets_to_json(state.sets)));
    out.insert(
        "decrees".into(),
        Value::Array(state.decrees.iter().map(decree_to_json).collect()),
    );
    out.insert("forts".into(), Value::Object(forts_to_json(&state.forts)));
    out.insert("fortSupply".into(), json!(state.fort_supply));
    out.insert("draftPool".into(), json!(units_to_keys(&state.draft_pool)));
    out.insert("banned".into(), json!(units_to_keys(&state.banned)));
    out.insert("log".into(), Value::Array(state.log.entries.iter().map(log_to_json).collect()));
    out.insert("winner".into(), match state.winner {
        Some(t) => json!(t),
        None => Value::Null,
    });
    out.insert("rng".into(), json!({ "seed": state.rng.seed }));
    Value::Object(out)
}

fn sets_to_json(sets: SetMask) -> Vec<&'static str> {
    // Base first, then the rest in catalog order — `create_game` puts base at
    // the front and the mask has no order of its own.
    let mut out = vec![UnitSet::Base.key()];
    for set in [UnitSet::Nobility, UnitSet::Siege, UnitSet::Nightfall] {
        if sets.has(set) {
            out.push(set.key());
        }
    }
    out
}

fn units_to_keys(units: &[UnitId]) -> Vec<&'static str> {
    units.iter().map(|u| u.key()).collect()
}

/// Counts as a `Partial<Record<UnitId, number>>`, zeros dropped. Nothing reads a
/// zero differently from an absent key — every reader is `?? 0`.
fn counts_to_json(counts: &[u8; UNIT_COUNT], order: &[UnitId]) -> Obj {
    let mut out = obj();
    // Drafted units first, in pick order, so the shape matches what `equipPlayer`
    // builds; then anything else that picked up a count.
    for unit in order {
        if counts[*unit as usize] > 0 {
            out.insert(unit.key().into(), json!(counts[*unit as usize]));
        }
    }
    for unit in UNIT_IDS {
        if counts[unit as usize] > 0 && !order.contains(&unit) {
            out.insert(unit.key().into(), json!(counts[unit as usize]));
        }
    }
    out
}

fn player_to_json(p: &PlayerState, info: Option<&SeatInfo>) -> Value {
    let mut out = obj();
    out.insert("seat".into(), json!(p.seat));
    out.insert("team".into(), json!(p.team));
    out.insert("userId".into(), json!(info.map(|i| i.user_id.as_str()).unwrap_or("")));
    out.insert("displayName".into(), json!(info.map(|i| i.display_name.as_str()).unwrap_or("")));
    out.insert(
        "avatarUrl".into(),
        match info.and_then(|i| i.avatar_url.as_deref()) {
            Some(url) => json!(url),
            None => Value::Null,
        },
    );
    if let Some(bot) = info.and_then(|i| i.bot.as_deref()) {
        out.insert("bot".into(), json!(bot));
    }
    out.insert("units".into(), json!(units_to_keys(&p.units)));
    out.insert("bag".into(), json!(coins_to_keys(&p.bag)));
    out.insert("hand".into(), json!(coins_to_keys(&p.hand)));
    out.insert(
        "discard".into(),
        Value::Array(
            p.discard
                .iter()
                .map(|d| json!({ "coin": d.coin.key(), "faceUp": d.face_up }))
                .collect(),
        ),
    );
    out.insert("supply".into(), Value::Object(counts_to_json(&p.supply, &p.units)));
    out.insert("removed".into(), Value::Object(counts_to_json(&p.removed, &p.units)));
    out.insert("seals".into(), json!(p.seals));
    out.insert("hasInitiative".into(), json!(p.has_initiative));
    Value::Object(out)
}

fn coins_to_keys(coins: &[CoinId]) -> Vec<&'static str> {
    coins.iter().map(|c| c.key()).collect()
}

fn units_to_json(board: &Board) -> Obj {
    let mut out = obj();
    for (h, stack) in board.iter() {
        let mut s = obj();
        s.insert("unit".into(), json!(stack.unit.key()));
        s.insert("team".into(), json!(stack.team));
        s.insert("seat".into(), json!(stack.seat));
        s.insert("coins".into(), json!(stack.coins));
        if let Some(p) = stack.poisoned_by.key() {
            s.insert("poisonedBy".into(), json!(p));
        }
        out.insert(id_of(h), Value::Object(s));
    }
    out
}

fn control_to_json(control: &ControlMap) -> Obj {
    let mut out = obj();
    for (i, team) in control.iter().enumerate() {
        if *team != NO_SEAT {
            out.insert(id_of(i as HexIdx), json!(team));
        }
    }
    out
}

fn forts_to_json(forts: &[bool; crate::board::HEX_COUNT]) -> Obj {
    let mut out = obj();
    for (i, f) in forts.iter().enumerate() {
        if *f {
            out.insert(id_of(i as HexIdx), json!(true));
        }
    }
    out
}

fn decree_to_json(d: &DecreeInPlay) -> Value {
    json!({ "id": d.id.key(), "seals": d.seals.iter().copied().collect::<Vec<u8>>() })
}

pub fn step_to_json(step: &PendingStep) -> Value {
    match step {
        PendingStep::OptionalMove { hex: h, source } => {
            json!({ "kind": "optionalMove", "hex": id_of(*h), "source": source.key() })
        }
        PendingStep::OptionalRepeat { hex: h } => {
            json!({ "kind": "optionalRepeat", "hex": id_of(*h), "source": "berserker" })
        }
        PendingStep::MustUseCoin { coin } => json!({
            "kind": "mustUseCoin",
            "coin": match coin { Some(c) => json!(c.key()), None => Value::Null },
            "source": "warriorPriest",
        }),
        PendingStep::ManeuverUnit { hex: h, source, optional } => json!({
            "kind": "maneuverUnit",
            "hex": id_of(*h),
            "source": source.key(),
            "optional": optional,
        }),
        PendingStep::GrantManeuver { attack, origin, range, source } => json!({
            "kind": "grantManeuver",
            "maneuver": if *attack { "attack" } else { "move" },
            "origin": id_of(*origin),
            "range": range,
            "source": source.key(),
        }),
        PendingStep::DecreeAttack { costs_coin, from_own_location } => json!({
            "kind": "decreeAttack",
            "costsCoin": costs_coin,
            "fromOwnLocation": from_own_location,
        }),
        PendingStep::DecreeMove { require_bolstered } => {
            json!({ "kind": "decreeMove", "requireBolstered": require_bolstered })
        }
        PendingStep::DecreeRecruit { source } => {
            json!({ "kind": "decreeRecruit", "source": source.key() })
        }
        PendingStep::DecreeLift => json!({ "kind": "decreeLift" }),
        PendingStep::DecreePlace { unit, coins, from, poisoned_by } => {
            let mut out = obj();
            out.insert("kind".into(), json!("decreePlace"));
            out.insert("unit".into(), json!(unit.key()));
            out.insert("coins".into(), json!(coins));
            out.insert("from".into(), hex(*from));
            // Absent unless there is a counter on it, the way a stack on the
            // board carries the field only when it is poisoned.
            if let Some(p) = poisoned_by.key() {
                out.insert("poisonedBy".into(), json!(p));
            }
            Value::Object(out)
        }
        PendingStep::DecreeSpy { target } => json!({ "kind": "decreeSpy", "target": target }),
        PendingStep::DecreeReinforce => json!({ "kind": "decreeReinforce" }),
        PendingStep::HeraldBolster { origin } => {
            json!({ "kind": "heraldBolster", "origin": id_of(*origin) })
        }
        PendingStep::ShoveEnemy { origin } => {
            json!({ "kind": "shoveEnemy", "origin": id_of(*origin) })
        }
        PendingStep::ManeuverUnitLimited { hex: h, allow_move, allow_attack } => {
            let mut allow: Vec<&str> = Vec::new();
            if *allow_move {
                allow.push("move");
            }
            if *allow_attack {
                allow.push("attack");
            }
            json!({ "kind": "maneuverUnitLimited", "hex": id_of(*h), "allow": allow })
        }
        PendingStep::FreeTactic { unit } => {
            json!({ "kind": "freeTactic", "unit": unit.key(), "source": "saboteur" })
        }
        PendingStep::Proclaim { free } => json!({ "kind": "proclaim", "free": free }),
        PendingStep::BurnSupply { unit, owner } => {
            json!({ "kind": "burnSupply", "unit": unit.key(), "owner": owner })
        }
        PendingStep::Deceive { decoy } => json!({ "kind": "deceive", "decoy": decoy.key() }),
        PendingStep::BolsterSelf { hex: h } => {
            json!({ "kind": "bolsterSelf", "hex": id_of(*h) })
        }
        PendingStep::BuildFort { hex: h, seat } => {
            json!({ "kind": "buildFort", "hex": id_of(*h), "seat": seat })
        }
        PendingStep::AbsorbHit { seat, target, by_hex, by_unit, by_seat, options } => {
            let mut opts: Vec<Value> = Vec::new();
            if options.supply {
                opts.push(json!({ "from": "supply" }));
            }
            for w in &options.wagons {
                opts.push(json!({ "from": "wagon", "hex": id_of(*w) }));
            }
            if options.decoy {
                opts.push(json!({ "from": "decoy" }));
            }
            json!({
                "kind": "absorbHit",
                "seat": seat,
                "target": id_of(*target),
                "by": { "hex": id_of(*by_hex), "unit": by_unit.key(), "seat": by_seat },
                "options": opts,
            })
        }
    }
}

fn log_to_json(entry: &LogEntry) -> Value {
    let mut params = obj();
    let unit = || UnitId::from_idx(entry.unit as usize).map(|u| u.key()).unwrap_or("");
    match entry.kind {
        LogKind::Ban | LogKind::Draft | LogKind::Unpoison | LogKind::Recruit | LogKind::Tactic
        | LogKind::Poison | LogKind::Lift | LogKind::Reinforce | LogKind::Burn
        | LogKind::Absorb => {
            params.insert("unit".into(), json!(unit()));
        }
        LogKind::Deploy | LogKind::Bolster => {
            params.insert("unit".into(), json!(unit()));
            params.insert("hex".into(), hex(entry.hex));
        }
        LogKind::Move => {
            params.insert("from".into(), hex(entry.from));
            params.insert("to".into(), hex(entry.to));
            params.insert("unit".into(), json!(unit()));
        }
        LogKind::Control => {
            params.insert("hex".into(), hex(entry.hex));
            if entry.unit != NONE {
                params.insert("unit".into(), json!(unit()));
            }
        }
        LogKind::Attack => {
            params.insert("unit".into(), json!(unit()));
            params.insert(
                "target".into(),
                json!(UnitId::from_idx(entry.target_unit as usize)
                    .map(|u| u.key())
                    .unwrap_or("")),
            );
            params.insert("from".into(), hex(entry.from));
            params.insert("hex".into(), hex(entry.hex));
        }
        LogKind::Proclaim => {
            params.insert(
                "decree".into(),
                json!(DecreeId::from_idx(entry.decree as usize).map(|d| d.key()).unwrap_or("")),
            );
        }
        LogKind::Victory => {
            params.insert("team".into(), json!(entry.team));
        }
        LogKind::RazeFort | LogKind::BuildFort | LogKind::BerserkerRepeat => {
            params.insert("hex".into(), hex(entry.hex));
        }
        LogKind::Push | LogKind::Shove => {
            params.insert("from".into(), hex(entry.from));
            params.insert("to".into(), hex(entry.to));
        }
        LogKind::Spy => {
            params.insert("coin".into(), json!(CoinId(entry.coin).key()));
        }
        LogKind::RoundStart
        | LogKind::Pass
        | LogKind::ReturnDecoy
        | LogKind::ClaimInitiative
        | LogKind::Sacrifice
        | LogKind::Deceive
        | LogKind::AbsorbWagon
        | LogKind::Stalemate => {}
    }
    json!({
        "round": entry.round,
        "seat": entry.seat,
        "kind": entry.kind.key(),
        "params": Value::Object(params),
    })
}

pub fn action_to_json(action: Action) -> Value {
    let mut out = obj();
    out.insert("type".into(), json!(action.kind.key()));
    if action.coin != NONE {
        out.insert("coin".into(), json!(action.coin));
    }
    let unit = || {
        json!(UnitId::from_idx(action.arg as usize).map(|u| u.key()).unwrap_or(""))
    };
    use ActionKind::*;
    match action.kind {
        Deploy => {
            out.insert("to".into(), hex(action.to));
        }
        Bolster | Control => {
            out.insert("at".into(), hex(action.from));
        }
        ClaimInitiative | Pass | Unpoison | ReturnDecoy | Skip => {}
        Recruit | FollowRecruit | FollowReinforce | FollowBurn | Draft | Ban => {
            out.insert("unit".into(), unit());
        }
        Move | Attack | FollowMove | FollowAttack | FollowShove => {
            out.insert("from".into(), hex(action.from));
            out.insert("to".into(), hex(action.to));
        }
        Proclaim | FollowProclaim => {
            out.insert(
                "decree".into(),
                json!(DecreeId::from_idx(action.arg as usize).map(|d| d.key()).unwrap_or("")),
            );
        }
        Tactic | FollowTactic => {
            out.insert("from".into(), hex(action.from));
            if action.to != NONE {
                out.insert("to".into(), hex(action.to));
            }
            if action.target != NONE {
                out.insert("target".into(), hex(action.target));
            }
            if action.subject != NONE {
                out.insert("subject".into(), hex(action.subject));
            }
        }
        FollowControl => {
            out.insert("at".into(), hex(action.from));
        }
        FollowRepeat | FollowLift | FollowBolster | FollowBuildFort => {
            out.insert("hex".into(), hex(action.from));
        }
        FollowPlace => {
            out.insert("to".into(), hex(action.to));
        }
        FollowSpy => {
            out.insert("index".into(), json!(action.arg));
        }
        FollowAbsorb => {
            let source = match action.arg {
                x if x == AbsorbSource::Supply as u8 => "supply",
                x if x == AbsorbSource::Wagon as u8 => "wagon",
                _ => "decoy",
            };
            out.insert("source".into(), json!(source));
            if action.from != NONE {
                out.insert("hex".into(), hex(action.from));
            }
        }
        FollowDeceive => {
            out.insert("seat".into(), json!(action.arg));
        }
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// In
// ---------------------------------------------------------------------------

fn as_hex(v: Option<&Value>) -> HexIdx {
    match v.and_then(Value::as_str) {
        Some(s) => index_of_id(s),
        None => NONE,
    }
}

pub fn action_from_json(v: &Value) -> Result<Action, String> {
    let kind = ActionKind::from_key(v.get("type").and_then(Value::as_str).unwrap_or(""))
        .ok_or_else(|| format!("unknown action type in {v}"))?;
    let mut action = Action::bare(kind);
    if let Some(coin) = v.get("coin").and_then(Value::as_u64) {
        action.coin = coin as u8;
    }
    // `from`, `at` and `hex` share a slot, and no action carries two of them.
    for key in ["from", "at", "hex"] {
        let h = as_hex(v.get(key));
        if h != NONE {
            action.from = h;
        }
    }
    action.to = as_hex(v.get("to"));
    action.target = as_hex(v.get("target"));
    action.subject = as_hex(v.get("subject"));

    if let Some(unit) = v.get("unit").and_then(Value::as_str) {
        action.arg = UnitId::from_key(unit).ok_or_else(|| format!("unknown unit {unit}"))? as u8;
    }
    if let Some(decree) = v.get("decree").and_then(Value::as_str) {
        action.arg =
            DecreeId::from_key(decree).ok_or_else(|| format!("unknown decree {decree}"))? as u8;
    }
    if let Some(index) = v.get("index").and_then(Value::as_u64) {
        action.arg = index as u8;
    }
    if let Some(seat) = v.get("seat").and_then(Value::as_u64) {
        action.arg = seat as u8;
    }
    if let Some(source) = v.get("source").and_then(Value::as_str) {
        action.arg = match source {
            "supply" => AbsorbSource::Supply as u8,
            "wagon" => AbsorbSource::Wagon as u8,
            _ => AbsorbSource::Decoy as u8,
        };
    }
    Ok(action)
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

pub fn view_to_json(view: &GameView) -> Value {
    let mut out = obj();
    out.insert("id".into(), json!(view.id.as_ref()));
    out.insert("size".into(), json!(view.size.seats()));
    out.insert("phase".into(), json!(view.phase.key()));
    out.insert("round".into(), json!(view.round));
    out.insert("turn".into(), json!(view.turn));
    out.insert("acting".into(), json!(view.acting));
    out.insert("you".into(), json!(view.you));
    out.insert(
        "players".into(),
        Value::Array(
            view.players
                .iter()
                .map(|p| player_view_to_json(p, view.seats.get(p.seat as usize)))
                .collect(),
        ),
    );
    out.insert("units".into(), Value::Object(units_to_json(&view.units)));
    out.insert("control".into(), Value::Object(control_to_json(&view.control)));
    out.insert("pending".into(), Value::Array(view.pending.iter().map(step_to_json).collect()));
    out.insert("initiativeMovedThisRound".into(), json!(view.initiative_moved_this_round));
    out.insert("decrees".into(), Value::Array(view.decrees.iter().map(decree_to_json).collect()));
    out.insert("forts".into(), Value::Object(forts_to_json(&view.forts)));
    out.insert("fortSupply".into(), json!(view.fort_supply));
    out.insert("draftMode".into(), json!(view.draft_mode.key()));
    out.insert("sets".into(), json!(sets_to_json(view.sets)));
    out.insert("draftPool".into(), json!(units_to_keys(&view.draft_pool)));
    out.insert("banned".into(), json!(units_to_keys(&view.banned)));
    out.insert("log".into(), Value::Array(view.log.iter().map(log_to_json).collect()));
    out.insert("winner".into(), match view.winner {
        Some(t) => json!(t),
        None => Value::Null,
    });
    out.insert(
        "legal".into(),
        Value::Array(view.legal.iter().map(|a| action_to_json(*a)).collect()),
    );
    Value::Object(out)
}

fn player_view_to_json(p: &PlayerView, info: Option<&SeatInfo>) -> Value {
    let mut out = obj();
    out.insert("seat".into(), json!(p.seat));
    out.insert("team".into(), json!(p.team));
    out.insert("userId".into(), json!(info.map(|i| i.user_id.as_str()).unwrap_or("")));
    out.insert("displayName".into(), json!(info.map(|i| i.display_name.as_str()).unwrap_or("")));
    out.insert(
        "avatarUrl".into(),
        match info.and_then(|i| i.avatar_url.as_deref()) {
            Some(url) => json!(url),
            None => Value::Null,
        },
    );
    if let Some(bot) = info.and_then(|i| i.bot.as_deref()) {
        out.insert("bot".into(), json!(bot));
    }
    out.insert("units".into(), json!(units_to_keys(&p.units)));
    out.insert("bagCount".into(), json!(p.bag_count));
    out.insert("handCount".into(), json!(p.hand_count));
    if let Some(hand) = &p.hand {
        out.insert("hand".into(), json!(coins_to_keys(hand)));
    }
    if let Some(bag) = &p.bag {
        out.insert("bag".into(), json!(coins_to_keys(bag)));
    }
    out.insert(
        "discard".into(),
        Value::Array(
            p.discard
                .iter()
                .map(|(coin, face_up)| {
                    json!({
                        "coin": match coin { Some(c) => json!(c.key()), None => Value::Null },
                        "faceUp": face_up,
                    })
                })
                .collect(),
        ),
    );
    out.insert("supply".into(), Value::Object(counts_to_json(&p.supply, &p.units)));
    out.insert("removed".into(), Value::Object(counts_to_json(&p.removed, &p.units)));
    out.insert("seals".into(), json!(p.seals));
    out.insert("markersRemaining".into(), json!(p.markers_remaining));
    out.insert("hasInitiative".into(), json!(p.has_initiative));
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// Reading a whole state back
// ---------------------------------------------------------------------------

/// Parses a `GameState` in the TypeScript shape. Used by the conformance harness
/// to start the Rust engine from a position TypeScript built.
pub fn state_from_json(v: &Value) -> Result<GameState, String> {
    let size = crate::board::BoardSize::from_seats(
        v.get("size").and_then(Value::as_u64).unwrap_or(2) as usize,
    )
    .ok_or("bad board size")?;
    let mut sets = SetMask::base();
    if let Some(list) = v.get("sets").and_then(Value::as_array) {
        for s in list {
            if let Some(set) = s.as_str().and_then(UnitSet::from_key) {
                sets = sets.with(set);
            }
        }
    }

    let mut players: ArrayVec<PlayerState, MAX_SEATS> = ArrayVec::new();
    let mut seats: Vec<SeatInfo> = Vec::new();
    for p in v.get("players").and_then(Value::as_array).ok_or("no players")? {
        let seat = p.get("seat").and_then(Value::as_u64).unwrap_or(0) as Seat;
        let team = p.get("team").and_then(Value::as_u64).unwrap_or(0) as Team;
        let mut player = PlayerState::new(seat, team);
        for u in p.get("units").and_then(Value::as_array).into_iter().flatten() {
            if let Some(unit) = u.as_str().and_then(UnitId::from_key) {
                player.units.push(unit);
            }
        }
        for c in p.get("bag").and_then(Value::as_array).into_iter().flatten() {
            player.bag.push(coin_of(c)?);
        }
        for c in p.get("hand").and_then(Value::as_array).into_iter().flatten() {
            player.hand.push(coin_of(c)?);
        }
        for d in p.get("discard").and_then(Value::as_array).into_iter().flatten() {
            player.discard.push(DiscardEntry {
                coin: coin_of(d.get("coin").ok_or("discard without a coin")?)?,
                face_up: d.get("faceUp").and_then(Value::as_bool).unwrap_or(false),
            });
        }
        read_counts(p.get("supply"), &mut player.supply)?;
        read_counts(p.get("removed"), &mut player.removed)?;
        player.seals = p.get("seals").and_then(Value::as_u64).unwrap_or(0) as u8;
        player.has_initiative =
            p.get("hasInitiative").and_then(Value::as_bool).unwrap_or(false);
        players.push(player);
        seats.push(SeatInfo {
            user_id: p.get("userId").and_then(Value::as_str).unwrap_or("").into(),
            display_name: p.get("displayName").and_then(Value::as_str).unwrap_or("").into(),
            avatar_url: p.get("avatarUrl").and_then(Value::as_str).map(str::to_owned),
            bot: p.get("bot").and_then(Value::as_str).map(str::to_owned),
        });
    }

    let mut units = Board::new();
    if let Some(map) = v.get("units").and_then(Value::as_object) {
        for (id, s) in map {
            units.insert(
                index_of_id(id),
                UnitStack {
                    unit: s
                        .get("unit")
                        .and_then(Value::as_str)
                        .and_then(UnitId::from_key)
                        .ok_or("bad unit")?,
                    team: s.get("team").and_then(Value::as_u64).unwrap_or(0) as Team,
                    seat: s.get("seat").and_then(Value::as_u64).unwrap_or(0) as Seat,
                    coins: s.get("coins").and_then(Value::as_u64).unwrap_or(1) as u8,
                    poisoned_by: match s.get("poisonedBy").and_then(Value::as_str) {
                        Some("assassin") => Poison::Assassin,
                        Some("saboteur") => Poison::Saboteur,
                        _ => Poison::None,
                    },
                },
            );
        }
    }

    let mut control = [NO_SEAT; crate::board::HEX_COUNT];
    if let Some(map) = v.get("control").and_then(Value::as_object) {
        for (id, team) in map {
            control[index_of_id(id) as usize] = team.as_u64().unwrap_or(0) as u8;
        }
    }
    let mut forts = [false; crate::board::HEX_COUNT];
    if let Some(map) = v.get("forts").and_then(Value::as_object) {
        for (id, _) in map {
            forts[index_of_id(id) as usize] = true;
        }
    }

    let mut decrees: ArrayVec<DecreeInPlay, 4> = ArrayVec::new();
    for d in v.get("decrees").and_then(Value::as_array).into_iter().flatten() {
        let id = d
            .get("id")
            .and_then(Value::as_str)
            .and_then(DecreeId::from_key)
            .ok_or("bad decree")?;
        let mut card = DecreeInPlay::new(id);
        for t in d.get("seals").and_then(Value::as_array).into_iter().flatten() {
            card.add_seal(t.as_u64().unwrap_or(0) as u8);
        }
        decrees.push(card);
    }

    let mut pending = Vec::new();
    for s in v.get("pending").and_then(Value::as_array).into_iter().flatten() {
        pending.push(step_from_json(s)?);
    }

    Ok(GameState {
        id: Arc::from(v.get("id").and_then(Value::as_str).unwrap_or("")),
        size,
        phase: Phase::from_key(v.get("phase").and_then(Value::as_str).unwrap_or("playing"))
            .ok_or("bad phase")?,
        round: v.get("round").and_then(Value::as_u64).unwrap_or(0) as u16,
        turn: v.get("turn").and_then(Value::as_u64).unwrap_or(0) as Seat,
        players,
        seats: Arc::new(seats),
        units,
        control,
        initiative: v.get("initiative").and_then(Value::as_u64).unwrap_or(0) as Seat,
        initiative_moved_this_round: v
            .get("initiativeMovedThisRound")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pending,
        draft_mode: DraftMode::from_key(
            v.get("draftMode").and_then(Value::as_str).unwrap_or("draft"),
        )
        .ok_or("bad draft mode")?,
        sets,
        decrees,
        forts,
        fort_supply: v.get("fortSupply").and_then(Value::as_u64).unwrap_or(0) as u8,
        draft_pool: read_units(v.get("draftPool")),
        banned: read_units(v.get("banned")),
        log: log_from_json(v.get("log")),
        winner: v.get("winner").and_then(Value::as_u64).map(|t| t as Team),
        rng: Rng::new(
            v.get("rng").and_then(|r| r.get("seed")).and_then(Value::as_u64).unwrap_or(0) as u32,
        ),
    })
}

fn coin_of(v: &Value) -> Result<CoinId, String> {
    v.as_str().and_then(CoinId::from_key).ok_or_else(|| format!("unknown coin {v}"))
}

fn read_units(v: Option<&Value>) -> Vec<UnitId> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|u| u.as_str().and_then(UnitId::from_key)).collect())
        .unwrap_or_default()
}

fn read_counts(v: Option<&Value>, into: &mut [u8; UNIT_COUNT]) -> Result<(), String> {
    if let Some(map) = v.and_then(Value::as_object) {
        for (key, n) in map {
            let unit = UnitId::from_key(key).ok_or_else(|| format!("unknown unit {key}"))?;
            into[unit as usize] = n.as_u64().unwrap_or(0) as u8;
        }
    }
    Ok(())
}

pub fn step_from_json(v: &Value) -> Result<PendingStep, String> {
    let kind = v.get("kind").and_then(Value::as_str).ok_or("step without a kind")?;
    let h = |key: &str| as_hex(v.get(key));
    let unit_of = |key: &str| -> Result<UnitId, String> {
        v.get(key)
            .and_then(Value::as_str)
            .and_then(UnitId::from_key)
            .ok_or_else(|| format!("step {kind} without a {key}"))
    };
    let source = |default: StepSource| -> StepSource {
        match v.get("source").and_then(Value::as_str) {
            Some("swordsman") => StepSource::Swordsman,
            Some("earl") => StepSource::Earl,
            Some("berserker") => StepSource::Berserker,
            Some("footman") => StepSource::Footman,
            Some("mercenary") => StepSource::Mercenary,
            Some("herald") => StepSource::Herald,
            Some("marshal") => StepSource::Marshal,
            Some("ensign") => StepSource::Ensign,
            Some("enlist") => StepSource::Enlist,
            Some("bishop") => StepSource::Bishop,
            Some("saboteur") => StepSource::Saboteur,
            _ => default,
        }
    };
    let flag = |key: &str| v.get(key).and_then(Value::as_bool).unwrap_or(false);
    let num = |key: &str| v.get(key).and_then(Value::as_u64).unwrap_or(0) as u8;

    Ok(match kind {
        "optionalMove" => {
            PendingStep::OptionalMove { hex: h("hex"), source: source(StepSource::Swordsman) }
        }
        "optionalRepeat" => PendingStep::OptionalRepeat { hex: h("hex") },
        "mustUseCoin" => PendingStep::MustUseCoin {
            coin: match v.get("coin") {
                Some(Value::String(s)) => Some(CoinId::from_key(s).ok_or("unknown coin")?),
                _ => None,
            },
        },
        "maneuverUnit" => PendingStep::ManeuverUnit {
            hex: h("hex"),
            source: source(StepSource::Footman),
            optional: flag("optional"),
        },
        "grantManeuver" => PendingStep::GrantManeuver {
            attack: v.get("maneuver").and_then(Value::as_str) == Some("attack"),
            origin: h("origin"),
            range: num("range"),
            source: source(StepSource::Marshal),
        },
        "decreeAttack" => PendingStep::DecreeAttack {
            costs_coin: flag("costsCoin"),
            from_own_location: flag("fromOwnLocation"),
        },
        "decreeMove" => PendingStep::DecreeMove { require_bolstered: flag("requireBolstered") },
        "decreeRecruit" => PendingStep::DecreeRecruit { source: source(StepSource::Enlist) },
        "decreeLift" => PendingStep::DecreeLift,
        "decreePlace" => PendingStep::DecreePlace {
            unit: unit_of("unit")?,
            coins: num("coins"),
            from: h("from"),
            poisoned_by: match v.get("poisonedBy").and_then(Value::as_str) {
                Some("assassin") => Poison::Assassin,
                Some("saboteur") => Poison::Saboteur,
                _ => Poison::None,
            },
        },
        "decreeSpy" => PendingStep::DecreeSpy { target: num("target") },
        "decreeReinforce" => PendingStep::DecreeReinforce,
        "heraldBolster" => PendingStep::HeraldBolster { origin: h("origin") },
        "shoveEnemy" => PendingStep::ShoveEnemy { origin: h("origin") },
        "maneuverUnitLimited" => {
            let allow: Vec<&str> = v
                .get("allow")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            PendingStep::ManeuverUnitLimited {
                hex: h("hex"),
                allow_move: allow.contains(&"move"),
                allow_attack: allow.contains(&"attack"),
            }
        }
        "freeTactic" => PendingStep::FreeTactic { unit: unit_of("unit")? },
        "proclaim" => PendingStep::Proclaim { free: flag("free") },
        "burnSupply" => {
            PendingStep::BurnSupply { unit: unit_of("unit")?, owner: num("owner") }
        }
        "deceive" => PendingStep::Deceive {
            decoy: v
                .get("decoy")
                .and_then(Value::as_str)
                .and_then(CoinId::from_key)
                .ok_or("bad decoy")?,
        },
        "bolsterSelf" => PendingStep::BolsterSelf { hex: h("hex") },
        "buildFort" => PendingStep::BuildFort { hex: h("hex"), seat: num("seat") },
        "absorbHit" => {
            let by = v.get("by").ok_or("absorbHit without an attacker")?;
            let mut options = AbsorbOptions::default();
            for o in v.get("options").and_then(Value::as_array).into_iter().flatten() {
                match o.get("from").and_then(Value::as_str) {
                    Some("supply") => options.supply = true,
                    Some("wagon") => options.wagons.push(as_hex(o.get("hex"))),
                    Some("decoy") => options.decoy = true,
                    _ => {}
                }
            }
            PendingStep::AbsorbHit {
                seat: num("seat"),
                target: h("target"),
                by_hex: as_hex(by.get("hex")),
                by_unit: by
                    .get("unit")
                    .and_then(Value::as_str)
                    .and_then(UnitId::from_key)
                    .ok_or("bad attacker")?,
                by_seat: by.get("seat").and_then(Value::as_u64).unwrap_or(0) as Seat,
                options,
            }
        }
        other => return Err(format!("unknown pending step {other}")),
    })
}

/// Parses a `GameView` in the TypeScript shape — the object the server sends a
/// player, and so the object a bot is handed.
///
/// The one field that has no counterpart is the log. What a bot reads out of it
/// is how recently each of its units maneuvered, and that is derived here rather
/// than carried, so a determinization never has to copy several hundred entries.
pub fn view_from_json(v: &Value) -> Result<GameView, String> {
    let size = crate::board::BoardSize::from_seats(
        v.get("size").and_then(Value::as_u64).unwrap_or(2) as usize,
    )
    .ok_or("bad board size")?;
    let mut sets = SetMask::base();
    for s in v.get("sets").and_then(Value::as_array).into_iter().flatten() {
        if let Some(set) = s.as_str().and_then(UnitSet::from_key) {
            sets = sets.with(set);
        }
    }

    let mut players: ArrayVec<PlayerView, MAX_SEATS> = ArrayVec::new();
    let mut seats: Vec<SeatInfo> = Vec::new();
    for p in v.get("players").and_then(Value::as_array).ok_or("no players")? {
        let mut units: ArrayVec<UnitId, MAX_UNITS> = ArrayVec::new();
        for u in p.get("units").and_then(Value::as_array).into_iter().flatten() {
            if let Some(unit) = u.as_str().and_then(UnitId::from_key) {
                units.push(unit);
            }
        }
        let hand = match p.get("hand").and_then(Value::as_array) {
            Some(list) => {
                let mut out: ArrayVec<CoinId, MAX_HAND> = ArrayVec::new();
                for c in list {
                    out.push(coin_of(c)?);
                }
                Some(out)
            }
            None => None,
        };
        let bag = match p.get("bag").and_then(Value::as_array) {
            Some(list) => {
                let mut out = Vec::with_capacity(list.len());
                for c in list {
                    out.push(coin_of(c)?);
                }
                Some(out)
            }
            None => None,
        };
        let mut discard = Vec::new();
        for d in p.get("discard").and_then(Value::as_array).into_iter().flatten() {
            let coin = match d.get("coin") {
                Some(Value::String(s)) => Some(CoinId::from_key(s).ok_or("unknown coin")?),
                _ => None,
            };
            discard.push((coin, d.get("faceUp").and_then(Value::as_bool).unwrap_or(false)));
        }
        let mut supply = [0u8; UNIT_COUNT];
        let mut removed = [0u8; UNIT_COUNT];
        read_counts(p.get("supply"), &mut supply)?;
        read_counts(p.get("removed"), &mut removed)?;

        seats.push(SeatInfo {
            user_id: p.get("userId").and_then(Value::as_str).unwrap_or("").into(),
            display_name: p.get("displayName").and_then(Value::as_str).unwrap_or("").into(),
            avatar_url: p.get("avatarUrl").and_then(Value::as_str).map(str::to_owned),
            bot: p.get("bot").and_then(Value::as_str).map(str::to_owned),
        });
        players.push(PlayerView {
            seat: p.get("seat").and_then(Value::as_u64).unwrap_or(0) as Seat,
            team: p.get("team").and_then(Value::as_u64).unwrap_or(0) as Team,
            units,
            bag_count: p.get("bagCount").and_then(Value::as_u64).unwrap_or(0) as u16,
            hand_count: p.get("handCount").and_then(Value::as_u64).unwrap_or(0) as u16,
            hand,
            bag,
            discard,
            supply,
            removed,
            seals: p.get("seals").and_then(Value::as_u64).unwrap_or(0) as u8,
            markers_remaining: p.get("markersRemaining").and_then(Value::as_i64).unwrap_or(0)
                as i32,
            has_initiative: p.get("hasInitiative").and_then(Value::as_bool).unwrap_or(false),
        });
    }

    let mut units = Board::new();
    if let Some(map) = v.get("units").and_then(Value::as_object) {
        for (id, s) in map {
            units.insert(
                index_of_id(id),
                UnitStack {
                    unit: s
                        .get("unit")
                        .and_then(Value::as_str)
                        .and_then(UnitId::from_key)
                        .ok_or("bad unit")?,
                    team: s.get("team").and_then(Value::as_u64).unwrap_or(0) as Team,
                    seat: s.get("seat").and_then(Value::as_u64).unwrap_or(0) as Seat,
                    coins: s.get("coins").and_then(Value::as_u64).unwrap_or(1) as u8,
                    poisoned_by: match s.get("poisonedBy").and_then(Value::as_str) {
                        Some("assassin") => Poison::Assassin,
                        Some("saboteur") => Poison::Saboteur,
                        _ => Poison::None,
                    },
                },
            );
        }
    }

    let mut control = [NO_SEAT; crate::board::HEX_COUNT];
    if let Some(map) = v.get("control").and_then(Value::as_object) {
        for (id, team) in map {
            control[index_of_id(id) as usize] = team.as_u64().unwrap_or(0) as u8;
        }
    }
    let mut forts = [false; crate::board::HEX_COUNT];
    if let Some(map) = v.get("forts").and_then(Value::as_object) {
        for (id, _) in map {
            forts[index_of_id(id) as usize] = true;
        }
    }

    let mut decrees: ArrayVec<DecreeInPlay, 4> = ArrayVec::new();
    for d in v.get("decrees").and_then(Value::as_array).into_iter().flatten() {
        let id = d
            .get("id")
            .and_then(Value::as_str)
            .and_then(DecreeId::from_key)
            .ok_or("bad decree")?;
        let mut card = DecreeInPlay::new(id);
        for t in d.get("seals").and_then(Value::as_array).into_iter().flatten() {
            card.add_seal(t.as_u64().unwrap_or(0) as u8);
        }
        decrees.push(card);
    }

    let mut pending = Vec::new();
    for s in v.get("pending").and_then(Value::as_array).into_iter().flatten() {
        pending.push(step_from_json(s)?);
    }

    let mut legal = Vec::new();
    for a in v.get("legal").and_then(Value::as_array).into_iter().flatten() {
        legal.push(action_from_json(a)?);
    }

    // A maneuver is one of three things: move, control, attack. The index is the
    // entry's position in the whole log, which is what "most recently" means.
    let log = log_from_json(v.get("log"));

    Ok(GameView {
        id: Arc::from(v.get("id").and_then(Value::as_str).unwrap_or("")),
        size,
        phase: Phase::from_key(v.get("phase").and_then(Value::as_str).unwrap_or("playing"))
            .ok_or("bad phase")?,
        round: v.get("round").and_then(Value::as_u64).unwrap_or(0) as u16,
        turn: v.get("turn").and_then(Value::as_u64).unwrap_or(0) as Seat,
        acting: v.get("acting").and_then(Value::as_u64).unwrap_or(0) as Seat,
        you: v.get("you").and_then(Value::as_u64).unwrap_or(0) as Seat,
        players,
        seats: Arc::new(seats),
        units,
        control,
        pending,
        initiative_moved_this_round: v
            .get("initiativeMovedThisRound")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        decrees,
        forts,
        fort_supply: v.get("fortSupply").and_then(Value::as_u64).unwrap_or(0) as u8,
        draft_mode: DraftMode::from_key(
            v.get("draftMode").and_then(Value::as_str).unwrap_or("draft"),
        )
        .ok_or("bad draft mode")?,
        sets,
        draft_pool: read_units(v.get("draftPool")),
        banned: read_units(v.get("banned")),
        last_maneuver: log.last_maneuver,
        log_length: log.length,
        log: log.entries,
        winner: v.get("winner").and_then(Value::as_u64).map(|t| t as Team),
        legal,
    })
}

/// The log, read back.
///
/// It has to survive the round trip: a caller that hands a state over, has one
/// action applied and takes it back is holding the same game, and a game
/// remembers what happened in it. Losing the log here showed up as a bot that
/// moved without anything appearing in the journal — the move was made, the
/// entry was written, and then the next round trip threw it away.
fn log_from_json(v: Option<&Value>) -> Log {
    let mut log = Log::new(true);
    let entries = match v.and_then(Value::as_array) {
        Some(list) => list,
        None => return log,
    };
    for entry in entries {
        let kind = match entry.get("kind").and_then(Value::as_str).and_then(log_kind) {
            Some(k) => k,
            // An entry this build does not know about still has to hold its
            // place: `maneuverRecency` counts positions in the whole log.
            None => {
                log.push(LogEntry::new(
                    entry.get("round").and_then(Value::as_u64).unwrap_or(0) as u16,
                    entry.get("seat").and_then(Value::as_u64).unwrap_or(0) as Seat,
                    LogKind::Pass,
                ));
                continue;
            }
        };
        let mut out = LogEntry::new(
            entry.get("round").and_then(Value::as_u64).unwrap_or(0) as u16,
            entry.get("seat").and_then(Value::as_u64).unwrap_or(0) as Seat,
            kind,
        );
        let params = entry.get("params");
        let text = |key: &str| params.and_then(|p| p.get(key)).and_then(Value::as_str);
        let number = |key: &str| params.and_then(|p| p.get(key)).and_then(Value::as_u64);
        if let Some(unit) = text("unit").and_then(UnitId::from_key) {
            out.unit = unit as u8;
        }
        if let Some(unit) = text("target").and_then(UnitId::from_key) {
            out.target_unit = unit as u8;
        }
        if let Some(hex) = text("hex") {
            out.hex = index_of_id(hex);
        }
        if let Some(hex) = text("from") {
            out.from = index_of_id(hex);
        }
        if let Some(hex) = text("to") {
            out.to = index_of_id(hex);
        }
        if let Some(decree) = text("decree").and_then(DecreeId::from_key) {
            out.decree = decree as u8;
        }
        if let Some(coin) = text("coin").and_then(CoinId::from_key) {
            out.coin = coin.0;
        }
        if let Some(team) = number("team") {
            out.team = team as u8;
        }
        log.push(out);
    }
    log
}

fn log_kind(key: &str) -> Option<LogKind> {
    Some(match key {
        "ban" => LogKind::Ban,
        "draft" => LogKind::Draft,
        "roundStart" => LogKind::RoundStart,
        "pass" => LogKind::Pass,
        "unpoison" => LogKind::Unpoison,
        "returnDecoy" => LogKind::ReturnDecoy,
        "claimInitiative" => LogKind::ClaimInitiative,
        "recruit" => LogKind::Recruit,
        "deploy" => LogKind::Deploy,
        "bolster" => LogKind::Bolster,
        "move" => LogKind::Move,
        "control" => LogKind::Control,
        "attack" => LogKind::Attack,
        "tactic" => LogKind::Tactic,
        "proclaim" => LogKind::Proclaim,
        "victory" => LogKind::Victory,
        "razeFort" => LogKind::RazeFort,
        "poison" => LogKind::Poison,
        "push" => LogKind::Push,
        "sacrifice" => LogKind::Sacrifice,
        "lift" => LogKind::Lift,
        "spy" => LogKind::Spy,
        "reinforce" => LogKind::Reinforce,
        "shove" => LogKind::Shove,
        "burn" => LogKind::Burn,
        "deceive" => LogKind::Deceive,
        "buildFort" => LogKind::BuildFort,
        "absorb" => LogKind::Absorb,
        "absorbWagon" => LogKind::AbsorbWagon,
        "berserkerRepeat" => LogKind::BerserkerRepeat,
        "stalemate" => LogKind::Stalemate,
        _ => return None,
    })
}
