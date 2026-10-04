// Shared maths for the trackers. Landmark indices are MediaPipe Pose's (33 points).
export const NOSE = 0, L_EYE = 2, R_EYE = 5, L_MOUTH = 9, R_MOUTH = 10, L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14,
  L_WR = 15, R_WR = 16, L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26, L_ANK = 27, R_ANK = 28;
export const BONES = [[L_SH, R_SH], [L_SH, L_EL], [L_EL, L_WR], [R_SH, R_EL], [R_EL, R_WR], [L_SH, L_HIP], [R_SH, R_HIP],
  [L_HIP, R_HIP], [L_HIP, L_KNEE], [L_KNEE, L_ANK], [R_HIP, R_KNEE], [R_KNEE, R_ANK]];
export const G = 9.81;
export const ETA_CONC = 0.22, ECC_COST = 0.35, KCAL_PER_J = 1 / 4184;   // as tools/scripts/analyze_pullups3.py
export const FAIL_SHORT_PCT = 0.60, VL_LANDMARKS = [25, 50], TOP_BAND_M = 0.03;

export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const mul = (a, k) => a.map((x) => x * k);
export const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
export const norm = (a) => Math.sqrt(dot(a, a));
export const mid = (a, b) => a.map((x, i) => (x + b[i]) / 2);
export const clip = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
export const median = (v) => { const s = [...v].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
export const ptp = (v) => Math.max(...v) - Math.min(...v);
export function angle(a, b, c) {
  const v1 = sub(a, b), v2 = sub(c, b);
  return deg(Math.acos(clip(dot(v1, v2) / (norm(v1) * norm(v2) + 1e-9), -1, 1)));
}
export const vlZone = (vl) => vl < VL_LANDMARKS[0] ? "under 25 %: fresh" : vl < VL_LANDMARKS[1] ? "25-50 %: past the training cut-off" : "over 50 %: grinding";

// Causal exponential filter with a time constant, for uneven frame times.
export class Ema {
  constructor(tau) { this.tau = tau; this.v = null; }
  step(x, dt) {
    if (this.v === null || !Number.isFinite(this.v)) this.v = x;
    else if (Number.isFinite(x)) this.v += (1 - Math.exp(-dt / this.tau)) * (x - this.v);
    return this.v;
  }
}
