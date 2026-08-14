//! What a player can work out about the hidden coins, and how to turn that into
//! a concrete state a search can play on.
//!
//! War Chest hides very little. Recruits are taken from an open supply, coins
//! destroyed on the board are counted, and face-up discards are there for all to
//! see — so the *contents* of an opponent's bag and hand follow by subtraction.
//! Only the order is unknown, and that is what a determinization invents.
//!
//! The work splits in two. [`HiddenCoins`] is the subtraction, and it does not
//! depend on anything random: for one position it is the same answer every time,
//! so a search computes it **once** and not once per iteration. [`Determinizer`]
//! holds that answer and deals from it into a state buffer the caller owns, so
//! an iteration allocates nothing at all.

use crate::rng::Rng;
use crate::types::*;
use crate::units::{CoinId, UnitId, UnitSet, DECOYS, ROYAL_COIN};
use crate::view::{GameView, PlayerView};
use arrayvec::ArrayVec;

#[derive(Clone, Debug, Default)]
pub struct HiddenCoins {
    pub seat: Seat,
    /// Coins that must be among this player's hidden piles, worked out exactly.
    pub known: Vec<CoinId>,
    /// Slots the subtraction cannot fill. Only a Decoy Coin can do that: it is
    /// planted face up in a discard pile and then vanishes into the bag on the
    /// next refill.
    pub unknown: usize,
    /// How many coins are hidden in each pile, from the public counts.
    pub bag_count: usize,
    pub hand_count: usize,
    pub facedown_count: usize,
}

/// The multiset of coins that must be somewhere in `seat`'s hidden piles.
pub fn hidden_coins(view: &GameView, seat: Seat) -> Result<HiddenCoins, String> {
    let p = view.players.get(seat as usize).ok_or_else(|| format!("no seat {seat}"))?;

    // Only ever keyed by this player's drafted units and the Royal Coin, and
    // walked in that order so the deal is reproducible from the seed.
    let mut order: ArrayVec<CoinId, { MAX_UNITS + 1 }> = ArrayVec::new();
    let mut left = [0i32; crate::units::COIN_KINDS];
    for unit in &p.units {
        left[*unit as usize] = unit.spec().coins as i32;
        order.push(CoinId::unit(*unit));
    }
    left[ROYAL_COIN.0 as usize] = 1;
    order.push(ROYAL_COIN);

    let take = |left: &mut [i32], coin: CoinId, n: i32| -> Result<(), String> {
        let have = left[coin.0 as usize];
        if have < n {
            return Err(format!(
                "view is inconsistent: seat {seat} shows too many {} coins",
                coin.key()
            ));
        }
        left[coin.0 as usize] = have - n;
        Ok(())
    };

    for (_, stack) in view.units.iter() {
        if stack.seat == seat {
            take(&mut left, CoinId::unit(stack.unit), stack.coins as i32)?;
        }
    }
    for unit in crate::units::UNIT_IDS {
        let n = p.supply[unit as usize] as i32;
        if n > 0 {
            take(&mut left, CoinId::unit(unit), n)?;
        }
        let n = p.removed[unit as usize] as i32;
        if n > 0 {
            take(&mut left, CoinId::unit(unit), n)?;
        }
    }

    // A lifted stack is on no pile at all: the Redeploy decree holds it on the
    // pending step between coming off the board and going back down. Without
    // this the sum comes up short by exactly those coins and the view looks
    // impossible — which is how it was found, as a search that died mid-match
    // whenever it was asked to think during a Redeploy.
    if seat == view.turn {
        for step in &view.pending {
            if let PendingStep::DecreePlace { unit, coins, .. } = step {
                take(&mut left, CoinId::unit(*unit), *coins as i32)?;
            }
        }
    }

    let mut facedown_count = 0usize;
    for (coin, _) in &p.discard {
        match coin {
            None => facedown_count += 1,
            Some(c) if !c.is_decoy() => take(&mut left, *c, 1)?,
            Some(_) => {}
        }
    }
    let hand_known = p.hand.is_some();
    if let Some(hand) = &p.hand {
        for coin in hand {
            if !coin.is_decoy() {
                take(&mut left, *coin, 1)?;
            }
        }
    }

    let mut known = Vec::new();
    for coin in order {
        for _ in 0..left[coin.0 as usize] {
            known.push(coin);
        }
    }

    let slots = p.bag_count as usize
        + if hand_known { 0 } else { p.hand_count as usize }
        + facedown_count;
    if slots < known.len() {
        return Err(format!(
            "view is inconsistent: seat {seat} hides {slots} coins but owns {}",
            known.len()
        ));
    }

    Ok(HiddenCoins {
        seat,
        unknown: slots - known.len(),
        known,
        bag_count: p.bag_count as usize,
        hand_count: if hand_known { 0 } else { p.hand_count as usize },
        facedown_count,
    })
}

/// Decoy Coins that could be sitting in somebody's hidden piles.
fn hidden_decoys(view: &GameView) -> ArrayVec<CoinId, 2> {
    let mut out = ArrayVec::new();
    if !view.sets.has(UnitSet::Nightfall) {
        return out;
    }
    let mut seen = [false; crate::units::COIN_KINDS];
    for p in &view.players {
        for (coin, _) in &p.discard {
            if let Some(c) = coin {
                seen[c.0 as usize] = true;
            }
        }
        if let Some(hand) = &p.hand {
            for coin in hand {
                seen[coin.0 as usize] = true;
            }
        }
        // A player's own bag is shown to them: its contents are their own coins.
        // A decoy sitting in it is *known*, and treating it as a slot to be
        // guessed let a sample put the other decoy there instead — changing
        // which unit's decoy the search believed was still beside its card.
        if let Some(bag) = &p.bag {
            for coin in bag {
                seen[coin.0 as usize] = true;
            }
        }
    }
    for decoy in DECOYS {
        if !seen[decoy.0 as usize] {
            out.push(decoy);
        }
    }
    out
}

/// Everything about a position that a determinization does not have to guess.
///
/// Built once per search. Its whole point is that the expensive half —
/// subtracting the visible coins out of the printed ones — has one answer for
/// the position, and only the shuffle changes between iterations.
pub struct Determinizer<'a> {
    view: &'a GameView,
    hidden: ArrayVec<HiddenCoins, MAX_SEATS>,
    decoys: ArrayVec<CoinId, 2>,
    /// Scratch the deal shuffles in place, so an iteration allocates nothing.
    pool: Vec<CoinId>,
}

impl<'a> Determinizer<'a> {
    pub fn new(view: &'a GameView) -> Result<Determinizer<'a>, String> {
        let mut hidden = ArrayVec::new();
        for p in &view.players {
            hidden.push(hidden_coins(view, p.seat)?);
        }
        let widest = hidden.iter().map(|h| h.known.len() + h.unknown).max().unwrap_or(0);
        Ok(Determinizer { view, hidden, decoys: hidden_decoys(view), pool: Vec::with_capacity(widest) })
    }

    /// Invents one full state consistent with everything the view shows: the
    /// same board, the same counts, the same visible coins, and a random order
    /// for what is hidden.
    ///
    /// `into` is overwritten. Reusing one state across iterations is what keeps
    /// the search from allocating: the vectors inside it keep their capacity.
    pub fn sample_into(&mut self, into: &mut GameState, rng: &mut Rng) -> Result<(), String> {
        let view = self.view;

        // A Decoy that vanished into somebody's bag has to be handed to exactly
        // one player, so the decoys are dealt across the table before the piles.
        let mut decoys = self.decoys.clone();
        rng.shuffle(&mut decoys);
        let mut extra: [ArrayVec<CoinId, 2>; MAX_SEATS] = Default::default();
        for h in &self.hidden {
            for _ in 0..h.unknown {
                let decoy = decoys
                    .pop()
                    .ok_or("view is inconsistent: more hidden coins than coins exist")?;
                extra[h.seat as usize].push(decoy);
            }
        }

        into.id = view.id.clone();
        into.size = view.size;
        into.phase = view.phase;
        into.round = view.round;
        into.turn = view.turn;
        into.seats = view.seats.clone();
        into.units = view.units.clone();
        into.control = view.control;
        into.initiative =
            view.players.iter().find(|p| p.has_initiative).map(|p| p.seat).unwrap_or(0);
        into.initiative_moved_this_round = view.initiative_moved_this_round;
        into.draft_mode = view.draft_mode;
        into.sets = view.sets;
        into.decrees = view.decrees.clone();
        into.forts = view.forts;
        into.fort_supply = view.fort_supply;
        into.draft_pool.clear();
        into.draft_pool.extend_from_slice(&view.draft_pool);
        into.banned.clear();
        into.banned.extend_from_slice(&view.banned);
        // The log is not carried. What the rollout reads out of it — how
        // recently each unit maneuvered — travels as a table instead.
        into.log.entries.clear();
        into.log.recording = false;
        into.log.length = view.log_length;
        into.log.last_maneuver = view.last_maneuver;
        into.winner = view.winner;
        // The search reshuffles bags itself; the seed only has to be reproducible.
        into.rng = Rng::new(rng.seed ^ (view.round as u32).wrapping_mul(0x9e37_79b1));

        into.players.clear();
        for p in &view.players {
            let hidden = &self.hidden[p.seat as usize];
            into.players.push(deal_player(
                p,
                hidden,
                &extra[p.seat as usize],
                &mut self.pool,
                rng,
            ));
        }

        // A pending step can carry hidden information too, and one of them does.
        // The Warrior Priest draws a coin that must be spent at once and the
        // step names it; `view_for` blanks that name for everybody but its
        // owner. A determinization is a *state*, and a state has no blanks.
        into.pending.clear();
        for step in &view.pending {
            match step {
                PendingStep::MustUseCoin { coin: None } => {
                    let hand = &into.players[view.turn as usize].hand;
                    // The coin was drawn into that hand a moment ago, so an
                    // empty one is not a position this step can be in.
                    if hand.is_empty() {
                        return Err("mustUseCoin over an empty hand".into());
                    }
                    let coin = hand[rng.next_int(hand.len())];
                    into.pending.push(PendingStep::MustUseCoin { coin: Some(coin) });
                }
                other => into.pending.push(other.clone()),
            }
        }
        Ok(())
    }
}

fn deal_player(
    p: &PlayerView,
    hidden: &HiddenCoins,
    extra: &[CoinId],
    pool: &mut Vec<CoinId>,
    rng: &mut Rng,
) -> PlayerState {
    pool.clear();
    pool.extend_from_slice(&hidden.known);
    pool.extend_from_slice(extra);
    rng.shuffle(pool);

    let hand: ArrayVec<CoinId, MAX_HAND> = match &p.hand {
        Some(h) => h.clone(),
        None => {
            let taken: ArrayVec<CoinId, MAX_HAND> =
                pool[..hidden.hand_count.min(pool.len())].iter().copied().collect();
            pool.drain(..taken.len());
            taken
        }
    };

    let mut discard = Vec::with_capacity(p.discard.len());
    for (coin, face_up) in &p.discard {
        let coin = match coin {
            Some(c) => *c,
            None => pool.pop().unwrap_or(ROYAL_COIN),
        };
        discard.push(DiscardEntry { coin, face_up: *face_up });
    }

    PlayerState {
        seat: p.seat,
        team: p.team,
        units: p.units.clone(),
        // Whatever is left is the bag, in an order the drawer cannot know.
        bag: pool.clone(),
        hand,
        discard,
        supply: p.supply,
        removed: p.removed,
        seals: p.seals,
        has_initiative: p.has_initiative,
    }
}

/// One determinization, allocating. The convenient form, for tests and for
/// callers that make one and throw it away.
pub fn sample_determinization(view: &GameView, rng: &mut Rng) -> Result<GameState, String> {
    let mut state = empty_state(view);
    Determinizer::new(view)?.sample_into(&mut state, rng)?;
    Ok(state)
}

/// A state with nothing in it, shaped for the view it is about to be filled from.
pub fn empty_state(view: &GameView) -> GameState {
    GameState {
        id: view.id.clone(),
        size: view.size,
        phase: view.phase,
        round: 0,
        turn: 0,
        players: ArrayVec::new(),
        seats: view.seats.clone(),
        units: Board::new(),
        control: [NO_SEAT; crate::board::HEX_COUNT],
        initiative: 0,
        initiative_moved_this_round: false,
        pending: Vec::new(),
        draft_mode: view.draft_mode,
        sets: view.sets,
        decrees: ArrayVec::new(),
        forts: [false; crate::board::HEX_COUNT],
        fort_supply: 0,
        draft_pool: Vec::new(),
        banned: Vec::new(),
        log: Log::new(false),
        winner: None,
        rng: Rng::new(0),
    }
}

/// The unit a coin names, for callers that only want the drafted ones.
pub fn drafted_units(view: &GameView, seat: Seat) -> ArrayVec<UnitId, MAX_UNITS> {
    view.players[seat as usize].units.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::BoardSize;
    use crate::setup::{create_game, CreateGameOptions};
    use crate::units::{SetMask, UnitId, DECOY_INFILTRATOR, DECOY_SKIRMISHER};
    use crate::view::view_for;

    /// The review's A-8. A player's own bag is shown to them — it is their own
    /// coins — so a decoy sitting in it is known, not guessed. Treating it as an
    /// unknown slot let a sample put the *other* decoy there, changing which
    /// unit's decoy the search believed was still beside its card.
    #[test]
    fn a_decoy_the_player_can_see_in_their_own_bag_is_not_guessed_at() {
        let mut opts = CreateGameOptions::new("observe", BoardSize::Duel, 1);
        opts.sets = SetMask::base().with(UnitSet::Nightfall);
        opts.fixed_units =
            Some(vec![vec![UnitId::Infiltrator, UnitId::Skirmisher], vec![UnitId::Swordsman, UnitId::Archer]]);
        let mut state = create_game(&opts).expect("a game");

        // One decoy has been planted on seat 0 and has since gone into the bag;
        // the other is still beside its card.
        state.players[0].bag.push(DECOY_INFILTRATOR);
        let view = view_for(&state, 0, Vec::new());
        assert!(view.players[0].bag.as_ref().unwrap().contains(&DECOY_INFILTRATOR));

        let hidden = hidden_decoys(&view);
        assert!(
            !hidden.contains(&DECOY_INFILTRATOR),
            "a decoy the player is looking at was treated as unknown"
        );
        assert!(
            hidden.contains(&DECOY_SKIRMISHER),
            "the decoy that really is unaccounted for should still be guessable"
        );
    }
}
