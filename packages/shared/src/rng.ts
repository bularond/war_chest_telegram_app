/**
 * Deterministic PRNG, for the seeds this side of the boundary derives.
 *
 * The engine has its own — the same mulberry32, in `wc-core` — and it is the one
 * that shuffles a bag. Nothing here has to agree with it: what is left in
 * TypeScript is a stream for a test policy to draw from and a way for the server
 * to derive one bot seed from another, and neither is a rule.
 */

export interface RngState {
  seed: number;
}

export function createRng(seed: number): RngState {
  return { seed: seed >>> 0 };
}

/** mulberry32 — small, fast, and reproducible from the seed. */
export function nextFloat(rng: RngState): number {
  rng.seed = (rng.seed + 0x6d2b79f5) >>> 0;
  let t = rng.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function nextInt(rng: RngState, maxExclusive: number): number {
  return Math.floor(nextFloat(rng) * maxExclusive);
}
