import * as M from './model.js';
import * as store from './store.js';
import { FrameSource, probeMp4, tidyFPS } from './video.js';
import { drawLineChart } from './chart.js';

export const VERSION = '1.0.0';

const $ = (id) => document.getElementById(id);
const fmt = (v, d) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';

function toast(message, ms = 4500) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// Close buttons and backdrop taps for every dialog.
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
}

// MARK: Routing

window.addEventListener('hashchange', route);

async function route() {
  const hash = location.hash;
  if (hash.startsWith('#/trial/')) {
    if (state.analysis?.id !== decodeURIComponent(hash.slice(8))) await openTrial(decodeURIComponent(hash.slice(8)));
  } else if (hash === '#/record') {
    closeTrial();
    showScreen('record');
    startCamera();
  } else {
    closeTrial();
    stopCamera();
    showScreen('home');
    await refreshList();
  }
}

// MARK: Home

const home = { analyses: [], selecting: false, selection: new Set() };

async function refreshList() {
  try {
    home.analyses = await store.listAnalyses();
  } catch (error) {
    home.analyses = [];
    $('import-status').hidden = false;
    $('import-status').className = 'status error';
    $('import-status').textContent = 'This browser is not letting MotionLab save data. Private browsing can cause this. ' + (error?.message ?? '');
  }
  renderList();
  const estimate = await store.storageEstimate();
  $('storage-note').textContent = estimate?.usage
    ? `Videos and results are saved in this browser only, using ${(estimate.usage / 1e6).toFixed(0)} MB.`
    : 'Videos and results are saved in this browser only.';
}

function renderList() {
  const list = $('trial-list');
  const { analyses, selecting, selection } = home;
  $('empty-list').hidden = analyses.length > 0;
  $('select-button').hidden = analyses.length === 0 && !selecting;
  $('select-button').textContent = selecting ? 'Done' : 'Select';
  $('select-bar').hidden = !selecting;
  $('start-buttons').hidden = selecting;
  const all = analyses.length > 0 && selection.size === analyses.length;
  $('select-all').textContent = all ? 'Deselect All' : 'Select All';
  $('delete-selected').textContent = `Delete (${selection.size})`;
  $('delete-selected').disabled = selection.size === 0;

  list.innerHTML = analyses.map((a) => {
    const date = new Date(a.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const lead = selecting ? `<span class="check ${selection.has(a.id) ? 'on' : ''}">${selection.has(a.id) ? CHECK : ''}</span>` : '';
    const tail = selecting ? '' : '<svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
    return `<li data-id="${esc(a.id)}">${lead}<div class="grow"><div class="name">${esc(a.name)}</div>
      <div class="meta">${date} · ${Math.round(a.captureFPS)} fps · ${a.calibration ? 'calibrated' : 'not calibrated'}</div></div>${tail}</li>`;
  }).join('');
}

$('trial-list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = li.dataset.id;
  if (home.selecting) {
    home.selection.has(id) ? home.selection.delete(id) : home.selection.add(id);
    renderList();
  } else {
    location.hash = '#/trial/' + encodeURIComponent(id);
  }
});

$('select-button').onclick = () => {
  home.selecting = !home.selecting;
  home.selection.clear();
  renderList();
};
$('select-all').onclick = () => {
  const all = home.selection.size === home.analyses.length;
  home.selection = new Set(all ? [] : home.analyses.map((a) => a.id));
  renderList();
};
$('delete-selected').onclick = () => {
  const n = home.selection.size;
  confirmDialog(`Delete ${n} ${n === 1 ? 'trial' : 'trials'}?`,
    "The videos and all their tracking will be removed from this device. This can't be undone.",
    async () => {
      for (const a of home.analyses.filter((x) => home.selection.has(x.id))) await store.deleteAnalysis(a);
      home.selection.clear();
      home.selecting = false;
      await refreshList();
    });
};

function confirmDialog(title, message, onConfirm) {
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').onclick = () => { $('confirm-dialog').close(); onConfirm(); };
  $('confirm-dialog').showModal();
}

$('help-button').onclick = () => $('help-dialog').showModal();
$('version-note').textContent = `MotionLab web ${VERSION}`;
$('record-button').onclick = () => { location.hash = '#/record'; };
$('import-input').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importVideo(file);
};

async function importVideo(blob, fpsHint) {
  const status = $('import-status');
  status.hidden = false;
  status.className = 'status';
  status.textContent = 'Importing video…';
  showScreen('home');
  let source;
  try {
    source = new FrameSource(blob);
    await source.open();
    const videoId = await store.saveVideo(blob);
    let fps = null, frameCount = null;
    const probe = await probeMp4(blob).catch(() => null);
    if (probe) ({ fps, frameCount } = probe);
    else if (fpsHint) fps = fpsHint;
    else fps = (await source.measureFPS()) ?? 30;
    source.setTiming(fps, frameCount);
    const name = 'Trial ' + new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const analysis = M.newAnalysis({
      name, videoId, videoFPS: fps, captureFPS: tidyFPS(fps),
      frameCount: source.frameCount, width: source.width, height: source.height,
    });
    await store.saveAnalysis(analysis);
    store.requestPersistence();
    status.hidden = true;
    state.pendingNotice = fpsHint
      ? `Recorded ${source.frameCount} frames at ${tidyFPS(fps)} fps.`
      : `${source.frameCount} frames at ${tidyFPS(fps)} fps. If this was filmed in slow motion, set the real frame rate in Trial settings (gear button).`;
    location.hash = '#/trial/' + encodeURIComponent(analysis.id);
  } catch (error) {
    status.className = 'status error';
    const message = String(error?.message ?? error);
    status.textContent = /DEMUXER|DECODE|SRC_NOT_SUPPORTED|MEDIA_ERR|format/i.test(message)
      ? 'This browser can’t play that video format. Try a different browser (Chrome or Safari), or convert the video to MP4 (H.264).'
      : 'Import failed: ' + message;
  } finally {
    source?.close();
  }
}

// MARK: Recorder

const rec = { stream: null, recorder: null, chunks: [], fps: 30 };

async function startCamera() {
  stopCamera();
  $('shutter').disabled = true;
  $('record-info').textContent = 'Starting camera…';
  drawGrid();
  if (!navigator.mediaDevices?.getUserMedia) {
    $('record-info').textContent = 'This browser cannot record here. Use the camera app button instead.';
    return;
  }
  const target = Number($('record-fps').value);
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: target }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (error) {
    $('record-info').textContent = error?.name === 'NotAllowedError'
      ? 'Camera access is off. Allow it in the browser’s site settings, or use the camera app button.'
      : 'No camera could be started. Use the camera app button or import a video instead.';
    return;
  }
  if (location.hash !== '#/record') { stopCamera(); return; }
  const track = rec.stream.getVideoTracks()[0];
  const s = track.getSettings();
  rec.fps = s.frameRate || target;
  $('preview').srcObject = rec.stream;
  $('record-info').textContent = `${Math.round(rec.fps)} fps · ${s.width ?? '?'}×${s.height ?? '?'}`;
  $('shutter').disabled = typeof MediaRecorder === 'undefined';
}

function stopCamera() {
  if (rec.recorder?.state === 'recording') {
    rec.recorder.onstop = null;
    rec.recorder.stop();
  }
  rec.recorder = null;
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.stream = null;
  $('preview').srcObject = null;
  $('shutter').classList.remove('recording');
  $('record-hint').hidden = false;
}

function drawGrid() {
  const c = $('grid');
  c.hidden = !$('grid-toggle').checked;
  const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  for (const i of [1, 2]) {
    ctx.moveTo(w * i / 3, 0); ctx.lineTo(w * i / 3, h);
    ctx.moveTo(0, h * i / 3); ctx.lineTo(w, h * i / 3);
  }
  ctx.stroke();
}

$('grid-toggle').onchange = drawGrid;
window.addEventListener('resize', () => { if (!$('record').hidden) drawGrid(); });
$('record-fps').onchange = () => startCamera();
$('record-close').onclick = () => { location.hash = '#/'; };
$('capture-input').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) { stopCamera(); importVideo(file); }
};

$('shutter').onclick = () => {
  if (rec.recorder?.state === 'recording') {
    rec.recorder.stop();
    return;
  }
  if (!rec.stream) return;
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t));
  rec.chunks = [];
  rec.recorder = new MediaRecorder(rec.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 12_000_000 });
  rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = () => {
    const blob = new Blob(rec.chunks, { type: rec.recorder?.mimeType || mimeType || 'video/webm' });
    const fps = rec.fps;
    stopCamera();
    importVideo(blob, fps);
  };
  rec.recorder.start(1000);
  $('shutter').classList.add('recording');
  $('record-hint').hidden = true;
  $('record-close').disabled = true;
  $('record-fps').disabled = true;
};
new MutationObserver(() => {
  if ($('record').hidden) { $('record-close').disabled = false; $('record-fps').disabled = false; }
}).observe($('record'), { attributes: true, attributeFilter: ['hidden'] });

// MARK: Digitising

const state = {
  analysis: null,
  source: null,
  frame: 0,
  selected: 'hip',
  mode: 'digitise', // or 'calibrate'
  afterTap: 'nextMarker',
  pendingCal: [],
  zoom: 1,
  pan: [0, 0],
  auto: null, // { cancelled }
  autoMessage: null,
  pendingNotice: null,
};

const view = $('view');
const ctx = view.getContext('2d');

async function openTrial(id) {
  closeTrial();
  showScreen('analysis');
  $('loading').hidden = false;
  $('loading').textContent = 'Loading video…';
  const a = await store.getAnalysis(id).catch(() => null);
  if (!a) {
    $('loading').textContent = 'This trial no longer exists.';
    return;
  }
  state.analysis = a;
  state.selected = a.activeMarkers[0] ?? 'hip';
  state.frame = a.trimStart ?? 0;
  state.mode = 'digitise';
  state.pendingCal = [];
  state.zoom = 1;
  state.pan = [0, 0];
  state.autoMessage = state.pendingNotice;
  state.pendingNotice = null;
  $('trial-title').textContent = a.name;
  try {
    const blob = await store.getVideo(a.videoId);
    if (!blob) throw new Error('The video for this trial is missing.');
    const source = new FrameSource(blob);
    await source.open();
    if (state.analysis !== a) { source.close(); return; }
    source.setTiming(a.videoFPS, a.frameCount);
    a.frameCount = source.frameCount;
    state.source = source;
    $('loading').hidden = true;
    renderControls();
    resizeView();
    await goTo(state.frame);
  } catch (error) {
    $('loading').textContent = "Can't open this trial: " + (error?.message ?? error);
  }
}

function closeTrial() {
  if (state.auto) state.auto.cancelled = true;
  state.auto = null;
  if (state.analysis) flushSave();
  state.source?.close();
  state.source = null;
  state.analysis = null;
  $('auto-panel').hidden = true;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
}

let saveTimer;
function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
  renderControls();
  render();
}
function flushSave() {
  clearTimeout(saveTimer);
  const a = state.analysis;
  if (a) store.saveAnalysis(a).catch((e) => toast('Saving failed: ' + (e?.message ?? e)));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

function range() {
  return M.workingRange(state.analysis);
}

async function goTo(frame) {
  const [lo, hi] = range();
  state.frame = Math.min(Math.max(frame, lo), hi);
  renderControls();
  render();
  await state.source.seek(state.frame);
  render();
}

function step(delta) {
  if (!state.source || state.auto || state.mode === 'calibrate') return;
  goTo(state.frame + delta);
}

$('back-button').onclick = () => { location.hash = '#/'; };
for (const b of document.querySelectorAll('[data-step]')) b.onclick = () => step(Number(b.dataset.step));
$('frame-slider').oninput = (e) => goTo(Number(e.target.value));
$('after-tap').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.afterTap = b.dataset.value;
  for (const x of $('after-tap').children) x.classList.toggle('on', x === b);
};
$('delete-point').onclick = () => {
  M.setPoint(state.analysis, null, state.selected, state.frame);
  changed();
};
$('chips').onclick = (e) => {
  const chip = e.target.closest('[data-marker]');
  if (!chip) return;
  state.selected = chip.dataset.marker;
  renderControls();
  render();
};
document.addEventListener('keydown', (e) => {
  if ($('analysis').hidden || document.querySelector('dialog[open]') || e.target.matches('input, select, textarea')) return;
  if (e.key === 'ArrowRight') { step(e.shiftKey ? 10 : 1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { step(e.shiftKey ? -10 : -1); e.preventDefault(); }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && !state.auto) $('delete-point').click();
});

function renderControls() {
  const a = state.analysis, src = state.source;
  if (!a || !src) return;
  const [lo, hi] = range();
  const busy = !!state.auto || state.mode === 'calibrate';
  $('controls').classList.toggle('disabled', busy);
  $('frame-text').textContent = M.isTrimmed(a)
    ? `Frame ${state.frame + 1} · trimmed to ${lo + 1}–${hi + 1}`
    : `Frame ${state.frame + 1} of ${src.frameCount}`;
  $('time-text').textContent = M.time(a, state.frame).toFixed(3) + ' s';
  const slider = $('frame-slider');
  slider.min = lo;
  slider.max = Math.max(hi, lo + 1);
  slider.value = state.frame;
  slider.disabled = hi === lo;

  $('chips').innerHTML = a.activeMarkers.map((m) => {
    const sel = m === state.selected;
    const color = M.MARKER_COLORS[m];
    const placed = M.point(a, m, state.frame) != null;
    const style = sel ? `background:${color}55;border-color:${color}` : '';
    return `<button class="chip" data-marker="${m}" style="${style}"><span class="dot" style="background:${color}"></span>${M.label(m)}${placed ? CHECK : ''}</button>`;
  }).join('');
  $('chips').querySelector('[style*="border-color"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  $('delete-point').disabled = M.point(a, state.selected, state.frame) == null;

  for (const id of ['trim-button', 'auto-button']) $(id).disabled = busy;
  $('calibrate-button').disabled = !!state.auto;
  $('calibrate-button').classList.toggle('on', state.mode === 'calibrate');
  $('trim-button').classList.toggle('on', M.isTrimmed(a));
  $('trial-title').textContent = a.name;

  let text;
  if (state.mode === 'calibrate') {
    text = state.pendingCal.length === 0
      ? 'Calibrate: tap the bottom of your reference object (this becomes ground level, height 0).'
      : 'Now tap the top of the reference object.';
  } else if (state.autoMessage) {
    text = state.autoMessage;
  } else {
    const what = `Tap to place ${M.label(state.selected).toLowerCase()}.`;
    text = a.calibration ? what : what + ' Not calibrated yet: use the ruler button for real distances.';
  }
  $('banner').textContent = text;
}

// MARK: Canvas drawing

function resizeView() {
  const dpr = devicePixelRatio || 1;
  const r = view.getBoundingClientRect();
  view.width = Math.round(r.width * dpr);
  view.height = Math.round(r.height * dpr);
  render();
}
new ResizeObserver(() => { if (!$('analysis').hidden) resizeView(); }).observe($('stage'));

function transform() {
  const src = state.source;
  const w = view.clientWidth, h = view.clientHeight;
  const iw = src.width || 1, ih = src.height || 1;
  const fit = Math.min(w / iw, h / ih);
  const bx = (w - iw * fit) / 2, by = (h - ih * fit) / 2;
  const cx = w / 2, cy = h / 2, z = state.zoom, [px, py] = state.pan;
  return {
    toView: (p) => [cx + (bx + p[0] * fit - cx) * z + px, cy + (by + p[1] * fit - cy) * z + py],
    toImage: (v) => [((cx + (v[0] - px - cx) / z) - bx) / fit, ((cy + (v[1] - py - cy) / z) - by) / fit],
    rect: [cx + (bx - cx) * z + px, cy + (by - cy) * z + py, iw * fit * z, ih * fit * z],
  };
}

function dot(p, r, color, outline = 'rgba(0,0,0,0.6)') {
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = outline;
  ctx.stroke();
}

function render() {
  const a = state.analysis, src = state.source;
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, view.clientWidth, view.clientHeight);
  if (!a || !src || !src.width) return;
  const t = transform();
  ctx.imageSmoothingEnabled = state.zoom < 3;
  ctx.drawImage(src.video, ...t.rect);
  $('reset-zoom').hidden = state.zoom === 1 && state.pan[0] === 0 && state.pan[1] === 0;

  // Path of the ball across all digitised frames.
  for (const [f, p] of Object.entries(a.points.ball ?? {})) {
    if (Number(f) !== state.frame) dot(t.toView(p), 3, M.MARKER_COLORS.ball + '99', 'transparent');
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  for (const [m1, m2] of M.SKELETON) {
    const p = M.point(a, m1, state.frame), q = M.point(a, m2, state.frame);
    if (p && q) {
      const [vp, vq] = [t.toView(p), t.toView(q)];
      ctx.beginPath(); ctx.moveTo(...vp); ctx.lineTo(...vq); ctx.stroke();
    }
  }

  for (const m of M.MARKERS) {
    const p = M.point(a, m, state.frame);
    if (!p) continue;
    const v = t.toView(p);
    const selected = state.mode === 'digitise' && m === state.selected;
    // Automatically placed points get a white outline, hand-placed ones a dark outline.
    dot(v, selected ? 6 : 5, M.MARKER_COLORS[m], M.isAutoTracked(a, m, state.frame) ? '#fff' : 'rgba(0,0,0,0.6)');
    if (selected) {
      ctx.beginPath(); ctx.arc(v[0], v[1], 10, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  const cal = state.pendingCal.length ? state.pendingCal
    : a.calibration ? [[a.calibration.ax, a.calibration.ay], [a.calibration.bx, a.calibration.by]] : [];
  const vs = cal.map(t.toView);
  if (vs.length === 2) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...vs[0]); ctx.lineTo(...vs[1]); ctx.stroke();
    ctx.restore();
    if (!state.pendingCal.length) {
      ctx.fillStyle = '#ffd60a';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(`${a.calibration.realLength.toFixed(2)} m`, (vs[0][0] + vs[1][0]) / 2 + 10, (vs[0][1] + vs[1][1]) / 2);
    }
  }
  for (const v of vs) dot(v, 5, '#ffd60a');
}

// MARK: Touch, mouse and pen input

const pointers = new Map();
let gesture = null;

view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pointers.size === 1) {
    gesture = { start: [e.offsetX, e.offsetY], pan0: [...state.pan], moved: false, multi: false };
  } else if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    gesture = {
      ...gesture, multi: true,
      d0: Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1,
      mid0: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2],
      z0: state.zoom, pan0: [...state.pan],
    };
  }
});

view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pointers.size === 1 && !gesture.multi) {
    const dx = e.offsetX - gesture.start[0], dy = e.offsetY - gesture.start[1];
    if (!gesture.moved && Math.hypot(dx, dy) < 10) return;
    gesture.moved = true;
    state.pan = [gesture.pan0[0] + dx, gesture.pan0[1] + dy];
    render();
  } else if (pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    zoomAround(gesture.mid0, mid, gesture.z0, gesture.pan0, gesture.z0 * d / gesture.d0);
  }
});

function zoomAround(anchor, target, z0, pan0, newZoom) {
  const z1 = Math.min(Math.max(newZoom, 1), 12);
  const cx = view.clientWidth / 2, cy = view.clientHeight / 2;
  // Keep the image point that was under `anchor` under `target`.
  const bx = cx + (anchor[0] - cx - pan0[0]) / z0;
  const by = cy + (anchor[1] - cy - pan0[1]) / z0;
  state.zoom = z1;
  state.pan = z1 === 1 ? [0, 0] : [target[0] - cx - (bx - cx) * z1, target[1] - cy - (by - cy) * z1];
  render();
}

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (e.type === 'pointerup' && gesture && !gesture.moved && !gesture.multi) handleTap([e.offsetX, e.offsetY]);
    gesture = null;
  } else if (pointers.size === 1 && gesture) {
    const [p] = [...pointers.values()];
    gesture = { ...gesture, start: p, pan0: [...state.pan], moved: true };
  }
}
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);

view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = [e.offsetX, e.offsetY];
  zoomAround(p, p, state.zoom, state.pan, state.zoom * Math.exp(-e.deltaY * 0.002));
}, { passive: false });

$('reset-zoom').onclick = () => { state.zoom = 1; state.pan = [0, 0]; render(); };

function handleTap(v) {
  const a = state.analysis, src = state.source;
  if (!a || !src || state.auto) return;
  const p = transform().toImage(v);
  if (p[0] < 0 || p[1] < 0 || p[0] > src.width || p[1] > src.height) return;
  state.autoMessage = null;
  if (state.mode === 'calibrate') {
    state.pendingCal.push(p);
    if (state.pendingCal.length === 2) {
      $('calibration-length').value = a.calibration ? String(a.calibration.realLength) : '1.0';
      $('calibration-dialog').showModal();
    }
    renderControls();
    render();
    return;
  }
  M.setPoint(a, p, state.selected, state.frame);
  if (state.afterTap === 'nextFrame') {
    changed();
    step(1);
  } else if (state.afterTap === 'nextMarker') {
    const list = a.activeMarkers;
    const i = list.indexOf(state.selected);
    if (i >= 0 && i + 1 < list.length) {
      state.selected = list[i + 1];
      changed();
    } else {
      state.selected = list[0] ?? state.selected;
      changed();
      step(1);
    }
  } else {
    changed();
  }
}

// MARK: Calibration

$('calibrate-button').onclick = () => {
  state.pendingCal = [];
  state.autoMessage = null;
  state.mode = state.mode === 'calibrate' ? 'digitise' : 'calibrate';
  renderControls();
  render();
};
$('calibration-save').onclick = () => {
  const length = parseFloat($('calibration-length').value.replace(',', '.'));
  if (state.pendingCal.length === 2 && length > 0) {
    const [[ax, ay], [bx, by]] = state.pendingCal;
    state.analysis.calibration = { ax, ay, bx, by, realLength: length };
  }
  $('calibration-dialog').close();
};
$('calibration-cancel').onclick = () => $('calibration-dialog').close();
$('calibration-dialog').addEventListener('close', () => {
  state.pendingCal = [];
  state.mode = 'digitise';
  changed();
});

// MARK: Trim

$('trim-button').onclick = () => {
  const [lo, hi] = range();
  const f = state.frame;
  $('trim-start').textContent = `Start at this frame (${f + 1})`;
  $('trim-end').textContent = `End at this frame (${f + 1})`;
  $('trim-start').disabled = f === lo;
  $('trim-end').disabled = f === hi;
  $('trim-clear').hidden = !M.isTrimmed(state.analysis);
  $('trim-dialog').showModal();
};
$('trim-start').onclick = () => {
  const a = state.analysis;
  a.trimStart = state.frame;
  if (a.trimEnd != null && a.trimEnd <= state.frame) a.trimEnd = null;
  $('trim-dialog').close();
  changed();
};
$('trim-end').onclick = () => {
  const a = state.analysis;
  a.trimEnd = state.frame;
  if (a.trimStart != null && a.trimStart >= state.frame) a.trimStart = null;
  $('trim-dialog').close();
  changed();
};
$('trim-clear').onclick = () => {
  state.analysis.trimStart = null;
  state.analysis.trimEnd = null;
  $('trim-dialog').close();
  changed();
};

// MARK: Automatic tracking

$('auto-button').onclick = () => {
  $('body-side').value = state.analysis.bodySide;
  $('follow-button').textContent = `Follow ${M.label(state.selected).toLowerCase()} from this frame`;
  $('follow-button').disabled = M.point(state.analysis, state.selected, state.frame) == null;
  $('auto-dialog').showModal();
};
$('body-side').onchange = (e) => { state.analysis.bodySide = e.target.value; changed(); };
for (const b of document.querySelectorAll('[data-pose]')) {
  b.onclick = () => {
    $('auto-dialog').close();
    const hi = Math.max(range()[1], state.frame);
    const n = b.dataset.pose;
    const last = n === 'all' ? hi : Math.min(state.frame + Number(n) - 1, hi);
    runPoseDetection(state.frame, last);
  };
}
$('follow-button').onclick = () => { $('auto-dialog').close(); runObjectTracking(); };
$('auto-stop').onclick = () => { if (state.auto) state.auto.cancelled = true; };

function startAuto(status) {
  const job = { cancelled: false };
  state.auto = job;
  state.autoMessage = null;
  $('auto-status').textContent = status;
  $('auto-progress').value = 0;
  $('auto-panel').hidden = false;
  renderControls();
  return job;
}

function finishAuto(job, message) {
  if (state.auto !== job) return;
  state.auto = null;
  state.autoMessage = message;
  $('auto-panel').hidden = true;
  changed();
}

function applyAutoPoints(a, frame, joints, replace) {
  for (const [m, p] of Object.entries(joints)) {
    if (!a.activeMarkers.includes(m)) continue;
    if (!replace && M.isManual(a, m, frame)) continue;
    M.setPoint(a, p, m, frame, true);
  }
}

async function runPoseDetection(first, last) {
  const a = state.analysis, src = state.source;
  const replace = $('replace-manual').checked;
  const job = startAuto('Loading the pose model…');
  let pose;
  try {
    pose = await import('./pose.js');
    await pose.loadPoseModel();
  } catch (error) {
    finishAuto(job, 'The pose model could not load. Check the internet connection the first time you use it. ' + (error?.message ?? ''));
    return;
  }
  $('auto-status').textContent = 'Finding joints…';
  // Start near the hip already on this frame (or the nearest earlier one), so the same person is followed.
  const hipFrames = M.trackedFramesFor(a, 'hip').filter((f) => f <= first);
  let hint = hipFrames.length ? M.point(a, 'hip', hipFrames[hipFrames.length - 1]) : null;
  let found = 0, total = 0;
  try {
    for (let f = first; f <= last && !job.cancelled; f++) {
      state.frame = f;
      await src.seek(f);
      const joints = await pose.detectPose(src.grab(), a.bodySide, hint);
      total++;
      if (joints.hip) hint = joints.hip;
      if (Object.keys(joints).length) {
        found++;
        applyAutoPoints(a, f, joints, replace);
      }
      $('auto-progress').value = (f - first + 1) / (last - first + 1);
      renderControls();
      render();
    }
  } catch (error) {
    finishAuto(job, 'Detection stopped with an error: ' + (error?.message ?? error));
    return;
  }
  const missing = a.activeMarkers.filter((m) => !pose.SUPPORTED_MARKERS.includes(m));
  const extra = missing.length ? ` ${missing.map(M.label).join(' and ')} isn't detected automatically: use Follow for it.` : '';
  finishAuto(job, job.cancelled ? 'Stopped. Joints found so far are kept.'
    : found === 0 ? 'No person found. Check the whole body is in view and well lit.'
    : `Found joints on ${found} of ${total} frames.${extra}`);
}

async function runObjectTracking() {
  const a = state.analysis, src = state.source;
  const marker = state.selected;
  const start = state.frame;
  const startPoint = M.point(a, marker, start);
  if (!startPoint) return;
  const last = range()[1];
  const box = Number($('object-size').value) * Math.min(src.width, src.height);
  const replace = $('replace-manual').checked;
  const job = startAuto(`Following ${M.label(marker).toLowerCase()}…`);
  const { ObjectTracker } = await import('./tracker.js');
  await src.seek(start);
  const tracker = new ObjectTracker(src.grab(), startPoint, box);
  let lostAt = null;
  for (let f = start + 1; f <= last && !job.cancelled; f++) {
    state.frame = f;
    await src.seek(f);
    const result = tracker.track(src.grab());
    if (result.confidence < 0.5) { lostAt = f; break; }
    applyAutoPoints(a, f, { [marker]: result.point }, replace);
    $('auto-progress').value = (f - start) / Math.max(last - start, 1);
    renderControls();
    render();
    // Let the page breathe so the Stop button stays responsive.
    await new Promise((r) => setTimeout(r, 0));
  }
  const name = M.label(marker).toLowerCase();
  if (lostAt != null) {
    finishAuto(job, `Lost the ${name} at frame ${lostAt + 1}. Tap it here, then choose Follow again.`);
    state.frame = lostAt;
    state.selected = marker;
    goTo(lostAt);
  } else {
    finishAuto(job, job.cancelled ? 'Stopped. Points found so far are kept.' : `Followed the ${name} to the end of the video.`);
  }
}

// MARK: Settings

$('settings-button').onclick = () => {
  const a = state.analysis, src = state.source;
  $('set-name').value = a.name;
  $('set-fps').value = String(a.captureFPS);
  $('video-info').textContent = `Video file: ${src.frameCount} frames, ${tidyFPS(a.videoFPS)} frames per second of playback, ${src.width}×${src.height}.`;
  $('marker-toggles').innerHTML = M.MARKERS.map((m) => `<label class="row"><span><span class="dot" style="background:${M.MARKER_COLORS[m]}"></span>${M.label(m)}</span>
    <input type="checkbox" data-toggle="${m}" ${a.activeMarkers.includes(m) ? 'checked' : ''}></label>`).join('');
  renderCalibrationInfo();
  $('settings-dialog').showModal();
};

function renderCalibrationInfo() {
  const c = state.analysis.calibration;
  $('calibration-info').innerHTML = c
    ? `<div class="row">Reference length<span class="value">${c.realLength.toFixed(3)} m</span></div>
       <div class="row">Scale<span class="value">${(1 / Math.max(M.metresPerPixel(c), 1e-12)).toFixed(1)} pixels per metre</span></div>
       <div class="row"><button class="text-button danger" id="remove-calibration" style="padding-left:0">Remove calibration</button></div>`
    : '<div class="row muted">Not calibrated. Use the ruler button on the video to mark an object of known length.</div>';
  const remove = $('remove-calibration');
  if (remove) remove.onclick = () => { state.analysis.calibration = null; renderCalibrationInfo(); changed(); };
}

$('set-name').oninput = (e) => { state.analysis.name = e.target.value || 'Trial'; changed(); };
$('set-fps').onchange = (e) => {
  const v = parseFloat(e.target.value.replace(',', '.'));
  if (v > 0) { state.analysis.captureFPS = v; changed(); } else e.target.value = String(state.analysis.captureFPS);
};
$('marker-toggles').onchange = (e) => {
  const m = e.target.dataset.toggle;
  if (!m) return;
  const active = new Set(state.analysis.activeMarkers);
  e.target.checked ? active.add(m) : active.delete(m);
  state.analysis.activeMarkers = M.MARKERS.filter((x) => active.has(x));
  if (!active.has(state.selected) && state.analysis.activeMarkers.length) state.selected = state.analysis.activeMarkers[0];
  changed();
};

// MARK: Results

const results = { angle: null, marker: 'ball', from: 0, to: 0 };

$('results-button').onclick = () => {
  const a = state.analysis;
  const angles = M.ANGLES.filter((d) => M.angleSeries(d, a).length);
  if (!angles.some((d) => d.csvName === results.angle)) results.angle = angles[0]?.csvName ?? null;
  const markers = M.MARKERS.filter((m) => M.trackedFramesFor(a, m).length >= 3);
  if (!markers.includes(results.marker)) results.marker = markers[0] ?? 'ball';
  resetProjectileRange();
  $('results-dialog').showModal();
  renderResults();
};

function resetProjectileRange() {
  const frames = M.trackedFramesFor(state.analysis, results.marker);
  results.from = frames[0] ?? 0;
  results.to = frames[frames.length - 1] ?? 0;
}

function row(name, value) {
  return `<div class="row">${name}<span class="value">${value}</span></div>`;
}

function renderResults() {
  const a = state.analysis;
  const body = $('results-body');
  const angles = M.ANGLES.filter((d) => M.angleSeries(d, a).length);
  const markers = M.MARKERS.filter((m) => M.trackedFramesFor(a, m).length >= 3);
  let html = '<h4>Joint angles</h4>';

  if (!angles.length) {
    html += '<div class="group"><div class="row muted">Digitise three connected markers on at least one frame (for example hip, knee and ankle) to see joint angles.</div></div>';
  } else {
    const def = angles.find((d) => d.csvName === results.angle) ?? angles[0];
    const data = M.angleSeries(def, a);
    const lo = data.reduce((m, s) => (s.value < m.value ? s : m));
    const hi = data.reduce((m, s) => (s.value > m.value ? s : m));
    html += `<div class="group">
      <label class="row">Angle<select id="angle-select">${angles.map((d) => `<option value="${d.csvName}" ${d === def ? 'selected' : ''}>${d.name}</option>`).join('')}</select></label>
      <canvas class="chart" id="angle-chart"></canvas>
      <p class="footnote">${def.note}</p>
      ${row('Minimum', `${lo.value.toFixed(1)}° at ${lo.time.toFixed(3)} s (frame ${lo.frame + 1})`)}
      ${row('Maximum', `${hi.value.toFixed(1)}° at ${hi.time.toFixed(3)} s (frame ${hi.frame + 1})`)}
      ${row('Range of motion', `${(hi.value - lo.value).toFixed(1)}°`)}
    </div>`;
    results.chart = { data, def };
  }

  html += '<h4>Projectile motion</h4><div class="group">';
  if (!markers.length) {
    html += '<div class="row muted">Digitise the ball (or another marker) on at least three frames while it is in the air.</div>';
  } else {
    const stepper = (id, v) => `<span class="stepper"><button data-adj="${id}" data-d="-1">−</button><input id="${id}" type="text" inputmode="numeric" value="${v + 1}"><button data-adj="${id}" data-d="1">+</button></span>`;
    html += `<label class="row">Marker<select id="proj-marker">${markers.map((m) => `<option value="${m}" ${m === results.marker ? 'selected' : ''}>${M.label(m)}</option>`).join('')}</select></label>
      <div class="row">From frame ${stepper('proj-from', results.from)}</div>
      <div class="row">To frame ${stepper('proj-to', results.to)}</div>`;
    if (!a.calibration) {
      html += '<div class="row warn">Calibrate the video first so positions are in metres.</div>';
    } else {
      const r = results.from <= results.to ? M.analyseProjectile(M.projectileSamples(a, results.marker, results.from, results.to)) : null;
      if (!r) {
        html += '<div class="row muted">Need at least three digitised frames of this marker in the chosen range.</div>';
      } else {
        html += row('Release speed', `${fmt(r.speed, 2)} m/s`) + row('Release angle', `${fmt(r.angle, 1)}°`)
          + row('Release height', `${fmt(r.releaseHeight, 2)} m`) + row('Horizontal velocity', `${fmt(r.horizontalVelocity, 2)} m/s`)
          + row('Vertical velocity', `${fmt(r.verticalVelocity, 2)} m/s`) + row('Rise after release', `${fmt(r.riseAfterRelease, 3)} m`)
          + row('Peak height', `${fmt(r.peakHeight, 2)} m`) + row('Time to peak', `${fmt(r.timeToPeak, 3)} s`)
          + (r.flightTimeToGround != null ? row('Flight time to ground', `${fmt(r.flightTimeToGround, 3)} s`) + row('Range to ground', `${fmt(r.rangeToGround, 2)} m`) : '')
          + (r.gravityFromData != null ? row('Gravity from data', `${fmt(r.gravityFromData, 2)} m/s²`) : '')
          + row('Fit error (RMS)', `${fmt(r.rmsError * 100, 1)} cm`) + row('Frames used', r.sampleCount);
      }
    }
  }
  html += `</div><p class="footnote">Use only frames where the object is in the air: after release or take-off and before landing. Values come from a parabola fitted with g = 9.81 m/s². Gravity from data should be close to 9.81 if digitising and calibration are good. Heights are measured from the bottom of the calibration reference.</p>`;

  const canShare = !!navigator.canShare?.({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] });
  html += `<h4>Export</h4><div class="export-row">
      <button class="sheet-button primary" id="csv-download">Download CSV</button>
      ${canShare ? '<button class="sheet-button" id="csv-share">Share CSV</button>' : ''}
    </div>
    <p class="footnote">One row per digitised frame with time, marker positions (${a.calibration ? 'metres' : 'pixels'}, y up) and joint angles. Opens in Excel, Numbers or Google Sheets.</p>`;

  body.innerHTML = html;

  if (results.chart && angles.length) {
    const { data, def } = results.chart;
    requestAnimationFrame(() => drawLineChart($('angle-chart'), data.map((s) => ({ x: s.time, y: s.value })),
      { xLabel: 'Time (s)', yLabel: `${def.name} angle (°)`, color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }));
  }
  $('angle-select')?.addEventListener('change', (e) => { results.angle = e.target.value; renderResults(); });
  $('proj-marker')?.addEventListener('change', (e) => { results.marker = e.target.value; resetProjectileRange(); renderResults(); });
  const maxFrame = state.source.frameCount - 1;
  const setRange = (id, v) => {
    if (id === 'proj-from') results.from = Math.min(Math.max(v, 0), results.to);
    else results.to = Math.max(Math.min(v, maxFrame), results.from);
    renderResults();
  };
  for (const b of body.querySelectorAll('[data-adj]')) {
    b.onclick = () => setRange(b.dataset.adj, (b.dataset.adj === 'proj-from' ? results.from : results.to) + Number(b.dataset.d));
  }
  for (const id of ['proj-from', 'proj-to']) {
    $(id)?.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isFinite(v)) setRange(id, v - 1); else renderResults();
    });
  }
  $('csv-download').onclick = () => {
    const url = URL.createObjectURL(new Blob([M.csv(a)], { type: 'text/csv' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: M.safeFileName(a.name) + '.csv' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  if ($('csv-share')) {
    $('csv-share').onclick = async () => {
      const file = new File([M.csv(a)], M.safeFileName(a.name) + '.csv', { type: 'text/csv' });
      try { await navigator.share({ files: [file], title: a.name }); } catch { /* cancelled */ }
    };
  }
}

window.addEventListener('resize', () => { if ($('results-dialog').open && results.chart) renderResults(); });

// MARK: Start

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (location.protocol === 'file:') {
  document.body.innerHTML = '<p style="padding:24px">MotionLab needs to be opened from a website, not as a file. See the instructions for putting it online.</p>';
} else {
  route();
}
