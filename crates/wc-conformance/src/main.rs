//! The Rust engine behind a pipe, so the TypeScript one can be played against it
//! move for move.
//!
//! Both engines are told to create the same game from the same seed and then
//! advanced in lockstep: TypeScript picks the action, sends it here, and after
//! every ply the two positions and the two legal-move lists are compared. Every
//! so often the harness also asks for the successor of *every* legal action, so
//! that rules only reachable by a move nobody played are covered too.
//!
//! One line of JSON in, one line of JSON out. Nothing here is on a hot path.

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};
use wc_core::board::BoardSize;
use wc_core::engine::{apply_action, legal, Validate};
use wc_core::invariants::check_invariants;
use wc_core::json::{action_from_json, action_to_json, state_from_json, state_to_json, view_to_json};
use wc_core::rng::Rng;
use wc_core::setup::{create_game, CreateGameOptions};
use wc_core::types::{DraftMode, GameState, SeatInfo, Seat};
use wc_core::units::{SetMask, UnitSet};
use wc_core::view::view_for;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut state: Option<GameState> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request, &mut state),
            Err(e) => json!({ "ok": false, "error": format!("bad request: {e}") }),
        };
        writeln!(stdout, "{reply}").expect("write");
        stdout.flush().expect("flush");
    }
}

fn handle(request: &Value, state: &mut Option<GameState>) -> Value {
    match run(request, state) {
        Ok(mut value) => {
            if let Value::Object(map) = &mut value {
                map.insert("ok".into(), json!(true));
            }
            value
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

fn run(request: &Value, slot: &mut Option<GameState>) -> Result<Value, String> {
    let cmd = request.get("cmd").and_then(Value::as_str).ok_or("no cmd")?;
    match cmd {
        "ping" => Ok(json!({})),
        "create" => {
            *slot = Some(create(request.get("opts").ok_or("no opts")?)?);
            Ok(json!({}))
        }
        "load" => {
            *slot = Some(state_from_json(request.get("state").ok_or("no state")?)?);
            Ok(json!({}))
        }
        _ => {
            let state = slot.as_mut().ok_or("no game")?;
            match cmd {
                "state" => Ok(json!({ "state": state_to_json(state) })),
                "acting" => Ok(json!({ "acting": state.acting_seat(), "terminal": state.is_terminal() })),
                "invariants" => Ok(json!({ "bad": check_invariants(state) })),
                "legal" => {
                    let seat = seat_of(request, state);
                    let actions = legal(state, seat);
                    Ok(json!({
                        "legal": actions.iter().map(|a| action_to_json(*a)).collect::<Vec<_>>()
                    }))
                }
                "view" => {
                    let seat = seat_of(request, state);
                    let actions = legal(state, seat);
                    Ok(json!({ "view": view_to_json(&view_for(state, seat, actions)) }))
                }
                // Every legal action played on a copy, so a rule nobody happened
                // to play is compared too.
                "successors" => {
                    let seat = seat_of(request, state);
                    let mut out = Vec::new();
                    for action in legal(state, seat) {
                        let mut next = state.clone();
                        match apply_action(&mut next, seat, action, Validate::No) {
                            Ok(()) => out.push(json!({
                                "action": action_to_json(action),
                                "state": state_to_json(&next),
                            })),
                            Err(e) => out.push(json!({
                                "action": action_to_json(action),
                                "error": e,
                            })),
                        }
                    }
                    Ok(json!({ "successors": out }))
                }
                "apply" => {
                    let seat = seat_of(request, state);
                    let action = action_from_json(request.get("action").ok_or("no action")?)?;
                    let validate = if request.get("validate").and_then(Value::as_bool) == Some(false)
                    {
                        Validate::No
                    } else {
                        Validate::Yes
                    };
                    apply_action(state, seat, action, validate).map_err(str::to_owned)?;
                    Ok(json!({}))
                }
                other => Err(format!("unknown cmd {other}")),
            }
        }
    }
}

fn seat_of(request: &Value, state: &GameState) -> Seat {
    match request.get("seat").and_then(Value::as_u64) {
        Some(s) => s as Seat,
        None => state.acting_seat(),
    }
}

fn create(opts: &Value) -> Result<GameState, String> {
    let size = BoardSize::from_seats(opts.get("size").and_then(Value::as_u64).unwrap_or(2) as usize)
        .ok_or("bad size")?;
    let seed = opts.get("seed").and_then(Value::as_u64).unwrap_or(1) as u32;
    let mut create = CreateGameOptions::new(
        opts.get("id").and_then(Value::as_str).unwrap_or("conformance"),
        size,
        seed,
    );
    if let Some(mode) = opts.get("draftMode").and_then(Value::as_str) {
        create.draft_mode = DraftMode::from_key(mode).ok_or("bad draft mode")?;
    }
    let mut sets = SetMask::base();
    for s in opts.get("sets").and_then(Value::as_array).into_iter().flatten() {
        if let Some(set) = s.as_str().and_then(UnitSet::from_key) {
            sets = sets.with(set);
        }
    }
    create.sets = sets;
    if let Some(seats) = opts.get("seats").and_then(Value::as_array) {
        create.seats = seats
            .iter()
            .map(|s| SeatInfo {
                user_id: s.get("userId").and_then(Value::as_str).unwrap_or("").into(),
                display_name: s.get("displayName").and_then(Value::as_str).unwrap_or("").into(),
                avatar_url: s.get("avatarUrl").and_then(Value::as_str).map(str::to_owned),
                bot: s.get("bot").and_then(Value::as_str).map(str::to_owned),
            })
            .collect();
    }
    if let Some(fixed) = opts.get("fixedUnits").and_then(Value::as_array) {
        create.fixed_units = Some(
            fixed
                .iter()
                .map(|row| {
                    row.as_array()
                        .map(|units| {
                            units
                                .iter()
                                .filter_map(|u| {
                                    u.as_str().and_then(wc_core::units::UnitId::from_key)
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect(),
        );
    }
    let _ = Rng::new(seed);
    create_game(&create).map_err(str::to_owned)
}
