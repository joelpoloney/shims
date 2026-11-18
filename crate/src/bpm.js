// Tempo from audio. The player feeds this the samples of a silent, sped-up
// pass; it keeps how loud the low end is every ~12 ms of track time, turns
// that into "where the hits are", and looks for the spacing that repeats.
// It can't tell a tempo from its half or double (87 against 174): the one
// nearer the middle of dance tempos wins, and anything above 160 is halved.

const HOP_SEC = 0.0116;
const LOW_HZ = 180;      // kicks and bass carry the beat
const MIN_SEC = 12;      // less audio than this says nothing
const SLOWEST = 62, FASTEST = 200;
const HALVE_ABOVE = 160;

// rate: how much faster than real time the samples arrive.
export function tempoMeter(sampleRate, rate) {
  const hop = Math.max(8, Math.round(sampleRate * HOP_SEC / rate));
  const hopSec = hop * rate / sampleRate;
  const a = 1 - Math.exp(-2 * Math.PI * Math.min(0.45, LOW_HZ * rate / sampleRate));
  const env = [];
  let low = 0, sum = 0, n = 0;
  return {
    feed(data) {
      for (let i = 0; i < data.length; i++) {
        low += a * (data[i] - low);
        sum += low * low;
        if (++n === hop) { env.push(sum); sum = 0; n = 0; }
      }
    },
    seconds: () => env.length * hopSec,
    result: () => estimate(env, hopSec),
  };
}

// → { bpm, sure } or null. `sure` is 0–1: how much of the rhythm the tempo explains.
export function estimate(env, hopSec) {
  const n = env.length;
  if (n * hopSec < MIN_SEC) return null;
  let max = 0;
  for (let i = 0; i < n; i++) if (env[i] > max) max = env[i];
  if (!max) return null;
  // Rises in loudness only, on a compressed scale so quiet parts still count.
  const on = new Float32Array(n);
  let prev = Math.log1p(1000 * env[0] / max), mean = 0;
  for (let i = 1; i < n; i++) {
    const cur = Math.log1p(1000 * env[i] / max);
    on[i] = Math.max(0, cur - prev);
    mean += on[i];
    prev = cur;
  }
  mean /= n;
  for (let i = 0; i < n; i++) on[i] -= mean;

  const maxLag = Math.min(Math.floor(n / 2), Math.ceil(16 * 60 / SLOWEST / hopSec) + 2);
  const acf = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += on[i] * on[i + lag];
    acf[lag] = s / (n - lag);
  }
  if (acf[0] <= 0) return null;
  const at = (lag) => {
    if (lag >= maxLag) return 0;
    const i = Math.floor(lag), f = lag - i;
    return acf[i] * (1 - f) + acf[i + 1] * f;
  };
  // A real tempo repeats at one, two, three and four beats. Three matters: a
  // breakbeat also repeats every beat and a half, which is no tempo at all.
  let best = 0, bestBpm = 0, bestRaw = 0;
  const rawAt = (bpm) => { const lag = 60 / bpm / hopSec; return at(lag) + 0.6 * at(2 * lag) + 0.6 * at(3 * lag) + 0.4 * at(4 * lag); };
  for (let bpm = SLOWEST; bpm <= FASTEST; bpm += 0.25) {
    const raw = rawAt(bpm);
    const octaves = Math.log2(bpm / 125);
    const score = raw * Math.exp(-0.5 * (octaves / 0.75) ** 2);
    if (score > best) { best = score; bestBpm = bpm; bestRaw = raw; }
  }
  if (!bestBpm) return null;
  // A breakbeat repeats every beat and a half too, and the pull toward the
  // middle can pick that. Between tempos 3:2 apart, the stronger rhythm wins.
  const around = (c) => { let m = [0, c]; for (let x = c - 2; x <= c + 2; x += 0.25) { const r = rawAt(x); if (r > m[0]) m = [r, x]; } return m; };
  for (const c of [bestBpm * 1.5, bestBpm / 1.5]) {
    if (c < SLOWEST || c > FASTEST) continue;
    const [r, x] = around(c);
    if (r > bestRaw * 1.05) { bestRaw = r; bestBpm = x; }
  }
  // One beat is only a few dozen steps long, so sharpen the answer on the
  // longer spans the same tempo must also repeat at.
  let fine = bestBpm, fineScore = -Infinity;
  for (let bpm = bestBpm - 1.5; bpm <= bestBpm + 1.5; bpm += 0.05) {
    const lag = 60 / bpm / hopSec;
    let s = 0;
    for (const beats of [4, 8, 16]) if (beats * lag < maxLag) s += at(beats * lag);
    if (s > fineScore) { fineScore = s; fine = bpm; }
  }
  if (fineScore > 0) bestBpm = Math.round(fine * 20) / 20;
  // The shops list drum & bass at half time (87, not 174); so does this.
  if (bestBpm > HALVE_ABOVE) bestBpm /= 2;
  return { bpm: Math.round(bestBpm), exact: bestBpm, sure: Math.max(0, Math.min(1, bestRaw / (2.6 * acf[0]))) };
}
