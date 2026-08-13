//! Game creation, the unit draft, and the Draw Coins phase.

use crate::board::{board_for, BoardSize, FORTIFICATIONS_ON_BOARD, FORTIFICATIONS_TOTAL,
                   FORTIFICATION_LAYOUTS};
use crate::decrees::{DecreeInPlay, DECREES_IN_PLAY, DECREE_IDS, SEALS_PER_SIDE};
use crate::rng::Rng;
use crate::types::*;
use crate::units::*;
use arrayvec::ArrayVec;
use std::sync::Arc;

pub const HAND_SIZE: usize = 3;

/// Cards struck out before an elimination draft — one per side, whatever the
/// table size, matching the two extra cards dealt into the pool.
pub const BANS: usize = 2;

#[derive(Clone, Debug)]
pub struct CreateGameOptions {
    pub id: String,
    pub size: BoardSize,
    pub seats: Vec<SeatInfo>,
    pub seed: u32,
    pub draft_mode: DraftMode,
    /// Which boxes are on the table. The base game is always included.
    pub sets: SetMask,
    /// Force a specific line-up, e.g. the rulebook's recommended first game.
    pub fixed_units: Option<Vec<Vec<UnitId>>>,
    /// Whether the state keeps a full log. A search state does not.
    pub recording: bool,
}

impl CreateGameOptions {
    pub fn new(id: impl Into<String>, size: BoardSize, seed: u32) -> CreateGameOptions {
        CreateGameOptions {
            id: id.into(),
            size,
            seats: (0..size.seats())
                .map(|i| SeatInfo {
                    user_id: format!("p{i}"),
                    display_name: format!("P{i}"),
                    avatar_url: None,
                    bot: None,
                })
                .collect(),
            seed,
            draft_mode: DraftMode::Draft,
            sets: SetMask::base(),
            fixed_units: None,
            recording: true,
        }
    }
}

fn team_of(seat: Seat, size: BoardSize) -> Team {
    // Duel: seat 0 vs seat 1. Four-player: teammates sit opposite each other.
    match size {
        BoardSize::Duel => seat,
        BoardSize::Team => seat % 2,
    }
}

/// Fills a player's bag and supply once their units are known.
pub fn equip_player(player: &mut PlayerState, rng: &mut Rng) {
    let mut bag: Vec<CoinId> = Vec::with_capacity(1 + player.units.len() * 2);
    bag.push(ROYAL_COIN);
    for unit in player.units.clone() {
        for _ in 0..COINS_IN_BAG_PER_UNIT {
            bag.push(CoinId::unit(unit));
        }
        player.supply[unit as usize] = unit.spec().coins - COINS_IN_BAG_PER_UNIT;
    }
    rng.shuffle(&mut bag);
    player.bag = bag;
}

pub fn create_game(opts: &CreateGameOptions) -> Result<GameState, &'static str> {
    let board = board_for(opts.size);
    if opts.seats.len() != opts.size.seats() {
        return Err("wrong number of seats");
    }

    let mut rng = Rng::new(opts.seed);
    let mut players: ArrayVec<PlayerState, MAX_SEATS> = (0..opts.size.seats())
        .map(|i| PlayerState::new(i as Seat, team_of(i as Seat, opts.size)))
        .collect();

    let sets = opts.sets.with(UnitSet::Base);
    let mut state = GameState {
        id: Arc::from(opts.id.as_str()),
        size: opts.size,
        phase: Phase::Draft,
        round: 0,
        turn: 0,
        players: ArrayVec::new(),
        seats: Arc::new(opts.seats.clone()),
        units: Board::new(),
        control: [NO_SEAT; crate::board::HEX_COUNT],
        initiative: 0,
        initiative_moved_this_round: false,
        pending: Vec::new(),
        draft_mode: opts.draft_mode,
        sets,
        decrees: ArrayVec::new(),
        forts: [false; crate::board::HEX_COUNT],
        fort_supply: 0,
        draft_pool: Vec::new(),
        banned: Vec::new(),
        log: Log::new(opts.recording),
        winner: None,
        rng: Rng::new(0),
    };

    // Nobility deals three of the seven Royal Decrees face up, and hands each
    // side its Seals. This happens before the draft, as the expansion instructs.
    if sets.has(UnitSet::Nobility) {
        let mut deck = DECREE_IDS;
        rng.shuffle(&mut deck);
        for id in deck.into_iter().take(DECREES_IN_PLAY) {
            state.decrees.push(DecreeInPlay::new(id));
        }
        // Three per *side*, and a four-player team shares them: the whole three
        // go to the first seat on the side, and `seals_left` reads the sum.
        for i in 0..players.len() {
            let team = players[i].team;
            let first = players.iter().position(|q| q.team == team) == Some(i);
            players[i].seals = if first { SEALS_PER_SIDE } else { 0 };
        }
    }

    // Siege picks one Fortification Map Card at random: four Fortifications go
    // on the board, the remaining three form the supply.
    if sets.has(UnitSet::Siege) {
        let layout = FORTIFICATION_LAYOUTS[rng.next_int(FORTIFICATION_LAYOUTS.len())];
        for hex in layout {
            state.forts[hex as usize] = true;
        }
        state.fort_supply = FORTIFICATIONS_TOTAL - FORTIFICATIONS_ON_BOARD;
    }

    // Each side starts controlling its crested locations.
    for (team, locations) in board.starting_locations.iter().enumerate() {
        for loc in locations {
            state.control[*loc as usize] = team as u8;
        }
    }

    if let Some(fixed) = &opts.fixed_units {
        for (seat, units) in fixed.iter().enumerate() {
            if let Some(p) = players.get_mut(seat) {
                p.units = units.iter().copied().collect();
            }
        }
        state.players = players;
        state.rng = rng;
        begin_play(&mut state);
        return Ok(state);
    }

    let per_player = units_per_player(opts.size);
    let pool_size =
        per_player * opts.size.seats() + if opts.draft_mode == DraftMode::Ban { BANS } else { 0 };
    let mut pool = units_for_sets(sets);
    rng.shuffle(&mut pool);
    pool.truncate(pool_size);

    if opts.draft_mode == DraftMode::Random {
        for (i, p) in players.iter_mut().enumerate() {
            p.units = pool[i * per_player..(i + 1) * per_player].iter().copied().collect();
        }
        state.players = players;
        state.rng = rng;
        begin_play(&mut state);
        return Ok(state);
    }

    state.players = players;
    state.rng = rng;
    state.draft_pool = pool;
    state.phase = if opts.draft_mode == DraftMode::Ban { Phase::Ban } else { Phase::Draft };
    // The rulebook flips the Initiative Marker to pick who bans and drafts first.
    state.turn = 0;
    Ok(state)
}

/// Whose turn it is to strike a card out.
pub fn ban_seat(state: &GameState) -> Seat {
    (state.banned.len() % 2) as Seat
}

pub fn apply_ban(state: &mut GameState, seat: Seat, unit: UnitId) -> Result<(), &'static str> {
    if state.phase != Phase::Ban {
        return Err("not banning");
    }
    if ban_seat(state) != seat {
        return Err("not your ban");
    }
    let idx = state.draft_pool.iter().position(|u| *u == unit).ok_or("unit not in pool")?;
    state.draft_pool.remove(idx);
    state.banned.push(unit);
    let mut entry = LogEntry::new(0, seat, LogKind::Ban);
    entry.unit = unit as u8;
    state.log.push(entry);

    if state.banned.len() >= BANS {
        state.phase = Phase::Draft;
        state.turn = draft_seat(state);
    } else {
        state.turn = ban_seat(state);
    }
    Ok(())
}

/// Whose turn it is to pick. Two-player order is A B B A A B B A, and the player
/// who picked second starts the game.
pub fn draft_order(size: BoardSize) -> &'static [Seat] {
    match size {
        BoardSize::Duel => &[0, 1, 1, 0, 0, 1, 1, 0],
        BoardSize::Team => &[0, 1, 2, 3, 3, 2, 1, 0, 1, 2, 3, 0],
    }
}

pub fn draft_seat(state: &GameState) -> Seat {
    let order = draft_order(state.size);
    let picked: usize = state.players.iter().map(|p| p.units.len()).sum();
    order.get(picked).copied().unwrap_or(0)
}

pub fn apply_draft_pick(
    state: &mut GameState,
    seat: Seat,
    unit: UnitId,
) -> Result<(), &'static str> {
    if state.phase != Phase::Draft {
        return Err("not drafting");
    }
    if draft_seat(state) != seat {
        return Err("not your pick");
    }
    let idx = state.draft_pool.iter().position(|u| *u == unit).ok_or("unit not in pool")?;
    state.draft_pool.remove(idx);
    if (seat as usize) >= state.players.len() {
        return Err("no such seat");
    }
    state.players[seat as usize].units.push(unit);
    let mut entry = LogEntry::new(0, seat, LogKind::Draft);
    entry.unit = unit as u8;
    state.log.push(entry);

    if state.draft_pool.is_empty() {
        begin_play(state);
    } else {
        state.turn = draft_seat(state);
    }
    Ok(())
}

/// Equips every player, hands out initiative and deals the first hands.
pub fn begin_play(state: &mut GameState) {
    let mut rng = state.rng;
    for p in state.players.iter_mut() {
        equip_player(p, &mut rng);
    }
    state.rng = rng;

    // After a draft the player who picked second goes first; a random deal has
    // nobody to reward, so it falls to seat 0.
    let first: usize = if state.draft_mode == DraftMode::Random { 0 } else { 1 };
    state.initiative = (first % state.players.len()) as Seat;
    let initiative = state.initiative;
    for p in state.players.iter_mut() {
        p.has_initiative = p.seat == initiative;
    }

    state.phase = Phase::Playing;
    state.round = 0;
    start_round(state);
}

/// Draws `n` coins, refilling the bag from the discard pile when it runs dry.
pub fn draw_coins(state: &mut GameState, seat: Seat, n: usize) -> ArrayVec<CoinId, MAX_HAND> {
    let mut drawn: ArrayVec<CoinId, MAX_HAND> = ArrayVec::new();
    let mut rng = state.rng;
    {
        let player = &mut state.players[seat as usize];
        for _ in 0..n {
            if player.bag.is_empty() {
                if player.discard.is_empty() {
                    break; // "Not enough coins?" — play short.
                }
                let mut refill: Vec<CoinId> = player.discard.iter().map(|d| d.coin).collect();
                rng.shuffle(&mut refill);
                player.bag = refill;
                player.discard.clear();
            }
            match player.bag.pop() {
                Some(coin) => drawn.push(coin),
                None => break,
            }
        }
        for coin in &drawn {
            player.hand.push(*coin);
        }
    }
    state.rng = rng;
    drawn
}

pub fn start_round(state: &mut GameState) {
    state.round += 1;
    state.initiative_moved_this_round = false;
    for seat in 0..state.players.len() as Seat {
        let held = state.players[seat as usize].hand.len();
        if held < HAND_SIZE {
            draw_coins(state, seat, HAND_SIZE - held);
        }
    }
    state.turn = state.initiative;
    state.log.push(LogEntry::new(state.round, state.initiative, LogKind::RoundStart));
}
