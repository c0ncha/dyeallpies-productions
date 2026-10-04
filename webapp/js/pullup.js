// Live pull-up tracker: a port of tools/scripts/live_pullups.py (class LiveSet), same constants
// and rules. Unrectified: the scale and the bar come from the dead hang, the chin verdict is the
// image-plane face-axis chin in a +-3 cm band with no depth allowance, every filter is causal.
import { Ema, G, ETA_CONC, ECC_COST, KCAL_PER_J, FAIL_SHORT_PCT, VL_LANDMARKS, TOP_BAND_M, NOSE, L_EYE, R_EYE, L_MOUTH, R_MOUTH,
  L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, sub, add, mul, norm, mid, clip, angle, median, mean, ptp, vlZone } from "./util.js";
import { LiveMuscles } from "./muscles.js";

const ARM_FRAC = 0.332, WRIST_BELOW_BAR = 0.08, LIFTED_FRAC = 0.956, CHIN_AXIS_K = 0.60, VERDICT_BAND_CM = 3.0;
const MIN_ROM_M = 0.20, START_H = 0.04, START_V = 0.10;
const GREEN = "#5adc5a", AMBER = "#ffbe3c", RED = "#f04646", DIM = "#aaaaaa", WHITE = "#f5f5f5";
const VERDICT_COL = { above: GREEN, at: AMBER, short: RED };

export class PullupSet {
  static id = "pullup"; static label = "Pull-ups";
  static setupHint = "hang with straight arms to calibrate";
  phaseColors = { SETUP: DIM, HANG: DIM, PULL: GREEN, HOLD: AMBER, LOWER: "#3caaff", DONE: WHITE };

  constructor(height, mass, frameH) {
    this.height = height; this.mLift = LIFTED_FRAC * mass; this.frameH = frameH;
    this.mus = new LiveMuscles(this.mLift);
    this.reset();
  }
  reset() {
    this.state = "SETUP"; this.ppm = this.barY = this.baseY = null;
    this.reps = []; this.count = 0; this.cur = null; this.pending = null;
    this.tPrev = null; this.h = 0; this.v = 0; this.hPrev = null; this.vPrev = null; this.acc = 0;
    this.el3 = this.el2 = NaN; this.chinCm = NaN;
    this.fSh = new Ema(0.06); this.fV = new Ema(0.10); this.fEl3 = new Ema(0.08); this.fEl2 = new Ema(0.08);
    this.fChin = new Ema(0.06); this.fA = new Ema(0.15);
    this.hangWin = []; this.tOff = null; this.tLost = null; this.lastSeen = null; this.tGrab = null; this.summary = null;
    this.mus.reset();
  }
  get onBar() { return ["HANG", "PULL", "HOLD", "LOWER"].includes(this.state); }

  // the dead hang: scale and bar. The last steady arms-straight window before the first pull wins.
  _calibrate(t, P, shY, wrY, armPx, straight) {
    if (!straight) { this.hangWin = []; return; }
    const seg = [[L_WR, L_EL], [L_EL, L_SH], [R_WR, R_EL], [R_EL, R_SH]].map(([a, b]) => norm(sub(P[a], P[b])));
    this.hangWin.push([t, shY, wrY, armPx, ...seg]);
    while (t - this.hangWin[0][0] > 0.5) this.hangWin.shift();
    const a = this.hangWin, col = (i) => a.map((r) => r[i]);
    if (a[a.length - 1][0] - a[0][0] < 0.3 || ptp(col(1)) > 0.015 * this.frameH) return;
    this.ppm = median(col(3)) / (ARM_FRAC * this.height - WRIST_BELOW_BAR);
    this.barY = median(col(2)) - WRIST_BELOW_BAR * this.ppm;
    this.baseY = median(col(1));
    const s = [4, 5, 6, 7].map((i) => median(col(i)) / this.ppm);
    this.mus.L = { l: [s[0], s[1]], r: [s[2], s[3]] };
    if (this.state === "SETUP") { this.state = "HANG"; this.tGrab = t; }
  }
  _finishPending() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.elbow_bottom_after = p._el3; p.elbow2d_bottom_after = p._el2; delete p._el3; delete p._el2;
    p.lockout = p.elbow_bottom_after >= 150 && p.elbow2d_bottom_after >= 160;
    const peakRef = Math.max(...this.reps.map((r) => r.peak_conc_v));
    const rom = 25 * clip(1 + Math.min(p.chin_cm, 0) / 10, 0, 1), lock = 15 * clip((p.elbow_bottom_after - 120) / 35, 0, 1);
    const ctrl = 20 * clip(p.t_eccentric / 1.5, 0, 1), sway = 15 * clip(1 - (p.hip_sway_cm - 4) / 16, 0, 1);
    const sym = 10 * clip(1 - (Math.abs(p.sh_dy_top_cm) - 1) / 4, 0, 1), vel = 15 * clip(p.peak_conc_v / peakRef, 0, 1);
    p.score = { rom, lockout: lock, control: ctrl, sway, symmetry: sym, power: vel };
    p.efficiency = rom + lock + ctrl + sway + sym + vel;
  }
  _closeRep() {
    let s = this.cur.samples; this.cur = null;      // [t, h, v, hip_x cm, chin cm, shoulder dy cm]
    const hs0 = s.map((r) => r[1]), iTop0 = hs0.indexOf(Math.max(...hs0));
    // the pull starts where the shoulders last left the base, not at a false start that hovered
    let low = -1;
    for (let i = 0; i < iTop0; i++) if (s[i][1] < START_H + 0.02) low = i;
    if (low >= 0) s = s.slice(low);
    const hs = s.map((r) => r[1]), peak = Math.max(...hs), iTop = hs.indexOf(peak);
    const good = this.reps.filter((r) => !r.failed).map((r) => r.rom_cm / 100);
    const failed = peak < (good.length ? FAIL_SHORT_PCT * median(good) : MIN_ROM_M);
    const atTop = hs.map((h, i) => (h >= peak - TOP_BAND_M ? i : -1)).filter((i) => i >= 0), i0 = atTop[0], i1 = atTop[atTop.length - 1];
    const tConc = Math.max(s[i0][0] - s[0][0], 1e-3), tHold = s[i1][0] - s[i0][0], tEcc = Math.max(s[s.length - 1][0] - s[i1][0], 1e-3);
    const chin = s[iTop][4], verdict = chin >= VERDICT_BAND_CM ? "above" : chin >= -VERDICT_BAND_CM ? "at" : "short";
    const work = this.mLift * G * peak, hip = s.map((r) => r[3]);
    const a = {
      rep: this.reps.filter((r) => !r.failed).length + (failed ? 0 : 1), n: this.reps.length + 1,
      t_start: s[0][0], t_top: s[iTop][0], t_end: s[s.length - 1][0], failed, rom_cm: peak * 100, chin_cm: chin, chin_verdict: verdict,
      t_concentric: tConc, t_top_hold: tHold, t_eccentric: tEcc,
      peak_conc_v: Math.max(...s.slice(0, i0 + 1).map((r) => r[2])), mean_conc_v: peak / tConc, peak_ecc_v: -Math.min(...s.slice(i1).map((r) => r[2])),
      hip_sway_cm: ptp(hip), sh_dy_top_cm: s[iTop][5], work_j: work, mean_power_w: work / tConc,
      kcal: work / ETA_CONC * (1 + ECC_COST) * KCAL_PER_J,
      fatigued_lats: this.mus.MF["latissimus dorsi"], fatigued_biceps: this.mus.MF["biceps brachii"],
      _el3: this.el3, _el2: this.el2,
    };
    const first = this.reps.find((r) => !r.failed) || a;
    a.velocity_loss_pct = Math.max(1 - a.mean_conc_v / first.mean_conc_v, 0) * 100;
    a.vl_zone = vlZone(a.velocity_loss_pct);
    this.reps.push(a); this.count = this.reps.filter((r) => !r.failed).length; this.pending = a;
  }
  endSet(t) {
    this.cur = null; this._finishPending(); this.state = "DONE";
    const good = this.reps.filter((r) => !r.failed);
    if (!good.length) { this.summary = { reps: 0, attempts: this.reps.length }; return; }
    const cnt = (v) => good.filter((r) => r.chin_verdict === v).length, over = good.find((r) => r.velocity_loss_pct >= VL_LANDMARKS[0]);
    this.summary = {
      reps: good.length, attempts: this.reps.length, hang_time_s: t - this.tGrab,
      chin_above: cnt("above"), chin_at: cnt("at"), chin_short: cnt("short"), lockouts: good.filter((r) => r.lockout).length,
      mean_rom_cm: mean(good.map((r) => r.rom_cm)), mean_chin_cm: mean(good.map((r) => r.chin_cm)),
      velocity_loss_last_pct: good[good.length - 1].velocity_loss_pct, first_rep_over_25pct: over ? over.rep : null,
      mean_efficiency: mean(good.map((r) => r.efficiency)), kcal: this.reps.reduce((s, r) => s + r.kcal, 0),
      px_per_m: this.ppm, bar_y_px: this.barY,
      fatigued_lats: this.mus.MF["latissimus dorsi"], fatigued_biceps: this.mus.MF["biceps brachii"], fatigued_grip: this.mus.MF["forearm flexors"],
      note: `live, unrectified: chin verdict in a +-${VERDICT_BAND_CM} cm band with no depth allowance`,
    };
  }
  // P [33][2] image px, W [33][3] world metres, V [33] visibility; all null when no pose was found
  update(t, P, W, V) {
    const dt = this.tPrev === null ? 1 / 30 : Math.max(t - this.tPrev, 1e-3);
    this.tPrev = t;
    if (this.state === "DONE") return;
    if (!P) {
      this.tLost = this.tLost ?? t;
      if (this.ppm && t - this.tLost > 1.5) this.endSet(t);
      return;
    }
    this.tLost = null;
    const sh = mid(P[L_SH], P[R_SH]), wr = mid(P[L_WR], P[R_WR]), hip = mid(P[L_HIP], P[R_HIP]);
    const mouth = mid(P[L_MOUTH], P[R_MOUTH]), eye = mid(P[L_EYE], P[R_EYE]);
    const chinPt = add(mouth, mul(sub(mouth, eye), CHIN_AXIS_K));
    const shY = this.fSh.step(sh[1], dt);
    const el3 = { l: angle(W[L_SH], W[L_EL], W[L_WR]), r: angle(W[R_SH], W[R_EL], W[R_WR]) };
    this.el3 = this.fEl3.step((el3.l + el3.r) / 2, dt);
    this.el2 = this.fEl2.step((angle(P[L_SH], P[L_EL], P[L_WR]) + angle(P[R_SH], P[R_EL], P[R_WR])) / 2, dt);
    const handsUp = P[L_WR][1] < P[L_SH][1] && P[R_WR][1] < P[R_SH][1], overhead = handsUp && wr[1] < P[NOSE][1];

    if (!this.reps.length && !this.cur) {
      const armPx = (norm(sub(P[L_SH], P[L_WR])) + norm(sub(P[R_SH], P[R_WR]))) / 2;
      this._calibrate(t, P, shY, wr[1], armPx, overhead && this.el2 >= 150);
    }
    if (this.ppm === null) return;

    if (!handsUp) {                       // the release
      this.tOff = this.tOff ?? t;
      if (t - this.tOff > 0.4) {
        if (this.reps.length || this.cur) this.endSet(t); else this.reset();
        return;
      }
    } else this.tOff = null;

    const h = (this.baseY - shY) / this.ppm;
    const v = this.fV.step(this.hPrev === null ? 0 : (h - this.hPrev) / dt, dt);
    this.acc = this.fA.step(this.vPrev === null ? 0 : (v - this.vPrev) / dt, dt);
    this.hPrev = h; this.h = h; this.v = v; this.vPrev = v;

    if (Math.min(V[NOSE], V[L_MOUTH], V[R_MOUTH]) > 0.5) {
      const gap = this.fChin.step((this.barY - chinPt[1]) / this.ppm * 100, dt);
      this.lastSeen = [gap, shY]; this.chinCm = gap;
    } else if (this.lastSeen) this.chinCm = this.lastSeen[0] + (this.lastSeen[1] - shY) / this.ppm * 100;

    if (this.pending) {                   // lock-out is read at the bottom after the rep
      this.pending._el3 = Math.max(this.pending._el3, this.el3); this.pending._el2 = Math.max(this.pending._el2, this.el2);
      if (t - this.pending.t_end > 1.5) this._finishPending();
    }
    if (!this.cur) {
      this.state = "HANG";
      if (Math.abs(v) < 0.05 && Math.abs(h) < 0.06) this.baseY += (1 - Math.exp(-dt / 0.5)) * (shY - this.baseY);
      if (h > START_H && v > START_V) { this._finishPending(); this.cur = { samples: [], peak: 0, hip: [hip[0], hip[0]] }; }
    }
    if (this.cur) {
      const c = this.cur;
      c.samples.push([t, h, v, hip[0] / this.ppm * 100, this.chinCm, (P[L_SH][1] - P[R_SH][1]) / this.ppm * 100]);
      c.peak = Math.max(c.peak, h); c.hip = [Math.min(c.hip[0], hip[0]), Math.max(c.hip[1], hip[0])];
      this.state = v > 0.05 ? "PULL" : v < -0.05 ? "LOWER" : "HOLD";
      if (c.peak >= 0.12 && h < Math.max(0.05, 0.25 * c.peak)) this._closeRep();
      else if (c.peak < 0.12 && h < 0.02) this.cur = null;      // a shrug, not an attempt
    }
    const sway = this.cur ? (this.cur.hip[1] - this.cur.hip[0]) / this.ppm * 100 : 4;
    this.mus.update(dt, P.map((p) => [p[0] / this.ppm, p[1] / this.ppm]), el3, this.acc, this.state, sway);
  }
  // hands overhead again after a finished set: the next one
  wantsNewSet(P) { return P[L_WR][1] < P[NOSE][1] && P[R_WR][1] < P[NOSE][1]; }
  // the counter ticks at the top: once the pull is long enough and has turned around
  get shownCount() {
    const c = this.cur;
    if (!c) return this.count;
    const good = this.reps.filter((r) => !r.failed).map((r) => r.rom_cm / 100);
    const need = good.length ? FAIL_SHORT_PCT * median(good) : MIN_ROM_M;
    return this.count + (c.peak >= need && this.h < c.peak - TOP_BAND_M ? 1 : 0);
  }
  liveRows() {
    const rows = [`elbow ${this.el3.toFixed(0)}°`, `speed ${(this.v >= 0 ? "+" : "") + this.v.toFixed(2)} m/s`, `height ${(this.h * 100).toFixed(0)} cm`];
    const a = this.reps[this.reps.length - 1];
    if (a && !a.failed) rows.push(`speed loss ${a.velocity_loss_pct.toFixed(0)} %`);
    return rows;
  }
  card() {
    const a = this.reps[this.reps.length - 1];
    if (!a) return [];
    if (a.failed) return [[`attempt ${a.n}: short pull (${a.rom_cm.toFixed(0)} cm), not counted`, RED]];
    const sign = (x) => (x > 0 ? "+" : "") + x.toFixed(0);
    return [
      [`rep ${a.rep}: chin ${a.chin_verdict.toUpperCase()} the bar (${sign(a.chin_cm)} cm)`, VERDICT_COL[a.chin_verdict]],
      a.lockout === undefined ? ["lock-out ...", DIM] : [`lock-out ${a.lockout ? "OK" : "SHORT"} (${a.elbow_bottom_after.toFixed(0)}°)`, a.lockout ? GREEN : RED],
      [`up ${a.t_concentric.toFixed(1)} s  down ${a.t_eccentric.toFixed(1)} s  ROM ${a.rom_cm.toFixed(0)} cm` + (a.efficiency !== undefined ? `  score ${a.efficiency.toFixed(0)}` : ""), WHITE],
    ];
  }
  summaryRows() {
    const m = this.summary;
    if (!m.reps) return ["0 reps"];
    return [
      `${m.reps} reps in ${m.hang_time_s.toFixed(0)} s on the bar`,
      `chin: ${m.chin_above} above, ${m.chin_at} at, ${m.chin_short} short`,
      `lock-out: ${m.lockouts}/${m.reps}`,
      `speed loss at the last rep: ${m.velocity_loss_last_pct.toFixed(0)} %`,
      `efficiency: ${m.mean_efficiency.toFixed(0)}/100   ${m.kcal.toFixed(1)} kcal`,
      `fatigued (model): lats ${(m.fatigued_lats * 100).toFixed(0)} %, biceps ${(m.fatigued_biceps * 100).toFixed(0)} %`,
    ];
  }
  snapshot() { return this.mus.snapshot(); }
}
