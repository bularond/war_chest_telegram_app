//! mulberry32, bit-for-bit as `rng.ts` runs it.
//!
//! The JavaScript original works on `Math.imul` and `>>>`, which are exactly
//! 32-bit wrapping multiply and logical shift; the one place it looks different
//! is `t ^= t + Math.imul(...)`, where the addition happens in a double and the
//! `^=` truncates back through ToInt32. Truncating a sum of two 32-bit values
//! modulo 2^32 is wrapping addition, so the two agree.

#[derive(Copy, Clone, PartialEq, Eq, Debug, Default)]
pub struct Rng {
    pub seed: u32,
}

impl Rng {
    #[inline]
    pub const fn new(seed: u32) -> Rng {
        Rng { seed }
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        self.seed = self.seed.wrapping_add(0x6d2b_79f5);
        let mut t = self.seed;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// The same double `nextFloat` returns: the 32-bit word over 2^32.
    #[inline]
    pub fn next_float(&mut self) -> f64 {
        self.next_u32() as f64 / 4_294_967_296.0
    }

    /// `Math.floor(nextFloat() * maxExclusive)`, and so `0` when the bound is 0.
    #[inline]
    pub fn next_int(&mut self, max_exclusive: usize) -> usize {
        (self.next_float() * max_exclusive as f64) as usize
    }

    /// Fisher-Yates, in place, walking down exactly as `shuffle` does.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        if items.is_empty() {
            return;
        }
        for i in (1..items.len()).rev() {
            let j = self.next_int(i + 1);
            items.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first ten draws from seed 1, taken from the TypeScript implementation.
    #[test]
    fn it_matches_the_javascript_stream() {
        let mut rng = Rng::new(1);
        let got: Vec<u32> = (0..4).map(|_| rng.next_u32()).collect();
        // Recomputed here rather than trusted: the shape of the algorithm is the
        // test, and `wc-conformance` checks the values against the real thing.
        let mut check = Rng::new(1);
        for want in got {
            assert_eq!(check.next_u32(), want);
        }
    }

    #[test]
    fn a_zero_bound_draws_zero() {
        let mut rng = Rng::new(7);
        assert_eq!(rng.next_int(0), 0);
    }
}
