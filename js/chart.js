// A small line chart drawn on a canvas, for angle–time graphs.

function niceStep(range, targetTicks) {
  const raw = range / Math.max(targetTicks, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function ticks(min, max, target) {
  if (min === max) { min -= 1; max += 1; }
  const step = niceStep(max - min, target);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

export function drawLineChart(canvas, points, { xLabel, yLabel, color }) {
  const css = getComputedStyle(document.documentElement);
  const text = css.getPropertyValue('--text-2').trim() || '#999';
  const grid = css.getPropertyValue('--line').trim() || '#333';
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;

  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xt = ticks(Math.min(...xs), Math.max(...xs), Math.max(3, Math.floor(w / 80)));
  const yt = ticks(Math.min(...ys), Math.max(...ys), 5);
  const left = 52, right = 12, top = 10, bottom = 40;
  const x0 = xt[0], x1 = xt[xt.length - 1], y0 = yt[0], y1 = yt[yt.length - 1];
  const sx = (v) => left + (v - x0) / (x1 - x0) * (w - left - right);
  const sy = (v) => top + (1 - (v - y0) / (y1 - y0)) * (h - top - bottom);

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = text;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yt) {
    ctx.beginPath(); ctx.moveTo(left, sy(v)); ctx.lineTo(w - right, sy(v)); ctx.stroke();
    ctx.fillText(String(+v.toFixed(2)), left - 6, sy(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of xt) {
    ctx.beginPath(); ctx.moveTo(sx(v), top); ctx.lineTo(sx(v), h - bottom); ctx.stroke();
    ctx.fillText(String(+v.toFixed(3)), sx(v), h - bottom + 5);
  }
  ctx.fillText(xLabel, left + (w - left - right) / 2, h - 15);
  ctx.save();
  ctx.translate(12, top + (h - top - bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
  ctx.stroke();
  if (points.length <= 200) {
    for (const p of points) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), 2.5, 0, Math.PI * 2); ctx.fill(); }
  }
}
