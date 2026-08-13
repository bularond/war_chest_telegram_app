//! How the heuristic reads a board: distances, what each location counts as, and
//! the shape of a priority list.
//!
//! The two primitives come from the fan-made solo flowchart (Seth McBride, BGG
//! user Dreadpirate404), which is the one written-down source of War Chest
//! heuristics.
//!
//! **Closest** — "the hex/location/enemy unit that is the least number of hexes
//! away, counting around any occupied spaces". So not hex distance: a path that
//! walks around whatever is in the way. A unit standing on a hex still counts as
//! a destination, it just cannot be walked through.
//!
//! **Order of priorities** — "a numerical list of criteria. If the first
//! criterion applies to one and only one candidate, use it. Otherwise move to
//! the second criterion, using only those candidates that applied to the first."
//! A filter cascade, not a score.
//!
//! Both are on the hot path — half of a search's time was measured in the sweeps
//! below — so a sweep writes into a caller-owned array and allocates nothing.

use arrayvec::ArrayVec;
use std::sync::LazyLock;
use wc_core::board::{board_for, BoardSize, HexIdx, DIST, HEX_COUNT, NONE};
use wc_core::types::{Board, Team};

pub const UNREACHABLE: f32 = f32::INFINITY;

/// Steps to the nearest source, for every hex on the board. `-1` is "no route".
#[derive(Clone)]
pub struct Steps(pub [i16; HEX_COUNT]);

impl Steps {
    pub fn empty() -> Steps {
        Steps([-1; HEX_COUNT])
    }

    #[inline]
    pub fn get(&self, hex: HexIdx) -> Option<u16> {
        if hex == NONE {
            return None;
        }
        let d = self.0[hex as usize];
        if d < 0 {
            None
        } else {
            Some(d as u16)
        }
    }

    /// The distance as the priority lists want it: unreachable is infinitely far.
    #[inline]
    pub fn to(&self, hex: HexIdx) -> f32 {
        match self.get(hex) {
            Some(d) => d as f32,
            None => UNREACHABLE,
        }
    }
}

/// Scratch for one sweep. Reused across sweeps and across decisions.
pub struct Sweeper {
    frontier: ArrayVec<HexIdx, HEX_COUNT>,
    next: ArrayVec<HexIdx, HEX_COUNT>,
    occupied: [bool; HEX_COUNT],
}

impl Default for Sweeper {
    fn default() -> Sweeper {
        Sweeper::new()
    }
}

impl Sweeper {
    pub fn new() -> Sweeper {
        Sweeper {
            frontier: ArrayVec::new(),
            next: ArrayVec::new(),
            occupied: [false; HEX_COUNT],
        }
    }

    /// Steps from any of `sources` to every hex on the board, walking around
    /// occupied hexes. An occupied hex gets a distance — you can reach it, you
    /// just cannot pass through it — but nothing is expanded beyond it.
    ///
    /// Several sources at once because the priority lists ask the question the
    /// other way round: not "how far is this hex from that one" but "which of
    /// these candidates is closest to any location of that kind". One sweep out
    /// from the locations answers it for every candidate.
    ///
    /// That the two agree needs an argument, since a sweep from many sources may
    /// leave one occupied source and cross to another. Both ends of a walk are
    /// allowed to be occupied and only the hexes between must be clear, so the
    /// sweep and a walk measured from the candidate use the same edges. And a
    /// route that passes *through* one source on the way to a second cannot beat
    /// the answer: it is at least as long as the route to the source it passed
    /// through, which is already in the minimum.
    pub fn sweep(&mut self, size: BoardSize, units: &Board, sources: &[HexIdx], into: &mut Steps) {
        let board = board_for(size);
        into.0 = [-1; HEX_COUNT];

        // Who stands where, once: the loop below would otherwise ask the
        // position about every hex it touches.
        self.occupied = [false; HEX_COUNT];
        for hex in units.hexes() {
            self.occupied[*hex as usize] = true;
        }

        self.frontier.clear();
        for source in sources {
            if *source == NONE || into.0[*source as usize] != -1 {
                continue;
            }
            if !board.on_board[*source as usize] {
                continue;
            }
            into.0[*source as usize] = 0;
            self.frontier.push(*source);
            // A walk may start on an occupied hex — its own — and may end on
            // one, but may not pass through one. Seeds are the exception.
            self.occupied[*source as usize] = false;
        }

        while !self.frontier.is_empty() {
            self.next.clear();
            for hex in &self.frontier {
                // Whatever stands here blocks the way through it.
                if self.occupied[*hex as usize] {
                    continue;
                }
                let d = into.0[*hex as usize] + 1;
                let n = board.adjacent_len[*hex as usize] as usize;
                for k in 0..n {
                    let neighbour = board.adjacent[*hex as usize][k];
                    if into.0[neighbour as usize] != -1 {
                        continue;
                    }
                    into.0[neighbour as usize] = d;
                    self.next.push(neighbour);
                }
            }
            std::mem::swap(&mut self.frontier, &mut self.next);
        }
    }
}

// ---------------------------------------------------------------------------
// How the chart classifies the board
// ---------------------------------------------------------------------------

type Locations = ArrayVec<HexIdx, 14>;
type Stacks = ArrayVec<HexIdx, { wc_core::types::MAX_STACKS }>;

#[derive(Default)]
pub struct Sense {
    pub me: Team,
    /// Locations under my control.
    pub friendly: Locations,
    /// Locations under the opponent's control.
    pub enemy: Locations,
    /// Locations nobody controls.
    pub neutral: Locations,
    /// Locations with an enemy unit standing on them.
    pub enemy_occupied: Locations,
    pub enemy_units: Stacks,
    pub my_units: Stacks,
    pub centre: HexIdx,
}

impl Sense {
    pub fn fill(&mut self, size: BoardSize, units: &Board, control: &wc_core::types::ControlMap, me: Team) {
        let board = board_for(size);
        self.me = me;
        self.friendly.clear();
        self.enemy.clear();
        self.neutral.clear();
        self.enemy_occupied.clear();
        self.enemy_units.clear();
        self.my_units.clear();

        for loc in &board.locations {
            let owner = control[*loc as usize];
            if owner == wc_core::types::NO_SEAT {
                self.neutral.push(*loc);
            } else if owner == me {
                self.friendly.push(*loc);
            } else {
                self.enemy.push(*loc);
            }
        }

        for (hex, stack) in units.iter() {
            if stack.team == me {
                self.my_units.push(hex);
            } else {
                self.enemy_units.push(hex);
            }
        }

        // Enemy locations, then neutral, then friendly — keeping only the ones
        // an enemy unit is standing on. The order is the chart's.
        let mut occupied: Locations = ArrayVec::new();
        for group in [&self.enemy, &self.neutral, &self.friendly] {
            for loc in group {
                if units.get(*loc).map(|s| s.team != me).unwrap_or(false) {
                    occupied.push(*loc);
                }
            }
        }
        self.enemy_occupied = occupied;
        self.centre = centre_of(size);
    }
}

/// The chart's last tie-breaker is "closest to the center hex". The board has no
/// printed centre, so it is taken as the hex whose greatest distance to any
/// other board hex is smallest — the middle of the map by plain geometry.
pub fn centre_of(size: BoardSize) -> HexIdx {
    static CENTRES: LazyLock<[HexIdx; 2]> = LazyLock::new(|| {
        let compute = |size: BoardSize| {
            let hexes = &board_for(size).hexes;
            let mut best = hexes[0];
            let mut best_score = u32::MAX;
            for hex in hexes {
                let mut worst = 0u32;
                let mut total = 0u32;
                for other in hexes {
                    let d = DIST[*hex as usize][*other as usize] as u32;
                    total += d;
                    if d > worst {
                        worst = d;
                    }
                }
                let score = worst * 1000 + total;
                if score < best_score {
                    best_score = score;
                    best = *hex;
                }
            }
            best
        };
        [compute(BoardSize::Duel), compute(BoardSize::Team)]
    });
    CENTRES[size.slot()]
}

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

/// Keeps the candidates that tie for the smallest value; empty if none is finite.
pub fn keep_smallest(left: &[u32], value: impl Fn(u32) -> f32, out: &mut Vec<u32>) {
    out.clear();
    let mut best = f32::INFINITY;
    for item in left {
        let v = value(*item);
        if v < best {
            best = v;
        }
    }
    if !best.is_finite() {
        return;
    }
    for item in left {
        if value(*item) == best {
            out.push(*item);
        }
    }
}

/// The same, when the values were gathered ahead of the comparison because each
/// candidate is measured against a different field. `values` runs parallel to
/// `left`.
pub fn keep_smallest_values(left: &[u32], values: &[f32], out: &mut Vec<u32>) {
    out.clear();
    let mut best = f32::INFINITY;
    for v in values {
        if *v < best {
            best = *v;
        }
    }
    if !best.is_finite() {
        return;
    }
    for (k, item) in left.iter().enumerate() {
        if values[k] == best {
            out.push(*item);
        }
    }
}

/// Keeps the candidates that tie for the largest value.
pub fn keep_largest(left: &[u32], value: impl Fn(u32) -> f32, out: &mut Vec<u32>) {
    out.clear();
    let mut best = f32::NEG_INFINITY;
    for item in left {
        let v = value(*item);
        if v > best {
            best = v;
        }
    }
    if !best.is_finite() {
        return;
    }
    for item in left {
        if value(*item) == best {
            out.push(*item);
        }
    }
}

/// Keeps the candidates that satisfy the test.
pub fn keep_if(left: &[u32], test: impl Fn(u32) -> bool, out: &mut Vec<u32>) {
    out.clear();
    for item in left {
        if test(*item) {
            out.push(*item);
        }
    }
}

/// One line of an "order of priorities" list, applied.
///
/// A criterion that narrows the field to exactly one candidate ends the list; a
/// criterion nothing satisfies is skipped, since the chart says to carry on
/// "using only those that applied" and none did.
///
/// Returns `true` when the list is settled and the caller should stop.
pub fn step_of_priority(left: &mut Vec<u32>, kept: &mut Vec<u32>) -> bool {
    if kept.is_empty() {
        return false;
    }
    std::mem::swap(left, kept);
    left.len() == 1
}
