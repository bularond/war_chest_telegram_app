//! The rules defects an external review found, each pinned by the case it named.
//!
//! These are not new rules. They are places where the engine and the printed
//! card disagreed, all of them read out of the code by `codex` on 13 August and
//! all of them faithfully carried into the Rust port before being fixed here.
//! A test each, because the way every one of them arrived was a reading of the
//! code, and the next reading will not happen on its own.
//!
//! The naming below (`A-3a`, `A-5b`, …) is the review's own, so a finding can be
//! looked up in `REVIEW.md` beside the test that closes it.

use wc_core::board::{board_for, index_of_id, BoardSize, HexIdx};
use wc_core::engine::{adjacent, apply_action, legal, Validate};
use wc_core::setup::{create_game, CreateGameOptions};
use wc_core::types::*;
use wc_core::units::*;

fn at(id: &str) -> HexIdx {
    let hex = index_of_id(id);
    assert_ne!(hex, wc_core::board::NONE, "{id} is not a hex on the printed board");
    hex
}

/// A playing position with the units named and nothing on the board.
fn game(mine: &[UnitId], theirs: &[UnitId], sets: SetMask) -> GameState {
    let mut opts = CreateGameOptions::new("review", BoardSize::Duel, 1);
    opts.sets = sets;
    opts.fixed_units = Some(vec![mine.to_vec(), theirs.to_vec()]);
    let mut state = create_game(&opts).expect("a game");
    state.units.clear();
    state.pending.clear();
    state.turn = 0;
    for p in state.players.iter_mut() {
        p.hand.clear();
    }
    state
}

fn place(state: &mut GameState, id: &str, unit: UnitId, seat: Seat, coins: u8) {
    let team = state.players[seat as usize].team;
    state.units.insert(
        at(id),
        UnitStack { unit, team, seat, coins, poisoned_by: Poison::None },
    );
}

fn hold(state: &mut GameState, seat: Seat, coin: CoinId) {
    state.players[seat as usize].hand.push(coin);
}

fn every_box() -> SetMask {
    SetMask::base().with(UnitSet::Nobility).with(UnitSet::Siege).with(UnitSet::Nightfall)
}

/// The first hex adjacent to `id` that nothing stands on.
fn free_neighbour(state: &GameState, id: &str) -> HexIdx {
    *adjacent(state, at(id))
        .iter()
        .find(|h| !state.units.occupied(**h))
        .expect("somewhere to go")
}

// ---------------------------------------------------------------------------
// A-3 — a granted action is still an action
// ---------------------------------------------------------------------------

/// «Enlist recruits a deployed Mercenary: no free maneuver appears.»
///
/// The hook was written inline in the paid `recruit` branch, so every other way
/// of recruiting — the Enlist decree, the Bishop's tactic — skipped it, though
/// the Nobility rulesheet names that exact combination as working.
#[test]
fn a3a_a_mercenary_recruited_by_a_decree_still_gets_its_maneuver() {
    let mut state = game(&[UnitId::Mercenary], &[UnitId::Swordsman], every_box());
    place(&mut state, "5,2", UnitId::Mercenary, 0, 1);
    state.players[0].supply[UnitId::Mercenary as usize] = 3;
    state.pending.push(PendingStep::DecreeRecruit { source: StepSource::Enlist });

    let action = Action::bare(ActionKind::FollowRecruit).with_unit(UnitId::Mercenary);
    apply_action(&mut state, 0, action, Validate::Yes).expect("the recruit is legal");

    assert!(
        state.pending.iter().any(|s| matches!(
            s,
            PendingStep::ManeuverUnit { source: StepSource::Mercenary, .. }
        )),
        "the Mercenary was recruited and offered nothing: {:?}",
        state.pending
    );
}

/// «Redeploy a poisoned Earl: it returns unpoisoned and receives no post-deploy
/// move.» Two defects in one action — the counter was dropped on the way, and
/// putting a stack back down was written as a board assignment rather than as a
/// deploy.
#[test]
fn a3bc_redeploy_keeps_the_poison_and_still_deploys() {
    let mut state = game(&[UnitId::Earl], &[UnitId::Assassin], every_box());
    place(&mut state, "4,0", UnitId::Earl, 0, 1);
    state.units.get_mut(at("4,0")).unwrap().poisoned_by = Poison::Assassin;
    state.pending.push(PendingStep::DecreeLift);

    apply_action(
        &mut state,
        0,
        Action::bare(ActionKind::FollowLift).with_from(at("4,0")),
        Validate::Yes,
    )
    .expect("lifting is legal");
    assert!(
        matches!(
            state.pending.last(),
            Some(PendingStep::DecreePlace { poisoned_by: Poison::Assassin, .. })
        ),
        "the counter did not travel with the stack: {:?}",
        state.pending.last()
    );

    let landing = *legal(&state, 0)
        .iter()
        .find(|a| a.kind == ActionKind::FollowPlace)
        .expect("somewhere to land");
    apply_action(&mut state, 0, landing, Validate::Yes).expect("placing is legal");

    let stack = state.units.get(landing.to).expect("the Earl is back on the board");
    assert_eq!(stack.poisoned_by, Poison::Assassin, "Redeploy cured the poison");
    assert!(
        state.pending.iter().any(|s| matches!(
            s,
            PendingStep::OptionalMove { source: StepSource::Earl, .. }
        )),
        "the Earl landed and was offered no move: {:?}",
        state.pending
    );
}

/// «A Sapper uses its tactic to enter a bare location and attack an adjacent
/// fort while fort supply remains: no build choice appears.»
///
/// The reading was right and the case is unreachable, which only the board says.
/// A Fortification stands on a location; the tactic attacks something *adjacent*
/// to where the Sapper lands; so the Sapper would have to land on a location
/// next to a location — and no two locations on the printed board touch. The
/// code was fixed anyway, because «the move half is a move» is the shape the
/// rest of the engine has and the accident that saves it is the board's, not the
/// code's. This pins the accident, so that redrawing the board fails here rather
/// than in a game.
#[test]
fn a3d_no_two_locations_touch_which_is_why_the_sapper_case_cannot_arise() {
    for size in [BoardSize::Duel, BoardSize::Team] {
        let board = board_for(size);
        for a in &board.locations {
            let n = board.adjacent_len[*a as usize] as usize;
            for neighbour in &board.adjacent[*a as usize][..n] {
                assert!(
                    !board.is_location[*neighbour as usize],
                    "{} and {} are adjacent locations — the Sapper's tactic can now \
                     land on one and hit a wall on the other, and that path needs a test",
                    wc_core::board::id_of(*a),
                    wc_core::board::id_of(*neighbour),
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// A-5 — a tactic attack is an attack
// ---------------------------------------------------------------------------

/// «A bolstered Cavalry can charge and attack a Bishop, although bolstered units
/// cannot attack it.» The charge had its own weaker copy of the attack check —
/// it knew about the Knight and not about the Bishop.
#[test]
fn a5a_a_bolstered_charge_cannot_reach_a_bishop() {
    let mut state = game(&[UnitId::Cavalry], &[UnitId::Bishop], every_box());
    place(&mut state, "5,2", UnitId::Cavalry, 0, 2);
    let bishop = free_neighbour(&state, "5,2");
    let team = state.players[1].team;
    state.units.insert(
        bishop,
        UnitStack { unit: UnitId::Bishop, team, seat: 1, coins: 1, poisoned_by: Poison::None },
    );
    hold(&mut state, 0, CoinId::unit(UnitId::Cavalry));

    assert!(
        !legal(&state, 0).iter().any(|a| a.target == bishop),
        "a bolstered unit was offered an attack on a Bishop"
    );

    // And an unbolstered one still may, which is the point of the restriction.
    state.units.get_mut(at("5,2")).unwrap().coins = 1;
    assert!(
        legal(&state, 0).iter().any(|a| a.target == bishop),
        "an unbolstered Cavalry should be able to charge a Bishop"
    );
}

/// «A Lancer can charge through a neutral Fortification.» The lane was tested
/// for units and nothing else, though a Fortification is exactly the thing a
/// multi-space move may land on and never pass through.
#[test]
fn a5b_a_fortification_blocks_the_lane_a_lancer_charges_down() {
    let mut state = game(&[UnitId::Lancer], &[UnitId::Swordsman], SetMask::base().with(UnitSet::Siege));
    // A straight line of four: the Lancer, the wall, the landing, the victim.
    let line = board_for(state.size)
        .hexes
        .iter()
        .copied()
        .find(|h| {
            (0..6).any(|dir| {
                let mut hex = *h;
                (0..3).all(|_| {
                    hex = wc_core::board::STEPS[hex as usize][dir];
                    hex != wc_core::board::NONE && board_for(BoardSize::Duel).on_board[hex as usize]
                })
            })
        })
        .expect("four hexes in a row");
    let dir = (0..6)
        .find(|dir| {
            let mut hex = line;
            (0..3).all(|_| {
                hex = wc_core::board::STEPS[hex as usize][*dir];
                hex != wc_core::board::NONE && board_for(BoardSize::Duel).on_board[hex as usize]
            })
        })
        .expect("the direction that fits");
    let step = |from: HexIdx, n: usize| {
        let mut hex = from;
        for _ in 0..n {
            hex = wc_core::board::STEPS[hex as usize][dir];
        }
        hex
    };
    let (wall, landing, victim) = (step(line, 1), step(line, 2), step(line, 3));

    place(&mut state, &wc_core::board::id_of(line), UnitId::Lancer, 0, 1);
    let team = state.players[1].team;
    state.units.insert(
        victim,
        UnitStack { unit: UnitId::Swordsman, team, seat: 1, coins: 1, poisoned_by: Poison::None },
    );
    hold(&mut state, 0, CoinId::unit(UnitId::Lancer));

    // Two spaces down a clear lane: legal.
    assert!(
        legal(&state, 0).iter().any(|a| a.to == landing && a.target == victim),
        "a clear two-space charge should be on offer"
    );

    // The same charge with a wall in the way: not legal.
    state.forts[wall as usize] = true;
    state.fort_supply = wc_core::board::FORTIFICATIONS_TOTAL - 1;
    assert!(
        !legal(&state, 0).iter().any(|a| a.to == landing && a.target == victim),
        "the Lancer charged straight through a Fortification"
    );
}

/// «A bolstered Trebuchet two spaces from an empty enemy Fortification gets no
/// tactic targeting it.» Ranged tactics walked the stacks, and an empty
/// Fortification is not one — so the one unit in the box built to knock walls
/// down at range could not see a wall standing on its own.
#[test]
fn a5c_a_ranged_tactic_can_hit_a_fortification_nobody_is_standing_on() {
    let mut state = game(&[UnitId::Trebuchet], &[UnitId::Swordsman], SetMask::base().with(UnitSet::Siege));
    let wall = board_for(state.size)
        .locations
        .iter()
        .copied()
        .find(|loc| {
            board_for(state.size)
                .hexes
                .iter()
                .any(|h| wc_core::board::DIST[*h as usize][*loc as usize] == 2)
        })
        .expect("a location with somewhere to shoot from");
    let from = *board_for(state.size)
        .hexes
        .iter()
        .find(|h| {
            wc_core::board::DIST[**h as usize][wall as usize] == 2
                && wc_core::board::DIR_BETWEEN[**h as usize][wall as usize] != wc_core::board::NONE
        })
        .expect("a straight two-hex line to it");

    state.forts = [false; wc_core::board::HEX_COUNT];
    state.forts[wall as usize] = true;
    state.fort_supply = wc_core::board::FORTIFICATIONS_TOTAL - 1;
    state.control[wall as usize] = 1;
    let team = state.players[0].team;
    state.units.insert(
        from,
        UnitStack { unit: UnitId::Trebuchet, team, seat: 0, coins: 2, poisoned_by: Poison::None },
    );
    hold(&mut state, 0, CoinId::unit(UnitId::Trebuchet));

    assert!(
        legal(&state, 0).iter().any(|a| a.kind == ActionKind::Tactic && a.target == wall),
        "the Trebuchet could not see a Fortification standing alone"
    );
}

// ---------------------------------------------------------------------------
// A-6 — «perform one maneuver with each Footman unit»
// ---------------------------------------------------------------------------

/// «Use the Footman tactic, maneuver the first, then skip the second — or skip
/// both entirely.» Every step the tactic queued was optional, so the card's
/// «each» was a suggestion.
#[test]
fn a6_the_footmans_maneuvers_are_not_optional() {
    let mut state = game(&[UnitId::Footman], &[UnitId::Swordsman], SetMask::base());
    place(&mut state, "4,0", UnitId::Footman, 0, 1);
    place(&mut state, "7,0", UnitId::Footman, 0, 1);
    hold(&mut state, 0, CoinId::unit(UnitId::Footman));

    let tactic = *legal(&state, 0)
        .iter()
        .find(|a| a.kind == ActionKind::Tactic)
        .expect("the Footman tactic is on offer");
    apply_action(&mut state, 0, tactic, Validate::Yes).expect("the tactic is legal");

    let steps = state.pending.iter().filter(|s| {
        matches!(s, PendingStep::ManeuverUnit { source: StepSource::Footman, optional: false, .. })
    });
    assert_eq!(steps.count(), 2, "both Footmen owe a maneuver: {:?}", state.pending);

    // And a Footman with somewhere to go may not simply stand still.
    assert!(
        !legal(&state, 0).iter().any(|a| a.kind == ActionKind::Skip),
        "skipping a maneuver the card requires was on offer"
    );
}

// ---------------------------------------------------------------------------
// A-7 — the Initiative Marker belongs to the side
// ---------------------------------------------------------------------------

/// «Seat 0 holds Initiative and seat 2 is their teammate. Seat 2 is offered
/// Claim Initiative and can transfer the marker within the same team.»
#[test]
fn a7b_initiative_cannot_be_taken_from_a_partner() {
    let mut opts = CreateGameOptions::new("review", BoardSize::Team, 1);
    opts.fixed_units = Some(vec![
        vec![UnitId::Swordsman, UnitId::Archer, UnitId::Pikeman],
        vec![UnitId::Cavalry, UnitId::Knight, UnitId::Scout],
        vec![UnitId::Lancer, UnitId::Marshal, UnitId::Ensign],
        vec![UnitId::Footman, UnitId::Berserker, UnitId::Mercenary],
    ]);
    let mut state = create_game(&opts).expect("a four-player game");
    state.pending.clear();

    // Seat 0 holds it; seat 2 is on the same team and is to move.
    for p in state.players.iter_mut() {
        p.has_initiative = p.seat == 0;
    }
    state.initiative = 0;
    state.initiative_moved_this_round = false;
    state.turn = 2;
    assert_eq!(state.players[2].team, state.players[0].team, "seats 0 and 2 are partners");

    assert!(
        !legal(&state, 2).iter().any(|a| a.kind == ActionKind::ClaimInitiative),
        "a player was offered the marker their own partner is holding"
    );
    // The other side may still take it, which is what the action is for.
    state.turn = 1;
    assert!(
        legal(&state, 1).iter().any(|a| a.kind == ActionKind::ClaimInitiative),
        "the opposing side should still be able to claim it"
    );
}
