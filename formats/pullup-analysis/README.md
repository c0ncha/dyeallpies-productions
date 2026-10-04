# Pull-up analysis

A phone clip of one pull-up set, camera on the floor, becomes a rep-counted, biomechanics-
annotated Reel and a full-length analysis, plus a dashboard, a written report with the
papers behind every number and an interactive page. This folder is the third set
(2026-09-08, 11 reps, judged to the USMC standard); the first two sets and everything learned
from them are archived in
[../archive/pullup-analysis-sets-1-2/](../archive/pullup-analysis-sets-1-2/README.md).

- The worked example with the timeline, every pass and every mistake on the way:
  [pullups-2026-09-08.md](pullups-2026-09-08.md)
- The report: [REPORT-3.md](REPORT-3.md) · the caption: [CAPTION-3.md](CAPTION-3.md) ·
  the dashboard: [pullup3-dashboard.png](pullup3-dashboard.png)
- The muscle model, written out with every constant ranked by how well it is known:
  [MUSCLE-MODEL.md](MUSCLE-MODEL.md); its printed validation table: [work3/model_v43.txt](work3/model_v43.txt)
- The plan and the critical assessment of the first two sets: [PLAN-3.md](PLAN-3.md)
- The literature archive (abstracts, open-access full texts, the tables as CSV):
  [references/pullup-science/](../../references/pullup-science/)
- The reel's cut, as a frame schedule: [work3/reel_schedule.json](work3/reel_schedule.json)
- The backdrop and its required credit lines: [assets/ATTRIBUTION.md](assets/ATTRIBUTION.md)

## Outputs

1. `pullup3-analysis.mp4`: the full set at real speed from the moment the hands take the bar
   to 2.3 s after the release, 1080x1920, with the tracked skeleton, the rep counter and phase
   pill, the live elbow angle and speed, the left stack (chin verdicts, speed loss, peak power,
   modelled lat temperature, the two prime movers' fatigued pools, kcal), the muscle map on the
   matted body against the jungle plate, a rep card after every rep, the GitHub box whenever the
   card is off, the shoulder-height chart, and a references card at the end.
2. `pullup3-reel-30.mp4`: the same render cut by frame schedule to 27.7 s (reps 1-2 at real
   speed, 3-10 at x3, rep 11 and the release at real speed).
3. `pullup3-dashboard.png`: the per-rep figure.
4. `pullup3-report.html`: the interactive report built from the analysis JSON.
5. `REPORT-3.md`, `CAPTION-3.md`, `MUSCLE-MODEL.md`.

**Ask for height and body mass up front.** Height calibrates the centimetre scale, mass turns
the kinematics into work, power, force and the joint torques the muscle model starts from.
Ask for a tape measure on the doorway width and the bar height, and for a second phone from
the side: the shoulder's depth behind the bar is computed from a 3D elbow angle, not seen.

## The third set's pipeline (2026-09-08, floor camera)

Scripts with the `3` suffix are the current ones; `work3/` holds the geometry helpers.

```bash
PY=.venv-pushup/Scripts/python.exe
# 0. tone-mapped SDR master (the phone records 10-bit HLG)
ffmpeg -y -init_hw_device vulkan -i IMG.MOV -vf "libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p" -c:v h264_nvenc -preset p5 -rc vbr -cq 12 -b:v 0 -c:a aac work3/master.mp4
# 1. camera model: vertical + horizontal vanishing points -> f, R, H (the doorway plane)
$PY work3/vp_fit.py work3/master.mp4 work3/vp.npy 135,165,600,1200,1745,1790 690
$PY work3/geom_fit.py work3/master.mp4 1745,1770,1800,1830,1860       # bar, lintel, horizontal VP
$PY work3/rectify.py work3/master.mp4 1770 work3/rect_check.png       # H_rect.npy, K.npy; check the frame
# 2. trackers on the master, in parallel (matte is the long pole, ~26 min)
$PY tools/scripts/extract_pose_mp.py work3/master.mp4 tools/models/pose_landmarker_heavy.task work3/pose_mp.npz
$PY tools/scripts/extract_pose_yolo.py work3/master.mp4 tools/models/yolov8m-pose.pt work3/pose_yolo.npz 640
$PY tools/scripts/extract_matte.py work3/master.mp4 work3/matte.npy 2
# 3. analysis in the rectified plane (stand= the reach under the bar, ref= arms down after the set)
$PY tools/scripts/analyze_pullups3.py work3/master.mp4 work3/pose_mp.npz work3/analysis.json work3/pose_yolo.npz height=1.88 mass=79 stand=7.8,9.2 ref=57.2,58.6
$PY tools/scripts/pullup_thermal4.py work3/analysis.json work3/pose_mp.npz   # the muscle model: moments, force sharing, fatigue; validation table vs Youdas (MUSCLE-MODEL.md)
$PY tools/scripts/pullup_chin_silhouette.py work3/analysis.json work3/matte.npy work3/chin_sil.json strip=work3/chin_strip.jpg
$PY tools/scripts/measure_redness.py work3/master.mp4 work3/pose_mp.npz work3/analysis.json work3/matte.npy work3/redness.json ref=0.22,0.22,0.35,0.28 base=205,275
# 4. backdrop: Commons search (curl), cut-outs (rembg isnet), plate
$PY work3/commons_search.py "spider monkey" work3/commons/spider_monkey.json 2500 50
$PY work3/commons_download.py && $PY work3/commons_credits.py && $PY work3/build_plate3.py
# 5. renders: preview three frames at 1:1 first (atlas), bake the body layer once, then the full set and the reel from the cache
$PY tools/scripts/pullup_atlas3.py work3/master.mp4 work3/pose_mp.npz work3/analysis.json work3/matte.npy 430,506,1478 work3/atlas3
$PY -u tools/scripts/render_pullup_overlay3.py work3/master.mp4 work3/pose_mp.npz work3/analysis.json work3/bake_dummy.mp4 heat=work3/matte.npy look=1 grid=1 cat=1 bg=assets/jungle3_plate.jpg trim=282,1768 hold=0.5 cache=work3/body.mkv bake=only > work3/bake_body.log   # ~25 min once: plate + paint + look per source frame, lossless FFV1 + .json (centroids, validity key); rebuilds itself when the paint, the look, the model or an input changes
$PY -u tools/scripts/render_pullup_overlay3.py work3/master.mp4 work3/pose_mp.npz work3/analysis.json out/pullup3-analysis.mp4 heat=work3/matte.npy look=1 grid=1 cat=1 bg=assets/jungle3_plate.jpg trim=282,1768 hold=0.5 cache=work3/body.mkv > work3/full_render.log   # ~2 min from the cache; dashboard3 / page3 take pose=work3/pose_mp.npz to use the v4 model
$PY -u tools/scripts/render_pullup_overlay3.py ... out/pullup3-reel-30.mp4 ... cache=work3/body.mkv schedule=work3/reel_schedule.json   # ~1.5 min from the cache (was 14)
# 6. gates, dashboard, page
$PY tools/scripts/check_flicker.py out/pullup3-analysis.mp4 work3/matte.npy work3/flicker_full.png offset=150
$PY tools/scripts/render_pullup_dashboard3.py work3/analysis.json out/pullup3-dashboard.png work3/redness.json
$PY tools/scripts/build_pullup_page3.py work3/analysis.json out/pullup3-report.html work3/redness.json
```

## Live tracking (2026-10-04, phone as the Mac's camera)

`tools/scripts/live_pullups.py` counts and grades the reps while they happen: the iPhone is the
camera (Continuity Camera), the Mac runs MediaPipe Pose and shows the counter, the phase, the
elbow angle, the speed and a card per rep; a summary appears at the release and the session
(clean video, landmarks in `extract_pose_mp.py`'s layout, per-rep JSON) is saved to `out/live/`.

```bash
python3 -m venv .venv-live && .venv-live/bin/pip install mediapipe==0.10.35 opencv-python numpy scipy
.venv-live/bin/python tools/scripts/live_pullups.py cam=1 height=1.88 mass=79      # rot=90 for an upright phone; video=clip.mov replays a file
```

It is unrectified: the scale and the bar come from the dead hang (0.3 s with straight arms is
enough), the chin verdict is the image-plane face-axis chin in a ±3 cm band with no depth
allowance, and the filters are causal. The offline pipeline stays the reference.

The muscle map is `tools/scripts/live_muscles.py`: the v4 model's chain and constants run one
frame at a time (no heat or temperature, whose scale needs the finished set; the colour is the
non-resting share of the pool, M_A + M_F), painted as soft regions from the landmarks, front or
back, with a bar per prime mover (`m` toggles it). Each set's folder holds `set.mp4` (clean),
`replay.mp4` (what the screen showed), `pose_mp.npz` and `live.json` (reps, summary, muscles);
`tools/scripts/build_pullup_history.py` builds `out/live/history.html`, the page that compares
the sets (rebuilt after every set). `session=<folder>` re-runs a saved set through the current
code; height and mass are remembered in `out/live/profile.json`.

## Rules that came out of the third set (2026-09-08, floor camera, anatomy paint) — these supersede

Worked example: `pullups-2026-09-08.md` (in this folder). Scripts:
`analyze_pullups3.py`, `render_pullup_overlay3.py`, `render_pullup_dashboard3.py`,
`build_pullup_page3.py`, `pullup_thermal4.py` (inverse dynamics → force sharing → force–velocity → activation dynamics → fatigue; formulation in `MUSCLE-MODEL.md`; `pullup_thermal3.py` is the phase-table model it replaced), `pullup_atlas3.py`, `pullup_chin_silhouette.py`;
geometry helpers in `pullup/work3/` (`vp_fit.py`, `geom_fit.py`, `rectify.py`, `build_plate3.py`,
`commons_search.py`). Research archive: `references/pullup-science/` (read `01`–`06` before
changing a constant; `DOWNLOADS.md` lists every file).

- **Research before rendering, and archive it.** Every constant in the heat budget, the
  velocity rules and the norms cites a file in `references/pullup-science/`. Agents fetch
  abstracts through PubMed E-utilities and Europe PMC, PDFs with `curl -A "Mozilla/5.0"`;
  the system Python's certificate store is expired, so downloads go through curl.
- **Tone-map HLG before anything reads a pixel.** iPhone clips are 10-bit HLG; the plain
  decode is grey. `libplacebo=tonemapping=bt.2390` on Vulkan (`-init_hw_device vulkan`) into
  an SDR master; zscale hable/mobius are worse by eye.
- **Measure in a rectified plane, render on the frame.** Two vanishing points → f from
  their orthogonality → H = K Rᵀ K⁻¹, then a residual rotation so the fitted bar is exactly
  level (the bar is the judge's line). Verify with the lintel: if it tilts the same way, the
  residual was the model. The plane normal must point away from the camera or the image
  mirrors. Landmarks go through H; the render, the grid (mapped back through H⁻¹) and the
  paint stay in image space.
- **Depth is the allowance, computed.** Elevation to the bar from K and the pitch; a point d
  behind the bar plane projects tan(elevation) × d lower. State the assumed depth (8 cm for
  the chin) and the band it implies (±3 cm) — never a fixed "3 cm".
- **The head hidden at the top is a witness only after you know what hides it.** With a bar
  mounted at the back edge of the lintel's underside, "hidden" means chin ≥ the bar's
  underside sight line, nothing more. Look at a rep top at full resolution with the
  highlights stretched before writing any occlusion bound. YOLO's nose confidence can stay
  high with the head gone; MediaPipe's visibility always does.
- **Chin from the last honest frame.** face_seen = eyes ≥ 4 cm under the bar's underside
  AND nose confidence > 0.35; chin at the top = face-axis chin there + the shoulder rise
  since. Print in-plane, adjusted and the head-hidden time per rep.
- **Phases from the local base.** The passive dead hang sits 2–3 cm below the active hang;
  the concentric starts from the highest shoulder position in the second before the pull.
- **Reference windows:** stature = the reach under the bar (arms up, at the bar plane);
  shoulder-tilt reference = arms down, after the set; ear-to-shoulder reference = the dead
  hang, never the reach (it reads a 10 cm "shrug" on every top).
- **Scale check by physics:** shoulder-to-bar at the dead hang must equal 0.332 × stature
  within a few percent. The wrist-based arm anchor under-reads by ~13 % (the wrist is 8 cm
  below the bar); report it, do not average it in.
- **Velocity: rep 1 is the reference (Beckham 2018), the fastest rep beside it; loss against
  25 % / 50 % (Sánchez-Moreno 2020); RIR is a range, never an integer.**
- **The chest flush is not muscle heat at the skin.** Skin blood flow falls in the first
  minute of exercise; report the index as effort-tracking and say what it is not.
- **Anatomy paint:** regions with fibre-direction fields (fan to the tendon or parallel),
  grooves with an inner highlight, belly shading, irregular thin striations, the frame's own
  luminance kept deep; ironbow scale 0 → +1.5 °C; names shown once when a muscle passes
  +0.3 °C. Preview hang / mid-pull / top at 1:1 before rendering.
- **Layout for a centred, large body:** push in only as far as keeps the bar under the
  Instagram top band; no side panels over the arms — readouts are pills beside the elbow
  and hips; the legend lives in the chart header; the card leads with three numbers.
- **Backdrop:** Commons API with `iiurlwidth` for thumbnails (hand-built thumb URLs 400),
  originals into `pullup/assets/commons/` with `CREDITS.json`; rembg isnet + alpha matting
  for cut-outs, drop any that sat on branches; the cat is pasted from its own mask.
- **Tooling hygiene:** patch scripts from a file with `encoding="utf-8"` (a heredoc here
  mangles `\n` and non-ASCII); run long renders with `python -u` straight to a log.
- Next upgrades, licence-checked in `05-ml-tooling-survey.md`: DWPose via rtmlib (jawline
  keypoints), SAM 2 for person + cat masks, SCHP for body-part parsing.

## Efficiency score (per rep, /100)

ROM 25 (chin at or over the bar, −2.5 per cm short) · eccentric control 20 (full at
1.5 s) · lock-out 15 (155°+ full, 0 at 120°) · low sway 15 (≤ 4 cm hip sway full, 0 at
20 cm) · pull speed 15 (peak concentric velocity ÷ the best rep of the set) · L/R
symmetry 10 (≤ 5° mean elbow gap full, 0 at 25°). A ≥ 85, B ≥ 70, C ≥ 55. The letter is
a footnote; the rep card and the chart chips carry the chin verdict.

## Next time

- Film from further back or higher so the head never leaves the frame at the top; then
  the chin can be measured directly instead of inferred.
- A side-on second angle makes sway, kip and lat work far more trustworthy.
- Skip the long dead hang if the set is a max-rep test.

## Caption

At most 2000 characters, one paragraph per line, five hashtags. Hook on the count and the
verdict, one paragraph on what the model is and one on what it is not, the four verdict
lines, the repository link, a question, the backdrop credits. See [CAPTION-3.md](CAPTION-3.md).
