"""
Live pull-up tracker: the phone is the camera (Continuity Camera), the Mac runs the pose model,
counts the reps, grades each one as it finishes and shows it large enough to read from the bar.

    python live_pullups.py [cam=1] [height=1.88] [mass=79] [model=tools/models/pose_landmarker_full.task]
        [rot=0|90|180|270] [video=clip.mp4] [fast=1] [headless=1] [record=1] [muscles=1]
        [out=formats/pullup-analysis/out/live] [session=<saved set folder>]

Keys in the window: q quit, r reset the set, f fullscreen, m muscle map on/off.
height and mass are remembered in <out>/profile.json once given. session=<folder> replays a saved
set through the current code and rewrites its live.json and replay.mp4 (the clean video is kept).

What is the same as analyze_pullups3.py: the constants, the face-axis chin, the lock-out rule
(3D elbow >= 150 and 2D >= 160 at the bottom after the rep), the 60 % ROM rule for a failed
attempt, the velocity-loss landmarks, the efficiency score.
What is different, because it is live and the place changes:
  * no rectification. There is no doorway to fit, so everything is measured in image pixels and
    the chin verdict carries the wide band (+-3 cm) with NO depth allowance: it is a rough call;
  * the scale and the bar come from the dead hang: shoulder-to-bar = 0.332 x stature, the wrist
    8 cm under the bar. The last steady arms-straight window before the first pull is the one used;
  * every filter is causal (exponential), so numbers lag by ~0.1 s instead of being centred;
  * velocity loss is on the mean concentric velocity against rep 1.
The muscle map is live_muscles.py: the model of pullup_thermal4.py run causally, painted as soft
regions from the landmarks (front or back, whichever faces the camera) with a bar per prime mover.
Every set is saved: set.mp4 (clean, for the offline pipeline), replay.mp4 (what the screen showed),
the landmarks in the extract_pose_mp.py layout (plus timestamps) and live.json (reps, summary,
muscles). build_pullup_history.py turns the folder into the comparison page.
"""
import sys, os, json, time, glob, threading
from collections import deque
import numpy as np
import cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_muscles as LM
from live_muscles import Ema

NOSE = 0; L_EYE, R_EYE = 2, 5; L_MOUTH, R_MOUTH = 9, 10
L_SH, R_SH = 11, 12; L_EL, R_EL = 13, 14; L_WR, R_WR = 15, 16
L_HIP, R_HIP = 23, 24; L_KNEE, R_KNEE = 25, 26; L_ANK, R_ANK = 27, 28
BONES = [(L_SH, R_SH), (L_SH, L_EL), (L_EL, L_WR), (R_SH, R_EL), (R_EL, R_WR), (L_SH, L_HIP), (R_SH, R_HIP),
         (L_HIP, R_HIP), (L_HIP, L_KNEE), (L_KNEE, L_ANK), (R_HIP, R_KNEE), (R_KNEE, R_ANK)]
G = 9.81
ARM_FRAC = 0.332          # shoulder joint -> bar at the dead hang / stature (Drillis & Contini 1966)
WRIST_BELOW_BAR = 0.08    # the wrist landmark sits 8 cm under the bar
LIFTED_FRAC = 0.956       # body mass minus hands + forearms (de Leva 1996)
ETA_CONC = 0.22           # metabolic efficiency of concentric muscle work
ECC_COST = 0.35           # eccentric metabolic cost relative to the same concentric work
KCAL_PER_J = 1 / 4184.0
FAIL_SHORT_PCT = 0.60     # an attempt below this fraction of the set's ROM is not a rep
CHIN_AXIS_K = 0.60        # mouth-to-chin / eye-to-mouth along the face axis
VERDICT_BAND_CM = 3.0     # +- band for "at the bar" (no rectification, no depth allowance)
VL_LANDMARKS = (25.0, 50.0)   # Sanchez-Moreno 2020
MIN_ROM_M = 0.20          # the first rep has no set to compare with: an absolute floor
START_H, START_V = 0.04, 0.10   # a pull starts: 4 cm over the local base, rising at 0.10 m/s
TOP_BAND_M = 0.03         # "at the top" = within 3 cm of the rep's peak


def angle(a, b, c):
    v1 = a - b; v2 = c - b
    cos = (v1 * v2).sum(-1) / (np.linalg.norm(v1, axis=-1) * np.linalg.norm(v2, axis=-1) + 1e-9)
    return float(np.degrees(np.arccos(np.clip(cos, -1, 1))))


class LiveSet:
    """One set, fed one frame at a time: update(t, P, W, V) with P (33, 2) image px, W (33, 3)
    world metres, V (33,) visibility; all None when no pose was found."""

    def __init__(self, height, mass, frame_h):
        self.height = height; self.m_lift = LIFTED_FRAC * mass; self.frame_h = frame_h
        self.mus = LM.LiveMuscles(self.m_lift)
        self.reset()

    def reset(self):
        self.state = "SETUP"          # SETUP, HANG, PULL, HOLD, LOWER, DONE
        self.ppm = self.bar_y = self.base_y = None
        self.reps = []; self.count = 0; self.cur = None; self.pending = None
        self.t_prev = None; self.h = 0.0; self.v = 0.0; self.h_prev = None
        self.el3 = self.el2 = float("nan"); self.chin_cm = float("nan")
        self.f_sh = Ema(0.06); self.f_v = Ema(0.10); self.f_el3 = Ema(0.08); self.f_el2 = Ema(0.08)
        self.f_chin = Ema(0.06); self.f_a = Ema(0.15); self.v_prev = None; self.acc = 0.0
        self.mus.reset()
        self.hang_win = deque(); self.t_off = None; self.t_lost = None
        self.last_seen = None; self.t_grab = None; self.summary = None

    # ----- the dead hang: scale and bar -----
    def _calibrate(self, t, P, sh_y, wr_y, arm_px, straight):
        if not straight:
            self.hang_win.clear(); return
        seg = [np.linalg.norm(P[a] - P[b]) for a, b in ((L_WR, L_EL), (L_EL, L_SH), (R_WR, R_EL), (R_EL, R_SH))]
        self.hang_win.append((t, sh_y, wr_y, arm_px, *seg))
        while t - self.hang_win[0][0] > 0.5:
            self.hang_win.popleft()
        a = np.array(self.hang_win)
        if a[-1, 0] - a[0, 0] < 0.3 or np.ptp(a[:, 1]) > 0.015 * self.frame_h:
            return
        self.ppm = float(np.median(a[:, 3]) / (ARM_FRAC * self.height - WRIST_BELOW_BAR))
        self.bar_y = float(np.median(a[:, 2]) - WRIST_BELOW_BAR * self.ppm)
        self.base_y = float(np.median(a[:, 1]))
        seg = np.median(a[:, 4:8], axis=0) / self.ppm       # forearm and upper arm at the plumb hang, metres
        self.mus.L = dict(l=(float(seg[0]), float(seg[1])), r=(float(seg[2]), float(seg[3])))
        if self.state == "SETUP":
            self.state = "HANG"; self.t_grab = t

    def _finish_pending(self):
        p = self.pending
        if p is None:
            return
        self.pending = None
        p["elbow_bottom_after"] = p.pop("_el3_max"); p["elbow2d_bottom_after"] = p.pop("_el2_max")
        p["lockout"] = bool(p["elbow_bottom_after"] >= 150 and p["elbow2d_bottom_after"] >= 160)
        self._score(p)

    def _score(self, a):
        peak_ref = max(r["peak_conc_v"] for r in self.reps)
        rom = 25 * float(np.clip(1 + min(a["chin_cm"], 0) / 10, 0, 1))
        lock = 15 * float(np.clip((a["elbow_bottom_after"] - 120) / 35, 0, 1))
        ctrl = 20 * float(np.clip(a["t_eccentric"] / 1.5, 0, 1))
        sway = 15 * float(np.clip(1 - (a["hip_sway_cm"] - 4) / 16, 0, 1))
        sym = 10 * float(np.clip(1 - (abs(a["sh_dy_top_cm"]) - 1) / 4, 0, 1))
        vel = 15 * float(np.clip(a["peak_conc_v"] / peak_ref, 0, 1))
        a["score"] = dict(rom=rom, lockout=lock, control=ctrl, sway=sway, symmetry=sym, power=vel)
        a["efficiency"] = float(rom + lock + ctrl + sway + sym + vel)

    def _close_rep(self, t):
        c = self.cur; self.cur = None
        s = np.array(c["samples"])            # t, h, v, hip_x, chin_cm, sh_dy_cm
        # the pull starts where the shoulders last left the base: a false start that hovered a few
        # centimetres up before the real pull is not part of the concentric
        low = np.where(s[:int(s[:, 1].argmax()), 1] < START_H + 0.02)[0]
        s = s[low[-1]:] if len(low) else s
        peak = float(s[:, 1].max()); i_top = int(s[:, 1].argmax())
        good = [r["rom_cm"] / 100 for r in self.reps if not r["failed"]]
        ref = float(np.median(good)) if good else None
        failed = peak < (FAIL_SHORT_PCT * ref if ref else MIN_ROM_M)
        at_top = np.where(s[:, 1] >= peak - TOP_BAND_M)[0]
        t_conc = max(float(s[at_top[0], 0] - s[0, 0]), 1e-3)
        t_hold = float(s[at_top[-1], 0] - s[at_top[0], 0])
        t_ecc = max(float(s[-1, 0] - s[at_top[-1], 0]), 1e-3)
        chin = float(s[i_top, 4])
        verdict = "above" if chin >= VERDICT_BAND_CM else "at" if chin >= -VERDICT_BAND_CM else "short"
        work = self.m_lift * G * peak
        a = dict(
            rep=sum(not r["failed"] for r in self.reps) + (0 if failed else 1), n=len(self.reps) + 1,
            t_start=float(s[0, 0]), t_top=float(s[i_top, 0]), t_end=float(s[-1, 0]),
            failed=bool(failed), rom_cm=peak * 100, chin_cm=chin, chin_verdict=verdict,
            t_concentric=t_conc, t_top_hold=t_hold, t_eccentric=t_ecc,
            peak_conc_v=float(s[:at_top[0] + 1, 2].max()), mean_conc_v=float(peak / t_conc),
            peak_ecc_v=float(-s[at_top[-1]:, 2].min()),
            hip_sway_cm=float(np.ptp(s[:, 3])), sh_dy_top_cm=float(s[i_top, 5]),
            work_j=float(work), mean_power_w=float(work / t_conc),
            kcal=float(work / ETA_CONC * (1 + ECC_COST) * KCAL_PER_J),
            fatigued_lats=self.mus.MF["latissimus dorsi"], fatigued_biceps=self.mus.MF["biceps brachii"],
            _el3_max=self.el3, _el2_max=self.el2,
        )
        first = next((r for r in self.reps if not r["failed"]), a)
        vl = max(1 - a["mean_conc_v"] / first["mean_conc_v"], 0.0) * 100
        a["velocity_loss_pct"] = float(vl)
        a["vl_zone"] = ("under 25 %: fresh" if vl < VL_LANDMARKS[0] else
                        "25-50 %: past the training cut-off" if vl < VL_LANDMARKS[1] else "over 50 %: grinding")
        self.reps.append(a)
        self.count = sum(not r["failed"] for r in self.reps)
        self.pending = a

    def _end_set(self, t):
        self.cur = None
        self._finish_pending()
        self.state = "DONE"
        good = [r for r in self.reps if not r["failed"]]
        if not good:
            self.summary = dict(reps=0, attempts=len(self.reps)); return
        self.summary = dict(
            reps=len(good), attempts=len(self.reps),
            hang_time_s=float(t - self.t_grab),
            chin_above=sum(r["chin_verdict"] == "above" for r in good),
            chin_at=sum(r["chin_verdict"] == "at" for r in good),
            chin_short=sum(r["chin_verdict"] == "short" for r in good),
            lockouts=sum(r["lockout"] for r in good),
            mean_rom_cm=float(np.mean([r["rom_cm"] for r in good])),
            mean_chin_cm=float(np.mean([r["chin_cm"] for r in good])),
            velocity_loss_last_pct=good[-1]["velocity_loss_pct"],
            first_rep_over_25pct=next((r["rep"] for r in good if r["velocity_loss_pct"] >= VL_LANDMARKS[0]), None),
            mean_efficiency=float(np.mean([r["efficiency"] for r in good])),
            kcal=float(sum(r["kcal"] for r in self.reps)),
            px_per_m=self.ppm, bar_y_px=self.bar_y,
            fatigued_lats=self.mus.MF["latissimus dorsi"], fatigued_biceps=self.mus.MF["biceps brachii"],
            fatigued_grip=self.mus.MF["forearm flexors"],
            note="live, unrectified: chin verdict in a +-%.0f cm band with no depth allowance" % VERDICT_BAND_CM,
        )

    def update(self, t, P, W, V):
        dt = 1 / 30 if self.t_prev is None else max(t - self.t_prev, 1e-3)
        self.t_prev = t
        if self.state == "DONE":
            return
        if P is None:
            self.t_lost = self.t_lost or t
            if self.ppm and t - self.t_lost > 1.5:
                self._end_set(t)
            return
        self.t_lost = None
        sh = (P[L_SH] + P[R_SH]) / 2; wr = (P[L_WR] + P[R_WR]) / 2; hip = (P[L_HIP] + P[R_HIP]) / 2
        mouth = (P[L_MOUTH] + P[R_MOUTH]) / 2; eye = (P[L_EYE] + P[R_EYE]) / 2
        chin_pt = mouth + CHIN_AXIS_K * (mouth - eye)
        sh_y = self.f_sh(float(sh[1]), dt)
        el3 = dict(l=angle(W[L_SH], W[L_EL], W[L_WR]), r=angle(W[R_SH], W[R_EL], W[R_WR]))
        self.el3 = self.f_el3((el3["l"] + el3["r"]) / 2, dt)
        self.el2 = self.f_el2((angle(P[L_SH], P[L_EL], P[L_WR]) + angle(P[R_SH], P[R_EL], P[R_WR])) / 2, dt)
        hands_up = P[L_WR, 1] < P[L_SH, 1] and P[R_WR, 1] < P[R_SH, 1]
        overhead = hands_up and wr[1] < P[NOSE, 1]

        if not self.reps and self.cur is None:      # the last steady hang before the first pull wins
            arm_px = (np.linalg.norm(P[L_SH] - P[L_WR]) + np.linalg.norm(P[R_SH] - P[R_WR])) / 2
            self._calibrate(t, P, sh_y, float(wr[1]), float(arm_px), overhead and self.el2 >= 150)
        if self.ppm is None:
            return

        if not hands_up:                            # the release
            self.t_off = self.t_off or t
            if t - self.t_off > 0.4:
                if self.reps or self.cur:
                    self._end_set(t)
                else:
                    self.reset()
                return
        else:
            self.t_off = None

        h = (self.base_y - sh_y) / self.ppm
        v = self.f_v(0.0 if self.h_prev is None else (h - self.h_prev) / dt, dt)
        self.acc = self.f_a(0.0 if self.v_prev is None else (v - self.v_prev) / dt, dt)
        self.h_prev = h; self.h = h; self.v = v; self.v_prev = v

        face = min(V[NOSE], V[L_MOUTH], V[R_MOUTH]) > 0.5
        if face:
            gap = self.f_chin((self.bar_y - float(chin_pt[1])) / self.ppm * 100, dt)
            self.last_seen = (gap, sh_y)
            self.chin_cm = gap
        elif self.last_seen:                         # the last honest frame + the shoulder rise since
            self.chin_cm = self.last_seen[0] + (self.last_seen[1] - sh_y) / self.ppm * 100

        if self.pending is not None:                 # lock-out is read at the bottom after the rep
            self.pending["_el3_max"] = max(self.pending["_el3_max"], self.el3)
            self.pending["_el2_max"] = max(self.pending["_el2_max"], self.el2)
            if t - self.pending["t_end"] > 1.5:
                self._finish_pending()

        if self.cur is None:
            self.state = "HANG"
            if abs(v) < 0.05 and abs(h) < 0.06:     # phases from the local base: follow the hang
                self.base_y += (1 - np.exp(-dt / 0.5)) * (sh_y - self.base_y)
            if h > START_H and v > START_V:
                self._finish_pending()
                self.cur = dict(samples=[], peak=0.0)
        if self.cur is not None:
            c = self.cur
            c["samples"].append((t, h, v, float(hip[0]) / self.ppm * 100, self.chin_cm,
                                 float(P[L_SH, 1] - P[R_SH, 1]) / self.ppm * 100))
            c["peak"] = max(c["peak"], h)
            c["hip"] = (min(c["hip"][0], hip[0]), max(c["hip"][1], hip[0])) if "hip" in c else (hip[0], hip[0])
            self.state = "PULL" if v > 0.05 else "LOWER" if v < -0.05 else "HOLD"
            if c["peak"] >= 0.12 and h < max(0.05, 0.25 * c["peak"]):
                self._close_rep(t)
            elif c["peak"] < 0.12 and h < 0.02:     # a shrug, not an attempt
                self.cur = None
        sway = (self.cur["hip"][1] - self.cur["hip"][0]) / self.ppm * 100 if self.cur else 4.0
        self.mus.update(dt, P / self.ppm, el3, self.acc, self.state, sway)

    @property
    def shown_count(self):
        """The counter ticks at the top: once the pull is long enough and has turned around."""
        c = self.cur
        if c is None:
            return self.count
        good = [r["rom_cm"] / 100 for r in self.reps if not r["failed"]]
        need = FAIL_SHORT_PCT * float(np.median(good)) if good else MIN_ROM_M
        return self.count + int(c["peak"] >= need and self.h < c["peak"] - TOP_BAND_M)

    @property
    def last(self):
        return self.reps[-1] if self.reps else None


# ---------------------------------------------------------------- camera, pose, screen

class Camera:
    """Reads on its own thread and keeps only the newest frame, so the pose model never works on a stale one."""
    def __init__(self, src, realtime=True):
        self.cap = cv2.VideoCapture(src, cv2.CAP_AVFOUNDATION) if isinstance(src, int) else cv2.VideoCapture(src)
        if not self.cap.isOpened():
            sys.exit(f"cannot open camera/video {src}")
        self.live = isinstance(src, int); self.realtime = realtime
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.frame = None; self.n = 0; self.done = False; self.lock = threading.Lock()
        if self.live:
            threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while not self.done:
            ok, f = self.cap.read()
            if not ok:
                time.sleep(0.005); continue
            with self.lock:
                self.frame = f; self.n += 1; self.t = time.monotonic()

    def read(self, last_n):
        """-> (n, t, frame) or None at the end of a file."""
        if not self.live:
            ok, f = self.cap.read()
            if not ok:
                return None
            t = last_n / self.fps
            return last_n + 1, t, f
        while True:
            with self.lock:
                if self.frame is not None and self.n != last_n:
                    return self.n, self.t, self.frame
            time.sleep(0.002)


GREEN, AMBER, RED, WHITE, DIM = (90, 220, 90), (60, 190, 255), (70, 70, 240), (245, 245, 245), (170, 170, 170)
VERDICT_COL = dict(above=GREEN, at=AMBER, short=RED)
PHASE_COL = dict(SETUP=DIM, HANG=DIM, PULL=GREEN, HOLD=AMBER, LOWER=(255, 170, 60), DONE=WHITE)


def text(img, s, org, scale, col=WHITE, thick=2):
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_DUPLEX, scale, (0, 0, 0), thick + 4, cv2.LINE_AA)
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_DUPLEX, scale, col, thick, cv2.LINE_AA)


def draw(frame, P, V, S, fps_now, muscles=True, history=None):
    H, W = frame.shape[:2]
    k = min(H, W) / 1080.0
    on_bar = S.state in ("HANG", "PULL", "HOLD", "LOWER")
    if muscles and P is not None and on_bar:
        LM.paint(frame, P, S.mus.E)
    if P is not None:
        for a, b in BONES:
            if V[a] > 0.3 and V[b] > 0.3:
                cv2.line(frame, tuple(P[a].astype(int)), tuple(P[b].astype(int)), (255, 255, 255), max(int(3 * k), 1), cv2.LINE_AA)
    if S.bar_y is not None:
        cv2.line(frame, (0, int(S.bar_y)), (W, int(S.bar_y)), AMBER, max(int(2 * k), 1), cv2.LINE_AA)
    x = int(40 * k)
    text(frame, str(S.shown_count), (x, int(230 * k)), 8 * k, WHITE, int(14 * k))
    text(frame, S.state, (x, int(310 * k)), 1.8 * k, PHASE_COL[S.state], int(3 * k))
    y = int(390 * k); dy = int(62 * k)
    if S.state == "SETUP":
        text(frame, "hang with straight arms to calibrate", (x, y), 1.3 * k, AMBER, int(2 * k))
    elif S.state == "DONE":
        m = S.summary
        rows = [] if m["reps"] == 0 else [
            f"{m['reps']} reps in {m['hang_time_s']:.0f} s on the bar",
            f"chin: {m['chin_above']} above, {m['chin_at']} at, {m['chin_short']} short (mean {m['mean_chin_cm']:+.1f} cm)",
            f"lock-out: {m['lockouts']}/{m['reps']}",
            f"speed loss at the last rep: {m['velocity_loss_last_pct']:.0f} %",
            f"efficiency: {m['mean_efficiency']:.0f}/100   {m['kcal']:.1f} kcal",
            f"fatigued: lats {m['fatigued_lats'] * 100:.0f} %, biceps {m['fatigued_biceps'] * 100:.0f} %, grip {m['fatigued_grip'] * 100:.0f} % (model)",
        ]
        if m["reps"] == 0:
            rows = ["0 reps"]
        elif history:
            rows.append(f"before this: last set {history[-1]} reps, best {max(history)} over {len(history)} sets")
        rows.append("grab the bar again for the next set")
        for i, r in enumerate(rows):
            text(frame, r, (x, y + i * dy), 1.3 * k, WHITE, int(2 * k))
    else:
        rows = [f"elbow {S.el3:.0f} deg", f"speed {S.v:+.2f} m/s", f"height {S.h * 100:.0f} cm"]
        if S.last and not S.last["failed"]:
            rows.append(f"speed loss {S.last['velocity_loss_pct']:.0f} %")
        for i, r in enumerate(rows):
            text(frame, r, (x, y + i * dy), 1.4 * k, WHITE, int(2 * k))
        a = S.last
        if a:
            y0 = H - int(150 * k)
            if a["failed"]:
                text(frame, f"attempt {a['n']}: short pull ({a['rom_cm']:.0f} cm), not counted", (x, y0), 1.5 * k, RED, int(3 * k))
            else:
                text(frame, f"rep {a['rep']}: chin {a['chin_verdict'].upper()} the bar ({a['chin_cm']:+.0f} cm)",
                     (x, y0), 1.7 * k, VERDICT_COL[a["chin_verdict"]], int(3 * k))
                lock = ("lock-out ..." if "lockout" not in a else
                        f"lock-out {'OK' if a['lockout'] else 'SHORT'} ({a['elbow_bottom_after']:.0f} deg)")
                lcol = DIM if "lockout" not in a else GREEN if a["lockout"] else RED
                text(frame, lock, (x, y0 + int(64 * k)), 1.5 * k, lcol, int(3 * k))
                text(frame, f"up {a['t_concentric']:.1f} s  down {a['t_eccentric']:.1f} s  ROM {a['rom_cm']:.0f} cm"
                     + (f"  score {a['efficiency']:.0f}" if "efficiency" in a else ""),
                     (x, y0 + int(120 * k)), 1.1 * k, WHITE, int(2 * k))
    if muscles and on_bar:
        if W >= H:
            LM.panel(frame, S.mus, W - int(600 * k), int(110 * k), k, text)
        else:
            LM.panel(frame, S.mus, x, y + 4 * dy + int(40 * k), k, text)
    text(frame, f"{fps_now:.0f} fps", (W - int(170 * k), int(50 * k)), 1.0 * k, DIM, int(2 * k))
    return frame


class Recorder:
    """One set's folder. set.mp4: the clean frames; replay.mp4: what the screen showed; pose_mp.npz:
    the landmarks in extract_pose_mp.py's layout, one row per video frame, plus timestamps;
    live.json: reps, summary, muscles. Both videos run on a fixed 30 fps timeline (a frame is
    repeated or dropped to follow the capture times), so a replay plays at the true speed."""
    FPS = 30.0

    def __init__(self, folder, size, clean=True):
        self.dir = folder
        os.makedirs(self.dir, exist_ok=True)
        self.size = size; self.clean = clean
        k = 1280 / max(size)
        self.rsize = (int(size[0] * k) // 2 * 2, int(size[1] * k) // 2 * 2)
        fourcc = cv2.VideoWriter_fourcc(*"avc1")            # H.264: plays in a browser
        self.vw = cv2.VideoWriter(os.path.join(self.dir, "set.mp4"), fourcc, self.FPS, size) if clean else None
        self.rw = cv2.VideoWriter(os.path.join(self.dir, "replay.mp4"), fourcc, self.FPS, self.rsize)
        self.img = []; self.world = []; self.ok = []; self.t = []; self.n = 0; self.t0 = None

    def add(self, frame, shown, t, res):
        self.t0 = t if self.t0 is None else self.t0
        k = min(int(round((t - self.t0) * self.FPS)) + 1 - self.n, 5)
        if k <= 0:
            return
        small = cv2.resize(shown, self.rsize, interpolation=cv2.INTER_AREA)
        ok = bool(res.pose_landmarks)
        img = [(l.x, l.y, l.z, l.visibility, l.presence) for l in res.pose_landmarks[0]] if ok else np.full((33, 5), np.nan)
        world = [(l.x, l.y, l.z) for l in res.pose_world_landmarks[0]] if ok else np.full((33, 3), np.nan)
        for _ in range(k):
            self.rw.write(small)
            if self.clean:
                self.vw.write(frame)
                self.img.append(img); self.world.append(world); self.ok.append(ok); self.t.append(t)
        self.n += k

    def close(self, S, meta):
        self.rw.release()
        if self.clean:
            self.vw.release()
            np.savez_compressed(os.path.join(self.dir, "pose_mp.npz"), fps=self.FPS, width=self.size[0], height=self.size[1],
                                n_frames=len(self.ok), img=np.array(self.img, np.float32), world=np.array(self.world, np.float32),
                                ok=np.array(self.ok), t=np.array(self.t))
        reps = [{k: v for k, v in r.items() if not k.startswith("_")} for r in S.reps]
        with open(os.path.join(self.dir, "live.json"), "w", encoding="utf-8") as f:
            json.dump(dict(meta=meta, summary=S.summary, reps=reps, model=S.mus.snapshot()), f, indent=1, default=float)
        print(f"saved {self.dir}", flush=True)


def past_reps(out_root, skip=None):
    """Rep counts of the saved sets, oldest first, for the line under the summary."""
    out = []
    for p in sorted(glob.glob(os.path.join(out_root, "*", "live.json"))):
        if skip and os.path.samefile(os.path.dirname(p), skip):
            continue
        try:
            m = json.load(open(p, encoding="utf-8"))["summary"]
            if m and m.get("reps"):
                out.append(int(m["reps"]))
        except (OSError, ValueError, KeyError):
            pass
    return out


def main():
    kw = dict(a.split("=", 1) for a in sys.argv[1:])
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    out_root = kw.get("out", os.path.join(repo, "formats", "pullup-analysis", "out", "live"))
    session = kw.get("session")                 # a saved set's folder: run it again, rewrite live.json + replay.mp4
    old = json.load(open(os.path.join(session, "live.json"), encoding="utf-8"))["meta"] if session else {}
    prof_path = os.path.join(out_root, "profile.json")
    prof = json.load(open(prof_path, encoding="utf-8")) if os.path.exists(prof_path) else {}
    height = float(kw.get("height", old.get("height", prof.get("height", 1.88))))
    mass = float(kw.get("mass", old.get("mass", prof.get("mass", 79))))
    if not session and ("height" in kw or "mass" in kw):
        os.makedirs(out_root, exist_ok=True)
        json.dump(dict(height=height, mass=mass), open(prof_path, "w", encoding="utf-8"))
    model = kw.get("model", os.path.join(repo, "tools", "models", "pose_landmarker_full.task"))
    rot = {0: None, 90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[int(kw.get("rot", 0))]
    headless = kw.get("headless") == "1" or bool(session); record = kw.get("record", "1") == "1"
    show_muscles = kw.get("muscles", "1") == "1"
    src = os.path.join(session, "set.mp4") if session else kw["video"] if "video" in kw else int(kw.get("cam", 1))
    ts = np.load(os.path.join(session, "pose_mp.npz"))["t"] if session else None
    cam = Camera(src)
    pace = "video" in kw and kw.get("fast") != "1" and not headless
    seconds = float(kw.get("seconds", 0))       # stop a live run after this long (for tests)
    print(f"height {height:.3f} m, mass {mass:.1f} kg", flush=True)

    import mediapipe as mp
    from mediapipe.tasks.python import vision, BaseOptions
    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model, delegate=BaseOptions.Delegate.CPU), running_mode=vision.RunningMode.VIDEO, num_poses=1,
        min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.5)

    S = None; rec = None; n = 0; t0 = None; fps_now = 0.0; t_wall = time.monotonic(); win = "live pull-ups"; full = False
    meta = dict(old) if session else dict(height=height, mass=mass, model=os.path.basename(model), source=str(src))
    history = past_reps(out_root, skip=session)
    if not headless:
        cv2.namedWindow(win, cv2.WINDOW_NORMAL)

    def finish():
        nonlocal rec, history
        rec.close(S, meta); rec = None
        history = past_reps(out_root, skip=session)
        try:
            import build_pullup_history
            print("history:", build_pullup_history.build(out_root), flush=True)
        except Exception as e:                      # the page is a convenience; a set is never lost to it
            print("history page not rebuilt:", e, flush=True)

    try:
        with vision.PoseLandmarker.create_from_options(opts) as lm:
            while True:
                got = cam.read(n)
                if got is None:
                    break
                n, t, frame = got
                if ts is not None and n - 1 < len(ts):
                    t = float(ts[n - 1])
                if seconds and t0 is not None and t - t0 > seconds:
                    break
                if rot is not None:
                    frame = cv2.rotate(frame, rot)
                t0 = t if t0 is None else t0
                H, W = frame.shape[:2]
                if S is None:
                    S = LiveSet(height, mass, H)
                res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)),
                                          int((t - t0) * 1000))
                P = Wd = V = None
                if res.pose_landmarks:
                    p = res.pose_landmarks[0]
                    P = np.array([(l.x * W, l.y * H) for l in p]); V = np.array([l.visibility for l in p])
                    Wd = np.array([(l.x, l.y, l.z) for l in res.pose_world_landmarks[0]])
                was = S.state
                if was == "DONE" and not session and P is not None and P[L_WR, 1] < P[NOSE, 1] and P[R_WR, 1] < P[NOSE, 1]:
                    S.reset(); was = "SETUP"            # hands overhead again: the next set
                S.update(t - t0, P, Wd, V)
                if record and rec is None and was == "SETUP" and S.state == "HANG":
                    if session:
                        rec = Recorder(session, (W, H), clean=False)
                    else:
                        meta["started"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                        rec = Recorder(os.path.join(out_root, time.strftime("%Y-%m-%d_%H%M%S")), (W, H))
                shown = draw(frame.copy(), P, V, S, fps_now, show_muscles, history) if (rec is not None or not headless) else None
                if rec is not None:
                    rec.add(frame, shown, t - t0, res)
                    if S.state in ("DONE", "SETUP"):    # SETUP: let go before a rep, nothing to keep but the clip
                        finish()
                if S.state == "DONE" and was != "DONE" and S.summary["reps"]:
                    print(json.dumps(S.summary, indent=1, default=float), flush=True)
                now = time.monotonic(); fps_now = 0.9 * fps_now + 0.1 / max(now - t_wall, 1e-3) if fps_now else 1 / max(now - t_wall, 1e-3)
                t_wall = now
                if not headless:
                    cv2.imshow(win, shown)
                    key = cv2.waitKey(max(int(1000 / cam.fps - 15), 1) if pace else 1) & 0xFF
                    if key == ord("q"):
                        break
                    if key == ord("r"):
                        S.reset()
                    if key == ord("m"):
                        show_muscles = not show_muscles
                    if key == ord("f"):
                        full = not full
                        cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN if full else cv2.WINDOW_NORMAL)
    except KeyboardInterrupt:
        pass
    cam.done = True
    if rec is not None:
        if S.state != "DONE":
            S._end_set(S.t_prev or 0.0)
        finish()
    if headless and S is not None:
        print(f"{fps_now:.1f} fps, frame {W}x{H}")
        for r in S.reps:
            print({k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items() if k != "score" and not k.startswith("_")})


if __name__ == "__main__":
    main()
