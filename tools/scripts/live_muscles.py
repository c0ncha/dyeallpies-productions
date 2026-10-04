"""
The muscle model of pullup_thermal4.py, one frame at a time, for live_pullups.py.

Same chain and the same constants (imported, not copied): inverse dynamics -> Crowninshield &
Brand force sharing -> Hill force-velocity -> Thelen activation dynamics -> the Xia & Frey-Law
three-compartment fatigue that carries from rep to rep. Formulation: formats/pullup-analysis/MUSCLE-MODEL.md.

What is different from the offline model, because nothing here can look ahead:
  * every smoothing is a causal exponential filter, and the levers are taken in image pixels
    over the hang's scale instead of in the rectified plane;
  * the feet-on-floor load fraction is dropped: the hands carry the full weight from the hang on;
  * no heat and no temperature (their scale is calibrated to the finished set's energy budget),
    so the colour is the fast part alone: the NON-RESTING share of the pool, M_A + M_F.
IT IS A MODEL, NOT A MEASUREMENT.
"""
import numpy as np
import cv2
import pullup_thermal4 as T4
from pullup_thermal3 import MUSCLES

G = 9.81
L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP = 11, 12, 13, 14, 15, 16, 23, 24
SIDES = dict(l=(L_SH, L_EL, L_WR, L_HIP), r=(R_SH, R_EL, R_WR, R_HIP))
# the bars beside the picture: the prime movers and the grip, in the order the model loads them
PANEL = [("latissimus dorsi", "lats"), ("teres major", "teres major"), ("biceps brachii", "biceps"),
         ("brachialis", "brachialis"), ("brachioradialis", "brachiorad."), ("forearm flexors", "grip"),
         ("trapezius", "trapezius"), ("pectoralis major", "pec")]
LUT = cv2.applyColorMap(np.arange(256, dtype=np.uint8).reshape(-1, 1), cv2.COLORMAP_TURBO)[:, 0][
    np.linspace(35, 235, 256).astype(int)]          # blue (resting) -> red (the whole pool busy)


class Ema:
    """Causal exponential filter with a time constant, for uneven frame times."""
    def __init__(self, tau):
        self.tau = tau; self.v = None

    def __call__(self, x, dt):
        if self.v is None or not np.isfinite(self.v):
            self.v = x
        elif np.isfinite(x):
            self.v += (1 - np.exp(-dt / self.tau)) * (x - self.v)
        return self.v


class LiveMuscles:
    def __init__(self, m_lift):
        self.m_lift = m_lift
        self.reset()

    def reset(self):
        self.L = None                                   # {side: (forearm m, upper arm m)} from the dead hang
        self.a = dict.fromkeys(MUSCLES, 0.0)
        self.MA = dict.fromkeys(MUSCLES, 0.0); self.MF = dict.fromkeys(MUSCLES, 0.0); self.MR = dict.fromkeys(MUSCLES, 1.0)
        self.E = dict.fromkeys(MUSCLES, 0.0); self.peak_a = dict.fromkeys(MUSCLES, 0.0)
        self.M_el = self.M_sh = 0.0; self.peak_M_el = self.peak_M_sh = 0.0
        self.f = {s: dict(theta=Ema(0.08), om_el=Ema(0.12), elev=Ema(0.08), om_sh=Ema(0.12), d_sh=Ema(0.10),
                          th0=None, el0=None) for s in SIDES}
        self.f_th = Ema(0.08); self.f_hold = Ema(0.15); self.f_init = Ema(0.15)

    def update(self, dt, Pm, el3, ay, phase, sway_cm):
        """Pm (33, 2) landmarks in metres (image px / px_per_m), el3 {side: 3D elbow angle},
        ay vertical acceleration m/s2, phase HANG/PULL/HOLD/LOWER, sway_cm of the running rep."""
        if self.L is None:
            return
        F = 0.5 * self.m_lift * float(np.clip(G + ay, 0, 2 * G))        # N per arm
        p = T4.SHARE_P
        u = dict.fromkeys(MUSCLES, 0.0)
        th_mean = self.f_th(float(np.clip(180 - 0.5 * (el3["l"] + el3["r"]), 0, 150)), dt)
        trunk = (Pm[L_HIP] + Pm[R_HIP]) / 2 - (Pm[L_SH] + Pm[R_SH]) / 2
        M_el = M_sh = 0.0; init = 0.0
        for s, (sh, el, wr, _) in SIDES.items():
            f = self.f[s]; L_fore, L_up = self.L[s]
            fore = Pm[wr] - Pm[el]; upper = Pm[el] - Pm[sh]
            # STEP 1: the levers. Elbow: the forearm's horizontal extent from its foreshortening.
            # Shoulder: across (seen) and depth (from the elbow angle by the law of cosines).
            lever_el = float(np.sqrt(max(L_fore ** 2 - fore[1] ** 2, fore[0] ** 2)))
            theta = f["theta"](float(np.clip(180 - el3[s], 0, 150)), dt)
            L_hs2 = max(L_fore ** 2 + L_up ** 2 - 2 * L_fore * L_up * np.cos(np.radians(180 - th_mean)), 1e-4)
            dx = abs(Pm[wr, 0] - Pm[sh, 0]); dy = abs(Pm[wr, 1] - Pm[sh, 1])
            d_sh = f["d_sh"](float(np.clip(np.sqrt(max(L_hs2 - dx ** 2 - dy ** 2, T4.D_SH_HANG ** 2)), T4.D_SH_HANG, T4.D_SH_MAX)), dt)
            lever_sh = float(np.hypot(dx, d_sh))
            om_el = f["om_el"](0.0 if f["th0"] is None else np.radians(theta - f["th0"]) / dt, dt); f["th0"] = theta
            cosang = float(upper @ -trunk) / (np.linalg.norm(upper) * np.linalg.norm(trunk) + 1e-6)
            elev = f["elev"](float(np.degrees(np.arccos(np.clip(cosang, -1, 1)))), dt)
            om_sh = f["om_sh"](0.0 if f["el0"] is None else -np.radians(elev - f["el0"]) / dt, dt); f["el0"] = elev
            Mel = F * lever_el; Msh = F * lever_sh
            M_el += 0.5 * Mel; M_sh += 0.5 * Msh
            # STEP 2 + 3 at the elbow: cubic force sharing, then force-velocity
            shape = float(T4.moment_arm_shape(theta))
            r = {m: v[1] * shape * (T4.PRONATION_BICEPS if m == "biceps brachii" else 1.0) for m, v in T4.ELBOW_FLEXORS.items()}
            denom = sum((r[m] * T4.ELBOW_FLEXORS[m][0]) ** (p / (p - 1)) for m in r) + 1e-9
            for m, (Fmax, _, lopt, _) in T4.ELBOW_FLEXORS.items():
                Fi = Mel * (r[m] * Fmax) ** (1 / (p - 1)) / denom * Fmax
                u[m] += 0.5 * Fi / (T4.ELBOW_STRENGTH * Fmax * float(T4.f_v(r[m] * om_el / (T4.V_MAX_LOPT * lopt))))
            # the same at the shoulder
            denom = sum((v[1] * v[0]) ** (p / (p - 1)) for v in T4.SHOULDER_ADDUCTORS.values())
            for m, (Fmax, r_m, lopt, _) in T4.SHOULDER_ADDUCTORS.items():
                Fi = Msh * (r_m * Fmax) ** (1 / (p - 1)) / denom * Fmax
                u[m] += 0.5 * Fi / (T4.SHOULDER_STRENGTH * Fmax * float(T4.f_v(r_m * om_sh / (T4.V_MAX_LOPT * lopt))))
            init += 0.5 * float(theta < T4.INIT_ELBOW_DEG and phase == "PULL")
        self.M_el, self.M_sh = M_el, M_sh
        self.peak_M_el = max(self.peak_M_el, M_el); self.peak_M_sh = max(self.peak_M_sh, M_sh)
        u["triceps"] = max(u["triceps"], T4.COCONTRACTION * u["biceps brachii"])
        grip = T4.GRIP_AT_HANG * F / (0.5 * self.m_lift * G)
        u["forearm flexors"] = grip; u["forearm extensors"] = grip * 35.0 / 60.0
        lat = u["latissimus dorsi"]
        for m, ratio in T4.STABILISER_RATIO.items():
            u[m] = ratio * lat
        hold = self.f_hold(float(phase == "HOLD"), dt); init = self.f_init(init, dt)
        u["latissimus dorsi"] *= 1 - 0.15 * hold
        u["trapezius"] += 0.15 * hold * lat + T4.INIT_TRAP * init
        u["upper trapezius"] += 0.10 * hold * lat
        u["pectoralis major"] += T4.INIT_PEC * init
        kip = float(np.clip((sway_cm - 4.0) / 8.0, 0, 1))
        u["rectus abdominis"] += 0.6 * kip * lat; u["external oblique"] += 0.4 * kip * lat
        load = float(np.clip((G + ay) / G, 0.5, 1.6))
        for m, a0 in T4.POSTURAL_ACT.items():
            u[m] = a0 * load
        for m in MUSCLES:
            # STEP 4: activation dynamics
            um = float(np.clip(np.nan_to_num(u[m]), 0, 1)); a = self.a[m]
            a += (um - a) * (1 - np.exp(-dt / (T4.TAU_ACT if um > a else T4.TAU_DEACT)))
            self.a[m] = a; self.peak_a[m] = max(self.peak_a[m], a)
            # STEP 5: three-compartment fatigue
            joint = T4.JOINT_OF.get(m, "shoulder"); Fr, Rr = T4.FATIGUE[joint]
            ma, mf, mr = self.MA[m], self.MF[m], self.MR[m]
            C = T4.L_D * min(a - ma, mr) if ma < a else T4.L_R * (a - ma)
            R_now = Rr * T4.REST_MULT[joint] if a < T4.REST_TL else Rr
            ma, mf, mr = max(ma + (C - Fr * ma) * dt, 0.0), max(mf + (Fr * ma - R_now * mf) * dt, 0.0), max(mr + (-C + R_now * mf) * dt, 0.0)
            tot = ma + mf + mr
            self.MA[m], self.MF[m], self.MR[m] = ma / tot, mf / tot, mr / tot
            self.E[m] = float(np.clip(self.MA[m] + self.MF[m], 0, 1))

    def snapshot(self):
        """What a finished set keeps: per muscle the peak activation and the fatigued pool at the release."""
        return dict(peak_elbow_moment_nm=self.peak_M_el, peak_shoulder_moment_nm=self.peak_M_sh,
                    muscles={m: dict(peak_activation=self.peak_a[m], fatigued=self.MF[m]) for m in MUSCLES})


# ---------------------------------------------------------------- the picture

def shapes(P, E):
    """Soft ellipses over the muscles the camera faces, from the landmarks alone (no matte, no
    atlas): (centre, half-axes, angle, value). Front or back by which side the left shoulder is on."""
    lsh, rsh = P[L_SH], P[R_SH]; mid = (lsh + rsh) / 2; hipm = (P[L_HIP] + P[R_HIP]) / 2
    w = np.linalg.norm(lsh - rsh) + 1e-6; torso = hipm - mid; tl = np.linalg.norm(torso) + 1e-6; tdir = torso / tl
    front = lsh[0] > rsh[0]                             # the person's left on the image right = facing the camera
    out = []

    def ell(c, along, a, b, m):
        out.append((c, (a, b), float(np.degrees(np.arctan2(along[1], along[0]))), E[m]))

    for sh, el, wr, hip in SIDES.values():
        sh, el, wr, hip = P[sh], P[el], P[wr], P[hip]
        inw = (mid - sh) / (w / 2); ua = el - sh; fa = wr - el; side = hip - sh
        nu, nf, ns = np.linalg.norm(ua) + 1e-6, np.linalg.norm(fa) + 1e-6, np.linalg.norm(side) + 1e-6
        if front:
            ell(sh + 0.40 * side - 0.05 * w * inw, side, 0.30 * ns, 0.10 * w, "latissimus dorsi")
            ell(sh + 0.30 * w * inw + 0.20 * w * tdir, inw, 0.24 * w, 0.15 * w, "pectoralis major")
            ell(sh + 0.76 * side + 0.09 * w * inw, side, 0.15 * ns, 0.07 * w, "external oblique")
            ell(sh + 0.08 * ua, ua, 0.15 * w, 0.14 * w, "middle deltoid")
            ell(sh + 0.55 * ua, ua, 0.32 * nu, 0.11 * w, "biceps brachii")
            ell(el + 0.35 * fa, fa, 0.33 * nf, 0.085 * w, "forearm flexors")
        else:
            ell(sh + 0.45 * side + 0.14 * w * inw, side, 0.30 * ns, 0.16 * w, "latissimus dorsi")
            ell(sh + 0.24 * w * inw + 0.17 * w * tdir, inw, 0.15 * w, 0.10 * w, "infraspinatus")
            ell(sh + 0.74 * side + 0.42 * (w / 2) * inw, tdir, 0.20 * tl, 0.05 * w, "erector spinae")
            ell(sh + 0.08 * ua, ua, 0.15 * w, 0.14 * w, "posterior deltoid")
            ell(sh + 0.55 * ua, ua, 0.32 * nu, 0.11 * w, "triceps")
            ell(el + 0.35 * fa, fa, 0.33 * nf, 0.085 * w, "forearm extensors")
            ell(sh + 0.55 * (w / 2) * inw - 0.12 * w * tdir, inw, 0.20 * w, 0.07 * w, "upper trapezius")   # from the front it would sit on the face
    if front:
        ell(mid + 0.64 * torso, tdir, 0.24 * tl, 0.11 * w, "rectus abdominis")
    else:
        ell(mid + 0.18 * torso, tdir, 0.26 * tl, 0.14 * w, "trapezius")
    return out


def paint(frame, P, E, strength=0.6, scale=0.25):
    """Blend the muscle colours onto the frame, in place. Drawn small and blurred, then scaled up."""
    H, W = frame.shape[:2]
    h, w = int(H * scale), int(W * scale)
    val = np.zeros((h, w), np.float32); mask = np.zeros((h, w), np.float32)
    for c, (a, b), ang, v in shapes(P, E):
        box = (tuple(map(int, c * scale)), (max(int(a * scale), 1), max(int(b * scale), 1)), ang, 0, 360)
        cv2.ellipse(val, *box, float(v), -1, cv2.LINE_AA); cv2.ellipse(mask, *box, 1.0, -1, cv2.LINE_AA)
    ys, xs = np.where(mask > 0)
    if len(ys) == 0:
        return
    k = max(int(np.linalg.norm(P[L_SH] - P[R_SH]) * scale * 0.10), 1) | 1
    y0, y1 = max(ys.min() - k, 0), min(ys.max() + k + 1, h); x0, x1 = max(xs.min() - k, 0), min(xs.max() + k + 1, w)
    val = cv2.GaussianBlur(val[y0:y1, x0:x1] , (k, k), 0); mask = cv2.GaussianBlur(mask[y0:y1, x0:x1], (k, k), 0)
    col = LUT[np.clip(val / np.maximum(mask, 1e-3) * 255, 0, 255).astype(np.uint8)]
    Y0, Y1, X0, X1 = int(y0 / scale), int(y1 / scale), int(x0 / scale), int(x1 / scale)
    size = (X1 - X0, Y1 - Y0)
    col = cv2.resize(col, size, interpolation=cv2.INTER_LINEAR).astype(np.float32)
    al = cv2.resize(mask, size, interpolation=cv2.INTER_LINEAR)[..., None] * strength
    roi = frame[Y0:Y1, X0:X1]
    roi[:] = (roi * (1 - al) + col * al).astype(np.uint8)


def panel(frame, M, x, y, k, text):
    """The bars: length and colour = the non-resting share of the pool, the white tick = the fatigued part."""
    text(frame, "muscle load (model)", (x, y), 0.9 * k, (245, 245, 245), max(int(2 * k), 1))
    bw, bh, dy = int(230 * k), int(20 * k), int(40 * k)
    for i, (m, label) in enumerate(PANEL):
        yy = y + int(22 * k) + i * dy
        cv2.rectangle(frame, (x, yy), (x + bw, yy + bh), (40, 40, 40), -1)
        e = M.E[m]
        cv2.rectangle(frame, (x, yy), (x + int(bw * e), yy + bh), tuple(int(c) for c in LUT[int(e * 255)]), -1)
        xf = x + int(bw * M.MF[m])
        cv2.rectangle(frame, (xf - max(int(2 * k), 1), yy - int(3 * k)), (xf + max(int(2 * k), 1), yy + bh + int(3 * k)), (255, 255, 255), -1)
        text(frame, f"{label}  {M.MF[m] * 100:.0f}% fatigued", (x + bw + int(12 * k), yy + bh), 0.7 * k, (245, 245, 245), max(int(2 * k), 1))
