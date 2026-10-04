// The app: camera -> MediaPipe Pose in the browser -> the exercise's tracker -> one canvas,
// plus the replay recorder and the history view. A static page; nothing is sent anywhere.
import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { PullupSet } from "./pullup.js";
import { PushupSet } from "./pushup.js";
import { drawFrame } from "./draw.js";
import { saveSet, allSets, getVideo, deleteSet } from "./store.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = (q) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${q}/float16/latest/pose_landmarker_${q}.task`;
const TRACKERS = { pullup: PullupSet, pushup: PushupSet };
const HINTS = {
  pullup: "Prop the phone where it sees you and the whole bar, with clear space above the bar. Then hang with straight arms for a moment before the first pull.",
  pushup: "Put the phone on the floor at your side, a few steps away, so it sees you from head to feet. Then hold the top of a push-up for a moment.",
};
const $ = (s) => document.querySelector(s);
const video = $("#video"), canvas = $("#canvas"), ctx = canvas.getContext("2d");

// A phone gets the fast pose model unless the accurate one was picked in Settings (modelSet).
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const settings = Object.assign({ units: "imperial", height: 1.75, mass: 75, voice: false, muscles: true, replay: true, model: "full", modelSet: false, facing: "user", exercise: "pullup" },
  JSON.parse(localStorage.getItem("settings") || "{}"));
if (!settings.modelSet) settings.model = MOBILE ? "lite" : "full";
const persist = () => localStorage.setItem("settings", JSON.stringify(settings));

let delegate = "GPU", failures = 0;
let landmarker = null, loadedModel = null, running = false, S = null, t0 = null, lastTime = -1, fps = 0, tWall = 0;
let recorder = null, chunks = [], recStream = null, setMeta = null, tDone = 0, spoken = 0, wake = null;
const past = { pullup: [], pushup: [] };              // rep counts of the saved sets, oldest first

async function refreshPast() {
  const sets = await allSets();
  for (const k in past) past[k] = sets.filter((s) => s.exercise === k).map((s) => s.summary.reps);
}
async function loadModel() {
  if (landmarker && loadedModel === settings.model) return;
  $("#status").textContent = "Loading the pose model…";
  const files = await FilesetResolver.forVisionTasks(WASM);
  const make = (delegate) => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL(settings.model), delegate }, runningMode: "VIDEO", numPoses: 1 });
  try { landmarker = await make(delegate); } catch { delegate = "CPU"; landmarker = await make("CPU"); }
  loadedModel = settings.model;
}
async function startCamera() {
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: settings.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  video.srcObject = stream;
  await video.play();
}
async function start() {
  try {
    $("#startBtn").disabled = true;
    await loadModel();
    $("#status").textContent = "Starting the camera…";
    await startCamera();
    await refreshPast();
    $("#start").hidden = true; video.hidden = false; canvas.hidden = false; $("#flip").hidden = false;
    wake = await navigator.wakeLock?.request("screen").catch(() => null);
    if (!running) { running = true; schedule(); }
  } catch (e) {
    $("#status").textContent = "Could not start: " + (e.message || e) + ". The camera needs permission and an https address.";
  } finally { $("#startBtn").disabled = false; }
}

function startRec() {
  setMeta = { started: new Date() };
  if (!settings.replay || !window.MediaRecorder) return;
  const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  try {
    recStream = recStream || canvas.captureStream(30);
    recorder = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: 2.5e6 }); chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start(1000);
  } catch { recorder = null; }
}
function stopRec() {                                  // -> the replay blob, or null
  return new Promise((res) => {
    if (!recorder) return res(null);
    const r = recorder; recorder = null;
    r.onstop = () => res(chunks.length ? new Blob(chunks, { type: r.mimeType }) : null);
    r.stop();
  });
}
async function finishSet() {
  const done = S, meta = setMeta, blob = await stopRec();
  if (!done.summary || !done.summary.reps || !meta) return;
  const d = meta.started, p = (n) => String(n).padStart(2, "0");
  const id = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const reps = done.reps.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_"))));
  await saveSet({ id, exercise: done.constructor.id, height: settings.height, mass: settings.mass, summary: done.summary, reps, model: done.snapshot(), video: !!blob }, blob);
}

// One call per camera frame, with the frame's own timestamp where the browser gives it
// (requestVideoFrameCallback): speeds and accelerations are differences over a few frames, and
// the time a callback happens to run is too uneven for that.
const useRvfc = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
function schedule() { useRvfc ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop); }
function loop(_, meta) {
  if (!running) return;
  schedule();
  const tFrame = meta ? meta.mediaTime : video.currentTime;
  if (video.readyState < 2 || !video.videoWidth || !$("#history").hidden) return;
  if (tFrame - lastTime < 0.005 && tFrame >= lastTime) return;          // the same frame again
  if (tFrame < lastTime) { S = null; t0 = null; }                        // a new stream
  lastTime = tFrame;
  const now = performance.now();
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; S = null; recStream = null; }
  if (!S || S.constructor.id !== settings.exercise) { S = new TRACKERS[settings.exercise](settings.height, settings.mass, canvas.height); spoken = 0; }
  t0 = t0 ?? tFrame;
  let res;
  try { res = landmarker.detectForVideo(video, now); failures = 0; } catch (e) {
    // some phones accept the GPU delegate and then fail on the first frames: fall back to the CPU once
    if (++failures < 3) return;
    running = false; $("#start").hidden = false; canvas.hidden = true;
    if (delegate === "GPU") { delegate = "CPU"; landmarker = null; failures = 0; start(); }
    else $("#status").textContent = "The pose model stopped: " + (e.message || e);
    return;
  }
  let P = null, W = null, V = null;
  if (res.landmarks && res.landmarks.length) {
    P = res.landmarks[0].map((l) => [l.x * canvas.width, l.y * canvas.height]);
    V = res.landmarks[0].map((l) => l.visibility ?? 1);
    W = res.worldLandmarks[0].map((l) => [l.x, l.y, l.z]);
  }
  const was = S.state;
  if (was === "DONE" && P && now - tDone > 2500 && S.wantsNewSet(P, V)) { S.reset(); spoken = 0; refreshPast(); }
  const before = S.state;
  S.update(tFrame - t0, P, W, V);
  if (before === "SETUP" && !["SETUP", "DONE"].includes(S.state)) startRec();
  if (S.state === "SETUP" && before !== "SETUP" && before !== "DONE") stopRec();         // let go before a rep: nothing to keep
  if (S.state === "DONE" && before !== "DONE") { tDone = now; finishSet(); }
  if (settings.voice && S.shownCount > spoken && window.speechSynthesis) { spoken = S.shownCount; speechSynthesis.speak(new SpeechSynthesisUtterance(String(spoken))); }
  fps = fps ? 0.9 * fps + 0.1 * 1000 / Math.max(now - tWall, 1) : 30; tWall = now;
  drawFrame(ctx, video, P, V, S, { mirror: settings.facing === "user", muscles: settings.muscles, fps, rec: !!recorder, history: past[settings.exercise] });
}

// ---------------------------------------------------------------- controls
function showExercise() {
  document.querySelectorAll("#exercise button").forEach((b) => b.classList.toggle("on", b.dataset.ex === settings.exercise));
  $("#startHint").textContent = HINTS[settings.exercise];
}
$("#exercise").addEventListener("click", (e) => { const ex = e.target.dataset.ex; if (!ex) return; stopRec(); settings.exercise = ex; persist(); showExercise(); refreshPast(); });
$("#startBtn").addEventListener("click", start);
$("#flip").addEventListener("click", async () => { settings.facing = settings.facing === "user" ? "environment" : "user"; persist(); stopRec(); S = null; t0 = null; lastTime = -1; await startCamera(); });
document.addEventListener("visibilitychange", async () => { if (!document.hidden && running) wake = await navigator.wakeLock?.request("screen").catch(() => null); });

const dlg = $("#settings");
function fillSettings() {
  $("#units").value = settings.units;
  const inches = settings.height / 0.0254;
  $("#ft").value = Math.floor(inches / 12); $("#inch").value = (inches % 12).toFixed(1); $("#lb").value = (settings.mass / 0.45359237).toFixed(0);
  $("#cm").value = (settings.height * 100).toFixed(0); $("#kg").value = settings.mass.toFixed(1);
  for (const k of ["voice", "muscles", "replay"]) $("#" + k).checked = settings[k];
  $("#model").value = settings.model; showUnits();
}
function showUnits() { const imp = $("#units").value === "imperial"; dlg.querySelectorAll(".imp").forEach((e) => e.hidden = !imp); dlg.querySelectorAll(".met").forEach((e) => e.hidden = imp); }
$("#units").addEventListener("change", showUnits);
$("#openSettings").addEventListener("click", () => { fillSettings(); dlg.showModal(); });
dlg.addEventListener("close", async () => {
  const num = (id, fallback) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v > 0 ? v : fallback; };
  settings.units = $("#units").value;
  if (settings.units === "imperial") { settings.height = (num("#ft", 5) * 12 + (parseFloat($("#inch").value) || 0)) * 0.0254; settings.mass = num("#lb", 165) * 0.45359237; }
  else { settings.height = num("#cm", 175) / 100; settings.mass = num("#kg", 75); }
  for (const k of ["voice", "muscles", "replay"]) settings[k] = $("#" + k).checked;
  const model = $("#model").value, changed = model !== settings.model; settings.model = model; if (changed) settings.modelSet = true; persist();
  S = null;                                           // a new height or mass applies from the next set
  if (changed && running) { running = false; await loadModel(); running = true; schedule(); }
});

// ---------------------------------------------------------------- history
const f = (x, d = 0) => (x == null ? "–" : (+x).toFixed(d)), pct = (x) => (x == null ? "–" : (100 * x).toFixed(0) + " %"), sgn = (x) => (x > 0 ? "+" : "") + f(x);
const NAMES = { pullup: "Pull-ups", pushup: "Push-ups" };
let filter = "all"; const openSets = new Set(), urls = {};
const tip = $("#tip");
function hover(el, html) {
  el.addEventListener("mousemove", (e) => { tip.innerHTML = html; tip.style.display = "block"; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px"; });
  el.addEventListener("mouseleave", () => (tip.style.display = "none"));
}
function headLine(s, best) {
  const m = s.summary, time = `${s.id.slice(11, 13)}:${s.id.slice(13, 15)}`;
  const parts = s.exercise === "pullup"
    ? [`chin ${sgn(m.mean_chin_cm)} cm`, `lock-out ${m.lockouts}/${m.reps}`, `speed loss ${f(m.velocity_loss_last_pct)} %`, `score ${f(m.mean_efficiency)}`, `lats ${pct(m.fatigued_lats)} fatigued`]
    : [`depth ${m.depth_pass}/${m.reps}`, `lock-out ${m.lockouts}/${m.reps}`, `straight ${m.straight}/${m.reps}`, `speed loss ${f(m.velocity_loss_last_pct)} %`, `score ${f(m.mean_efficiency)}`];
  return `<b class="${m.reps === best[s.exercise] ? "best" : ""}">${m.reps}</b><span>${NAMES[s.exercise]} · ${time}</span>` + parts.map((p) => `<span>${p}</span>`).join("");
}
function repTable(s) {
  const cls = { above: "ok", at: "mid", short: "bad" }, yes = (b) => (b == null ? "–" : b ? '<span class="ok">ok</span>' : '<span class="bad">short</span>');
  if (s.exercise === "pullup") return `<table><tr><th>rep</th><th>chin</th><th>lock-out</th><th>up</th><th>down</th><th>ROM</th><th>speed</th><th>loss</th><th>score</th></tr>` +
    s.reps.map((r) => `<tr><td>${r.failed ? "×" : r.rep}</td><td class="${cls[r.chin_verdict]}">${r.chin_verdict} ${sgn(r.chin_cm)} cm</td><td>${yes(r.lockout)} ${f(r.elbow_bottom_after)}°</td><td>${f(r.t_concentric, 1)} s</td><td>${f(r.t_eccentric, 1)} s</td><td>${f(r.rom_cm)} cm</td><td>${f(r.mean_conc_v, 2)}</td><td>${f(r.velocity_loss_pct)} %</td><td>${f(r.efficiency)}</td></tr>`).join("") + "</table>";
  return `<table><tr><th>rep</th><th>depth</th><th>lock-out</th><th>body line</th><th>down</th><th>up</th><th>ROM</th><th>loss</th><th>score</th></tr>` +
    s.reps.map((r) => `<tr><td>${r.failed ? "×" : r.rep}</td><td>${yes(r.depth_pass)} ${f(r.elbow_bottom)}°</td><td>${yes(r.lockout)} ${f(r.elbow_top)}°</td><td class="${r.straight ? "ok" : "bad"}">${f(r.body_line_min)}°</td><td>${f(r.t_eccentric, 1)} s</td><td>${f(r.t_concentric, 1)} s</td><td>${f(r.rom_cm)} cm</td><td>${f(r.velocity_loss_pct)} %</td><td>${f(r.efficiency)}</td></tr>`).join("") + "</table>";
}
async function renderHistory() {
  const all = await allSets(), sets = all.filter((s) => filter === "all" || s.exercise === filter);
  const best = {}; for (const s of all) best[s.exercise] = Math.max(best[s.exercise] || 0, s.summary.reps);
  const total = sets.reduce((a, s) => a + s.summary.reps, 0), top = Math.max(0, ...sets.map((s) => s.summary.reps)), last = sets[sets.length - 1];
  $("#tiles").innerHTML = [[sets.length, "sets"], [total, "reps in total"], [top, "best set"], [last ? last.summary.reps : "–", "last set"], [new Set(sets.map((s) => s.id.slice(0, 10))).size, "days"]]
    .map(([b, s]) => `<div class="tile"><b>${b}</b><span>${s}</span></div>`).join("");
  // one bar per set, oldest first; one series, so no legend
  const svg = $("#bars"), bw = 34, gap = 10, H = 180, base = H - 34, Wd = Math.max(sets.length * (bw + gap) + 40, 280), ns = "http://www.w3.org/2000/svg";
  svg.innerHTML = ""; svg.setAttribute("width", Wd); svg.setAttribute("height", H);
  const mk = (t, a, txt) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; svg.appendChild(e); return e; };
  mk("line", { x1: 20, x2: Wd - 10, y1: base, y2: base, stroke: "var(--rule)" });
  let prev = null;
  sets.forEach((s, i) => {
    const x = 26 + i * (bw + gap), h = top ? (base - 22) * s.summary.reps / top : 0, day = s.id.slice(0, 10);
    const r = mk("rect", { x, y: base - h, width: bw, height: Math.max(h, 1), rx: 4, fill: "var(--accent)" });
    hover(r, `${day} ${s.id.slice(11, 13)}:${s.id.slice(13, 15)}<br>${NAMES[s.exercise]}: ${s.summary.reps} reps`);
    r.addEventListener("click", () => toggle(s.id));
    mk("text", { x: x + bw / 2, y: base - h - 6, "text-anchor": "middle", class: "val" }, s.summary.reps);
    mk("text", { x: x + bw / 2, y: base + 15, "text-anchor": "middle" }, s.id.slice(11, 13) + ":" + s.id.slice(13, 15));
    if (day !== prev) { mk("text", { x, y: base + 30 }, day); prev = day; }
  });
  const box = $("#sets"); box.innerHTML = ""; box.classList.toggle("two", [...openSets].filter((id) => sets.some((s) => s.id === id)).length >= 2);
  let dayEl = null;
  for (const s of [...sets].reverse()) {
    const day = s.id.slice(0, 10);
    if (day !== dayEl && !box.classList.contains("two")) { dayEl = day; box.insertAdjacentHTML("beforeend", `<div class="day">${day}</div>`); }
    const el = document.createElement("div"); el.className = "set" + (openSets.has(s.id) ? " open" : "");
    el.innerHTML = `<div class="head">${headLine(s, best)}</div>`;
    el.querySelector(".head").addEventListener("click", () => toggle(s.id));
    if (openSets.has(s.id)) {
      const d = document.createElement("div"); d.className = "detail";
      d.innerHTML = `<div class="vid"></div><div class="scroll">${repTable(s)}</div><button class="del">Delete this set</button>`;
      d.querySelector(".del").addEventListener("click", async () => { if (d.querySelector(".del").dataset.sure) { await deleteSet(s.id); openSets.delete(s.id); await refreshPast(); renderHistory(); } else { d.querySelector(".del").dataset.sure = 1; d.querySelector(".del").textContent = "Tap again to delete"; } });
      el.appendChild(d);
      if (s.video) getVideo(s.id).then((blob) => { if (!blob) return; urls[s.id] = urls[s.id] || URL.createObjectURL(blob); d.querySelector(".vid").innerHTML = `<video src="${urls[s.id]}" controls playsinline preload="metadata"></video>`; });
      else d.querySelector(".vid").innerHTML = `<p class="small">No replay saved for this set.</p>`;
    }
    box.appendChild(el);
  }
  if (!sets.length) box.innerHTML = `<p class="small">No sets yet.</p>`;
}
function toggle(id) { openSets.has(id) ? openSets.delete(id) : openSets.add(id); renderHistory(); }
$("#openHistory").addEventListener("click", () => { $("#live").hidden = true; $("#history").hidden = false; renderHistory(); });
$("#closeHistory").addEventListener("click", () => { $("#history").hidden = true; $("#live").hidden = false; refreshPast(); });
$("#filter").addEventListener("click", (e) => { if (!e.target.dataset.f) return; filter = e.target.dataset.f; document.querySelectorAll("#filter button").forEach((b) => b.classList.toggle("on", b === e.target)); renderHistory(); });
$("#export").addEventListener("click", async () => {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(await allSets(), null, 1)], { type: "application/json" }));
  a.download = "rep-tracker-sets.json"; a.click();
});

showExercise();
window.__app = { get S() { return S; }, settings, allSets };      // for tests

// A phone has no console to look at: show an unexpected error on the page.
function report(msg) {
  let el = $("#err");
  if (!el) { el = document.createElement("p"); el.id = "err"; el.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;margin:0;padding:8px 10px;background:#f04646;color:#fff;border-radius:8px;font-size:13px;z-index:9"; document.body.appendChild(el); el.addEventListener("click", () => el.remove()); }
  el.textContent = "Error: " + msg + " (tap to dismiss)";
}
window.addEventListener("error", (e) => report(e.message));
window.addEventListener("unhandledrejection", (e) => report(e.reason && e.reason.message || String(e.reason)));
