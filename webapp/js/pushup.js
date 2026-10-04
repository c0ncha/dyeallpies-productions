// Live push-up tracker, camera at the SIDE. Judged to the same standard as
// tools/scripts/analyze_pushups.py (USMC PFT: elbow at or under 90 deg at the bottom, elbows locked
// at the top, the body straight: shoulder-hip-ankle at least 168 deg), but it is NOT a port of it:
// that analysis reconstructs 3D from one head-on floor camera with one athlete's measured lengths.
// Here everything is read in the image plane of a side view:
//   * the scale comes from the plank: shoulder-to-ankle = (0.818 - 0.039) x stature;
//   * the near arm and the near side of the body (the more visible one) give the 2D elbow angle
//     and the body line; lock-out is 150 deg on that angle (a choice, not from the standard);
//   * a rep is the shoulders back at the top after a descent; under 60 % of the set's range it
//     is an attempt; symmetry cannot be seen from the side, so the score is the other five
//     lines of the offline score rescaled to 100;
//   * work is body weight x 0.66 x the shoulder's rise (the centre of mass sits about two thirds
//     of the way from the toes to the shoulders; an estimate), plus the plank's isometric cost.
import { Ema, G, ETA_CONC, ECC_COST, KCAL_PER_J, FAIL_SHORT_PCT, VL_LANDMARKS, TOP_BAND_M, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR,
  L_HIP, R_HIP, L_ANK, R_ANK, sub, norm, clip, angle, median, mean, ptp, vlZone } from "./util.js";

const SH_FRAC = 0.818, ANK_FRAC = 0.039, ELBOW_BOTTOM = 90, LOCKOUT_DEG = 150, BODY_LINE_DEG = 168, PLANK_MET = 3.0, COM_RISE = 0.66;
const MIN_ROM_M = 0.12, START_D = 0.04, START_V = 0.10;
const GREEN = "#5adc5a", AMBER = "#ffbe3c", RED = "#f04646", DIM = "#aaaaaa", WHITE = "#f5f5f5";
const SIDE = { l: [L_SH, L_EL, L_WR, L_HIP, L_ANK], r: [R_SH, R_EL, R_WR, R_HIP, R_ANK] };

export class PushupSet {
  static id = "pushup"; static label = "Push-ups";
  static setupHint = "camera at your side: hold the top of a push-up to calibrate";
  phaseColors = { SETUP: DIM, PLANK: DIM, LOWER: "#3caaff", HOLD: AMBER, PUSH: GREEN, DONE: WHITE };

  constructor(height, mass, frameH) { this.height = height; this.mass = mass; this.frameH = frameH; this.mus = null; this.reset(); }
  reset() {
    this.state = "SETUP"; this.ppm = this.baseY = null; this.barY = null;
    this.reps = []; this.count = 0; this.cur = null; this.pending = null;
    this.tPrev = null; this.d = 0; this.v = 0; this.dPrev = null; this.elbow = NaN; this.line = NaN;
    this.fSh = new Ema(0.06); this.fV = new Ema(0.10); this.fEl = new Ema(0.08); this.fLine = new Ema(0.08);
    this.win = []; this.tOff = null; this.tLost = null; this.tStart = null; this.summary = null;
  }
  get onBar() { return false; }
  get shownCount() { return this.count; }
  _near(V) {                             // the side of the body the camera sees
    const vis = (s) => SIDE[s].reduce((a, i) => a + V[i], 0);
    return SIDE[vis("l") >= vis("r") ? "l" : "r"];
  }
  _finishPending() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.elbow_top = p._top; delete p._top;
    p.lockout = p.elbow_top >= LOCKOUT_DEG;
    const peakRef = Math.max(...this.reps.map((r) => r.peak_conc_v));
    const depth = 25 * clip(1 - Math.max(p.elbow_bottom - ELBOW_BOTTOM, 0) / 30, 0, 1), lock = 15 * clip((p.elbow_top - 130) / 30, 0, 1);
    const line = 20 * clip(1 - Math.max(0, BODY_LINE_DEG - p.body_line_min) / 15, 0, 1), ctrl = 15 * clip(p.t_eccentric / 1.0, 0, 1);
    const vel = 15 * clip(p.peak_conc_v / peakRef, 0, 1);
    p.score = { depth, lockout: lock, body_line: line, control: ctrl, power: vel };
    p.efficiency = (depth + lock + line + ctrl + vel) / 90 * 100;
  }
  _closeRep() {
    let s = this.cur.samples; this.cur = null;      // [t, drop m, v (+ down), elbow, body line]
    const ds0 = s.map((r) => r[1]), iB0 = ds0.indexOf(Math.max(...ds0));
    let low = -1;
    for (let i = 0; i < iB0; i++) if (s[i][1] < START_D + 0.02) low = i;
    if (low >= 0) s = s.slice(low);
    const ds = s.map((r) => r[1]), peak = Math.max(...ds);
    const good = this.reps.filter((r) => !r.failed).map((r) => r.rom_cm / 100);
    const failed = peak < (good.length ? FAIL_SHORT_PCT * median(good) : MIN_ROM_M);
    const atB = ds.map((d, i) => (d >= peak - TOP_BAND_M ? i : -1)).filter((i) => i >= 0), i0 = atB[0], i1 = atB[atB.length - 1];
    const tEcc = Math.max(s[i0][0] - s[0][0], 1e-3), tHold = s[i1][0] - s[i0][0], tConc = Math.max(s[s.length - 1][0] - s[i1][0], 1e-3);
    const elbowBottom = Math.min(...s.map((r) => r[3])), lineMin = Math.min(...s.map((r) => r[4]));
    const work = this.mass * G * COM_RISE * peak, plankW = PLANK_MET * 3.5 * this.mass / 1000 * 5 / 60 * 4184;
    const a = {
      rep: good.length + (failed ? 0 : 1), n: this.reps.length + 1, t_start: s[0][0], t_bottom: s[i0][0], t_end: s[s.length - 1][0], failed,
      rom_cm: peak * 100, elbow_bottom: elbowBottom, depth_pass: elbowBottom <= ELBOW_BOTTOM, body_line_min: lineMin, straight: lineMin >= BODY_LINE_DEG,
      t_eccentric: tEcc, t_bottom_hold: tHold, t_concentric: tConc,
      peak_conc_v: -Math.min(...s.slice(i1).map((r) => r[2])), mean_conc_v: peak / tConc, peak_ecc_v: Math.max(...s.slice(0, i0 + 1).map((r) => r[2])),
      work_j: work, mean_power_w: work / tConc,
      kcal: (work / ETA_CONC * (1 + ECC_COST) + plankW * (s[s.length - 1][0] - s[0][0])) * KCAL_PER_J,
      _top: this.elbow,
    };
    const first = this.reps.find((r) => !r.failed) || a;
    a.velocity_loss_pct = Math.max(1 - a.peak_conc_v / first.peak_conc_v, 0) * 100;
    a.vl_zone = vlZone(a.velocity_loss_pct);
    this.reps.push(a); this.count = this.reps.filter((r) => !r.failed).length; this.pending = a;
  }
  endSet(t) {
    this.cur = null; this._finishPending(); this.state = "DONE";
    const good = this.reps.filter((r) => !r.failed);
    if (!good.length) { this.summary = { reps: 0, attempts: this.reps.length }; return; }
    const over = good.find((r) => r.velocity_loss_pct >= VL_LANDMARKS[0]);
    this.summary = {
      reps: good.length, attempts: this.reps.length, time_s: t - this.tStart,
      depth_pass: good.filter((r) => r.depth_pass).length, lockouts: good.filter((r) => r.lockout).length, straight: good.filter((r) => r.straight).length,
      mean_rom_cm: mean(good.map((r) => r.rom_cm)), mean_elbow_bottom: mean(good.map((r) => r.elbow_bottom)), mean_body_line_min: mean(good.map((r) => r.body_line_min)),
      velocity_loss_last_pct: good[good.length - 1].velocity_loss_pct, first_rep_over_25pct: over ? over.rep : null,
      mean_efficiency: mean(good.map((r) => r.efficiency)), kcal: this.reps.reduce((s, r) => s + r.kcal, 0), px_per_m: this.ppm,
      note: "live, side view, image plane: elbow and body line from the near side; symmetry not seen",
    };
  }
  _posture(P, V) {                       // horizontal body on the hands?
    const [sh, el, wr, hip, ank] = this._near(V).map((i) => P[i]);
    const dx = Math.abs(ank[0] - sh[0]), dy = Math.abs(ank[1] - sh[1]);
    return { sh, el, wr, hip, ank, flat: dy < 0.6 * dx, upright: dy > dx, handsDown: wr[1] > sh[1], len: norm(sub(sh, ank)) };
  }
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
    const b = this._posture(P, V);
    const shY = this.fSh.step(b.sh[1], dt);
    this.elbow = this.fEl.step(angle(b.sh, b.el, b.wr), dt);
    this.line = this.fLine.step(angle(b.sh, b.hip, b.ank), dt);

    if (!this.reps.length && !this.cur) {  // the plank: the last steady arms-locked window before the first descent wins
      if (b.flat && b.handsDown && this.elbow >= LOCKOUT_DEG) {
        this.win.push([t, shY, b.len]);
        while (t - this.win[0][0] > 0.5) this.win.shift();
        const w = this.win;
        if (w[w.length - 1][0] - w[0][0] >= 0.3 && ptp(w.map((r) => r[1])) <= 0.015 * this.frameH) {
          this.ppm = median(w.map((r) => r[2])) / ((SH_FRAC - ANK_FRAC) * this.height);
          this.baseY = median(w.map((r) => r[1]));
          if (this.state === "SETUP") { this.state = "PLANK"; this.tStart = t; }
        }
      } else this.win = [];
    }
    if (this.ppm === null) return;

    if (b.upright || !b.handsDown) {       // off the hands
      this.tOff = this.tOff ?? t;
      if (t - this.tOff > 0.6) {
        if (this.reps.length || this.cur) this.endSet(t); else this.reset();
        return;
      }
    } else this.tOff = null;

    const d = (shY - this.baseY) / this.ppm;         // the shoulders' drop from the top, + = down
    const v = this.fV.step(this.dPrev === null ? 0 : (d - this.dPrev) / dt, dt);
    this.dPrev = d; this.d = d; this.v = v;
    if (this.pending) {                    // lock-out is read at the top after the rep
      this.pending._top = Math.max(this.pending._top, this.elbow);
      if (t - this.pending.t_end > 1.5) this._finishPending();
    }
    if (!this.cur) {
      this.state = "PLANK";
      if (Math.abs(v) < 0.05 && Math.abs(d) < 0.06) this.baseY += (1 - Math.exp(-dt / 0.5)) * (shY - this.baseY);
      if (d > START_D && v > START_V) { this._finishPending(); this.cur = { samples: [], peak: 0 }; }
    }
    if (this.cur) {
      const c = this.cur;
      c.samples.push([t, d, v, this.elbow, this.line]);
      c.peak = Math.max(c.peak, d);
      this.state = v > 0.05 ? "LOWER" : v < -0.05 ? "PUSH" : "HOLD";
      if (c.peak >= 0.08 && d < Math.max(0.04, 0.25 * c.peak)) this._closeRep();
      else if (c.peak < 0.08 && d < 0.02) this.cur = null;
    }
  }
  wantsNewSet(P, V) { const b = this._posture(P, V); return b.flat && b.handsDown; }
  liveRows() {
    const rows = [`elbow ${this.elbow.toFixed(0)}°`, `body line ${this.line.toFixed(0)}°`, `depth ${(this.d * 100).toFixed(0)} cm`];
    const a = this.reps[this.reps.length - 1];
    if (a && !a.failed) rows.push(`speed loss ${a.velocity_loss_pct.toFixed(0)} %`);
    return rows;
  }
  card() {
    const a = this.reps[this.reps.length - 1];
    if (!a) return [];
    if (a.failed) return [[`attempt ${a.n}: short descent (${a.rom_cm.toFixed(0)} cm), not counted`, RED]];
    return [
      [`rep ${a.rep}: depth ${a.depth_pass ? "OK" : "SHORT"} (elbow ${a.elbow_bottom.toFixed(0)}°)`, a.depth_pass ? GREEN : RED],
      a.lockout === undefined ? ["lock-out ...", DIM] : [`lock-out ${a.lockout ? "OK" : "SHORT"} (${a.elbow_top.toFixed(0)}°)   body ${a.straight ? "straight" : "NOT straight"} (${a.body_line_min.toFixed(0)}°)`, a.lockout && a.straight ? GREEN : RED],
      [`down ${a.t_eccentric.toFixed(1)} s  up ${a.t_concentric.toFixed(1)} s  ROM ${a.rom_cm.toFixed(0)} cm` + (a.efficiency !== undefined ? `  score ${a.efficiency.toFixed(0)}` : ""), WHITE],
    ];
  }
  summaryRows() {
    const m = this.summary;
    if (!m.reps) return ["0 reps"];
    return [
      `${m.reps} reps in ${m.time_s.toFixed(0)} s`,
      `depth: ${m.depth_pass}/${m.reps} to 90° (mean ${m.mean_elbow_bottom.toFixed(0)}°)`,
      `lock-out: ${m.lockouts}/${m.reps}   straight body: ${m.straight}/${m.reps}`,
      `speed loss at the last rep: ${m.velocity_loss_last_pct.toFixed(0)} %`,
      `efficiency: ${m.mean_efficiency.toFixed(0)}/100   ${m.kcal.toFixed(1)} kcal`,
    ];
  }
  snapshot() { return null; }
}
