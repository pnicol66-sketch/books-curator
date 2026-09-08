'use strict';

/* Book Curator — phone capture app, Shelf mode.
 *
 * A separate project from Vinyl Curator; the machinery that is proven there
 * (IndexedDB store, camera, background Drive upload queue, folder sharing,
 * update bar, dictation) is copied in with the same function names so a diff
 * between the two apps stays readable. The vinyl domain (shot table, crop,
 * matrix dictation) is not here. This slice records SHELVES only: one labelled
 * photo (or a few overlapping frames) per shelf, checked for legibility,
 * uploaded to the client's own Drive under Book Curator/_Shelves/<label>/.
 */

/* Build stamp — rewritten by bump-version.ps1 (and the pre-commit hook) so it
   always matches the service worker's cache name. Shown in Settings. */
const APP_VERSION = '20260908-194840';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function sanitize(s) { return String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim(); }
function pad2(n) { return String(n).padStart(2, '0'); }

/* Shelf chips: the closed set of things worth saying about a shelf that the
   read cannot see for itself. They land in shelf.json and seed the sheet's Notes. */
const CHIPS = ['Second row behind', 'Books stacked flat on top', 'Top shelf, shot from below', 'Glass door'];
const SHELVES_FOLDER = '_Shelves';   // sorts first, can never collide with an Author_Title folder
const CAM_TIP = '📸 Card at the left end · phone sideways · square to the shelf · fill the width';

/* ---------- IndexedDB ---------- */
let _db = null;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('bookcurator', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('shelves')) d.createObjectStore('shelves', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: ['shelfId', 'n'] });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function db() { return _db || (_db = await openDB()); }
function reqP(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function dbPut(store, val, key) { return reqP((await db()).transaction(store, 'readwrite').objectStore(store).put(val, key)); }
async function dbGet(store, key) { return reqP((await db()).transaction(store).objectStore(store).get(key)); }
async function dbAll(store) { return reqP((await db()).transaction(store).objectStore(store).getAll()); }
async function dbDel(store, key) { return reqP((await db()).transaction(store, 'readwrite').objectStore(store).delete(key)); }
async function dbClear(store) { return reqP((await db()).transaction(store, 'readwrite').objectStore(store).clear()); }
async function photosFor(shelfId) {
  const all = await reqP((await db()).transaction('photos').objectStore('photos')
    .getAll(IDBKeyRange.bound([shelfId, 0], [shelfId, 999])));
  return all.sort((a, b) => a.n - b.n);
}

/* ---------- built-in Google credentials ----------
 *
 * An OAuth client id identifies THIS APP, not the person signing in, and in a
 * browser app it is public by design. Filling it in here is what keeps a client
 * out of the Cloud console entirely: they tap Upload, sign in with their own
 * Google account, allow.
 *
 * Book Curator has ITS OWN Cloud project and OAuth client (owner's decision,
 * 8 Sep 2026). Never paste the Vinyl Curator client id here: under the
 * drive.file scope an app sees only the folders created under its own client
 * id, so a client id can never be changed once a client has uploaded, and the
 * two apps must never share one. Empty until the book-curator-tools project
 * exists; Settings has a box that overrides whatever is here.
 */
const BUILTIN = {
  // Cloud project "book-curator-tools", consent screen published In production,
  // authorised JavaScript origins https://pnicol66-sketch.github.io and http://localhost:8322
  clientId: '991007809247-3kb4gqf2jfbghp5q34l4sp43f1087174.apps.googleusercontent.com',
  apiKey: '',         // AIza...        - only for the "Link…" picker
  projectNumber: '',  // 000000000000   - only for the "Link…" picker
  shareWith: 'pnicol66@gmail.com',
};

/* ---------- settings ---------- */
const settings = {
  clientId: '', apiKey: '', projectNumber: '', shareWith: '',
  operator: '', quality: 0.95,
  driveFolder: 'Book Curator', driveFolderId: '',
};
// What the app should actually use: an explicit Settings entry always wins.
function cred(k) { return String(settings[k] || BUILTIN[k] || '').trim(); }
async function loadSettings() {
  const s = await dbGet('kv', 'settings');
  if (s) Object.assign(settings, s);
  if (!settings.driveFolder) settings.driveFolder = 'Book Curator';
}
async function saveSettings() { await dbPut('kv', { ...settings }, 'settings'); }

/* ---------- navigation ---------- */
let backAction = null;
function show(id, { title = 'Book Curator', back = null, gear = false } = {}) {
  stopVoice();   // any screen change cancels an in-progress dictation
  $$('main > section').forEach(s => s.classList.toggle('active', s.id === id));
  $('#title').textContent = title;
  backAction = back;
  $('#btnBack').classList.toggle('hidden', !back);
  $('#btnSettings').classList.toggle('hidden', !gear);
  window.scrollTo(0, 0);
}
$('#btnBack').onclick = () => backAction && backAction();
$('#btnSettings').onclick = () => openSettings();

/* ---------- home ---------- */
function shelfMeta(sh, photos) {
  const bits = [`${photos.length} photo${photos.length === 1 ? '' : 's'}`];
  if (sh.count) bits.push(`~${sh.count} books`);
  if (sh.chips && sh.chips.length) bits.push(sh.chips.join(', '));
  if (sh.finishedAt) bits.push('finished');
  return bits.join(' · ');
}
async function goHome() {
  stopCam();
  stopLevel();
  freeGate();
  show('scr-home', { title: 'Book Curator', gear: true });
  const all = (await dbAll('shelves')).sort((a, b) => b.created - a.created);
  const shelves = all.filter(s => !s.uploaded);
  const hiddenCount = all.length - shelves.length;
  $('#btnArchive').classList.toggle('hidden', !hiddenCount);
  const list = $('#shelfList');
  list.innerHTML = '';
  if (!shelves.length) {
    list.innerHTML = hiddenCount
      ? '<p class="empty">All shelves uploaded ✓<br>Find them under “Uploaded shelves” below.</p>'
      : '<p class="empty">No shelves yet.<br>Tap “New shelf” to start.</p>';
  }
  let uploadable = 0;
  for (const sh of shelves) {
    const photos = await photosFor(sh.id);
    if (photos.length && !sh.upload) uploadable++;
    const row = document.createElement('div');
    row.className = 'shelfcard';
    row.dataset.shelf = sh.id;
    const upText = uploadLabel(sh);
    row.innerHTML =
      `<button class="sh-open"><div class="sh-label">${esc(sh.label)}</div>` +
      `<div class="sh-meta">${esc(shelfMeta(sh, photos))}</div>` +
      `<div class="sh-up${sh.upload ? ' ' + sh.upload.state : ''}${upText ? '' : ' hidden'}">${esc(upText)}</div></button>` +
      `<button class="sh-retry${sh.upload && sh.upload.state === 'failed' ? '' : ' hidden'}" aria-label="Retry upload">↻</button>` +
      `<button class="sh-del${sh.upload && sh.upload.state === 'uploading' ? ' hidden' : ''}" aria-label="Delete shelf">🗑</button>`;
    row.querySelector('.sh-open').onclick = () => openShelf(sh.id);
    row.querySelector('.sh-retry').onclick = async () => {
      const fresh = await dbGet('shelves', sh.id);
      if (!fresh || !fresh.upload) return;
      await setUpload(fresh, { state: 'queued', error: '', queued: Date.now() });
      pumpUploads();
    };
    row.querySelector('.sh-del').onclick = () => deleteShelf(sh.id);
    list.appendChild(row);
  }
  $('#btnUploadAll').classList.toggle('hidden', uploadable < 1);
  $('#btnUploadAll').textContent = `☁ Upload ${uploadable === 1 ? 'the finished shelf' : uploadable + ' finished shelves'}`;
  refreshUploadCards();
}
async function deleteShelf(id) {
  const sh = await dbGet('shelves', id);
  if (!sh) return goHome();
  if (sh.upload && sh.upload.state === 'uploading') return toast('Wait for the upload to finish');
  if (!confirm(`Delete "${sh.label}" and its photos from this phone?`)) return;
  for (const p of await photosFor(id)) await dbDel('photos', [id, p.n]);
  await dbDel('shelves', id);
  goHome();
}

/* ---------- new shelf ---------- */
// "Study, case 2, shelf 3" → "Study, case 2, shelf 4": bump the LAST number in
// the previous label, so a case of six shelves needs one typed label.
function nextLabel(prev) {
  if (!prev) return 'Case 1, shelf 1';
  const m = prev.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return prev;
  return m[1] + (Number(m[2]) + 1) + m[3];
}
$('#btnNew').onclick = async () => {
  const all = (await dbAll('shelves')).sort((a, b) => b.created - a.created);
  $('#inLabel').value = nextLabel(all.length ? all[0].label : '');
  $('#inOperator').value = settings.operator || '';
  $('#btnLabelVoice').classList.toggle('hidden', !SpeechRec);
  show('scr-new', { title: 'New shelf', back: goHome });
  if (!settings.operator) $('#inOperator').focus();
};
$('#btnCreate').onclick = async () => {
  const label = sanitize($('#inLabel').value);
  if (!label) return toast('Give the shelf a label');
  const op = $('#inOperator').value.trim();
  if (op !== settings.operator) { settings.operator = op; await saveSettings(); }
  const sh = {
    id: Date.now().toString(36),
    label, chips: [], note: '', count: null,
    operator: op, created: Date.now(), startedAt: Date.now(), finishedAt: null,
  };
  await dbPut('shelves', sh);
  curShelf = sh;
  openCamera();   // straight to the camera: the label is done, the shelf is the job
};

/* ---------- shelf screen ---------- */
let curShelf = null;
let thumbUrls = [];
async function openShelf(id) {
  curShelf = await dbGet('shelves', id);
  if (!curShelf) return goHome();
  backToShelf();
}
function backToShelf() {
  stopCam();
  stopLevel();
  freeGate();
  stopVoice();
  show('scr-shelf', { title: 'Shelf', back: goHome });
  renderShelf();
}
async function renderShelf() {
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];
  const sh = curShelf;
  const photos = await photosFor(sh.id);
  $('#shelfHdr').textContent = sh.label;
  $('#shelfSub').textContent = photos.length
    ? `${photos.length} frame${photos.length === 1 ? '' : 's'} · tap one to view`
    : 'No photo yet';
  $('#shelfTip').classList.toggle('hidden', photos.length > 0);
  const grid = $('#frameGrid');
  grid.innerHTML = '';
  for (const p of photos) {
    const b = document.createElement('button');
    b.className = 'frame';
    const url = URL.createObjectURL(p.blob);
    thumbUrls.push(url);
    b.innerHTML = `<img alt="Frame ${p.n}" src="${url}"><span class="n">${p.n}</span>`;
    b.onclick = () => openViewer(p);
    grid.appendChild(b);
  }
  $('#btnShoot').textContent = photos.length ? '＋ Another frame (a wider shelf)' : '📷 Take the shelf photo';
  $('#btnShoot').className = photos.length ? 'secondary' : 'primary';
  $$('#chips .chip').forEach(c => c.classList.toggle('on', (sh.chips || []).includes(c.dataset.chip)));
  $('#inShelfNote').value = sh.note || '';
  $('#inCount').value = sh.count == null ? '' : String(sh.count);
  $('#btnNoteVoice').classList.toggle('hidden', !SpeechRec);
  const up = uploadActive(sh);
  $('#btnUpload').disabled = !photos.length || up;
  $('#btnUpload').textContent = up ? uploadLabel(sh) : '☁ Upload to Google Drive';
  $('#btnNext').disabled = !photos.length;
}
$('#btnShoot').onclick = () => openCamera();
$$('#chips .chip').forEach(c => c.onclick = async () => {
  const set = new Set(curShelf.chips || []);
  if (set.has(c.dataset.chip)) set.delete(c.dataset.chip); else set.add(c.dataset.chip);
  curShelf.chips = CHIPS.filter(x => set.has(x));
  c.classList.toggle('on', set.has(c.dataset.chip));
  await dbPut('shelves', curShelf);
});
$('#inShelfNote').onchange = async () => {
  curShelf.note = $('#inShelfNote').value.trim();
  await dbPut('shelves', curShelf);
};
$('#inCount').onchange = async () => {
  const v = $('#inCount').value.trim();
  curShelf.count = v === '' ? null : Math.max(0, Math.round(Number(v)) || 0);
  await dbPut('shelves', curShelf);
};
$('#btnNoteVoice').onclick = () => beginDictation('#inShelfNote', '#btnNoteVoice', voiceToNote);
$('#btnDeleteShelf').onclick = () => deleteShelf(curShelf.id);
// Finish this shelf and open the next one with the label already bumped. If a
// fresh sign-in is on hand the finished shelf is queued for upload on the way,
// so a run of shelves goes up while the next one is being shot.
$('#btnNext').onclick = async () => {
  await finishShelf(curShelf);
  if (tokenFresh() && !uploadActive(curShelf)) {
    await queueShelf(curShelf);
    pumpUploads();
  }
  $('#btnNew').onclick();
};
async function finishShelf(sh) {
  sh.note = $('#inShelfNote').value.trim();
  if (!sh.finishedAt) sh.finishedAt = Date.now();
  await dbPut('shelves', sh);
}

/* ---------- camera ---------- */
let stream = null, track = null, imageCapture = null, curFrame = null;   // curFrame: frame number being re-shot, else null
async function openCamera(frameNo) {
  curFrame = frameNo || null;
  freeGate();
  const photos = await photosFor(curShelf.id);
  const n = curFrame || photos.length + 1;
  show('scr-camera', { title: curShelf.label, back: backToShelf });
  $('#camLabel').textContent = n > 1 || curFrame ? `${curShelf.label} · frame ${n}` : curShelf.label;
  $('#camTip').textContent = n > 1 && !curFrame
    ? '📸 Overlap the last frame by about a quarter, same distance, same height'
    : CAM_TIP;
  $('#camFallback').classList.add('hidden');
  await startCam();
  startLevel();   // after the tap: iOS only grants motion access from a user gesture
}
async function startCam() {
  stopCam();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return camFail('The camera needs a secure (https) address. You can still import a photo taken with the camera app.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
  } catch (e) {
    return camFail('Camera unavailable or permission denied. You can still import a photo taken with the camera app.');
  }
  const v = $('#video');
  v.srcObject = stream;
  try { await v.play(); } catch {}
  track = stream.getVideoTracks()[0];
  imageCapture = ('ImageCapture' in window) ? new ImageCapture(track) : null;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  // Flash off, always: a shelf photo with the torch on is a row of glare.
  if (caps.torch) track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
  const zoomEl = $('#zoom');
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoomEl.min = caps.zoom.min;
    zoomEl.max = caps.zoom.max;
    zoomEl.step = caps.zoom.step || 0.1;
    zoomEl.value = (track.getSettings && track.getSettings().zoom) || caps.zoom.min;
    $('#zoomRow').classList.remove('hidden');
  } else {
    $('#zoomRow').classList.add('hidden');
  }
  const modes = caps.focusMode || [];
  if (modes.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
}
function refocus() {
  if (!track) return;
  const modes = (track.getCapabilities && track.getCapabilities().focusMode) || [];
  if (modes.includes('single-shot')) {
    track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }).catch(() => {});
  } else if (modes.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
}
function stopCam() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null; track = null; imageCapture = null;
  }
}
function camFail(msg) {
  $('#camFallback').classList.remove('hidden');
  $('#camFallbackMsg').textContent = msg;
}
$('#zoom').oninput = e => {
  if (track) track.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] }).catch(() => {});
};
$('#zoom').onchange = () => refocus();
$('#btnSnap').onclick = snap;
$('#btnImport').onclick = () => $('#fileInput').click();
$('#btnImport2').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    openGate(bmp);
  } catch {
    toast('Could not read that image');
  }
};
// A blank capture (all-black / uniform frame) sometimes comes back from
// takePhoto() or a not-yet-ready video frame. Uniform frames have ~zero
// luminance variance; a real photo carries texture, so this never rejects a
// genuinely dark shot.
function isBlankFrame(bmp) {
  try {
    const n = 32;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0, n, n);
    const d = cx.getImageData(0, 0, n, n).data;
    let sum = 0, sum2 = 0;
    const cnt = n * n;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += l; sum2 += l * l;
    }
    const variance = sum2 / cnt - (sum / cnt) ** 2;
    return variance < 6;
  } catch { return false; }   // never block a capture on a measurement error
}
async function snap() {
  let bmp = null;
  if (imageCapture && imageCapture.takePhoto) {
    try {
      const blob = await Promise.race([
        imageCapture.takePhoto(),
        new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 3000)),
      ]);
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {}
  }
  // a blank takePhoto result falls through to the live video frame below
  if (bmp && isBlankFrame(bmp)) { if (bmp.close) bmp.close(); bmp = null; }
  if (!bmp) {
    const v = $('#video');
    if (!v.videoWidth) return toast('Camera not ready');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    bmp = await createImageBitmap(c);
    if (isBlankFrame(bmp)) {
      if (bmp.close) bmp.close();
      return toast('Camera returned a blank frame — hold steady and snap again', 3000);
    }
  }
  openGate(bmp);
}

/* ---------- level line ----------
 *
 * The one thing the read cannot fix afterwards is a shelf shot on a tilt: the
 * spines lean, the card leans, and the crops come out as parallelograms. So
 * the viewfinder shows where level is. Gravity's direction in the screen plane
 * comes from devicemotion; folded to the nearest quarter turn it works the
 * same whether the phone is held upright or sideways. Green within 1.5°.
 * The forward/back lean is shown as a number; a shelf shot from below or
 * above is foreshortened, and the client should know before they tap.
 */
let levelHandler = null;
async function startLevel() {
  const wrap = $('#levelWrap');
  wrap.classList.add('hidden');
  if (typeof DeviceMotionEvent === 'undefined') return;
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') return;
    }
  } catch { return; }
  stopLevel();
  let shown = false;
  levelHandler = e => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    const theta = Math.atan2(g.x, g.y) * 180 / Math.PI;      // gravity's angle in the screen plane
    let dev = ((theta % 90) + 90) % 90;                       // fold to the nearest quarter turn…
    if (dev >= 45) dev -= 90;                                 // …→ [-45, 45): 0 = level, either way up
    const pitch = Math.atan2(g.z || 0, Math.hypot(g.x, g.y)) * 180 / Math.PI;
    const line = $('#levelLine'), txt = $('#levelText');
    line.style.transform = `rotate(${(-dev).toFixed(1)}deg)`;
    const okRoll = Math.abs(dev) <= 1.5, okPitch = Math.abs(pitch) <= 5;
    line.classList.toggle('ok', okRoll);
    txt.classList.toggle('ok', okRoll && okPitch);
    txt.textContent = okRoll && okPitch ? 'Level ✓'
      : !okRoll ? `Tilt ${Math.abs(dev).toFixed(0)}° — straighten`
      : `Lean ${Math.abs(pitch).toFixed(0)}° — stand square`;
    if (!shown) { shown = true; wrap.classList.remove('hidden'); }
  };
  window.addEventListener('devicemotion', levelHandler);
}
function stopLevel() {
  if (levelHandler) window.removeEventListener('devicemotion', levelHandler);
  levelHandler = null;
  const wrap = $('#levelWrap');
  if (wrap) wrap.classList.add('hidden');
}

/* ---------- legibility gate ----------
 *
 * The one gate that matters: an unreadable shelf photo costs a return visit.
 * Before the frame is accepted the whole photo is shown with a 3× loupe the
 * client drags over the smallest spine. No crop, no straightening — the read
 * wants the whole frame exactly as shot, at full resolution.
 */
const LOUPE_ZOOM = 3;
let gate = { bmp: null, scale: 1, dpr: 1, loupe: null, drag: false };
function freeGate() {
  if (gate.bmp && gate.bmp.close) gate.bmp.close();
  gate = { bmp: null, scale: 1, dpr: 1, loupe: null, drag: false };
}
function openGate(bmp) {
  stopCam();
  stopLevel();
  freeGate();
  gate.bmp = bmp;
  gate.loupe = { x: bmp.width / 2, y: bmp.height / 2 };
  show('scr-gate', { title: 'Can you read it?', back: () => openCamera(curFrame) });
  layoutGate();
}
function layoutGate() {
  const gc = $('#gateCanvas'), wrap = $('#gateWrap');
  if (!gate.bmp) return;
  const bw = gate.bmp.width, bh = gate.bmp.height;
  const maxW = wrap.clientWidth, maxH = wrap.clientHeight;
  gate.scale = Math.min(maxW / bw, maxH / bh);
  gate.dpr = Math.min(window.devicePixelRatio || 1, 2);
  gc.style.width = Math.round(bw * gate.scale) + 'px';
  gc.style.height = Math.round(bh * gate.scale) + 'px';
  gc.width = Math.round(bw * gate.scale * gate.dpr);
  gc.height = Math.round(bh * gate.scale * gate.dpr);
  drawGate();
}
function drawGate() {
  const gc = $('#gateCanvas');
  if (!gate.bmp) return;
  const ctx = gc.getContext('2d');
  const s = gate.scale * gate.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, gc.width, gc.height);
  ctx.drawImage(gate.bmp, 0, 0, gc.width, gc.height);
  const L = gate.loupe;
  if (!L) return;
  const dpr = gate.dpr;
  // big loupe: reading is the point, and the finger is under it
  const R = Math.min(gc.width, gc.height) * 0.28;
  const cx = L.x * s, cy = L.y * s;
  const k = s * LOUPE_ZOOM;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#0d0d0d';
  ctx.fill();
  ctx.clip();
  ctx.setTransform(k, 0, 0, k, cx - L.x * k, cy - L.y * k);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(gate.bmp, 0, 0);
  ctx.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.lineWidth = 4 * dpr;
  ctx.stroke();
  ctx.strokeStyle = '#d9a441';
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
  ctx.restore();
}
const gc = $('#gateCanvas');
function gatePoint(e) {
  const r = gc.getBoundingClientRect();
  const w = gate.bmp.width, h = gate.bmp.height;
  return {
    x: Math.max(0, Math.min(w, (e.clientX - r.left) / gate.scale)),
    y: Math.max(0, Math.min(h, (e.clientY - r.top) / gate.scale)),
  };
}
gc.addEventListener('pointerdown', e => {
  if (!gate.bmp) return;
  gate.drag = true;
  gate.loupe = gatePoint(e);
  gc.setPointerCapture(e.pointerId);
  e.preventDefault();
  drawGate();
});
gc.addEventListener('pointermove', e => {
  if (!gate.drag || !gate.bmp) return;
  gate.loupe = gatePoint(e);
  drawGate();
});
gc.addEventListener('pointerup', () => { gate.drag = false; });
gc.addEventListener('pointercancel', () => { gate.drag = false; });
window.addEventListener('resize', () => { if ($('#scr-gate').classList.contains('active')) layoutGate(); });
$('#btnReshoot').onclick = () => openCamera(curFrame);
$('#btnKeep').onclick = keepFrame;
// Full resolution, no crop, no level: the frame is re-encoded from the
// oriented bitmap so the file needs no EXIF rotation to read right, and at
// the highest quality the client chose. A spine's publisher line is 10 px tall.
async function keepFrame() {
  if (!gate.bmp) return;
  const btn = $('#btnKeep');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  await new Promise(r => setTimeout(r, 40));
  try {
    const bmp = gate.bmp;
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((res, rej) =>
      c.toBlob(b => b ? res(b) : rej(new Error('JPEG encode failed')), 'image/jpeg', settings.quality || 0.95));
    const photos = await photosFor(curShelf.id);
    const n = curFrame || (photos.length ? photos[photos.length - 1].n + 1 : 1);
    await dbPut('photos', { shelfId: curShelf.id, n, blob, w: bmp.width, h: bmp.height, when: Date.now() });
    curShelf.finishedAt = null;   // a new frame reopens the shelf
    await dbPut('shelves', curShelf);
    backToShelf();
    toast(`Frame ${n} saved ✓`);
  } catch (e) {
    console.error(e);
    toast('Save failed: ' + e.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Yes — keep';
  }
}

/* ---------- viewer ---------- */
let viewPhoto = null, viewerUrl = null;
function openViewer(p) {
  viewPhoto = p;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(p.blob);
  $('#viewerImg').src = viewerUrl;
  $('#viewerName').textContent = `${curShelf.label} · frame ${p.n} · ${p.w}×${p.h}`;
  show('scr-viewer', { title: `Frame ${p.n}`, back: backToShelf });
}
$('#btnVRetake').onclick = () => openCamera(viewPhoto.n);
$('#btnVDelete').onclick = async () => {
  if (!confirm('Delete this frame?')) return;
  await dbDel('photos', [curShelf.id, viewPhoto.n]);
  backToShelf();
};

/* ---------- voice dictation ---------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let speech = null;
// Free-text dictation (labels, notes): keep the words the engine heard, tidy
// the spacing. Labels get Sentence case so a lowercased result still reads right.
function voiceToText(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
function voiceToNote(s) { return String(s).replace(/\s+/g, ' ').trim(); }
let voiceMap = voiceToText;         // active mapper — set per field when dictation starts
let voiceFieldSel = '#inLabel';     // the input/textarea dictation fills
let voiceBtnSel = '#btnLabelVoice'; // the button whose label reflects dictation state
let voiceWant = false;    // the user wants the mic open — survives the per-utterance restarts
let voiceBase = '';       // text already committed to the box; the live interim guess is painted on top
let voiceLastStart = 0;   // for the runaway-restart guard below
let voiceRestarts = 0;
let voiceProgress = false; // did the session that just ended actually commit any speech?
function paintVoice(interim) {
  const ta = $(voiceFieldSel);
  if (!ta) return;
  const iv = interim ? voiceMap(interim) : '';
  ta.value = voiceBase + (iv ? (voiceBase ? ' ' : '') + iv : '');
}
// Full teardown. Other screens call this to cancel dictation on navigation, so it must
// be a no-op on the text box unless a session was actually running.
function stopVoice() {
  const wasActive = voiceWant || !!speech;
  voiceWant = false;
  if (speech) { const s = speech; speech = null; s.onend = null; try { s.stop(); } catch (e) {} }
  if (wasActive) paintVoice('');   // drop any half-heard interim guess, keep the committed text
  const b = $(voiceBtnSel);
  if (b) { b.classList.remove('listening'); b.textContent = b.dataset.idle || '🎤 Dictate'; }
}
function startVoiceSession() {
  const rec = new SpeechRec();
  rec.lang = navigator.language || 'en-US';
  // NOT continuous: in continuous mode mobile Chrome re-emits the whole
  // utterance as a fresh final entry over and over. One utterance per session
  // means exactly one final; restartVoice() reopens the mic after each.
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 3;
  let committed = 0;
  const ready = () => { if (speech === rec && voiceWant) { const b = $(voiceBtnSel); if (b) b.textContent = '🎤 Listening… tap to stop'; } };
  rec.onaudiostart = ready;
  rec.onstart = ready;
  rec.onresult = e => {
    ready();
    let intr = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        if (i >= committed) {
          const mf = voiceMap(r[0].transcript);
          if (mf) { voiceBase = (voiceBase ? voiceBase + ' ' : '') + mf; voiceProgress = true; }
          committed = i + 1;
        }
      } else {
        intr += ' ' + r[0].transcript;
      }
    }
    paintVoice(intr);
  };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      voiceWant = false;
      toast('Microphone blocked — allow mic access for this site in your browser settings', 4200);
    } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
      toast('Dictation error: ' + e.error, 3500);
    }
  };
  rec.onend = () => {
    if (speech !== rec) return;
    speech = null;
    if (voiceWant) restartVoice(); else stopVoice();
  };
  speech = rec;
  voiceLastStart = Date.now();
  voiceProgress = false;
  try { rec.start(); } catch (e) { stopVoice(); }
}
function restartVoice() {
  if (voiceProgress) {
    voiceRestarts = 0;
  } else {
    const now = Date.now();
    voiceRestarts = (now - voiceLastStart < 1200) ? voiceRestarts + 1 : 0;
    if (voiceRestarts > 8) { toast('Dictation stopped listening', 2500); return stopVoice(); }
  }
  setTimeout(() => { if (voiceWant) startVoiceSession(); }, 250);
}
function beginDictation(fieldSel, btnSel, mapper) {
  if (voiceWant || speech) return stopVoice();   // any tap while listening = stop
  if (!SpeechRec) return;
  voiceFieldSel = fieldSel;
  voiceBtnSel = btnSel;
  voiceMap = mapper;
  const ta = $(fieldSel);
  voiceBase = ta && ta.value.trim() ? ta.value.trim() : '';
  voiceWant = true;
  voiceRestarts = 0;
  const b = $(btnSel);
  b.classList.add('listening');
  b.textContent = '🎤 Starting…';
  startVoiceSession();
}
$('#btnLabelVoice').onclick = () => beginDictation('#inLabel', '#btnLabelVoice', voiceToText);

/* ---------- Google Drive ---------- */
let gsiLoaded = null;
let tokenInfo = { token: null, exp: 0 };
function loadGsi() {
  return gsiLoaded || (gsiLoaded = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => { gsiLoaded = null; rej(new Error('Could not load Google sign-in (offline?)')); };
    document.head.appendChild(s);
  }));
}
async function getToken() {
  if (!cred('clientId')) throw new Error('This build has no Google Client ID yet — add one in Settings');
  if (tokenInfo.token && Date.now() < tokenInfo.exp - 60000) return tokenInfo.token;
  await loadGsi();
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: cred('clientId'),
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: r => {
        if (r.access_token) {
          tokenInfo = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
          res(r.access_token);
        } else {
          rej(new Error(r.error || 'Sign-in failed'));
        }
      },
      error_callback: e => rej(new Error(e.message || e.type || 'Sign-in cancelled')),
    });
    tc.requestAccessToken();
  });
}
async function drive(url, opts = {}) {
  const token = await getToken();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error('Drive error ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}
function qEsc(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
async function findFolder(name, parent) {
  const q = `name='${qEsc(name)}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`;
  const r = await drive('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id)');
  return (r.files && r.files.length) ? r.files[0].id : null;
}
async function findOrCreateFolder(name, parent) {
  const found = await findFolder(name, parent);
  if (found) return found;
  const made = await drive('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  });
  return made.id;
}
// Create or replace one file in a folder, by name: find-then-PATCH-or-POST, so
// a re-shot frame replaces its file and an interrupted upload is safe to rerun.
async function uploadFile(folder, name, mime, blob) {
  const q = `name='${qEsc(name)}' and '${folder}' in parents and trashed=false`;
  const existing = await drive('https://www.googleapis.com/drive/v3/files?q=' +
    encodeURIComponent(q) + '&fields=files(id)');
  if (existing.files && existing.files.length) {
    return drive(`https://www.googleapis.com/upload/drive/v3/files/${existing.files[0].id}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': mime },
      body: blob,
    });
  }
  const boundary = 'bookcurator' + Date.now();
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name, parents: [folder] }),
    `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  return drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body,
  });
}
// The shelf's own record of what it is, written into its Drive folder LAST so a
// manifest only ever describes a folder whose photos arrived. The importer reads
// this, never the folder name. Timing fields feed the shelves-per-hour report.
async function writeShelfManifest(folder, sh, photos) {
  const started = sh.startedAt || sh.created, finished = sh.finishedAt || Date.now();
  const manifest = {
    bookCurator: 1,
    kind: 'shelf',
    appShelfId: sh.id,
    label: sh.label,
    photos: photos.map(p => ({ file: pad2(p.n) + '.jpg', w: p.w, h: p.h })),
    chips: sh.chips || [],
    note: sh.note || '',
    count: sh.count == null ? null : sh.count,
    operator: sh.operator || settings.operator || '',
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    captureMinutes: Math.round((finished - started) / 6000) / 10,
    app: APP_VERSION,
    updated: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  await uploadFile(folder, 'shelf.json', 'application/json', blob);
}

/* ---------- Google Picker: point the app at an EXISTING Drive folder ----------
 * Under drive.file the app sees only folders it created itself, so a folder
 * made by hand or shared with the client is invisible to findFolder(). Picking
 * it in the Google Picker grants access. Needs an API key and the project
 * NUMBER from the same Cloud project as the Client ID. */
let pickerLoaded = null;
function loadPicker() {
  return pickerLoaded || (pickerLoaded = new Promise((res, rej) => {
    const fail = () => { pickerLoaded = null; rej(new Error('Could not load the Google folder picker (offline?)')); };
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = () => gapi.load('picker', { callback: res, onerror: fail });
    s.onerror = fail;
    document.head.appendChild(s);
  }));
}
function pickerReady() { return !!(cred('clientId') && cred('apiKey') && cred('projectNumber')); }
async function pickFolder() {
  if (!pickerReady())
    throw new Error('Linking needs the API key and project number in Settings, not just the Client ID');
  const token = await getToken();
  await loadPicker();
  return new Promise(res => {
    const folderView = mine => {
      const v = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true);
      if (google.picker.DocsViewMode && google.picker.DocsViewMode.LIST) v.setMode(google.picker.DocsViewMode.LIST);
      if (!mine && typeof v.setOwnedByMe === 'function') { v.setOwnedByMe(false); v.setLabel('Shared with me'); }
      return v;
    };
    const picker = new google.picker.PickerBuilder()
      .setTitle('Open a folder to check what is in it, then select it')
      .setDeveloperKey(cred('apiKey'))
      .setAppId(cred('projectNumber'))
      .setOAuthToken(token)
      .addView(folderView(true))
      .addView(folderView(false))
      .setCallback(d => {
        if (d.action === google.picker.Action.PICKED) {
          const doc = d.docs && d.docs[0];
          res(doc ? { id: doc.id, name: doc.name } : null);
        } else if (d.action === google.picker.Action.CANCEL) {
          res(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
// The client-side root: the linked folder when one was picked, otherwise
// find-or-create "Book Curator" at the top of My Drive. Never "Vinyl Curator";
// the two importers must never see each other's folders.
async function resolveRootFolder() {
  const id = settings.driveFolderId;
  if (!id) return findOrCreateFolder(settings.driveFolder || 'Book Curator', 'root');
  try {
    const f = await drive('https://www.googleapis.com/drive/v3/files/' + id + '?fields=id,trashed');
    if (f && f.id && !f.trashed) return f.id;
  } catch (e) {
    // deleted, unshared, or access revoked - handled below
  }
  // Deliberately NOT falling back to creating the folder by name: an invisible
  // duplicate of the shared folder is the exact failure linking exists to stop.
  throw new Error('The linked Drive folder can’t be opened — re-link it in ⚙ Settings.');
}

/* ---------- automatic sharing ----------
 * Asking a client to get Drive sharing right by hand is the step most likely to
 * go wrong, so the first upload offers to share the root folder, read-only, with
 * the curator; every sub-folder inherits it. Best-effort: a refusal or failure
 * must never cost the client their upload, so this reports and returns. */
async function shareFolder(folderId, folderName, st) {
  const email = cred('shareWith');
  if (!email) return;
  const seen = (await dbGet('kv', 'sharedFolders')) || {};
  if (seen[folderId]) return;          // already handled, or already declined
  try {
    if (st) st(`Checking folder sharing…`);
    const perms = await drive('https://www.googleapis.com/drive/v3/files/' + folderId +
      '/permissions?fields=permissions(emailAddress)');
    const already = (perms.permissions || [])
      .some(p => String(p.emailAddress || '').toLowerCase() === email.toLowerCase());
    if (!already) {
      const ok = confirm(
        'Share “' + folderName + '” with ' + email + '?\n\n' +
        'Your shelf photos are saved into this folder in your own Google Drive. ' +
        'Sharing it read-only lets the curator read them without you sending anything — ' +
        'otherwise they stay where only you can see them.\n\n' +
        'You stay the owner. Nothing else in your Drive is shared, and you can ' +
        'stop sharing at any time from Drive itself.');
      if (!ok) {
        seen[folderId] = 'declined';
        await dbPut('kv', seen, 'sharedFolders');
        toast('Not shared — the folder stays private to you', 4500);
        return;
      }
      // No email anywhere in the flow (owner, 8 Sep 2026): the curator finds the
      // folder under "Shared with me" and the sheet importer reads it from there.
      await drive('https://www.googleapis.com/drive/v3/files/' + folderId +
        '/permissions?sendNotificationEmail=false&fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: email }),
      });
      toast('Shared “' + folderName + '” with ' + email + ' ✓', 4000);
    }
    seen[folderId] = Date.now();
    await dbPut('kv', seen, 'sharedFolders');
  } catch (e) {
    console.error(e);
    toast('Couldn’t set up sharing on this folder — the upload continues', 4500);
  }
}

/* ---------- upload queue ----------
 *
 * A shelf's upload record lives on the shelf itself (shelf.upload), so the home
 * list is the queue:
 *   queued    -> waiting its turn (the Drive folders are resolved by the worker)
 *   uploading -> frames going up; done/total count
 *   paused    -> the Google token ran out and renewing it needs a tap
 *   failed    -> stopped with an error; retry from the home card
 * Finishing writes shelf.json LAST, then the uploaded stamp. The queue drains
 * while the app is open on any screen and resumes on the next open; files that
 * went up already are replaced in place, so an interrupted shelf is safe to rerun.
 *
 * Unlike the vinyl app there is no folder question to ask the client: two
 * shelves with the same label simply become "<label>" and "<label> (2)". The
 * sheet identifies a shelf by its first photo's Drive file id, never its name.
 */
const UPLOAD_PARALLEL = 2;
let uploadPumpRunning = false;
let rootCache = null;   // { id, name } once resolved this session

function uploadActive(sh) {
  return !!(sh && sh.upload && /^(queued|uploading|paused)$/.test(sh.upload.state));
}
function uploadLabel(sh) {
  const u = sh.upload;
  if (!u) return '';
  if (u.state === 'queued') return '⏳ Waiting to upload';
  if (u.state === 'uploading') return `☁ Uploading ${u.done}/${u.total}…`;
  if (u.state === 'paused') return '⏸ Upload paused — sign in below to continue';
  if (u.state === 'failed') return '⚠ Upload failed — ' + (u.error || 'tap ↻ to retry');
  return '';
}
// A token with less than two minutes left is not worth starting a file on:
// renewing one opens Google's sign-in, which only a tap may do.
function tokenFresh() {
  return !!(tokenInfo.token && Date.now() < tokenInfo.exp - 120000);
}
async function uploadQueue() {
  return (await dbAll('shelves'))
    .filter(s => s.upload && /^(queued|uploading|paused)$/.test(s.upload.state))
    .sort((a, b) => (a.upload.queued || 0) - (b.upload.queued || 0));
}
async function setUpload(sh, patch) {
  Object.assign(sh.upload, patch);
  await dbPut('shelves', sh);
  if (curShelf && curShelf.id === sh.id) curShelf.upload = sh.upload;
  refreshUploadCards();
}
async function queueShelf(sh) {
  const photos = await photosFor(sh.id);
  if (!photos.length) return false;
  if (!sh.finishedAt) sh.finishedAt = Date.now();
  sh.upload = { state: 'queued', done: 0, total: photos.length + 1, queued: Date.now(), error: '' };
  await dbPut('shelves', sh);
  if (curShelf && curShelf.id === sh.id) curShelf = sh;
  return true;
}
// Sign in, resolve and share the root (the only part that needs the client),
// then queue. Everything else happens in the worker while they carry on.
async function prepareUpload(st) {
  if (!cred('clientId')) throw new Error('This build has no Google Client ID yet — add one in ⚙ Settings');
  st('Signing in to Google…');
  await getToken();
  st('Finding your Book Curator folder…');
  const id = await resolveRootFolder();
  const name = settings.driveFolder || 'Book Curator';
  rootCache = { id, name };
  await shareFolder(id, name, st);
  return rootCache;
}
async function pumpUploads() {
  if (uploadPumpRunning) return;
  uploadPumpRunning = true;
  try {
    for (;;) {
      const queue = await uploadQueue();
      if (!queue.length) break;
      if (!tokenFresh()) {
        for (const sh of queue) if (sh.upload.state !== 'paused') await setUpload(sh, { state: 'paused' });
        refreshUploadCards();
        break;
      }
      const sh = queue[0];
      await uploadShelf(sh);
      if (sh.upload && sh.upload.state === 'paused') break;
    }
  } finally {
    uploadPumpRunning = false;
    refreshUploadCards();
  }
}
async function shelfFolderFor(sh, shelvesFolder) {
  if (sh.driveFolderId) {
    try {
      const f = await drive('https://www.googleapis.com/drive/v3/files/' + sh.driveFolderId + '?fields=id,name,trashed');
      if (f && f.id && !f.trashed) return { id: f.id, name: f.name };
    } catch (e) { /* deleted or unreachable - make a new one */ }
  }
  const base = sanitize(sh.label) || 'Shelf';
  let name = base;
  for (let n = 2; n < 100 && await findFolder(name, shelvesFolder); n++) name = `${base} (${n})`;
  return { id: await findOrCreateFolder(name, shelvesFolder), name };
}
async function uploadShelf(sh) {
  try {
    const photos = await photosFor(sh.id);
    if (!photos.length) throw new Error('Nothing to upload — no photos saved');
    await setUpload(sh, { state: 'uploading', done: 0, total: photos.length + 1, error: '' });
    if (!rootCache) rootCache = { id: await resolveRootFolder(), name: settings.driveFolder || 'Book Curator' };
    const shelvesFolder = await findOrCreateFolder(SHELVES_FOLDER, rootCache.id);
    const folder = await shelfFolderFor(sh, shelvesFolder);
    sh.driveFolderId = folder.id;
    sh.driveFolderName = folder.name;
    await dbPut('shelves', sh);
    let next = 0, failed = null, paused = false;
    const worker = async () => {
      while (next < photos.length && !failed && !paused) {
        if (!tokenFresh()) { paused = true; break; }
        const p = photos[next++];
        try {
          await uploadFile(folder.id, pad2(p.n) + '.jpg', 'image/jpeg', p.blob);
          await setUpload(sh, { done: sh.upload.done + 1 });
        } catch (e) { failed = e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, photos.length) }, worker));
    if (failed) throw failed;
    if (paused) { await setUpload(sh, { state: 'paused' }); return; }
    await writeShelfManifest(folder.id, sh, photos);
    await setUpload(sh, { done: photos.length + 1 });
    sh.uploaded = Date.now();
    delete sh.upload;
    await dbPut('shelves', sh);
    if (curShelf && curShelf.id === sh.id) curShelf = sh;
    toast(`Uploaded “${sh.label}” ✓ (${photos.length} photo${photos.length === 1 ? '' : 's'})`, 3600);
    if ($('#scr-home').classList.contains('active')) goHome();
  } catch (e) {
    console.error('upload', sh.id, e);
    const msg = String(e && e.message || e);
    // A refused or cancelled sign-in mid-run is a pause, not a failure.
    if (/sign-in|token|401/i.test(msg)) { await setUpload(sh, { state: 'paused' }); return; }
    await setUpload(sh, { state: 'failed', error: msg.slice(0, 120) });
  }
}
// Repaint the status line on every home card that carries an upload record,
// without rebuilding the list.
function refreshUploadCards() {
  if ($('#scr-shelf').classList.contains('active') && curShelf) {
    const up = uploadActive(curShelf);
    $('#btnUpload').disabled = up || $('#btnNext').disabled;
    $('#btnUpload').textContent = up ? uploadLabel(curShelf) : '☁ Upload to Google Drive';
  }
  if (!$('#scr-home').classList.contains('active')) return;
  (async () => {
    const shelves = await dbAll('shelves');
    const byId = Object.fromEntries(shelves.map(s => [s.id, s]));
    $$('#shelfList .shelfcard[data-shelf]').forEach(card => {
      const sh = byId[card.dataset.shelf];
      const line = card.querySelector('.sh-up');
      if (!sh || !line) return;
      const text = uploadLabel(sh);
      line.textContent = text;
      line.className = 'sh-up' + (sh.upload ? ' ' + sh.upload.state : '');
      line.classList.toggle('hidden', !text);
      card.querySelector('.sh-del').classList.toggle('hidden', !!(sh.upload && sh.upload.state === 'uploading'));
      card.querySelector('.sh-retry').classList.toggle('hidden', !(sh.upload && sh.upload.state === 'failed'));
    });
    const waiting = shelves.filter(s => s.upload && s.upload.state === 'paused').length;
    const btn = $('#btnUploadSignin');
    btn.classList.toggle('hidden', !waiting);
    btn.textContent = `Sign in to continue ${waiting} upload${waiting === 1 ? '' : 's'}`;
  })();
}
$('#btnUpload').onclick = async () => {
  if (uploadActive(curShelf)) return;
  const btn = $('#btnUpload');
  btn.disabled = true;
  try {
    await finishShelf(curShelf);
    await prepareUpload(t => { btn.textContent = t; });
    await queueShelf(curShelf);
    toast('Queued — uploading while you carry on', 3000);
    goHome();
    pumpUploads();
  } catch (e) {
    console.error(e);
    toast(e.message, 4500);
    btn.disabled = false;
    btn.textContent = '☁ Upload to Google Drive';
  }
};
// One sign-in, every finished shelf queued: the estate flow is shoot forty
// shelves, then upload them all at the kitchen table.
$('#btnUploadAll').onclick = async () => {
  const btn = $('#btnUploadAll');
  btn.disabled = true;
  try {
    await prepareUpload(t => { btn.textContent = t; });
    let n = 0;
    for (const sh of await dbAll('shelves')) {
      if (sh.uploaded || sh.upload) continue;
      if (await queueShelf(sh)) n++;
    }
    toast(`Queued ${n} shelf${n === 1 ? '' : 'ves'} — uploading while you carry on`, 3200);
    goHome();
    pumpUploads();
  } catch (e) {
    console.error(e);
    toast(e.message, 4500);
    goHome();
  } finally {
    btn.disabled = false;
  }
};
$('#btnUploadSignin').onclick = async () => {
  try {
    await getToken();                       // a tap: Google's sign-in may open
    for (const sh of await uploadQueue())
      if (sh.upload.state === 'paused') await setUpload(sh, { state: 'queued' });
    pumpUploads();
  } catch (e) { toast(e.message, 4000); }
};
// Resume on open and on every return to the foreground; without a fresh token
// the pump marks the shelves paused and the home screen offers the sign-in.
document.addEventListener('visibilitychange', () => { if (!document.hidden) pumpUploads(); });

/* ---------- uploaded shelves ---------- */
$('#btnArchive').onclick = () => openArchive();
async function openArchive() {
  show('scr-archive', { title: 'Uploaded shelves', back: goHome });
  const list = $('#arcList');
  list.innerHTML = '';
  const done = (await dbAll('shelves')).filter(s => s.uploaded).sort((a, b) => b.uploaded - a.uploaded);
  $('#arcStatus').textContent = done.length
    ? 'These are in your Google Drive under Book Curator / _Shelves. The photos are still on this phone until you delete them.'
    : 'Nothing uploaded yet.';
  for (const sh of done) {
    const photos = await photosFor(sh.id);
    const row = document.createElement('div');
    row.className = 'shelfcard';
    row.innerHTML =
      `<button class="sh-open"><div class="sh-label">${esc(sh.label)}</div>` +
      `<div class="sh-meta">☁ ${esc(sh.driveFolderName || sh.label)} · ${photos.length} photo${photos.length === 1 ? '' : 's'} · ${new Date(sh.uploaded).toLocaleDateString()}</div></button>` +
      `<button class="sh-retry" aria-label="Move back to home screen">↩</button>` +
      `<button class="sh-del" aria-label="Delete from phone">🗑</button>`;
    row.querySelector('.sh-open').onclick = () => openShelf(sh.id);
    row.querySelector('.sh-retry').onclick = async () => {
      delete sh.uploaded;
      await dbPut('shelves', sh);
      toast('Shelf is back on the home screen — re-upload when done');
      goHome();
    };
    row.querySelector('.sh-del').onclick = async () => {
      if (!confirm(`Delete "${sh.label}" from this phone? It stays in your Google Drive.`)) return;
      for (const p of photos) await dbDel('photos', [sh.id, p.n]);
      await dbDel('shelves', sh.id);
      openArchive();
    };
    list.appendChild(row);
  }
}

/* ---------- settings ---------- */
function openSettings() {
  $('#inOperator2').value = settings.operator || '';
  $('#inClientId').value = settings.clientId;
  $('#inApiKey').value = settings.apiKey;
  $('#inProjectNumber').value = settings.projectNumber;
  $('#inShareWith').value = settings.shareWith;
  $('#inShareWith').placeholder = BUILTIN.shareWith || 'nobody — uploads stay private';
  $('#inClientId').placeholder = BUILTIN.clientId || 'xxxxxxxx.apps.googleusercontent.com';
  $('#builtinNote').classList.toggle('hidden', !BUILTIN.clientId);
  $('#inDriveFolder').value = settings.driveFolder || 'Book Curator';
  $('#inQuality').value = String(settings.quality || 0.95);
  renderLinkNote();
  show('scr-settings', { title: 'Settings', back: goHome });
}
function renderLinkNote() {
  $('#linkNote').textContent = settings.driveFolderId
    ? '🔗 Linked to a folder that already exists in Drive. Tap Link… to unlink.'
    : '';
  $('#btnLink').textContent = settings.driveFolderId ? 'Linked' : 'Link…';
}
// The picker needs live credentials and the owner may have only just typed
// them, so take them off the form - and keep them - before opening it.
async function syncCredsFromForm() {
  const was = [settings.clientId, settings.apiKey, settings.projectNumber].join('|');
  settings.clientId = $('#inClientId').value.trim();
  settings.apiKey = $('#inApiKey').value.trim();
  settings.projectNumber = $('#inProjectNumber').value.trim();
  if ([settings.clientId, settings.apiKey, settings.projectNumber].join('|') === was) return;
  tokenInfo = { token: null, exp: 0 };   // a different client id invalidates the old token
  await saveSettings();
}
$('#btnLink').onclick = async () => {
  if (settings.driveFolderId) {
    if (!confirm('Unlink the Drive folder? Uploads go back to a “' + (settings.driveFolder || 'Book Curator') + '” folder the app creates in My Drive.')) return;
    settings.driveFolderId = '';
    rootCache = null;
    await saveSettings();
    renderLinkNote();
    return;
  }
  try {
    await syncCredsFromForm();
    const picked = await pickFolder();
    if (!picked) return;
    settings.driveFolderId = picked.id;
    settings.driveFolder = picked.name;
    rootCache = null;
    $('#inDriveFolder').value = picked.name;
    await saveSettings();
    renderLinkNote();
    toast('Linked to “' + picked.name + '” in Drive ✓', 3600);
  } catch (e) {
    console.error(e);
    toast(e.message, 5000);
  }
};
$('#btnSaveSettings').onclick = async () => {
  settings.operator = $('#inOperator2').value.trim();
  settings.clientId = $('#inClientId').value.trim();
  settings.apiKey = $('#inApiKey').value.trim();
  settings.projectNumber = $('#inProjectNumber').value.trim();
  const shareWas = cred('shareWith');
  settings.shareWith = $('#inShareWith').value.trim();
  if (cred('shareWith') !== shareWas) await dbPut('kv', {}, 'sharedFolders');
  const folder = sanitize($('#inDriveFolder').value) || 'Book Curator';
  if (folder !== settings.driveFolder) { settings.driveFolderId = ''; rootCache = null; }
  settings.driveFolder = folder;
  settings.quality = Number($('#inQuality').value) || 0.95;
  tokenInfo = tokenInfo.token && settings.clientId === cred('clientId') ? tokenInfo : { token: null, exp: 0 };
  await saveSettings();
  toast('Settings saved');
  goHome();
};
$('#btnWipe').onclick = async () => {
  if (!confirm('Delete ALL shelves, photos, and settings stored by this app on this phone?')) return;
  await dbClear('photos');
  await dbClear('shelves');
  await dbClear('kv');
  Object.assign(settings, { clientId: '', apiKey: '', projectNumber: '', shareWith: '', operator: '', quality: 0.95, driveFolder: 'Book Curator', driveFolderId: '' });
  toast('All app data deleted');
  goHome();
};

/* ---------- install prompt ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  $('#btnInstall').classList.remove('hidden');
});
$('#btnInstall').onclick = () => {
  if (deferredPrompt) deferredPrompt.prompt();
  deferredPrompt = null;
  $('#btnInstall').classList.add('hidden');
};
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  $('#btnInstall').classList.add('hidden');
  $('#iosInstall').classList.add('hidden');
});
function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}
/* iOS never fires beforeinstallprompt — Share → Add to Home Screen is the only
   route there — so coach it instead. iPadOS reports itself as a Macintosh,
   hence the touch-points test. */
function isIOS() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
async function maybeCoachIosInstall() {
  if (!isIOS() || isStandalone()) return;
  if (await dbGet('kv', 'iosInstallDismissed')) return;
  $('#iosInstall').classList.remove('hidden');
}
$('#btnIosDismiss').onclick = async () => {
  $('#iosInstall').classList.add('hidden');
  await dbPut('kv', 1, 'iosInstallDismissed');
};

/* ---------- service worker + update prompt ---------- */
/* An installed app has no address bar and no reliable way to force a reload, so
   a new version has to announce itself. The worker waits until the user taps
   Update; skipWaiting then triggers controllerchange, and we reload once. */
let swReg = null;
let updateRequested = false;
$('#btnUpdate').onclick = () => {
  $('#btnUpdate').disabled = true;
  updateRequested = true;
  if (swReg && swReg.waiting) swReg.waiting.postMessage('SKIP_WAITING');
  else location.reload();
};
async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  // On a first-ever install the worker's clients.claim() also fires
  // controllerchange. Reload only when this page was already controlled, or
  // when the user actually asked for the update.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !(hadController || updateRequested)) return;
    reloading = true;
    location.reload();
  });
  try { swReg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }); }
  catch (e) { return; }
  const announce = () => { if (navigator.serviceWorker.controller) $('#updateBar').classList.remove('hidden'); };
  if (swReg.waiting) announce();
  swReg.addEventListener('updatefound', () => {
    const nw = swReg.installing;
    if (!nw) return;
    nw.addEventListener('statechange', () => { if (nw.state === 'installed') announce(); });
  });
  // A standalone app is resumed far more often than it is launched, so a resume
  // is our real chance to notice a new build.
  const checkForUpdate = async () => {
    if (!swReg) return;
    try { await swReg.update(); } catch (e) {}
    if (swReg.waiting) announce();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
}
async function showVersion() {
  $('#verStamp').textContent = APP_VERSION;
  if (isStandalone()) $('#verInstalled').textContent = ' — installed';
}

/* ---------- init ---------- */
(async function init() {
  await loadSettings();
  initServiceWorker();
  showVersion();
  maybeCoachIosInstall().catch(() => {});
  await goHome();
  pumpUploads();   // an interrupted queue: no token yet, so this marks it paused and shows the sign-in
})();
