// Everything the screen (and so the replay) shows, drawn on one canvas.
import { BONES, L_SH, R_SH } from "./util.js";
import { shapes, PANEL } from "./muscles.js";

const STOPS = [[48, 90, 220], [40, 190, 200], [90, 210, 90], [240, 210, 60], [245, 130, 40], [215, 40, 35]];   // resting -> the whole pool busy
export function heat(e) {
  const x = Math.min(Math.max(e, 0), 1) * (STOPS.length - 1), i = Math.min(Math.floor(x), STOPS.length - 2), f = x - i;
  return STOPS[i].map((c, k) => Math.round(c + (STOPS[i + 1][k] - c) * f));
}
function text(ctx, s, x, y, px, col = "#f5f5f5", align = "left") {
  ctx.font = `700 ${px}px system-ui, -apple-system, "Helvetica Neue", sans-serif`;
  ctx.textAlign = align; ctx.lineJoin = "round"; ctx.lineWidth = Math.max(px / 6, 3); ctx.strokeStyle = "rgba(0,0,0,.85)";
  ctx.strokeText(s, x, y); ctx.fillStyle = col; ctx.fillText(s, x, y);
}
function paintMuscles(ctx, P, E) {
  for (const [c, a, b, ang, v] of shapes(P, E)) {
    const [r, g, bl] = heat(v);
    ctx.save(); ctx.translate(c[0], c[1]); ctx.rotate(ang); ctx.scale(Math.max(a, 1), Math.max(b, 1));
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, `rgba(${r},${g},${bl},.62)`); grad.addColorStop(0.65, `rgba(${r},${g},${bl},.55)`); grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, 1, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
  }
}
function panel(ctx, M, x, y, k) {
  text(ctx, "muscle load (model)", x, y, 26 * k);
  const bw = 230 * k, bh = 20 * k, dy = 40 * k;
  PANEL.forEach(([m, label], i) => {
    const yy = y + 18 * k + i * dy, e = M.E[m];
    ctx.fillStyle = "rgba(30,30,30,.8)"; ctx.fillRect(x, yy, bw, bh);
    ctx.fillStyle = `rgb(${heat(e)})`; ctx.fillRect(x, yy, bw * e, bh);
    ctx.fillStyle = "#fff"; ctx.fillRect(x + bw * M.MF[m] - 2 * k, yy - 3 * k, 4 * k, bh + 6 * k);
    text(ctx, `${label}  ${(M.MF[m] * 100).toFixed(0)}% fatigued`, x + bw + 12 * k, yy + bh, 21 * k);
  });
}

export function drawFrame(ctx, video, P, V, S, o) {
  const W = ctx.canvas.width, H = ctx.canvas.height, k = Math.min(W, H) / 1080, live = !["SETUP", "DONE"].includes(S.state);
  ctx.save();
  if (o.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }        // a front camera reads like a mirror; the text below does not flip
  ctx.drawImage(video, 0, 0, W, H);
  if (P) {
    if (o.muscles && S.mus && S.onBar) paintMuscles(ctx, P, S.mus.E);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(3 * k, 1.5); ctx.lineCap = "round"; ctx.beginPath();
    for (const [a, b] of BONES) if (V[a] > 0.3 && V[b] > 0.3) { ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); }
    ctx.stroke();
  }
  if (S.barY != null) { ctx.strokeStyle = "#ffbe3c"; ctx.lineWidth = Math.max(2 * k, 1); ctx.beginPath(); ctx.moveTo(0, S.barY); ctx.lineTo(W, S.barY); ctx.stroke(); }
  ctx.restore();

  const x = 40 * k, dy = 62 * k;
  let y = 390 * k;
  text(ctx, String(S.shownCount), x, 230 * k, 240 * k);
  text(ctx, S.state, x, 310 * k, 54 * k, S.phaseColors[S.state]);
  if (S.state === "SETUP") {
    const words = S.constructor.setupHint.split(" "); let line = "";
    for (const w of words) {           // wrap to the frame's width
      ctx.font = `700 ${40 * k}px system-ui`;
      if (ctx.measureText(line + " " + w).width > W - 2 * x && line) { text(ctx, line, x, y, 40 * k, "#ffbe3c"); y += 50 * k; line = w; } else line = line ? line + " " + w : w;
    }
    text(ctx, line, x, y, 40 * k, "#ffbe3c");
  } else if (S.state === "DONE") {
    const rows = S.summaryRows();
    if (S.summary.reps && o.history.length) rows.push(`before this: last set ${o.history[o.history.length - 1]}, best ${Math.max(...o.history)}`);
    rows.push("get back in position for the next set");
    rows.forEach((r, i) => text(ctx, r, x, y + i * dy * 0.9, 36 * k));
  } else {
    const rows = S.liveRows();
    rows.forEach((r, i) => text(ctx, r, x, y + i * dy, 42 * k));
    if (o.muscles && S.mus && S.onBar) {
      if (W >= H) panel(ctx, S.mus, W - 600 * k, 110 * k, k); else panel(ctx, S.mus, x, y + rows.length * dy + 20 * k, k);
    }
    const card = S.card(), y0 = H - 150 * k;
    card.forEach(([s, col], i) => text(ctx, s, x, y0 + i * 58 * k, (i === 2 ? 32 : 44) * k, col));
  }
  if (o.rec) { ctx.fillStyle = "#f04646"; ctx.beginPath(); ctx.arc(W - 40 * k, 44 * k, 12 * k, 0, 2 * Math.PI); ctx.fill(); }
  text(ctx, `${o.fps.toFixed(0)} fps`, W - 70 * k, 56 * k, 28 * k, "#aaa", "right");
}
