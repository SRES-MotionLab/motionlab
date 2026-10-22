// Trial data, joint angles, projectile fitting and CSV export. Pure maths, no UI code.

export const MARKERS = ['head', 'shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'toe', 'ball'];
export const DEFAULT_ACTIVE = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'toe'];

export const MARKER_COLORS = {
  head: '#bf5af2', shoulder: '#0a84ff', elbow: '#64d2ff', wrist: '#66d4cf', hip: '#30d158',
  knee: '#ffd60a', ankle: '#ff9f0a', toe: '#ff453a', ball: '#ff375f',
};

/** Pairs of markers joined by a line when drawing the stick figure. */
export const SKELETON = [
  ['head', 'shoulder'], ['shoulder', 'elbow'], ['elbow', 'wrist'],
  ['shoulder', 'hip'], ['hip', 'knee'], ['knee', 'ankle'], ['ankle', 'toe'],
];

export const label = (marker) => marker[0].toUpperCase() + marker.slice(1);

export function newAnalysis({ name, videoId, videoFPS, captureFPS, frameCount, width, height }) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
    name,
    createdAt: Date.now(),
    videoId,
    /** Frames per second of the video file's own timeline, used to step through it. */
    videoFPS,
    /** Frames per second the movement was filmed at. Time of frame n is n / captureFPS. */
    captureFPS,
    frameCount,
    width,
    height,
    calibration: null, // { ax, ay, bx, by, realLength } in image pixels; A is the origin
    activeMarkers: [...DEFAULT_ACTIVE],
    points: {}, // marker -> { frame: [x, y] } in image pixels, origin top-left, y down
    autoTracked: {}, // marker -> { frame: true }
    bodySide: 'auto',
    trimStart: null,
    trimEnd: null,
  };
}

export const isCalibrated = (a) => !!a.calibration;
export const isTrimmed = (a) => a.trimStart != null || a.trimEnd != null;

export function workingRange(a) {
  const last = Math.max(a.frameCount - 1, 0);
  const start = Math.min(Math.max(a.trimStart ?? 0, 0), last);
  const end = Math.min(Math.max(a.trimEnd ?? last, start), last);
  return [start, end];
}

export const point = (a, marker, frame) => a.points[marker]?.[frame] ?? null;

export function setPoint(a, p, marker, frame, isAuto = false) {
  if (p) {
    (a.points[marker] ??= {})[frame] = [p[0], p[1]];
  } else if (a.points[marker]) {
    delete a.points[marker][frame];
  }
  if (isAuto && p) {
    (a.autoTracked[marker] ??= {})[frame] = true;
  } else if (a.autoTracked[marker]) {
    delete a.autoTracked[marker][frame];
  }
}

export const isAutoTracked = (a, marker, frame) => !!a.autoTracked[marker]?.[frame];
export const isManual = (a, marker, frame) => point(a, marker, frame) != null && !isAutoTracked(a, marker, frame);

export const time = (a, frame) => (a.captureFPS > 0 ? frame / a.captureFPS : 0);

export function metresPerPixel(c) {
  const px = Math.hypot(c.bx - c.ax, c.by - c.ay);
  return px > 0 ? c.realLength / px : 0;
}

/** Position with y up: metres from the calibration origin when calibrated, otherwise pixels. */
export function position(a, marker, frame) {
  const p = point(a, marker, frame);
  if (!p) return null;
  const c = a.calibration;
  if (c) {
    const s = metresPerPixel(c);
    return [(p[0] - c.ax) * s, (c.ay - p[1]) * s];
  }
  return [p[0], -p[1]];
}

export function trackedFramesFor(a, marker) {
  return Object.keys(a.points[marker] ?? {}).map(Number).sort((x, y) => x - y);
}

/** Every frame that has at least one digitised point. */
export function trackedFrames(a) {
  const set = new Set();
  for (const m of Object.values(a.points)) for (const f of Object.keys(m)) set.add(Number(f));
  return [...set].sort((x, y) => x - y);
}

// MARK: Angles

/** Included angle at `v` between the segments to `p` and `q`, in degrees (0–180). A straight limb is 180°. */
export function includedAngle(p, v, q) {
  const ux = p[0] - v[0], uy = p[1] - v[1];
  const vx = q[0] - v[0], vy = q[1] - v[1];
  const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!(lengths > 0)) return null;
  const cosine = (ux * vx + uy * vy) / lengths;
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI;
}

/** Angle of the segment from `p` to `q` away from vertical, with y up. Positive when q is to the right of p. */
export function angleFromVertical(p, q) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  if (dx === 0 && dy === 0) return null;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

export const ANGLES = [
  { name: 'Knee', csvName: 'knee_angle_deg', joint: ['hip', 'knee', 'ankle'],
    note: 'Included angle hip–knee–ankle. 180° is a straight leg.' },
  { name: 'Hip', csvName: 'hip_angle_deg', joint: ['shoulder', 'hip', 'knee'],
    note: 'Included angle shoulder–hip–knee. 180° is a straight trunk and thigh.' },
  { name: 'Ankle', csvName: 'ankle_angle_deg', joint: ['knee', 'ankle', 'toe'],
    note: 'Included angle knee–ankle–toe. Standing is roughly 90–110°.' },
  { name: 'Elbow', csvName: 'elbow_angle_deg', joint: ['shoulder', 'elbow', 'wrist'],
    note: 'Included angle shoulder–elbow–wrist. 180° is a straight arm.' },
  { name: 'Shoulder', csvName: 'shoulder_angle_deg', joint: ['hip', 'shoulder', 'elbow'],
    note: 'Included angle between the trunk and the upper arm. 0° is the arm by the side.' },
  { name: 'Trunk lean', csvName: 'trunk_from_vertical_deg', segment: ['hip', 'shoulder'],
    note: 'Hip-to-shoulder line from vertical. Positive leans towards the right of the screen.' },
];

export function angleValue(def, a, frame) {
  if (def.joint) {
    const [m1, m2, m3] = def.joint;
    const p = position(a, m1, frame), v = position(a, m2, frame), q = position(a, m3, frame);
    return p && v && q ? includedAngle(p, v, q) : null;
  }
  const p = position(a, def.segment[0], frame), q = position(a, def.segment[1], frame);
  return p && q ? angleFromVertical(p, q) : null;
}

export function angleSeries(def, a) {
  const out = [];
  for (const f of trackedFrames(a)) {
    const v = angleValue(def, a, f);
    if (v != null) out.push({ frame: f, time: time(a, f), value: v });
  }
  return out;
}

// MARK: Projectile

export const STANDARD_GRAVITY = 9.81;

/** Positions in metres of `marker` between two frames. Empty if the video is not calibrated. */
export function projectileSamples(a, marker, from, to) {
  if (!isCalibrated(a)) return [];
  return trackedFramesFor(a, marker)
    .filter((f) => f >= from && f <= to)
    .map((f) => {
      const p = position(a, marker, f);
      return { t: time(a, f), x: p[0], y: p[1] };
    });
}

/** Least-squares straight line y = intercept + slope·x. */
export function linearFit(x, y) {
  const n = x.length;
  if (n !== y.length || n < 2) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

/** Least-squares parabola y = c + b·x + a·x², solved from the normal equations by Cramer's rule. */
export function quadraticFit(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], yi = y[i], x2 = xi * xi;
    s0 += 1; s1 += xi; s2 += x2; s3 += x2 * xi; s4 += x2 * x2;
    t0 += yi; t1 += xi * yi; t2 += x2 * yi;
  }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]]);
  if (Math.abs(d) < 1e-12) return null;
  return {
    c: det([[t0, s1, s2], [t1, s2, s3], [t2, s3, s4]]) / d,
    b: det([[s0, t0, s2], [s1, t1, s3], [s2, t2, s4]]) / d,
    a: det([[s0, s1, t0], [s1, s2, t1], [s2, s3, t2]]) / d,
  };
}

/** Fits x = x0 + vx·τ and y = y0 + vy·τ − ½gτ², where τ is time since the first sample. */
export function analyseProjectile(samples, g = STANDARD_GRAVITY) {
  if (samples.length < 3) return null;
  const t0 = samples[0].t;
  const taus = samples.map((s) => s.t - t0);
  const xs = samples.map((s) => s.x);
  const ys = samples.map((s) => s.y);
  const xFit = linearFit(taus, xs);
  const yFit = linearFit(taus, ys.map((y, i) => y + 0.5 * g * taus[i] ** 2));
  if (!xFit || !yFit) return null;

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const tau = taus[i];
    const dx = xs[i] - (xFit.intercept + xFit.slope * tau);
    const dy = ys[i] - (yFit.intercept + yFit.slope * tau - 0.5 * g * tau * tau);
    sumSquares += dx * dx + dy * dy;
  }
  const quad = samples.length >= 4 ? quadraticFit(taus, ys) : null;

  const vx = xFit.slope, vy = yFit.slope, h = yFit.intercept;
  const rise = vy > 0 ? vy * vy / (2 * g) : 0;
  const flightTime = h >= 0 ? (vy + Math.sqrt(vy * vy + 2 * g * h)) / g : null;
  return {
    sampleCount: samples.length,
    gravity: g,
    releaseTime: t0,
    releaseHeight: h,
    releaseX: xFit.intercept,
    horizontalVelocity: vx,
    verticalVelocity: vy,
    gravityFromData: quad ? -2 * quad.a : null,
    rmsError: Math.sqrt(sumSquares / samples.length),
    speed: Math.hypot(vx, vy),
    angle: Math.atan2(vy, Math.abs(vx)) * 180 / Math.PI,
    riseAfterRelease: rise,
    peakHeight: h + rise,
    timeToPeak: Math.max(vy / g, 0),
    flightTimeToGround: flightTime,
    rangeToGround: flightTime != null ? Math.abs(vx) * flightTime : null,
  };
}

// MARK: CSV

/** One row per digitised frame: time, marker positions and every angle that has data. */
export function csv(a) {
  const frames = trackedFrames(a);
  const markers = MARKERS.filter((m) => Object.keys(a.points[m] ?? {}).length > 0);
  const angles = ANGLES.filter((d) => frames.some((f) => angleValue(d, a, f) != null));
  const unit = isCalibrated(a) ? 'm' : 'px';

  const header = ['frame', 'time_s'];
  for (const m of markers) header.push(`${m}_x_${unit}`, `${m}_y_${unit}`);
  header.push(...angles.map((d) => d.csvName));

  const lines = [header.join(',')];
  for (const f of frames) {
    const row = [String(f + 1), time(a, f).toFixed(4)];
    for (const m of markers) {
      const p = position(a, m, f);
      row.push(p ? p[0].toFixed(4) : '', p ? p[1].toFixed(4) : '');
    }
    for (const d of angles) {
      const v = angleValue(d, a, f);
      row.push(v != null ? v.toFixed(2) : '');
    }
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

export function safeFileName(name) {
  const s = name.split(/[^A-Za-z0-9]+/).filter(Boolean).join('_');
  return s || 'trial';
}
