//! Royal Decrees, from War Chest: Nobility.
//!
//! Three of the seven are dealt face up at setup. A player proclaims by
//! discarding the Royal Coin face up, placing one of their three Proclamation
//! Seals on a Decree and carrying out its ability — so each side gets each
//! Decree once per game.

#[derive(Copy, Clone, PartialEq, Eq, Debug, Hash)]
#[repr(u8)]
pub enum DecreeId {
    Sacrifice = 0,
    Guard,
    March,
    Enlist,
    Redeploy,
    Spy,
    Reinforce,
}

pub const DECREE_COUNT: usize = 7;

pub const DECREE_IDS: [DecreeId; DECREE_COUNT] = {
    use DecreeId::*;
    [Sacrifice, Guard, March, Enlist, Redeploy, Spy, Reinforce]
};

pub const DECREE_KEYS: [&str; DECREE_COUNT] =
    ["sacrifice", "guard", "march", "enlist", "redeploy", "spy", "reinforce"];

impl DecreeId {
    pub fn key(self) -> &'static str {
        DECREE_KEYS[self as usize]
    }

    pub fn from_key(key: &str) -> Option<DecreeId> {
        DECREE_KEYS.iter().position(|k| *k == key).map(|i| DECREE_IDS[i])
    }

    pub fn from_idx(i: usize) -> Option<DecreeId> {
        DECREE_IDS.get(i).copied()
    }
}

/// Decrees dealt face up for a game, and Seals each side may spend.
pub const DECREES_IN_PLAY: usize = 3;
pub const SEALS_PER_SIDE: u8 = 3;

/// A Decree on the table, with the sides that have already used it.
///
/// The teams are a list rather than a bitmask because the order is the order
/// they proclaimed in, and that order is part of the state a conformance run
/// compares byte for byte.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DecreeInPlay {
    pub id: DecreeId,
    pub seals: arrayvec::ArrayVec<u8, 4>,
}

impl DecreeInPlay {
    pub fn new(id: DecreeId) -> DecreeInPlay {
        DecreeInPlay { id, seals: arrayvec::ArrayVec::new() }
    }

    #[inline]
    pub fn has_seal(&self, team: u8) -> bool {
        self.seals.contains(&team)
    }

    #[inline]
    pub fn add_seal(&mut self, team: u8) {
        self.seals.push(team);
    }
}
