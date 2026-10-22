// Frame-by-frame access to a video in the browser.

/** Reads the frame count and frame rate of the video track from an MP4 or MOV file without decoding it. */
export async function probeMp4(blob) {
  const read = async (start, length) => new DataView(await blob.slice(start, start + length).arrayBuffer());
  const type = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

  // Find the top-level moov box.
  let offset = 0, moov = null;
  while (offset + 8 <= blob.size) {
    const h = await read(offset, 16);
    let size = h.getUint32(0);
    const kind = type(h, 4);
    let header = 8;
    if (size === 1) { size = Number(h.getBigUint64(8)); header = 16; }
    if (size === 0) size = blob.size - offset;
    if (size < header) return null;
    if (kind === 'moov') { moov = await read(offset + header, size - header); break; }
    offset += size;
  }
  if (!moov) return null;

  // Walk the child boxes of a container held in `dv` between start and end.
  function* children(dv, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      let header = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); header = 16; }
      if (size === 0) size = end - o;
      if (size < header || o + size > end) return;
      yield { kind: type(dv, o + 4), start: o + header, end: o + size };
      o += size;
    }
  }
  const child = (dv, box, kind) => { for (const c of children(dv, box.start, box.end)) if (c.kind === kind) return c; return null; };

  for (const trak of children(moov, 0, moov.byteLength)) {
    if (trak.kind !== 'trak') continue;
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!hdlr || type(moov, hdlr.start + 8) !== 'vide') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    const version = moov.getUint8(mdhd.start);
    const timescale = moov.getUint32(mdhd.start + (version === 1 ? 20 : 12));
    const stbl = child(moov, child(moov, mdia, 'minf') ?? { start: 0, end: 0 }, 'stbl');
    const stts = stbl && child(moov, stbl, 'stts');
    if (!stts) return null;
    const entries = moov.getUint32(stts.start + 4);
    let count = 0, total = 0;
    for (let i = 0; i < entries; i++) {
      const n = moov.getUint32(stts.start + 8 + i * 8);
      const delta = moov.getUint32(stts.start + 12 + i * 8);
      count += n;
      total += n * delta;
    }
    // Fragmented files (some browser recordings) keep their samples elsewhere.
    if (count < 2 || total <= 0 || !timescale) return null;
    return { frameCount: count, fps: count * timescale / total };
  }
  return null;
}

/** Rounds a measured frame rate to a common one when it is very close (e.g. 239.98 → 240). */
export function tidyFPS(fps) {
  for (const common of [23.976, 29.97, 59.94, 119.88]) {
    if (Math.abs(fps - common) < 0.01) return common;
  }
  for (const common of [24, 25, 30, 48, 50, 60, 100, 120, 240, 480, 960]) {
    if (Math.abs(fps - common) / common < 0.004) return common;
  }
  return Math.round(fps * 100) / 100;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function once(target, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(target.error ?? new Error('This video could not be read. Try a different file or format (MP4 works best).')); };
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(event, ok); target.removeEventListener('error', fail); };
    target.addEventListener(event, ok);
    target.addEventListener('error', fail);
  });
}

/** Wraps a hidden <video> element so frames can be shown one at a time. */
export class FrameSource {
  constructor(blob) {
    this.url = URL.createObjectURL(blob);
    this.video = document.createElement('video');
    Object.assign(this.video, { muted: true, playsInline: true, preload: 'auto' });
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.src = this.url;
    this.fps = 30;
    this.frameCount = 1;
    this._target = null;
    this._seeking = null;
  }

  get width() { return this.video.videoWidth; }
  get height() { return this.video.videoHeight; }

  async open() {
    const v = this.video;
    if (v.readyState < 1) await once(v, 'loadedmetadata');
    // Browser recordings in WebM report an unknown duration until the browser has looked at the end of the file.
    if (!Number.isFinite(v.duration)) {
      v.currentTime = 1e7;
      await once(v, 'durationchange', 8000).catch(() => {});
      await wait(50);
    }
    if (v.readyState < 2) {
      // iOS only decodes frames once a video has started playing, so start and stop it straight away.
      try { await v.play(); v.pause(); } catch { /* autoplay blocked; seeking still works on most browsers */ }
      if (v.readyState < 2) await once(v, 'loadeddata', 8000).catch(() => {});
    }
    if (!v.videoWidth) throw new Error('This file has no video picture the browser can show. Try converting it to MP4.');
  }

  /** Measures the frame rate by playing a moment of video. Used when the file's header can't be read. */
  async measureFPS() {
    const v = this.video;
    if (!('requestVideoFrameCallback' in v)) return null;
    const times = [];
    let handle;
    const collect = (_, meta) => { times.push(meta.mediaTime); handle = v.requestVideoFrameCallback(collect); };
    handle = v.requestVideoFrameCallback(collect);
    v.currentTime = 0;
    try { await v.play(); } catch { return null; }
    await wait(1200);
    v.pause();
    v.cancelVideoFrameCallback(handle);
    const deltas = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0.0005) deltas.push(d);
    }
    if (deltas.length < 5) return null;
    deltas.sort((a, b) => a - b);
    // Timestamps are often rounded (e.g. to whole milliseconds), so average the deltas near the typical one.
    const typical = deltas[Math.floor(deltas.length * 0.3)];
    const near = deltas.filter((d) => d > typical * 0.75 && d < typical * 1.25);
    return tidyFPS(near.length / near.reduce((s, d) => s + d, 0));
  }

  setTiming(fps, frameCount) {
    this.fps = fps;
    const fromDuration = Number.isFinite(this.video.duration) ? Math.max(1, Math.floor(this.video.duration * fps + 0.25)) : frameCount;
    this.frameCount = Math.max(1, Math.min(frameCount || fromDuration, fromDuration));
  }

  /** Shows `frame`. Only the most recent request is honoured if several arrive while seeking. */
  async seek(frame) {
    this._target = frame;
    if (this._seeking) return this._seeking;
    this._seeking = (async () => {
      try {
        while (this._target != null) {
          const f = this._target;
          this._target = null;
          await this._seekNow(f);
          this.currentFrame = f;
        }
      } finally {
        this._seeking = null;
      }
    })();
    return this._seeking;
  }

  async _seekNow(frame) {
    const v = this.video;
    // Aim for the middle of the frame so rounding never lands on its neighbour.
    let t = (frame + 0.5) / this.fps;
    if (Number.isFinite(v.duration)) t = Math.min(t, Math.max(v.duration - 0.25 / this.fps, 0));
    if (Math.abs(v.currentTime - t) < 1e-6 && v.readyState >= 2) return;
    const presented = 'requestVideoFrameCallback' in v
      ? new Promise((r) => { v.requestVideoFrameCallback(() => r()); setTimeout(r, 120); })
      : null;
    const seeked = once(v, 'seeked', 10000);
    v.currentTime = t;
    await seeked;
    if (presented) await presented;
  }

  /** Draws the current frame into a canvas of the video's full size and returns it. */
  grab(canvas = this._grabCanvas ??= document.createElement('canvas')) {
    if (canvas.width !== this.width || canvas.height !== this.height) {
      canvas.width = this.width;
      canvas.height = this.height;
    }
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(this.video, 0, 0);
    return canvas;
  }

  close() {
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
