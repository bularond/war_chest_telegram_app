//! Hex geometry for the War Chest board.
//!
//! The physical board uses flat-top hexes laid out in columns, where odd columns
//! are pushed DOWN by half a hex — the "odd-q" offset layout. Public coordinates
//! stay offset `(col, row)` because that is what the printed board looks like;
//! everything geometric converts to axial first.
//!
//! Unlike the TypeScript original a hex is never a string here. Every board hex
//! has a number — its index into `board::HEXES` — and that number is what the
//! engine passes around. `Hex` exists for the two places that need coordinates:
//! building the tables below, and talking to the outside world.

/// Offset coordinates of a hex on the printed board.
#[derive(Copy, Clone, PartialEq, Eq, Debug, Hash)]
pub struct Hex {
    pub col: i8,
    pub row: i8,
}

impl Hex {
    pub const fn new(col: i8, row: i8) -> Self {
        Hex { col, row }
    }
}

/// Axial coordinates (q = column, s = "diagonal row").
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct Axial {
    pub q: i16,
    pub s: i16,
}

pub const fn to_axial(h: Hex) -> Axial {
    let col = h.col as i16;
    Axial { q: col, s: h.row as i16 - (col - (col & 1)) / 2 }
}

pub const fn from_axial(a: Axial) -> Hex {
    Hex { col: a.q as i8, row: (a.s + (a.q - (a.q & 1)) / 2) as i8 }
}

/// The six axial directions, clockwise from "east". `DIRECTIONS[i]` and
/// `DIRECTIONS[(i + 3) % 6]` are opposites.
pub const DIRECTIONS: [Axial; 6] = [
    Axial { q: 1, s: 0 },
    Axial { q: 1, s: -1 },
    Axial { q: 0, s: -1 },
    Axial { q: -1, s: 0 },
    Axial { q: -1, s: 1 },
    Axial { q: 0, s: 1 },
];

pub const fn step(h: Hex, dir: Axial, times: i16) -> Hex {
    let a = to_axial(h);
    from_axial(Axial { q: a.q + dir.q * times, s: a.s + dir.s * times })
}

pub fn neighbors(h: Hex) -> [Hex; 6] {
    let mut out = [h; 6];
    let mut i = 0;
    while i < 6 {
        out[i] = step(h, DIRECTIONS[i], 1);
        i += 1;
    }
    out
}

pub const fn distance(a: Hex, b: Hex) -> u8 {
    let x = to_axial(a);
    let y = to_axial(b);
    let dq = x.q - y.q;
    let ds = x.s - y.s;
    (((dq.abs()) + ((dq + ds).abs()) + (ds.abs())) / 2) as u8
}

/// Screen position of a hex centre, for a flat-top hex of the given radius.
pub fn pixel_center(h: Hex, radius: f64) -> (f64, f64) {
    let w = 3f64.sqrt() * radius;
    let x = 1.5 * radius * h.col as f64;
    let y = w * h.row as f64 + if h.col & 1 != 0 { w / 2.0 } else { 0.0 };
    (x, y)
}

/// `"col,row"` — the shape a hex has on the wire and in the TypeScript engine.
pub fn hex_id(h: Hex) -> String {
    format!("{},{}", h.col, h.row)
}

/// Parses `"col,row"`. Returns `None` on anything else.
pub fn parse_hex_id(id: &str) -> Option<Hex> {
    let (col, row) = id.split_once(',')?;
    Some(Hex { col: col.parse().ok()?, row: row.parse().ok()? })
}
