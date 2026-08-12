/**
 * Logistic regression: weights fitted to who actually won.
 *
 * The other two tuners ask "is this change worth keeping" and pay hundreds of
 * games for one answer. This asks a different question — "given these features,
 * what fraction of games were won from here" — and answers it for every weight
 * at once, from games that cost nothing to play because nobody is searching in
 * them.
 *
 * What it fits is `P(win) = σ(w · f)`, minimising log loss by plain gradient
 * descent with a little L2. That the evaluation is `tanh(w · f)` rather than a
 * probability does not matter to the fit: `tanh(x) = 2σ(2x) − 1`, so the same
 * vector orders positions the same way either side of the transform, and the
 * scale is swallowed by `tanh` anyway.
 *
 * **What it cannot do.** The label is the outcome of a game played by whatever
 * policy collected it. Fit on heuristic self-play, the weights predict who wins
 * *under heuristic play*, which is a proxy for the real thing and not the real
 * thing. So the output is a candidate, exactly like SPSA's: it becomes a
 * baseline when an SPRT says so, and not before.
 */

export interface Sample {
  /** One position. */
  readonly features: readonly number[];
  /** 1 if the side these features are written for went on to win, 0 if not, 0.5 for a draw. */
  readonly result: number;
  /** Down-weights positions from the same game, which are anything but independent. */
  readonly weight?: number;
}

export interface FitSettings {
  readonly steps: number;
  readonly rate: number;
  /** L2, to keep a feature that barely appears from bolting. */
  readonly l2: number;
}

export const DEFAULT_FIT: FitSettings = { steps: 400, rate: 1.5, l2: 1e-4 };

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Mean log loss, the thing being minimised. Reported so a run can be judged. */
export function logLoss(samples: readonly Sample[], w: readonly number[]): number {
  let total = 0;
  let mass = 0;
  for (const s of samples) {
    const weight = s.weight ?? 1;
    const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(dot(w, s.features))));
    total += weight * -(s.result * Math.log(p) + (1 - s.result) * Math.log(1 - p));
    mass += weight;
  }
  return mass === 0 ? 0 : total / mass;
}

/**
 * Fits by gradient descent. Deterministic: same samples in, same weights out,
 * because a tuner nobody can re-run is a tuner nobody can check.
 */
export function fit(
  samples: readonly Sample[],
  settings: FitSettings = DEFAULT_FIT,
  start?: readonly number[],
): number[] {
  const width = samples[0]?.features.length ?? 0;
  const w = start ? [...start] : new Array<number>(width).fill(0);
  if (samples.length === 0 || width === 0) return w;

  for (let step = 0; step < settings.steps; step++) {
    const grad = new Array<number>(width).fill(0);
    let mass = 0;
    for (const s of samples) {
      const weight = s.weight ?? 1;
      const error = sigmoid(dot(w, s.features)) - s.result;
      for (let i = 0; i < width; i++) {
        grad[i] = (grad[i] as number) + weight * error * (s.features[i] as number);
      }
      mass += weight;
    }
    if (mass === 0) break;
    for (let i = 0; i < width; i++) {
      w[i] = (w[i] as number) - settings.rate * ((grad[i] as number) / mass + settings.l2 * (w[i] as number));
    }
  }
  return w;
}

/**
 * Scales a fitted vector so one coordinate is 1.
 *
 * The evaluation's scale means nothing — `tanh` swallows it, and only the ratios
 * between weights decide anything — but a person reading the numbers needs an
 * anchor, and the rest of this project anchors on `markers`.
 */
export function normalize(w: readonly number[], anchor: number): number[] {
  const scale = w[anchor];
  if (scale === undefined || Math.abs(scale) < 1e-9) return [...w];
  return w.map((x) => Number((x / scale).toFixed(4)));
}

/**
 * Fits the evaluation to what the *search* thought a position was worth, rather
 * than to who eventually won it.
 *
 * Why bother, given `fit` above. A regression on outcomes maximises how well the
 * vector predicts the winner — and the win condition itself predicts the winner
 * better than anything, so the fit shrinks every other feature next to markers.
 * That reads well and steers badly: an evaluation that says little except "who
 * is closer to winning" gives the search nothing to work with in the middlegame,
 * which is exactly where it needs help. Measured, that vector lost heavily.
 *
 * The target here is the search's own backed-up value at the position. That is
 * not circular, because the search saw further than the evaluation did: fitting
 * to it pulls what the search knows down into the function it starts from. It is
 * the same idea as TD-leaf in chess engines.
 *
 * Least squares against `tanh(w · f)`, since that is the shape the evaluation
 * actually has.
 */
export function fitToValues(
  samples: readonly Sample[],
  settings: FitSettings = DEFAULT_FIT,
  start?: readonly number[],
): number[] {
  const width = samples[0]?.features.length ?? 0;
  const w = start ? [...start] : new Array<number>(width).fill(0);
  if (samples.length === 0 || width === 0) return w;

  for (let step = 0; step < settings.steps; step++) {
    const grad = new Array<number>(width).fill(0);
    let mass = 0;
    for (const s of samples) {
      const weight = s.weight ?? 1;
      const guess = Math.tanh(dot(w, s.features));
      // d/dw of ½(tanh(w·f) − v)² is (tanh − v)(1 − tanh²)·f.
      const slope = (guess - s.result) * (1 - guess * guess);
      for (let i = 0; i < width; i++) {
        grad[i] = (grad[i] as number) + weight * slope * (s.features[i] as number);
      }
      mass += weight;
    }
    if (mass === 0) break;
    for (let i = 0; i < width; i++) {
      w[i] = (w[i] as number) - settings.rate * ((grad[i] as number) / mass + settings.l2 * (w[i] as number));
    }
  }
  return w;
}

/** Mean squared error against `tanh(w · f)`, the loss `fitToValues` reduces. */
export function valueLoss(samples: readonly Sample[], w: readonly number[]): number {
  let total = 0;
  let mass = 0;
  for (const s of samples) {
    const weight = s.weight ?? 1;
    const guess = Math.tanh(dot(w, s.features));
    total += weight * (guess - s.result) ** 2;
    mass += weight;
  }
  return mass === 0 ? 0 : total / mass;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}
