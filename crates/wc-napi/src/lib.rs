//! The engine and the bots, as a Node addon.
//!
//! Two shapes cross the boundary. The rules are stateless functions over JSON,
//! which is what `@wc/shared` needs and what makes the TypeScript side a facade
//! rather than a second implementation. The bot is a long-lived object, because
//! a search owns a tree arena and a pile of scratch that would be pointless to
//! rebuild per move.
//!
//! Nothing here holds a lock across a call into JavaScript, and the search runs
//! on rayon's threads inside an async task — so a thousand-millisecond think
//! does not stop the server answering anybody else.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use serde_json::Value;

use wc_bot::ismcts::{best_of, merge_reports, Budget, RootStat, SearchSettings};
use wc_bot::{player_named, Player};
use wc_core::engine::{apply_action, legal, Validate};
use wc_core::invariants::check_invariants;
use wc_core::json::{
    action_from_json, action_to_json, state_from_json, state_to_json, view_from_json, view_to_json,
};
use wc_core::rng::Rng;
use wc_core::setup::{create_game, CreateGameOptions};
use wc_core::types::{Action, DraftMode, GameState, Seat, SeatInfo};
use wc_core::units::{SetMask, UnitId, UnitSet};
use wc_core::view::view_for;

fn fail<E: std::fmt::Display>(e: E) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}

fn parse(text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(fail)
}

// ---------------------------------------------------------------------------
// A game the server owns
// ---------------------------------------------------------------------------

/// One game, held on the Rust side.
///
/// A room advances in place and pays only for the views it actually sends,
/// which is the difference between this and the stateless functions below.
#[napi]
pub struct Game {
    state: GameState,
}

#[napi]
impl Game {
    /// `{ id, size, seed, draftMode, sets, seats, fixedUnits }`.
    #[napi(factory)]
    pub fn create(options: String) -> Result<Game> {
        Ok(Game { state: build(&parse(&options)?).map_err(fail)? })
    }

    /// A game restored from its serialized form.
    #[napi(factory)]
    pub fn from_json(state: String) -> Result<Game> {
        Ok(Game { state: state_from_json(&parse(&state)?).map_err(fail)? })
    }

    #[napi]
    pub fn to_json(&self) -> String {
        state_to_json(&self.state).to_string()
    }

    /// The legal actions for a seat, or for whoever owes the next decision.
    #[napi]
    pub fn legal(&self, seat: Option<u32>) -> String {
        let seat = seat.map(|s| s as Seat).unwrap_or_else(|| self.state.acting_seat());
        let actions: Vec<Value> =
            legal(&self.state, seat).into_iter().map(action_to_json).collect();
        Value::Array(actions).to_string()
    }

    /// What one seat is allowed to see, legal actions included.
    #[napi]
    pub fn view(&self, seat: u32) -> String {
        let seat = seat as Seat;
        let actions = legal(&self.state, seat);
        view_to_json(&view_for(&self.state, seat, actions)).to_string()
    }

    /// Applies an action, checking it against the legal list first.
    ///
    /// The check is not optional here and must never become so: it is the only
    /// thing standing between a crafted WebSocket message and the game.
    #[napi]
    pub fn apply(&mut self, seat: u32, action: String) -> Result<()> {
        let action = action_from_json(&parse(&action)?).map_err(fail)?;
        apply_action(&mut self.state, seat as Seat, action, Validate::Yes).map_err(fail)
    }

    #[napi]
    pub fn acting_seat(&self) -> u32 {
        self.state.acting_seat() as u32
    }

    #[napi]
    pub fn is_terminal(&self) -> bool {
        self.state.is_terminal()
    }

    #[napi]
    pub fn winner(&self) -> Option<u32> {
        self.state.winner.map(|t| t as u32)
    }

    /// Structural checks the position must satisfy. Empty means sound.
    #[napi]
    pub fn invariants(&self) -> Vec<String> {
        check_invariants(&self.state)
    }
}

fn build(opts: &Value) -> std::result::Result<GameState, String> {
    let size = wc_core::board::BoardSize::from_seats(
        opts.get("size").and_then(Value::as_u64).unwrap_or(2) as usize,
    )
    .ok_or("bad board size")?;
    let mut create = CreateGameOptions::new(
        opts.get("id").and_then(Value::as_str).unwrap_or("game"),
        size,
        opts.get("seed").and_then(Value::as_u64).unwrap_or(1) as u32,
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
                                .filter_map(|u| u.as_str().and_then(UnitId::from_key))
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect(),
        );
    }
    create_game(&create).map_err(str::to_owned)
}

// ---------------------------------------------------------------------------
// The rules, statelessly
// ---------------------------------------------------------------------------

#[napi]
pub fn legal_actions(state: String, seat: u32) -> Result<String> {
    let state = state_from_json(&parse(&state)?).map_err(fail)?;
    let actions: Vec<Value> =
        legal(&state, seat as Seat).into_iter().map(action_to_json).collect();
    Ok(Value::Array(actions).to_string())
}

/// Applies an action and returns the state that follows. The original is
/// untouched, which is what a caller holding its own copy expects.
#[napi]
pub fn apply_to(
    state: String,
    seat: u32,
    action: String,
    validate: Option<bool>,
) -> Result<String> {
    let mut state = state_from_json(&parse(&state)?).map_err(fail)?;
    let action = action_from_json(&parse(&action)?).map_err(fail)?;
    let check = if validate == Some(false) { Validate::No } else { Validate::Yes };
    apply_action(&mut state, seat as Seat, action, check).map_err(fail)?;
    Ok(state_to_json(&state).to_string())
}

#[napi]
pub fn view_of(state: String, seat: u32) -> Result<String> {
    let state = state_from_json(&parse(&state)?).map_err(fail)?;
    let actions = legal(&state, seat as Seat);
    Ok(view_to_json(&view_for(&state, seat as Seat, actions)).to_string())
}

#[napi]
pub fn invariants_of(state: String) -> Result<Vec<String>> {
    let state = state_from_json(&parse(&state)?).map_err(fail)?;
    Ok(check_invariants(&state))
}

#[napi]
pub fn acting_seat_of(state: String) -> Result<u32> {
    let state = state_from_json(&parse(&state)?).map_err(fail)?;
    Ok(state.acting_seat() as u32)
}

/// The printed board and the card catalog, so the client draws from the same
/// data the rules run on rather than from a second copy of it.
#[napi]
pub fn catalog() -> String {
    wc_core::catalog::catalog().to_string()
}

/// Which build of the bots this is, for the game log.
#[napi]
pub fn bot_build() -> String {
    wc_bot::BOT_BUILD.to_string()
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

/// What each level plays with, and how long it may think.
///
/// Medium and Hard differ by thinking time rather than by a different bot, which
/// is what makes a level a level and not a separate personality.
fn plan_for(level: &str) -> (&'static str, u64) {
    match level {
        "easy" => ("heuristic", 0),
        "hard" => ("ismcts", 1000),
        _ => ("ismcts", 250),
    }
}

/// The searchers and the threads they run on, shared with the tasks that use
/// them so that a promise cannot outlive what it is searching with.
struct Brain {
    level: String,
    threads: usize,
    pool: rayon::ThreadPool,
    /// One searcher per thread, each with its own tree arena. Behind one lock,
    /// because a bot answers one position at a time and the alternative is a
    /// pile of locks that all end up held together anyway.
    searchers: Mutex<Vec<Player>>,
}

impl Brain {
    fn think(&self, view: &str, seed: u32, budget: Budget) -> std::result::Result<String, String> {
        let parsed: Value = serde_json::from_str(view).map_err(|e| e.to_string())?;
        let view = view_from_json(&parsed)?;
        if view.legal.is_empty() {
            return Err("the bot was asked to move with nothing legal".into());
        }
        if view.legal.len() == 1 {
            return Ok(answer(view.legal[0], &[]));
        }

        let mut searchers = self.searchers.lock().map_err(|_| "the bot is poisoned")?;
        let threads = self.threads.min(searchers.len());
        // Several searches of the same position from different seeds, their
        // visit counts added up. Worth about 1.2× one search — the trees share
        // an evaluation and a rollout policy, so they make the same mistake and
        // adding it up eight times changes little. It is kept because the cores
        // were idle, not because it is much.
        // The guard cannot cross into the pool, so the slice is taken out of it
        // first: the borrow is what rayon needs, not the lock.
        let slice: &mut [Player] = &mut searchers[..threads];
        let answers: Vec<(Action, Vec<RootStat>)> = self.pool.install(move || {
            slice
                .par_iter_mut()
                .enumerate()
                .map(|(i, player)| {
                    let mut rng =
                        Rng::new(seed.wrapping_add((i as u32).wrapping_mul(0x9e37_79b1)));
                    let (action, report) = player.choose_reported(&view, budget, &mut rng);
                    (action, report.map(|r| r.roots).unwrap_or_default())
                })
                .collect()
        });

        let roots: Vec<Vec<RootStat>> =
            answers.iter().map(|(_, r)| r.clone()).filter(|r| !r.is_empty()).collect();
        if roots.is_empty() {
            // A level that does not search answers with a move and no
            // statistics, and asking twelve threads for it would be twelve
            // times the same answer.
            let action = answers.first().map(|(a, _)| *a).ok_or("no search returned a move")?;
            return Ok(answer(action, &[]));
        }
        let merged = merge_reports(&roots);
        let best = best_of(&merged).ok_or("nothing to merge: no search returned a root move")?;
        Ok(answer(best.action, &merged))
    }
}

/// A bot that keeps its trees between moves.
///
/// One of these per level per process. Inside it are `threads` searchers, one
/// per worker: root parallelism, the only parallel scheme that needs no shared
/// tree and no locks inside the search itself.
#[napi]
pub struct Bot {
    brain: Arc<Brain>,
}

#[napi]
impl Bot {
    #[napi(constructor)]
    pub fn new(level: String, threads: Option<u32>) -> Result<Bot> {
        let threads = threads
            .map(|t| t as usize)
            .unwrap_or_else(|| {
                std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
            })
            .max(1);
        let (bot, _) = plan_for(&level);
        let settings = SearchSettings::default();
        let searchers = (0..threads)
            .map(|_| player_named(bot, &settings).expect("a level names a bot that exists"))
            .collect();
        Ok(Bot {
            brain: Arc::new(Brain {
                level,
                threads,
                pool: rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(fail)?,
                searchers: Mutex::new(searchers),
            }),
        })
    }

    /// One move, off the event loop.
    ///
    /// The returned promise settles when the search is done. Nothing about the
    /// game is held while it runs — the view came in as JSON and the answer goes
    /// out as JSON — so a search that overruns cannot take a room with it.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn choose(&self, view: String, seed: u32, budget_ms: Option<u32>) -> AsyncTask<Move> {
        AsyncTask::new(Move {
            brain: self.brain.clone(),
            view,
            seed,
            budget: self.budget(budget_ms),
        })
    }

    /// The same, blocking. For scripts and tests, never for the server.
    #[napi]
    pub fn choose_sync(&self, view: String, seed: u32, budget_ms: Option<u32>) -> Result<String> {
        self.brain.think(&view, seed, self.budget(budget_ms)).map_err(fail)
    }

    #[napi(getter)]
    pub fn level(&self) -> String {
        self.brain.level.clone()
    }

    #[napi(getter)]
    pub fn threads(&self) -> u32 {
        self.brain.threads as u32
    }

    fn budget(&self, budget_ms: Option<u32>) -> Budget {
        let (_, default_ms) = plan_for(&self.brain.level);
        let ms = budget_ms.map(u64::from).filter(|m| *m > 0).unwrap_or(default_ms);
        Budget { ms: if ms > 0 { Some(ms) } else { None }, iterations: None }
    }
}

fn answer(action: Action, roots: &[RootStat]) -> String {
    let stats: Vec<Value> = roots
        .iter()
        .map(|r| {
            serde_json::json!({
                "action": action_to_json(r.action),
                // A key is fifty bits, which a JSON number would round.
                "key": r.key.to_string(),
                "visits": r.visits,
                "value": r.value,
            })
        })
        .collect();
    serde_json::json!({ "action": action_to_json(action), "roots": stats }).to_string()
}

/// The async half of [`Bot::choose`].
pub struct Move {
    brain: Arc<Brain>,
    view: String,
    seed: u32,
    budget: Budget,
}

impl Task for Move {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        self.brain.think(&self.view, self.seed, self.budget).map_err(fail)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
