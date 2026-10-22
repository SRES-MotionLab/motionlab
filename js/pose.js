// Finds body joints in a single frame with Google's MediaPipe Pose model, which runs on the device.

const base = new URL('../vendor/', import.meta.url).href;

// MediaPipe landmark numbers for the person's left and right side.
const JOINTS = {
  head: [7, 8], // ears
  shoulder: [11, 12],
  elbow: [13, 14],
  wrist: [15, 16],
  hip: [23, 24],
  knee: [25, 26],
  ankle: [27, 28],
  toe: [31, 32], // tip of the foot
};

export const SUPPORTED_MARKERS = Object.keys(JOINTS);

let landmarkerPromise;

/** Loads the model once. The first time takes a few seconds while about 20 MB downloads. */
export function loadPoseModel() {
  landmarkerPromise ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import(base + 'mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(base + 'mediapipe/wasm');
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: base + 'models/pose_landmarker_full.task', delegate },
      runningMode: 'IMAGE',
      numPoses: 3,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
    });
    try {
      return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
    }
  })();
  landmarkerPromise.catch(() => { landmarkerPromise = null; });
  return landmarkerPromise;
}

/**
 * Returns joint positions in image pixels (origin top-left).
 * When several people are visible, picks the one whose hip is nearest `nearHip`, or otherwise the largest.
 */
export async function detectPose(canvas, side, nearHip, minimumVisibility = 0.3) {
  const landmarker = await loadPoseModel();
  const result = landmarker.detect(canvas);
  const w = canvas.width, h = canvas.height;
  const people = result.landmarks ?? [];
  if (!people.length) return {};

  const px = (l) => [l.x * w, l.y * h];
  const hipOf = (p) => [(p[23].x + p[24].x) / 2 * w, (p[23].y + p[24].y) / 2 * h];
  const spread = (p) => {
    const xs = p.map((l) => l.x), ys = p.map((l) => l.y);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };

  let person;
  if (nearHip) {
    const dist = (p) => { const [x, y] = hipOf(p); return Math.hypot(x - nearHip[0], y - nearHip[1]); };
    person = people.reduce((best, p) => (dist(p) < dist(best) ? p : best));
  } else {
    person = people.reduce((best, p) => (spread(p) > spread(best) ? p : best));
  }

  let useLeft;
  if (side === 'left') useLeft = true;
  else if (side === 'right') useLeft = false;
  else {
    let left = 0, right = 0;
    for (const [l, r] of Object.values(JOINTS)) {
      left += person[l].visibility ?? 0;
      right += person[r].visibility ?? 0;
    }
    useLeft = left >= right;
  }

  const out = {};
  for (const [marker, [l, r]] of Object.entries(JOINTS)) {
    const lm = person[useLeft ? l : r];
    const inside = lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1;
    if (inside && (lm.visibility ?? 1) >= minimumVisibility) out[marker] = px(lm);
  }
  return out;
}
