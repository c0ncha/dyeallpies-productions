// The pull-up muscle model, one frame at a time: a port of tools/scripts/live_muscles.py, whose
// constants come from tools/scripts/pullup_thermal4.py (the source of truth; every number there
// cites its paper). Chain: inverse dynamics -> Crowninshield & Brand force sharing -> Hill
// force-velocity -> Thelen activation dynamics -> Xia & Frey-Law three-compartment fatigue.
// The colour is the non-resting share of the motor-unit pool, M_A + M_F. A MODEL, NOT A MEASUREMENT.
import { Ema, G, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, sub, add, mul, dot, norm, mid, clip, rad, deg } from "./util.js";

const SHARE_P = 3, TAU_ACT = 0.015, TAU_DEACT = 0.050, V_MAX_LOPT = 10, HILL_A = 0.25, ECC_PLATEAU = 1.6;
const D_SH_HANG = 0.04, D_SH_MAX = 0.40, COCONTRACTION = 0.12, GRIP_AT_HANG = 0.60, ATHLETE = 1.20;
const INIT_TRAP = 0.35, INIT_ELBOW_DEG = 35, INIT_PEC = 0.25, PRONATION_BICEPS = 0.75, L_D = 10, L_R = 10, REST_TL = 0.02;
// [F_max N, moment arm m, optimal fibre length m], one arm
const ELBOW_FLEXORS = { "biceps brachii": [1060, 0.047, 0.120], "brachialis": [987, 0.026, 0.086], "brachioradialis": [261, 0.075, 0.170] };
const SHOULDER_ADDUCTORS = { "latissimus dorsi": [1253, 0.045, 0.25], "teres major": [425, 0.025, 0.16], "pectoralis major": [450, 0.015, 0.14],
  "posterior deltoid": [260, 0.015, 0.14], "triceps": [800, 0.000, 0.134] };
const STABILISER_RATIO = { "infraspinatus": 0.60, "trapezius": 0.42, "upper trapezius": 0.50, "serratus anterior": 0.21, "middle deltoid": 0.36,
  "external oblique": 0.27, "rectus abdominis": 0.16, "erector spinae": 0.32 };
const POSTURAL_ACT = { "hip flexors": 0.18, "quadriceps": 0.08, "hamstrings": 0.06, "gluteus maximus": 0.08, "calves": 0.04 };
const FATIGUE = { elbow: [0.00912, 0.00094], shoulder: [0.01820, 0.00168], grip: [0.00980, 0.00064], trunk: [0.00755, 0.00075], leg: [0.01500, 0.00149] };
const REST_MULT = { elbow: 15, shoulder: 15, grip: 30, trunk: 15, leg: 15 };
const JOINT_OF = { "forearm flexors": "grip", "forearm extensors": "grip", "external oblique": "trunk", "rectus abdominis": "trunk", "erector spinae": "trunk" };
for (const m in ELBOW_FLEXORS) JOINT_OF[m] = "elbow";
for (const m in SHOULDER_ADDUCTORS) JOINT_OF[m] = "shoulder";
for (const m in POSTURAL_ACT) JOINT_OF[m] = "leg";
export const MUSCLES = [...Object.keys(SHOULDER_ADDUCTORS), ...Object.keys(ELBOW_FLEXORS), "forearm flexors", "forearm extensors",
  ...Object.keys(STABILISER_RATIO), ...Object.keys(POSTURAL_ACT)];
export const PANEL = [["latissimus dorsi", "lats"], ["teres major", "teres major"], ["biceps brachii", "biceps"], ["brachialis", "brachialis"],
  ["brachioradialis", "brachiorad."], ["forearm flexors", "grip"], ["trapezius", "trapezius"], ["pectoralis major", "pec"]];
const SIDES = { l: [L_SH, L_EL, L_WR, L_HIP], r: [R_SH, R_EL, R_WR, R_HIP] };

const momentArmShape = (theta) => 0.30 + 0.70 * Math.sin(rad(clip(theta, 0, 145)) * (90 / 85));
function fv(vn) {            // Hill force-velocity, + = shortening
  const v = clip(vn, -1, 0.98);
  return v >= 0 ? (1 - v) / (1 + v / HILL_A) : 1 + (ECC_PLATEAU - 1) * (-v) / (0.08 + (-v));
}
const zeros = (x = 0) => Object.fromEntries(MUSCLES.map((m) => [m, x]));

export class LiveMuscles {
  constructor(mLift) { this.mLift = mLift; this.reset(); }
  reset() {
    this.L = null;            // {side: [forearm m, upper arm m]} from the dead hang
    this.a = zeros(); this.MA = zeros(); this.MF = zeros(); this.MR = zeros(1); this.E = zeros(); this.peakA = zeros();
    this.Mel = this.Msh = this.peakMel = this.peakMsh = 0;
    this.f = {};
    for (const s in SIDES) this.f[s] = { theta: new Ema(0.08), omEl: new Ema(0.12), elev: new Ema(0.08), omSh: new Ema(0.12), dSh: new Ema(0.10), th0: null, el0: null };
    this.fTh = new Ema(0.08); this.fHold = new Ema(0.15); this.fInit = new Ema(0.15);
  }
  // Pm: landmarks in metres (image px / px_per_m), el3: {l, r} 3D elbow angles, ay m/s2
  update(dt, Pm, el3, ay, phase, swayCm) {
    if (!this.L) return;
    const F = 0.5 * this.mLift * clip(G + ay, 0, 2 * G), p = SHARE_P, u = zeros();
    const thMean = this.fTh.step(clip(180 - 0.5 * (el3.l + el3.r), 0, 150), dt);
    const trunk = sub(mid(Pm[L_HIP], Pm[R_HIP]), mid(Pm[L_SH], Pm[R_SH]));
    let Mel = 0, Msh = 0, init = 0;
    for (const s in SIDES) {
      const [sh, el, wr] = SIDES[s], f = this.f[s], [Lf, Lu] = this.L[s];
      const fore = sub(Pm[wr], Pm[el]), upper = sub(Pm[el], Pm[sh]);
      const leverEl = Math.sqrt(Math.max(Lf * Lf - fore[1] * fore[1], fore[0] * fore[0]));
      const theta = f.theta.step(clip(180 - el3[s], 0, 150), dt);
      const Lhs2 = Math.max(Lf * Lf + Lu * Lu - 2 * Lf * Lu * Math.cos(rad(180 - thMean)), 1e-4);
      const dx = Math.abs(Pm[wr][0] - Pm[sh][0]), dy = Math.abs(Pm[wr][1] - Pm[sh][1]);
      const dSh = f.dSh.step(clip(Math.sqrt(Math.max(Lhs2 - dx * dx - dy * dy, D_SH_HANG ** 2)), D_SH_HANG, D_SH_MAX), dt);
      const leverSh = Math.hypot(dx, dSh);
      const omEl = f.omEl.step(f.th0 === null ? 0 : rad(theta - f.th0) / dt, dt); f.th0 = theta;
      const cosang = dot(upper, mul(trunk, -1)) / (norm(upper) * norm(trunk) + 1e-6);
      const elev = f.elev.step(deg(Math.acos(clip(cosang, -1, 1))), dt);
      const omSh = f.omSh.step(f.el0 === null ? 0 : -rad(elev - f.el0) / dt, dt); f.el0 = elev;
      const mel = F * leverEl, msh = F * leverSh;
      Mel += 0.5 * mel; Msh += 0.5 * msh;
      const shape = momentArmShape(theta), r = {};
      for (const m in ELBOW_FLEXORS) r[m] = ELBOW_FLEXORS[m][1] * shape * (m === "biceps brachii" ? PRONATION_BICEPS : 1);
      let den = 1e-9;
      for (const m in r) den += (r[m] * ELBOW_FLEXORS[m][0]) ** (p / (p - 1));
      for (const m in ELBOW_FLEXORS) {
        const [Fmax, , lopt] = ELBOW_FLEXORS[m];
        const Fi = mel * (r[m] * Fmax) ** (1 / (p - 1)) / den * Fmax;
        u[m] += 0.5 * Fi / (ATHLETE * Fmax * fv(r[m] * omEl / (V_MAX_LOPT * lopt)));
      }
      den = 0;
      for (const m in SHOULDER_ADDUCTORS) den += (SHOULDER_ADDUCTORS[m][1] * SHOULDER_ADDUCTORS[m][0]) ** (p / (p - 1));
      for (const m in SHOULDER_ADDUCTORS) {
        const [Fmax, rm, lopt] = SHOULDER_ADDUCTORS[m];
        const Fi = msh * (rm * Fmax) ** (1 / (p - 1)) / den * Fmax;
        u[m] += 0.5 * Fi / (ATHLETE * Fmax * fv(rm * omSh / (V_MAX_LOPT * lopt)));
      }
      init += 0.5 * (theta < INIT_ELBOW_DEG && phase === "PULL" ? 1 : 0);
    }
    this.Mel = Mel; this.Msh = Msh; this.peakMel = Math.max(this.peakMel, Mel); this.peakMsh = Math.max(this.peakMsh, Msh);
    u["triceps"] = Math.max(u["triceps"], COCONTRACTION * u["biceps brachii"]);
    const grip = GRIP_AT_HANG * F / (0.5 * this.mLift * G);
    u["forearm flexors"] = grip; u["forearm extensors"] = grip * 35 / 60;
    const lat = u["latissimus dorsi"];
    for (const m in STABILISER_RATIO) u[m] = STABILISER_RATIO[m] * lat;
    const hold = this.fHold.step(phase === "HOLD" ? 1 : 0, dt); init = this.fInit.step(init, dt);
    u["latissimus dorsi"] *= 1 - 0.15 * hold;
    u["trapezius"] += 0.15 * hold * lat + INIT_TRAP * init;
    u["upper trapezius"] += 0.10 * hold * lat;
    u["pectoralis major"] += INIT_PEC * init;
    const kip = clip((swayCm - 4) / 8, 0, 1);
    u["rectus abdominis"] += 0.6 * kip * lat; u["external oblique"] += 0.4 * kip * lat;
    const load = clip((G + ay) / G, 0.5, 1.6);
    for (const m in POSTURAL_ACT) u[m] = POSTURAL_ACT[m] * load;
    for (const m of MUSCLES) {
      const um = clip(Number.isFinite(u[m]) ? u[m] : 0, 0, 1);
      let a = this.a[m];
      a += (um - a) * (1 - Math.exp(-dt / (um > a ? TAU_ACT : TAU_DEACT)));
      this.a[m] = a; this.peakA[m] = Math.max(this.peakA[m], a);
      const joint = JOINT_OF[m] || "shoulder", [Fr, Rr] = FATIGUE[joint];
      let ma = this.MA[m], mf = this.MF[m], mr = this.MR[m];
      const C = ma < a ? L_D * Math.min(a - ma, mr) : L_R * (a - ma);
      const Rn = a < REST_TL ? Rr * REST_MULT[joint] : Rr;
      const ma2 = Math.max(ma + (C - Fr * ma) * dt, 0), mf2 = Math.max(mf + (Fr * ma - Rn * mf) * dt, 0), mr2 = Math.max(mr + (-C + Rn * mf) * dt, 0);
      const tot = ma2 + mf2 + mr2;
      this.MA[m] = ma2 / tot; this.MF[m] = mf2 / tot; this.MR[m] = mr2 / tot;
      this.E[m] = clip(this.MA[m] + this.MF[m], 0, 1);
    }
  }
  snapshot() {
    const muscles = {};
    for (const m of MUSCLES) muscles[m] = { peak_activation: this.peakA[m], fatigued: this.MF[m] };
    return { peak_elbow_moment_nm: this.peakMel, peak_shoulder_moment_nm: this.peakMsh, muscles };
  }
}

// Soft ellipses over the muscles the camera faces, from the landmarks alone:
// [centre, a, b, angle rad, value]. Front or back by which side the left shoulder is on.
export function shapes(P, E) {
  const lsh = P[L_SH], rsh = P[R_SH], m0 = mid(lsh, rsh), hipm = mid(P[L_HIP], P[R_HIP]);
  const w = norm(sub(lsh, rsh)) + 1e-6, torso = sub(hipm, m0), tl = norm(torso) + 1e-6, tdir = mul(torso, 1 / tl);
  const front = lsh[0] > rsh[0], out = [];
  const ell = (c, along, a, b, m) => out.push([c, a, b, Math.atan2(along[1], along[0]), E[m]]);
  const at = (o, ...terms) => terms.reduce((acc, [k, v]) => add(acc, mul(v, k)), o);
  for (const s in SIDES) {
    const [sh, el, wr, hip] = SIDES[s].map((i) => P[i].slice(0, 2));
    const inw = mul(sub(m0, sh), 2 / w), ua = sub(el, sh), fa = sub(wr, el), side = sub(hip, sh);
    const nu = norm(ua) + 1e-6, nf = norm(fa) + 1e-6, ns = norm(side) + 1e-6;
    if (front) {
      ell(at(sh, [0.40, side], [-0.05 * w, inw]), side, 0.30 * ns, 0.10 * w, "latissimus dorsi");
      ell(at(sh, [0.30 * w, inw], [0.20 * w, tdir]), inw, 0.24 * w, 0.15 * w, "pectoralis major");
      ell(at(sh, [0.76, side], [0.09 * w, inw]), side, 0.15 * ns, 0.07 * w, "external oblique");
      ell(at(sh, [0.08, ua]), ua, 0.15 * w, 0.14 * w, "middle deltoid");
      ell(at(sh, [0.55, ua]), ua, 0.32 * nu, 0.11 * w, "biceps brachii");
      ell(at(el, [0.35, fa]), fa, 0.33 * nf, 0.085 * w, "forearm flexors");
    } else {
      ell(at(sh, [0.45, side], [0.14 * w, inw]), side, 0.30 * ns, 0.16 * w, "latissimus dorsi");
      ell(at(sh, [0.24 * w, inw], [0.17 * w, tdir]), inw, 0.15 * w, 0.10 * w, "infraspinatus");
      ell(at(sh, [0.74, side], [0.21 * w, inw]), tdir, 0.20 * tl, 0.05 * w, "erector spinae");
      ell(at(sh, [0.08, ua]), ua, 0.15 * w, 0.14 * w, "posterior deltoid");
      ell(at(sh, [0.55, ua]), ua, 0.32 * nu, 0.11 * w, "triceps");
      ell(at(el, [0.35, fa]), fa, 0.33 * nf, 0.085 * w, "forearm extensors");
      ell(at(sh, [0.275 * w, inw], [-0.12 * w, tdir]), inw, 0.20 * w, 0.07 * w, "upper trapezius");
    }
  }
  if (front) ell(at(m0, [0.64, torso]), tdir, 0.24 * tl, 0.11 * w, "rectus abdominis");
  else ell(at(m0, [0.18, torso]), tdir, 0.26 * tl, 0.14 * w, "trapezius");
  return out;
}
