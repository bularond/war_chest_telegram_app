//! The printed board, reconstructed exactly as `board.ts` builds it, and then
//! flattened into lookup tables.
//!
//! Every geometric question the engine asks — who is adjacent, how far is that,
//! is this a straight line — is answered by an array read here. The board never
//! changes during a game, and the search asks these questions millions of times a
//! second, so nothing below is computed twice.

use crate::hex::{distance, from_axial, hex_id, neighbors, step, to_axial, Axial, Hex, DIRECTIONS};
use std::sync::LazyLock;

/// Index of a hex into [`HEXES`]. `NONE` means "no hex".
pub type HexIdx = u8;

/// One past the last hex index: the value that means "no hex here".
pub const NONE: HexIdx = 255;

/// Slots a hex index can take, `NONE` included. Used to pack move keys.
pub const HEX_SLOTS: u64 = 48;

pub const CENTER_COL: i16 = 5;

/// Two-player or four-player. The discriminant is the seat count, as in the
/// TypeScript `BoardSize`.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum BoardSize {
    Duel = 2,
    Team = 4,
}

impl BoardSize {
    #[inline]
    pub const fn slot(self) -> usize {
        match self {
            BoardSize::Duel => 0,
            BoardSize::Team => 1,
        }
    }

    #[inline]
    pub const fn seats(self) -> usize {
        self as usize
    }

    pub const fn from_seats(n: usize) -> Option<Self> {
        match n {
            2 => Some(BoardSize::Duel),
            4 => Some(BoardSize::Team),
            _ => None,
        }
    }
}

fn to_cube(h: Hex) -> (i16, i16, i16) {
    let a = to_axial(h);
    let x = a.q - CENTER_COL;
    let z = a.s;
    (x, -x - z, z)
}

fn in_hexagon(h: Hex, half_width: i16) -> bool {
    let (x, y, z) = to_cube(h);
    x.abs() <= half_width && y.abs() <= 3 && z.abs() <= 3
}

/// The same scan `buildHexes` runs: column ascending, row ascending, filtered.
fn build_hexes(half_width: i16) -> Vec<Hex> {
    let mut out = Vec::new();
    for col in (CENTER_COL - half_width)..=(CENTER_COL + half_width) {
        for row in -4..=9 {
            let h = Hex::new(col as i8, row as i8);
            if in_hexagon(h, half_width) {
                out.push(h);
            }
        }
    }
    out
}

/// All 47 hexes of the printed board, in the order `FULL_BOARD_HEXES` has them.
pub static HEXES: LazyLock<Vec<Hex>> = LazyLock::new(|| build_hexes(5));

/// Reverse lookup, over the window the scan above can reach.
const COL_SPAN: usize = 11;
const ROW_MIN: i16 = -4;
const ROW_SPAN: usize = 14;

static INDEX: LazyLock<[HexIdx; COL_SPAN * ROW_SPAN]> = LazyLock::new(|| {
    let mut table = [NONE; COL_SPAN * ROW_SPAN];
    for (i, h) in HEXES.iter().enumerate() {
        table[slot_of(*h).expect("board hex outside the scan window")] = i as HexIdx;
    }
    table
});

fn slot_of(h: Hex) -> Option<usize> {
    let col = h.col as i16;
    let row = h.row as i16;
    if !(0..COL_SPAN as i16).contains(&col) {
        return None;
    }
    let r = row - ROW_MIN;
    if !(0..ROW_SPAN as i16).contains(&r) {
        return None;
    }
    Some(col as usize * ROW_SPAN + r as usize)
}

/// The index of a hex, or `NONE` if it is not on the printed board at all.
#[inline]
pub fn index_of(h: Hex) -> HexIdx {
    match slot_of(h) {
        Some(s) => INDEX[s],
        None => NONE,
    }
}

#[inline]
pub fn hex_at(idx: HexIdx) -> Hex {
    HEXES[idx as usize]
}

pub fn id_of(idx: HexIdx) -> String {
    hex_id(hex_at(idx))
}

pub fn index_of_id(id: &str) -> HexIdx {
    match crate::hex::parse_hex_id(id) {
        Some(h) => index_of(h),
        None => NONE,
    }
}

pub const HEX_COUNT: usize = 47;

// ---------------------------------------------------------------------------
// Geometry tables
// ---------------------------------------------------------------------------

/// `STEPS[hex][dir]` — the neighbour in that direction, or `NONE` off the board.
pub static STEPS: LazyLock<[[HexIdx; 6]; HEX_COUNT]> = LazyLock::new(|| {
    let mut table = [[NONE; 6]; HEX_COUNT];
    for (i, h) in HEXES.iter().enumerate() {
        for (k, n) in neighbors(*h).into_iter().enumerate() {
            table[i][k] = index_of(n);
        }
    }
    table
});

/// Hex distance between any two board hexes.
pub static DIST: LazyLock<[[u8; HEX_COUNT]; HEX_COUNT]> = LazyLock::new(|| {
    let mut table = [[0u8; HEX_COUNT]; HEX_COUNT];
    for (i, a) in HEXES.iter().enumerate() {
        for (j, b) in HEXES.iter().enumerate() {
            table[i][j] = distance(*a, *b);
        }
    }
    table
});

/// The direction `to` lies from `from` when the two are on one of the six
/// straight lines, or `NONE`. `straightLineBetween` is then "walk that many
/// steps"; the hexes in between are read off [`STEPS`].
pub static DIR_BETWEEN: LazyLock<[[u8; HEX_COUNT]; HEX_COUNT]> = LazyLock::new(|| {
    let mut table = [[NONE; HEX_COUNT]; HEX_COUNT];
    for (i, a) in HEXES.iter().enumerate() {
        for (j, b) in HEXES.iter().enumerate() {
            if i == j {
                continue;
            }
            let d = DIST[i][j] as i16;
            for (k, dir) in DIRECTIONS.iter().enumerate() {
                if step(*a, *dir, d) == *b {
                    table[i][j] = k as u8;
                    break;
                }
            }
        }
    }
    table
});

/// Whether the hexes strictly between two collinear hexes are all empty of the
/// given occupancy. `d` is their distance; the caller has already checked that
/// [`DIR_BETWEEN`] names a direction.
#[inline]
pub fn ray_clear(from: HexIdx, dir: u8, d: u8, occupied: &impl Fn(HexIdx) -> bool) -> bool {
    let mut hex = from;
    for _ in 1..d {
        hex = STEPS[hex as usize][dir as usize];
        if hex == NONE || occupied(hex) {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Per-size board definition
// ---------------------------------------------------------------------------

/// Hexes reachable at a given table size, plus the adjacency filtered to them.
pub struct BoardDefinition {
    /// Board hexes in `boardFor(size).hexes` order.
    pub hexes: Vec<HexIdx>,
    pub on_board: [bool; HEX_COUNT],
    /// `adjacent()` — up to six neighbours in `DIRECTIONS` order, off-board dropped.
    pub adjacent: [[HexIdx; 6]; HEX_COUNT],
    pub adjacent_len: [u8; HEX_COUNT],
    /// Locations in `boardFor(size).locations` order.
    pub locations: Vec<HexIdx>,
    pub is_location: [bool; HEX_COUNT],
    /// Locations each seat's team starts the game controlling.
    pub starting_locations: Vec<Vec<HexIdx>>,
    pub control_markers: u8,
}

/// All 14 locations on the printed board, in `FULL_BOARD_LOCATIONS` order.
const FULL_BOARD_LOCATION_IDS: [&str; 14] = [
    "0,3", "1,1", "2,3", "3,1", "3,4", "4,0", "4,3", "6,2", "6,5", "7,0", "7,3", "8,2", "9,3",
    "10,2",
];

const STARTING_A: [&str; 2] = ["4,0", "7,0"];
const STARTING_B: [&str; 2] = ["3,4", "6,5"];
const OUTER_A: &str = "1,1";
const OUTER_B: &str = "9,3";

fn build_definition(half_width: i16, control_markers: u8, outer: bool) -> BoardDefinition {
    let hexes: Vec<HexIdx> = build_hexes(half_width).into_iter().map(index_of).collect();
    let mut on_board = [false; HEX_COUNT];
    for h in &hexes {
        on_board[*h as usize] = true;
    }

    let mut adjacent = [[NONE; 6]; HEX_COUNT];
    let mut adjacent_len = [0u8; HEX_COUNT];
    for i in 0..HEX_COUNT {
        let mut n = 0;
        for k in 0..6 {
            let s = STEPS[i][k];
            if s != NONE && on_board[s as usize] {
                adjacent[i][n] = s;
                n += 1;
            }
        }
        adjacent_len[i] = n as u8;
    }

    let locations: Vec<HexIdx> = FULL_BOARD_LOCATION_IDS
        .iter()
        .map(|id| index_of_id(id))
        .filter(|h| on_board[*h as usize])
        .collect();
    let mut is_location = [false; HEX_COUNT];
    for l in &locations {
        is_location[*l as usize] = true;
    }

    let mut a: Vec<HexIdx> = STARTING_A.iter().map(|id| index_of_id(id)).collect();
    let mut b: Vec<HexIdx> = STARTING_B.iter().map(|id| index_of_id(id)).collect();
    if outer {
        a.push(index_of_id(OUTER_A));
        b.push(index_of_id(OUTER_B));
    }

    BoardDefinition {
        hexes,
        on_board,
        adjacent,
        adjacent_len,
        locations,
        is_location,
        starting_locations: vec![a, b],
        control_markers,
    }
}

pub static DUEL_BOARD: LazyLock<BoardDefinition> = LazyLock::new(|| build_definition(3, 6, false));
pub static TEAM_BOARD: LazyLock<BoardDefinition> = LazyLock::new(|| build_definition(5, 8, true));

#[inline]
pub fn board_for(size: BoardSize) -> &'static BoardDefinition {
    match size {
        BoardSize::Duel => &DUEL_BOARD,
        BoardSize::Team => &TEAM_BOARD,
    }
}

/// The half-turn that maps one side of the board onto the other.
pub fn rotate180(idx: HexIdx) -> HexIdx {
    let a = to_axial(hex_at(idx));
    let q = 2 * CENTER_COL - a.q;
    index_of(from_axial(Axial { q, s: -a.s }))
}

/// Where a hex sits along the axis the two players face each other across, in
/// half-rows so that the odd columns hanging half a row lower stay exact.
fn vertical_position(h: Hex) -> i16 {
    h.row as i16 * 2 + if h.col & 1 != 0 { 1 } else { 0 }
}

/// The five duel locations nearest each side — `a` the top half, `b` the bottom.
pub static DUEL_LOCATIONS_BY_SIDE: LazyLock<[Vec<HexIdx>; 2]> = LazyLock::new(|| {
    let centre_row = vertical_position(Hex::new(CENTER_COL as i8, 2));
    let mut a = Vec::new();
    let mut b = Vec::new();
    for loc in &DUEL_BOARD.locations {
        if vertical_position(hex_at(*loc)) < centre_row {
            a.push(*loc);
        } else {
            b.push(*loc);
        }
    }
    [a, b]
});

/// Every Fortification Map Card: two Fortifications among a side's five nearest
/// locations, mirrored for the opponent. C(5,2) = 10 of them.
pub static FORTIFICATION_LAYOUTS: LazyLock<Vec<[HexIdx; 4]>> = LazyLock::new(|| {
    let mine = &DUEL_LOCATIONS_BY_SIDE[0];
    let mut out = Vec::new();
    for i in 0..mine.len() {
        for j in (i + 1)..mine.len() {
            out.push([mine[i], mine[j], rotate180(mine[i]), rotate180(mine[j])]);
        }
    }
    out
});

/// Fortification coins in the box: four go on the board, three to the supply.
pub const FORTIFICATIONS_TOTAL: u8 = 7;
pub const FORTIFICATIONS_ON_BOARD: u8 = 4;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_printed_board_is_forty_seven_hexes() {
        assert_eq!(HEXES.len(), 47);
        assert_eq!(DUEL_BOARD.hexes.len(), 37);
        assert_eq!(TEAM_BOARD.hexes.len(), 47);
    }

    #[test]
    fn the_duel_board_keeps_ten_of_the_fourteen_locations() {
        assert_eq!(TEAM_BOARD.locations.len(), 14);
        assert_eq!(DUEL_BOARD.locations.len(), 10);
    }

    #[test]
    fn the_two_halves_mirror_each_other() {
        assert_eq!(DUEL_LOCATIONS_BY_SIDE[0].len(), 5);
        assert_eq!(DUEL_LOCATIONS_BY_SIDE[1].len(), 5);
        for loc in &DUEL_LOCATIONS_BY_SIDE[0] {
            assert!(DUEL_LOCATIONS_BY_SIDE[1].contains(&rotate180(*loc)));
        }
        assert_eq!(FORTIFICATION_LAYOUTS.len(), 10);
    }

    #[test]
    fn indices_round_trip_through_their_printed_ids() {
        for (i, h) in HEXES.iter().enumerate() {
            assert_eq!(index_of_id(&hex_id(*h)), i as HexIdx);
        }
    }

    #[test]
    fn a_straight_line_walks_the_direction_it_names() {
        for i in 0..HEX_COUNT {
            for j in 0..HEX_COUNT {
                let dir = DIR_BETWEEN[i][j];
                if dir == NONE {
                    continue;
                }
                let mut hex = i as HexIdx;
                for _ in 0..DIST[i][j] {
                    hex = STEPS[hex as usize][dir as usize];
                }
                assert_eq!(hex, j as HexIdx);
            }
        }
    }
}
