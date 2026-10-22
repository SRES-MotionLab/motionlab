// Follows one object (a ball, a toe) from frame to frame by matching a small picture of it.

const TEMPLATE = 24; // template side in working pixels

function grey(source, x, y, w, h, outW, outH, scratch) {
  scratch.width = outW;
  scratch.height = outH;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, x, y, w, h, 0, 0, outW, outH);
  const rgba = ctx.getImageData(0, 0, outW, outH).data;
  const out = new Float32Array(outW * outH);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return out;
}

function normalise(t) {
  let mean = 0;
  for (const v of t) mean += v;
  mean /= t.length;
  let ss = 0;
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) { out[i] = t[i] - mean; ss += out[i] * out[i]; }
  return { data: out, norm: Math.sqrt(ss) };
}

/** Normalised cross-correlation of the template over every position in the search image. Returns the best. */
function bestMatch(img, iw, ih, tmpl, tw, th) {
  let best = { score: -2, x: 0, y: 0 };
  const n = tw * th;
  for (let oy = 0; oy + th <= ih; oy++) {
    for (let ox = 0; ox + tw <= iw; ox++) {
      let sum = 0, sum2 = 0, cross = 0;
      for (let y = 0; y < th; y++) {
        const row = (oy + y) * iw + ox, trow = y * tw;
        for (let x = 0; x < tw; x++) {
          const v = img[row + x];
          sum += v; sum2 += v * v; cross += v * tmpl.data[trow + x];
        }
      }
      const variance = sum2 - (sum * sum) / n;
      const score = variance > 1e-6 && tmpl.norm > 0 ? cross / (Math.sqrt(variance) * tmpl.norm) : -1;
      if (score > best.score) best = { score, x: ox, y: oy };
    }
  }
  return best;
}

export class ObjectTracker {
  /** `boxSize` is the side of the square around the object, in image pixels. It should just enclose the object. */
  constructor(frame, start, boxSize) {
    this.box = Math.max(8, Math.round(boxSize));
    this.scale = TEMPLATE / this.box;
    this.scratch = document.createElement('canvas');
    this.imageW = frame.width;
    this.imageH = frame.height;
    this.position = start;
    this.velocity = [0, 0];
    this.template = this._patch(frame, start);
    this.original = this.template;
  }

  _patch(frame, centre) {
    const half = this.box / 2;
    const x = Math.min(Math.max(centre[0] - half, 0), this.imageW - this.box);
    const y = Math.min(Math.max(centre[1] - half, 0), this.imageH - this.box);
    return normalise(grey(frame, x, y, this.box, this.box, TEMPLATE, TEMPLATE, this.scratch));
  }

  /** Finds the object in the next frame. Returns its centre in image pixels and a match score (−1 to 1). */
  track(frame) {
    const predicted = [this.position[0] + this.velocity[0], this.position[1] + this.velocity[1]];
    const reach = this.box * 1.5 + Math.hypot(...this.velocity);
    const size = Math.round(reach * 2 + this.box);
    const x0 = Math.round(Math.min(Math.max(predicted[0] - size / 2, 0), Math.max(this.imageW - size, 0)));
    const y0 = Math.round(Math.min(Math.max(predicted[1] - size / 2, 0), Math.max(this.imageH - size, 0)));
    const w = Math.min(size, this.imageW - x0), h = Math.min(size, this.imageH - y0);
    const sw = Math.max(TEMPLATE, Math.round(w * this.scale)), sh = Math.max(TEMPLATE, Math.round(h * this.scale));
    const region = grey(frame, x0, y0, w, h, sw, sh, this.scratch);

    // Compare against both the latest look of the object and how it looked at the start, and keep the better.
    let match = bestMatch(region, sw, sh, this.template, TEMPLATE, TEMPLATE);
    if (this.template !== this.original) {
      const m2 = bestMatch(region, sw, sh, this.original, TEMPLATE, TEMPLATE);
      if (m2.score > match.score) match = m2;
    }

    const found = [
      x0 + (match.x + TEMPLATE / 2) * (w / sw),
      y0 + (match.y + TEMPLATE / 2) * (h / sh),
    ];
    this.velocity = [found[0] - this.position[0], found[1] - this.position[1]];
    this.position = found;
    if (match.score > 0.8) {
      const fresh = this._patch(frame, found);
      const blended = new Float32Array(fresh.data.length);
      for (let i = 0; i < blended.length; i++) blended[i] = 0.7 * this.template.data[i] + 0.3 * fresh.data[i];
      this.template = normalise(blended);
    }
    return { point: found, confidence: match.score };
  }
}
