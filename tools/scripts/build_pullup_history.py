"""
Build the comparison page for the live pull-up sets: every saved set in one table, a bar per set,
and a card per chosen set with its replay and its reps, side by side.

    python build_pullup_history.py [formats/pullup-analysis/out/live]

Reads <folder>/*/live.json (written by live_pullups.py) and writes <folder>/history.html. The
replays are linked by relative path, so the page is opened from that folder. Every number is
injected from the JSON at build time. live_pullups.py rebuilds the page after each set.
"""
import sys, os, json, glob

HTML = r"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pull-up Log</title>
<style>
:root{
  --paper:#f6f5f1; --panel:#fffefb; --ink:#14161a; --ink-2:#4a4f57; --rule:#dcd9d1;
  --accent:#b8420f; --pass:#1d6b3f; --warn:#9a6a06; --hot:#cf3623;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace; --sans:system-ui,-apple-system,"Helvetica Neue",sans-serif;
}
@media (prefers-color-scheme:dark){ :root{
  --paper:#101215; --panel:#171a1f; --ink:#eceae4; --ink-2:#a2a7b0; --rule:#2b2f36;
  --accent:#f4794a; --pass:#4cbd7c; --warn:#e0aa3c; --hot:#f4674f; color-scheme:dark; } }
*{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 var(--sans)}
main{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:28px;margin:0 0 4px} h2{font-size:17px;margin:34px 0 10px} .sub{color:var(--ink-2);margin:0 0 22px}
.tiles{display:flex;flex-wrap:wrap;gap:12px} .tile{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:12px 16px;min-width:150px}
.tile b{display:block;font-size:30px;font-variant-numeric:tabular-nums} .tile span{color:var(--ink-2);font-size:13px}
.box{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:14px;overflow-x:auto}
svg text{fill:var(--ink-2);font:12px var(--sans)} svg .val{fill:var(--ink);font-weight:600}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums} th,td{padding:7px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--rule)}
th{color:var(--ink-2);font-weight:500;font-size:13px} th:first-child,td:first-child{text-align:left}
tr.day td{background:var(--paper);color:var(--ink-2);font-size:13px;text-align:left}
tr.set{cursor:pointer} tr.set:hover td{background:color-mix(in srgb,var(--accent) 7%,transparent)} tr.set.on td:first-child{box-shadow:inset 3px 0 var(--accent)}
.best{color:var(--pass);font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-top:14px}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:12px}
.card h3{margin:0 0 8px;font-size:15px;display:flex;justify-content:space-between} .card h3 button{border:0;background:none;color:var(--ink-2);cursor:pointer;font-size:15px}
.card video{width:100%;max-height:60vh;background:#000;border-radius:6px} .card table{font-size:13px;margin-top:8px} .card td,.card th{padding:4px 6px}
.v-above{color:var(--pass)} .v-at{color:var(--warn)} .v-short{color:var(--hot)}
.note{color:var(--ink-2);font-size:13px;margin-top:10px}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--paper);padding:5px 8px;border-radius:5px;font-size:12px;display:none}
</style>
<main>
<h1>Pull-up Log</h1>
<p class="sub" id="sub"></p>
<div class="tiles" id="tiles"></div>
<h2>Reps per set</h2>
<div class="box"><svg id="bars" role="img" aria-label="Reps per set, oldest first"></svg></div>
<h2>Sets</h2>
<p class="sub">Click a set to open its replay and reps below. Open two or more to compare them side by side.</p>
<div class="box"><table id="sets"></table></div>
<div class="cards" id="cards"></div>
<p class="note">Live numbers are unrectified: the chin is read in the picture, in a ±3 cm band with no allowance for the camera's angle.
The fatigue columns are a muscle model's output (MUSCLE-MODEL.md), not a measurement. Speed loss is the mean pull speed of the last rep against rep 1.</p>
</main><div id="tip"></div>
<script>
const D = __DATA__;
const $ = (s) => document.querySelector(s), f = (x, d = 0) => x == null ? "–" : (+x).toFixed(d), pct = (x) => x == null ? "–" : (100 * x).toFixed(0) + " %";
const tip = $("#tip");
function hover(el, html){ el.addEventListener("mousemove", e => { tip.innerHTML = html; tip.style.display = "block"; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px"; }); el.addEventListener("mouseleave", () => tip.style.display = "none"); }
const sets = D.sets, best = Math.max(0, ...sets.map(s => s.reps)), total = sets.reduce((a, s) => a + s.reps, 0), days = new Set(sets.map(s => s.day));
$("#sub").textContent = sets.length ? `${sets[0].day} to ${sets[sets.length - 1].day} · built ${D.built}` : "No sets saved yet.";
const last = sets[sets.length - 1];
$("#tiles").innerHTML = [[sets.length, "sets"], [total, "reps in total"], [best, "best set"], [last ? last.reps : "–", "last set"], [days.size, "days"]].map(([b, s]) => `<div class="tile"><b>${b}</b><span>${s}</span></div>`).join("");

// one bar per set, oldest first; one series, so no legend
(function(){
  const svg = $("#bars"), bw = 34, gap = 10, H = 190, top = 22, base = H - 34, W = Math.max(sets.length * (bw + gap) + 40, 300);
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const ns = "http://www.w3.org/2000/svg", mk = (t, a, txt) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; svg.appendChild(e); return e; };
  mk("line", {x1: 20, x2: W - 10, y1: base, y2: base, stroke: "var(--rule)"});
  let prevDay = null;
  sets.forEach((s, i) => {
    const x = 26 + i * (bw + gap), h = best ? (base - top) * s.reps / best : 0;
    const r = mk("rect", {x, y: base - h, width: bw, height: Math.max(h, 1), rx: 4, fill: "var(--accent)"});
    hover(r, `${s.day} ${s.time}<br>${s.reps} reps · speed loss ${f(s.vl)} %`);
    r.style.cursor = "pointer"; r.addEventListener("click", () => toggle(s.id));
    mk("text", {x: x + bw / 2, y: base - h - 6, "text-anchor": "middle", class: "val"}, s.reps);
    mk("text", {x: x + bw / 2, y: base + 15, "text-anchor": "middle"}, s.time.slice(0, 5));
    if (s.day !== prevDay) { mk("text", {x, y: base + 30}, s.day); prevDay = s.day; }
  });
})();

function spark(v){ if (v.length < 2) return ""; const w = 70, h = 20, mx = Math.max(...v), mn = Math.min(...v, 0); const p = v.map((y, i) => `${(i / (v.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 2 - (y - mn) / (mx - mn || 1) * (h - 4)).toFixed(1)}`).join(" "); return `<svg width="${w}" height="${h}" role="img" aria-label="pull speed by rep"><polyline points="${p}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>`; }
const open = new Set();
function table(){
  let h = "<tr><th>set</th><th>reps</th><th>chin, mean</th><th>lock-outs</th><th>pull speed, rep 1</th><th>speed by rep</th><th>speed loss</th><th>efficiency</th><th>fatigued: lats</th><th>biceps</th><th>grip</th><th>kcal</th></tr>", day = null, n = 0;
  for (const s of sets) {
    if (s.day !== day) { day = s.day; n = 0; h += `<tr class="day"><td colspan="12">${day}</td></tr>`; }
    n++;
    h += `<tr class="set${open.has(s.id) ? " on" : ""}" data-id="${s.id}"><td>#${n} · ${s.time}</td><td class="${s.reps === best ? "best" : ""}">${s.reps}</td><td>${s.chin == null ? "–" : (s.chin > 0 ? "+" : "") + f(s.chin, 1) + " cm"}</td><td>${s.lock}/${s.reps}</td><td>${f(s.v1, 2)} m/s</td><td>${spark(s.rows.map(r => r.v))}</td><td>${f(s.vl)} %</td><td>${f(s.eff)}</td><td>${pct(s.f_lats)}</td><td>${pct(s.f_biceps)}</td><td>${pct(s.f_grip)}</td><td>${f(s.kcal, 1)}</td></tr>`;
  }
  $("#sets").innerHTML = h;
  document.querySelectorAll("tr.set").forEach(tr => tr.addEventListener("click", () => toggle(tr.dataset.id)));
}
function cards(){
  $("#cards").innerHTML = sets.filter(s => open.has(s.id)).map(s => `<div class="card"><h3><span>${s.day} ${s.time} · ${s.reps} reps</span><button data-id="${s.id}" aria-label="close">✕</button></h3>
    ${s.video ? `<video src="${s.video}" controls playsinline preload="metadata"></video>` : `<p class="note">no replay saved for this set</p>`}
    <table><tr><th>rep</th><th>chin</th><th>lock-out</th><th>up</th><th>down</th><th>ROM</th><th>speed</th><th>loss</th><th>score</th></tr>
    ${s.rows.map(r => `<tr><td>${r.failed ? "×" : r.rep}</td><td class="v-${r.verdict}">${r.verdict} ${(r.chin > 0 ? "+" : "") + f(r.chin)} cm</td><td>${r.lock == null ? "–" : r.lock ? "ok" : "short"} ${f(r.el)}°</td><td>${f(r.up, 1)} s</td><td>${f(r.down, 1)} s</td><td>${f(r.rom)} cm</td><td>${f(r.v, 2)}</td><td>${f(r.vl)} %</td><td>${f(r.eff)}</td></tr>`).join("")}</table></div>`).join("");
  document.querySelectorAll(".card button").forEach(b => b.addEventListener("click", () => toggle(b.dataset.id)));
}
function toggle(id){ open.has(id) ? open.delete(id) : open.add(id); table(); cards(); }
if (last) open.add(last.id);
table(); cards();
</script>
"""


def load(root):
    sets = []
    for p in sorted(glob.glob(os.path.join(root, "*", "live.json"))):
        d = os.path.dirname(p); sid = os.path.basename(d)
        try:
            j = json.load(open(p, encoding="utf-8"))
        except (OSError, ValueError):
            continue
        m = j.get("summary") or {}
        if not m.get("reps"):
            continue
        good = [r for r in j["reps"] if not r["failed"]]
        video = next((f"{sid}/{v}" for v in ("replay.mp4", "set.mp4") if os.path.exists(os.path.join(d, v))), None)
        sets.append(dict(
            id=sid, day=sid[:10], time=f"{sid[11:13]}:{sid[13:15]}:{sid[15:17]}", video=video,
            reps=m["reps"], chin=m.get("mean_chin_cm"), lock=m.get("lockouts"), v1=good[0]["mean_conc_v"],
            vl=m.get("velocity_loss_last_pct"), eff=m.get("mean_efficiency"), kcal=m.get("kcal"),
            f_lats=m.get("fatigued_lats"), f_biceps=m.get("fatigued_biceps"), f_grip=m.get("fatigued_grip"),
            rows=[dict(rep=r["rep"], failed=r["failed"], verdict=r["chin_verdict"], chin=r["chin_cm"], lock=r.get("lockout"),
                       el=r.get("elbow_bottom_after"), up=r["t_concentric"], down=r["t_eccentric"], rom=r["rom_cm"],
                       v=r["mean_conc_v"], vl=r["velocity_loss_pct"], eff=r.get("efficiency")) for r in j["reps"]]))
    return sets


def build(root):
    import time
    out = os.path.join(root, "history.html")
    data = dict(sets=load(root), built=time.strftime("%Y-%m-%d %H:%M"))
    with open(out, "w", encoding="utf-8") as f:
        f.write(HTML.replace("__DATA__", json.dumps(data, default=float).replace("</", "<\\/")))
    return out


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    print(build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(here)), "formats", "pullup-analysis", "out", "live")))
