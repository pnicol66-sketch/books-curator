'use strict';

/* Books Curator — phone capture app, Shelf mode and request answers.
 *
 * A separate project from Vinyl Curator; the machinery that is proven there
 * (IndexedDB store, camera, background Drive upload queue, folder sharing,
 * update bar, dictation) is copied in with the same function names so a diff
 * between the two apps stays readable. The vinyl domain (crop, matrix
 * dictation) is not here. Shelves: one labelled photo (or a few overlapping
 * frames) per shelf, checked for legibility, uploaded to the client's own Drive
 * under Books Curator/_Shelves/<label>/. Request answers: the curator asks for
 * one book off a shelf; the phone takes its jacket front and copyright page and
 * files them in a folder of their own beside _Shelves, found from the shelf's
 * folder by id, never by name.
 */

/* Build stamp — rewritten by bump-version.ps1 (and the pre-commit hook) so it
   always matches the service worker's cache name. Shown in Settings. */
const APP_VERSION = '20260924-051607';

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
const SHELF_GATE = 'Drag the loupe over the smallest spine. Can you read it?';
/* A book asked for by the curator: two photos, both required, and the copyright
   page's words, optional. The numbers are the shot numbers the sheet files by. */
const BOOK_SHOTS = [
  { id: '01', name: 'Jacket Front', label: 'Front of the jacket (or the cover if there is no jacket)',
    tip: '📸 The whole front, square on · flash off', gate: 'Drag the loupe over the title. Can you read it?' },
  { id: '12', name: 'Copyright Page', label: 'Copyright page: open the book flat at it, the whole page, square on',
    tip: '📸 Open the book flat at the copyright page · the whole page, square on · flash off',
    gate: 'Drag the loupe over the smallest print. Can you read it?' },
];
const BOOK_WORDS = { id: '13', name: 'Copyright Verbatim' };

/* ---------- IndexedDB ---------- */
let _db = null;
function openDB() {
  return new Promise((res, rej) => {
    // Version 2 adds the book stores (a Spot-check answer: its record and its
    // shots). Every store is created behind a guard and nothing existing is ever
    // touched or re-keyed: shelves live here (never clear site data).
    const r = indexedDB.open('bookcurator', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('shelves')) d.createObjectStore('shelves', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: ['shelfId', 'n'] });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('shots')) d.createObjectStore('shots', { keyPath: ['bookId', 'shotId'] });
    };
    // An older page still open in another tab holds version 1 until it closes.
    r.onblocked = () => toast('Close the other Books Curator tab, then reopen the app', 6000);
    r.onsuccess = () => {
      const d = r.result;
      // A newer version opening elsewhere: let it upgrade, and never keep using the
      // closed connection (every later read would throw).
      d.onversionchange = () => { d.close(); _db = null; toast('A newer version of the app is open - close this one and open it again', 6000); };
      res(d);
    };
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
async function shotsFor(bookId) {
  const all = await reqP((await db()).transaction('shots').objectStore('shots')
    .getAll(IDBKeyRange.bound([bookId, '00'], [bookId, '99'])));
  return all.sort((a, b) => a.shotId.localeCompare(b.shotId));
}

/* ---------- built-in Google credentials ----------
 *
 * An OAuth client id identifies THIS APP, not the person signing in, and in a
 * browser app it is public by design. Filling it in here is what keeps a client
 * out of the Cloud console entirely: they tap Upload, sign in with their own
 * Google account, allow.
 *
 * Books Curator has ITS OWN Cloud project and OAuth client (owner's decision,
 * 8 Sep 2026). Never paste the Vinyl Curator client id here: under the
 * drive.file scope an app sees only the folders created under its own client
 * id, so a client id can never be changed once a client has uploaded, and the
 * two apps must never share one. Empty until the book-curator-tools project
 * exists; Settings has a box that overrides whatever is here.
 */
const BUILTIN = {
  // Cloud project "book-curator-tools", consent screen published In production,
  // authorised JavaScript origins https://bookscurator.net, https://pnicol66-sketch.github.io
  // and http://localhost:8322 (the app moved to bookscurator.net on 14 Sep 2026)
  clientId: '991007809247-3kb4gqf2jfbghp5q34l4sp43f1087174.apps.googleusercontent.com',
  apiKey: '',         // AIza...        - only for the "Link…" picker
  projectNumber: '',  // 000000000000   - only for the "Link…" picker
  shareWith: 'pnicol66@gmail.com',
  // Where the phone asks for its curator's requests (one address for every
  // client; empty until it exists, and then the Requests card stays hidden).
  requestsUrl: '',
};

/* ---------- settings ---------- */
const settings = {
  clientId: '', apiKey: '', projectNumber: '', shareWith: '',
  operator: '', quality: 0.95,
  driveFolder: 'Books Curator', driveFolderId: '',
  requestsUrl: '',
};
// What the app should actually use: an explicit Settings entry always wins.
function cred(k) { return String(settings[k] || BUILTIN[k] || '').trim(); }
async function loadSettings() {
  const s = await dbGet('kv', 'settings');
  if (s) Object.assign(settings, s);
  if (!settings.driveFolder) settings.driveFolder = 'Books Curator';
}
async function saveSettings() { await dbPut('kv', { ...settings }, 'settings'); }

/* ---------- navigation ---------- */
let backAction = null;
function show(id, { title = 'Books Curator', back = null, gear = false } = {}) {
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
  show('scr-home', { title: 'Books Curator', gear: true });
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
  renderReqCard();
  refreshRequests();   // at most once a minute
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
// What the camera, the gate and the viewer are working on: a shelf frame
// (curShelf, curFrame) or a book shot (curBook, capT.shot).
let capT = { kind: 'shelf' };
function capBack() { return capT.kind === 'book' ? openBookCamera(capT.shot) : openCamera(curFrame); }
async function openCamera(frameNo) {
  capT = { kind: 'shelf' };
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
// A book shot: no level line (a page shot flat reads a pitch near 90 degrees);
// the loupe gate stays, it is the right check for a number line.
async function openBookCamera(shotId) {
  const s = BOOK_SHOTS.find(x => x.id === shotId);
  if (!curBook || !s) return goHome();
  if (curBook.upload && curBook.upload.state === 'uploading') return toast('Wait for the upload to finish');
  if ($('#scr-book').classList.contains('active')) await leaveBook();
  capT = { kind: 'book', shot: shotId };
  freeGate();
  stopLevel();
  show('scr-camera', { title: curBook.title || 'Book', back: backToBook });
  $('#camLabel').textContent = `${s.id} ${s.name}`;
  $('#camTip').textContent = s.tip;
  $('#camFallback').classList.add('hidden');
  await startCam();
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
  const s = capT.kind === 'book' ? BOOK_SHOTS.find(x => x.id === capT.shot) : null;
  $('#gatePrompt').textContent = s ? s.gate : SHELF_GATE;
  show('scr-gate', { title: 'Can you read it?', back: capBack });
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
$('#btnReshoot').onclick = () => capBack();
$('#btnKeep').onclick = keepFrame;
// Full resolution, no crop, no level: the frame is re-encoded from the
// oriented bitmap so the file needs no EXIF rotation to read right, and at
// the highest quality the client chose. A spine's publisher line is 10 px tall.
function gateJpeg(bmp) {
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((res, rej) =>
    c.toBlob(b => b ? res(b) : rej(new Error('JPEG encode failed')), 'image/jpeg', settings.quality || 0.95));
}
async function keepFrame() {
  if (!gate.bmp) return;
  const btn = $('#btnKeep');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  await new Promise(r => setTimeout(r, 40));
  try {
    const bmp = gate.bmp;
    const blob = await gateJpeg(bmp);
    if (capT.kind === 'book') return await keepBookShot(capT.shot, bmp, blob);
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
// A shelf frame {shelfId, n, ...} or a book shot {bookId, shotId, ...}.
function openViewer(p) {
  viewPhoto = p;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(p.blob);
  $('#viewerImg').src = viewerUrl;
  if (p.shotId) {
    const s = BOOK_SHOTS.find(x => x.id === p.shotId) || { name: '' };
    $('#viewerName').textContent = `${curBook.title} · ${p.shotId} ${s.name} · ${p.w}×${p.h}`;
    $('#btnVRetake').textContent = 'Re-shoot this photo';
    $('#btnVDelete').textContent = 'Delete this photo';
    show('scr-viewer', { title: `${p.shotId} ${s.name}`, back: backToBook });
    return;
  }
  $('#viewerName').textContent = `${curShelf.label} · frame ${p.n} · ${p.w}×${p.h}`;
  $('#btnVRetake').textContent = 'Re-shoot this frame';
  $('#btnVDelete').textContent = 'Delete this frame';
  show('scr-viewer', { title: `Frame ${p.n}`, back: backToShelf });
}
$('#btnVRetake').onclick = () => viewPhoto.shotId ? openBookCamera(viewPhoto.shotId) : openCamera(viewPhoto.n);
$('#btnVDelete').onclick = async () => {
  if (viewPhoto.shotId) {
    if (!confirm('Delete this photo?')) return;
    await dbDel('shots', [curBook.id, viewPhoto.shotId]);
    await bookChanged(curBook);
    return backToBook();
  }
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
// The copyright page's words, read aloud: a number line is said "ten nine eight
// ... one" and must come out "10 9 8 ... 1", one number per word, never run
// together; a year said "nineteen sixty three" is 1963, and "thirty one" is 31.
// "new line" breaks the line; "copyright sign" is the symbol.
const VERB_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const VERB_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const VERB_W1 = '(one|two|three|four|five|six|seven|eight|nine)';
const VERB_WTENS = '(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const VERB_YEAR_RE = new RegExp('\\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)[ -]' +
  '(?:(oh)[ -]' + VERB_W1 + '|' + VERB_WTENS + '(?:[ -]' + VERB_W1 + ')?|(hundred))\\b', 'gi');
const VERB_TENS_RE = new RegExp('\\b' + VERB_WTENS + '[ -]' + VERB_W1 + '\\b', 'gi');
const VERB_ONE_RE = new RegExp('\\b(' + VERB_ONES.concat(VERB_TENS.filter(Boolean)).join('|') + ')\\b', 'gi');
function verbVal(w) { w = String(w).toLowerCase(); const i = VERB_ONES.indexOf(w); return i >= 0 ? i : VERB_TENS.indexOf(w) * 10; }
function voiceToVerbatim(s) {
  return String(s)
    .replace(/\b(new line|newline|next line)\b/gi, '\n')
    .replace(/\bcopyright (sign|symbol)\b/gi, '©')
    .replace(VERB_YEAR_RE, (m, pre, oh, ohUnit, tens, unit, hundred) =>
      String(verbVal(pre) * 100 + (oh ? verbVal(ohUnit) : hundred ? 0 : verbVal(tens) + (unit ? verbVal(unit) : 0))))
    .replace(VERB_TENS_RE, (m, t, u) => String(verbVal(t) + verbVal(u)))
    .replace(VERB_ONE_RE, w => String(verbVal(w)))
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ | $/g, '');
}
// Tidy what dictation joined with spaces around its line breaks.
function tidyVerbatim(s) { return String(s || '').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]+/g, ' ').trim(); }
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
// find-or-create "Books Curator" at the top of My Drive. Never "Vinyl Curator";
// the two importers must never see each other's folders.
async function resolveRootFolder() {
  const id = settings.driveFolderId;
  if (!id) return findOrCreateFolder(settings.driveFolder || 'Books Curator', 'root');
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
  if (u.state === 'paused') return '⏸ Upload paused — sign in to continue';
  if (u.state === 'failed') return '⚠ Upload failed — ' + (u.error || 'tap ↻ to retry');
  return '';
}
// A token with less than two minutes left is not worth starting a file on:
// renewing one opens Google's sign-in, which only a tap may do.
function tokenFresh() {
  return !!(tokenInfo.token && Date.now() < tokenInfo.exp - 120000);
}
// The queue holds shelves and request books alike; a record says which it is.
function storeOf(r) { return r && r.kind === 'book' ? 'books' : 'shelves'; }
async function uploadQueue() {
  return [...await dbAll('shelves'), ...await dbAll('books')]
    .filter(s => s.upload && /^(queued|uploading|paused)$/.test(s.upload.state))
    .sort((a, b) => (a.upload.queued || 0) - (b.upload.queued || 0));
}
async function setUpload(sh, patch) {
  Object.assign(sh.upload, patch);
  await dbPut(storeOf(sh), sh);
  if (storeOf(sh) === 'shelves' && curShelf && curShelf.id === sh.id) curShelf.upload = sh.upload;
  if (storeOf(sh) === 'books' && curBook && curBook.id === sh.id) curBook.upload = sh.upload;
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
  st('Finding your Books Curator folder…');
  const id = await resolveRootFolder();
  const name = settings.driveFolder || 'Books Curator';
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
      await (sh.kind === 'book' ? uploadBook(sh) : uploadShelf(sh));
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
    if (!rootCache) rootCache = { id: await resolveRootFolder(), name: settings.driveFolder || 'Books Curator' };
    const shelvesFolder = await findOrCreateFolder(SHELVES_FOLDER, rootCache.id);
    const folder = await shelfFolderFor(sh, shelvesFolder);
    sh.driveFolderId = folder.id;
    sh.driveFolderName = folder.name;
    sh.fileIds = sh.fileIds || {};
    await dbPut('shelves', sh);
    // The folder id is how this phone asks for its curator's requests about the
    // shelf; it is kept even after the shelf's photos are deleted.
    await addHeldId(folder.id, { kind: 'shelf', label: sh.label, localId: sh.id });
    let next = 0, failed = null, paused = false;
    const worker = async () => {
      while (next < photos.length && !failed && !paused) {
        if (!tokenFresh()) { paused = true; break; }
        const p = photos[next++];
        try {
          const up = await uploadFile(folder.id, pad2(p.n) + '.jpg', 'image/jpeg', p.blob);
          if (up && up.id) sh.fileIds[pad2(p.n) + '.jpg'] = up.id;
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

/* A request's book goes into the root its shelf went into, found from the
 * shelf's own folder BY ID: <shelf folder> -> _Shelves -> the root. The app
 * made (or was given) all three, so drive.file can read them. Never the folder
 * named in Settings and never a search by name: a phone that lost its settings,
 * or a second phone, still files the answer where the curator reads. */
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files/';
const SHELF_GONE = 'The shelf this request belongs to is no longer in your Google Drive - tell your curator';
async function requestRootFolder(key) {
  const get = async (id, fields) => {
    try { return await drive(DRIVE_FILES + encodeURIComponent(id) + '?fields=' + fields); }
    catch (e) { if (/Drive error (403|404)/.test(String(e.message))) throw new Error(SHELF_GONE); throw e; }
  };
  if (!REQ_KEY_RE.test(String(key || ''))) throw new Error(SHELF_GONE);
  const sf = await get(key, 'id,parents,trashed');
  if (!sf || sf.trashed || !Array.isArray(sf.parents) || sf.parents.length !== 1) throw new Error(SHELF_GONE);
  const sv = await get(sf.parents[0], 'id,name,parents,trashed');
  if (!sv || sv.trashed || sv.name !== SHELVES_FOLDER || !Array.isArray(sv.parents) || sv.parents.length !== 1) throw new Error(SHELF_GONE);
  const root = await get(sv.parents[0], 'id,name,trashed');
  if (!root || !root.id || root.trashed) throw new Error(SHELF_GONE);
  return { id: root.id, name: root.name };
}
function bookFileBase(bk) { return `${sanitize(bk.author || '') || 'Unknown'} - ${sanitize(bk.title || '') || 'Untitled'}`; }
function bookFolderName(bk) { return `${sanitize(bk.author || '') || 'Unknown'}_${sanitize(bk.title || '') || 'Untitled'}`; }
// The request's own folder while it is alive (from the record, or from answered
// when the record was made again); otherwise a new Author_Title folder in the
// root, " (2)" on a clash, never merged into another book's folder.
async function bookFolderFor(bk, rootId) {
  const known = bk.driveFolderId || ((await answeredMap())[bk.requestId] || {}).driveFolderId || '';
  if (known) {
    try {
      const f = await drive(DRIVE_FILES + encodeURIComponent(known) + '?fields=id,name,trashed');
      if (f && f.id && !f.trashed) return { id: f.id, name: f.name };
    } catch (e) { if (!/Drive error (403|404)/.test(String(e.message))) throw e; }
  }
  const base = bookFolderName(bk);
  let name = base;
  for (let n = 2; n < 100 && await findFolder(name, rootId); n++) name = `${base} (${n})`;
  return { id: await findOrCreateFolder(name, rootId), name };
}
async function uploadBook(bk) {
  try {
    const shots = await shotsFor(bk.id);
    if (!bookReady(shots)) throw new Error('Both photos are needed first');
    const base = bookFileBase(bk);
    const files = BOOK_SHOTS.map(s => {
      const x = shots.find(y => y.shotId === s.id);
      return { shot: s.id, name: `${base} - ${s.id} ${s.name}.jpg`, mime: 'image/jpeg', blob: x.blob, w: x.w, h: x.h };
    });
    const words = shots.find(y => y.shotId === BOOK_WORDS.id && y.text);
    if (words) files.push({ shot: BOOK_WORDS.id, name: `${base} - ${BOOK_WORDS.id} ${BOOK_WORDS.name}.txt`, mime: 'text/plain',
      blob: new Blob([words.text], { type: 'text/plain' }), text: true });
    await setUpload(bk, { state: 'uploading', done: 0, total: files.length + 1, error: '' });
    const root = await requestRootFolder(bk.shelfRef && bk.shelfRef.shelfFolderId);
    const folder = await bookFolderFor(bk, root.id);
    // From here the folder IS this request's answer: kept before the first file,
    // so a retry, or a record made again, goes back into it.
    bk.driveFolderId = folder.id;
    bk.driveFolderName = folder.name;
    bk.fileIds = bk.fileIds || {};
    await dbPut('books', bk);
    await setAnswered(bk.requestId, { bookId: bk.id, driveFolderId: folder.id });
    for (const f of files) {
      if (!tokenFresh()) { await setUpload(bk, { state: 'paused' }); return; }
      const up = await uploadFile(folder.id, f.name, f.mime, f.blob);
      if (up && up.id) bk.fileIds[f.name] = up.id;
      await setUpload(bk, { done: bk.upload.done + 1 });
    }
    await writeBookManifest(folder.id, bk, files);
    await setUpload(bk, { done: files.length + 1 });
    bk.uploaded = Date.now();
    delete bk.upload;
    await dbPut('books', bk);
    if (curBook && curBook.id === bk.id) curBook = bk;
    await setAnswered(bk.requestId, { uploaded: bk.uploaded });
    // The book's own folder: how the phone will ask about it at full capture.
    await addHeldId(folder.id, { kind: 'book', label: bk.title, localId: bk.id });
    toast(`Sent “${bk.title}” ✓`, 3600);
    renderReqCard();
    if ($('#scr-requests').classList.contains('active')) openRequests();
    if ($('#scr-book').classList.contains('active') && curBook && curBook.id === bk.id) renderBook();
  } catch (e) {
    console.error('upload', bk.id, e);
    const msg = String(e && e.message || e);
    if (/sign-in|token|401/i.test(msg)) { await setUpload(bk, { state: 'paused' }); return; }
    await setUpload(bk, { state: 'failed', error: msg.slice(0, 120) });
  }
}
// book.json, written LAST: the importer reads it, never the folder name.
async function writeBookManifest(folder, bk, files) {
  const started = bk.startedAt || bk.created, finished = bk.finishedAt || Date.now();
  const r = bk.shelfRef || {};
  const manifest = {
    bookCurator: 1,
    kind: 'book',
    template: 'spot',
    appBookId: bk.id,
    author: bk.author || '',
    title: bk.title || '',
    requestId: bk.requestId || '',
    requestBookId: bk.requestBookId || '',
    shelfRef: { shelfId: r.shelfId || '', shelfFolderId: r.shelfFolderId || '', file: r.file || '', box: r.box || null, where: r.where || '' },
    note: bk.note || '',
    photos: files.filter(f => !f.text).map(f => ({ shot: f.shot, file: f.name, w: f.w, h: f.h, required: true })),
    texts: files.filter(f => f.text).map(f => ({ shot: f.shot, file: f.name })),
    operator: bk.operator || settings.operator || '',
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    captureMinutes: Math.round((finished - started) / 6000) / 10,
    app: APP_VERSION,
    updated: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  await uploadFile(folder, 'book.json', 'application/json', blob);
}
// Repaint the status line on every home card that carries an upload record,
// without rebuilding the list.
function refreshUploadCards() {
  if ($('#scr-shelf').classList.contains('active') && curShelf) {
    const up = uploadActive(curShelf);
    $('#btnUpload').disabled = up || $('#btnNext').disabled;
    $('#btnUpload').textContent = up ? uploadLabel(curShelf) : '☁ Upload to Google Drive';
  }
  if ($('#scr-book').classList.contains('active') && curBook) {
    const bk = curBook;
    shotsFor(bk.id).then(shots => { if (curBook === bk) paintBookUpload(bk, bookReady(shots)); });
  }
  if (!$('#scr-home').classList.contains('active')) return;
  (async () => {
    const shelves = await dbAll('shelves'), books = await dbAll('books');
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
    const waiting = shelves.concat(books).filter(s => s.upload && s.upload.state === 'paused').length;
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pumpUploads(); refreshRequests(); } });

/* ---------- requests: what your curator wants photographed next ----------
 * The phone names the Drive folder ids of the shelves it uploaded (kept in
 * heldIds, even after a shelf's photos are deleted) and the request service
 * answers the live requests for those shelves: author, title, where to find the
 * book, what to photograph, and the spine's box on the shelf photo. A reply that
 * is not JSON (Google's "unable to open the file" page) counts as no answer: the
 * list on the phone stays as it was. The phone tells the service a request was
 * seen; "received" is your curator's act, never the phone's. */
const REQ_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[-\w]+\/exec$/;
const REQ_KEY_RE = /^[A-Za-z0-9_-]{25,100}$/;
const REQ_RID_RE = /^R\d{4,6}-[A-HJ-NP-Z2-9]{4}$/;
let reqLastTry = 0, reqBusy = false, reqObjUrl = null;
function requestsUrl() { const u = cred('requestsUrl'); return REQ_URL_RE.test(u) ? u : ''; }
async function heldIds() { return (await dbGet('kv', 'heldIds')) || {}; }
async function addHeldId(id, info) {
  if (!id || !REQ_KEY_RE.test(id)) return;
  const h = await heldIds();
  if (h[id]) return;
  h[id] = { ...info, at: Date.now() };
  await dbPut('kv', h, 'heldIds');
}
// Every uploaded shelf this phone holds, on every start; no network, no sign-in.
async function seedHeldIds() {
  const h = await heldIds();
  let n = 0;
  for (const sh of await dbAll('shelves')) {
    if (sh.driveFolderId && REQ_KEY_RE.test(sh.driveFolderId) && !h[sh.driveFolderId]) {
      h[sh.driveFolderId] = { kind: 'shelf', label: sh.label, localId: sh.id, at: Date.now() };
      n++;
    }
  }
  if (n) await dbPut('kv', h, 'heldIds');
}
// One call to the request service: a text/plain POST with no headers (no CORS
// preflight). Anything but a JSON object is null: "no answer".
async function requestsPost(body) {
  const url = requestsUrl();
  if (!url) return null;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: ctl.signal });
    const txt = await r.text();
    try { const o = JSON.parse(txt); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; }
  } catch (e) { return null; } finally { clearTimeout(t); }
}
function reqItemOk(it) {
  return !!it && typeof it.rid === 'string' && REQ_RID_RE.test(it.rid) && typeof it.key === 'string';
}
// At most once a minute unless asked (Check again). Up to 3 tries; the cached list
// is replaced only by a good answer, and a shelf the service could not open keeps
// its cached requests.
async function refreshRequests({ force = false } = {}) {
  if (!requestsUrl() || reqBusy) return;
  if (!force && Date.now() - reqLastTry < 60000) return;
  reqBusy = true;
  reqLastTry = Date.now();
  try {
    const ids = Object.keys(await heldIds()).filter(id => REQ_KEY_RE.test(id));
    const cached = (await dbGet('kv', 'requests')) || { items: [] };
    if (!ids.length) { await dbPut('kv', { items: [], fetchedAt: Date.now(), build: '', lastError: '' }, 'requests'); return; }
    let rep = null;
    for (let a = 1; a <= 3; a++) {
      rep = await requestsPost({ op: 'list', v: 1, ids });
      if (rep && rep.ok === true && Array.isArray(rep.items)) break;
      rep = null;
      if (a < 3) await new Promise(r => setTimeout(r, 1500 * a));
    }
    if (!rep) { await dbPut('kv', { ...cached, lastError: 'Could not check just now' }, 'requests'); return; }
    const unavailable = Array.isArray(rep.unavailable) ? rep.unavailable : [];
    const fresh = rep.items.filter(reqItemOk);
    const kept = (cached.items || []).filter(it => unavailable.indexOf(it.key) >= 0 && !fresh.some(x => x.rid === it.rid));
    const items = fresh.concat(kept);
    await dbPut('kv', { items, fetchedAt: Date.now(), build: String(rep.build || ''), lastError: '' }, 'requests');
    await markSeen(ids, fresh);
  } finally {
    reqBusy = false;
    renderReqCard();
    if ($('#scr-requests').classList.contains('active')) openRequests();
  }
}
// "Seen" once per request, recorded only when the service confirms it.
async function markSeen(ids, items) {
  const seen = (await dbGet('kv', 'requestsSeen')) || {};
  const rids = items.map(i => i.rid).filter(r => !seen[r]).slice(0, 500);
  if (!rids.length) return;
  const rep = await requestsPost({ op: 'seen', v: 1, ids, rids });
  if (!rep || rep.ok !== true) return;
  for (const r of [].concat(rep.stamped || [], rep.already || [])) if (rids.indexOf(r) >= 0) seen[r] = Date.now();
  await dbPut('kv', seen, 'requestsSeen');
}
function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
// A request's state on this phone, from the phone's own records only.
function reqState(it, answered, books = {}) {
  const a = answered[it.rid];
  if (a && a.uploaded) return { key: 'sent', text: 'Sent - waiting for your curator' };
  const bk = a && a.bookId ? books[a.bookId] : null;
  if (bk && bk.upload) return { key: 'shot', text: uploadLabel(bk) };
  if (a && a.ready) return { key: 'shot', text: 'Photographed - waiting to upload' };
  return { key: 'todo', text: 'To do' };
}
async function renderReqCard() {
  const card = $('#reqCard');
  if (!card) return;
  if (!requestsUrl()) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const c = (await dbGet('kv', 'requests')) || { items: [] };
  const answered = (await dbGet('kv', 'answered')) || {};
  const waiting = (c.items || []).filter(it => reqState(it, answered).key !== 'sent').length;
  $('#reqCount').textContent = String(waiting);
  $('#reqCount').classList.toggle('hidden', !waiting);
  $('#reqSub').textContent = !c.fetchedAt ? (c.lastError ? 'Could not check just now' : 'Checking…')
    : (c.lastError ? 'Could not check just now - showing the last list'
      : (waiting ? waiting + ' waiting' : 'Nothing waiting') + ' · last checked ' + fmtTime(c.fetchedAt));
}
$('#reqCard').onclick = () => openRequests();
async function openRequests() {
  // Two draws can overlap (Check again, and the refresh it triggers): only the latest
  // one writes to the list, so nothing is drawn twice.
  const token = openRequests.n = (openRequests.n || 0) + 1;
  show('scr-requests', { title: 'Requests', back: goHome });
  const c = (await dbGet('kv', 'requests')) || { items: [] };
  const answered = (await dbGet('kv', 'answered')) || {};
  const held = await heldIds();
  const allBooks = await dbAll('books'), books = Object.fromEntries(allBooks.map(b => [b.id, b]));
  const byFolder = {};
  for (const s of await dbAll('shelves')) if (s.driveFolderId) byFolder[s.driveFolderId] = s;
  $('#rqsStatus').textContent = !c.fetchedAt ? (c.lastError ? 'Could not check just now.' : 'Checking…')
    : (c.lastError ? 'Could not check just now - showing the last list from ' + fmtTime(c.fetchedAt) + '.' : 'Last checked ' + fmtTime(c.fetchedAt) + '.');
  if (token !== openRequests.n) return;
  const list = $('#rqsList');
  list.innerHTML = '';
  const items = (c.items || []).slice();
  // Books started here whose request the list no longer returns (withdrawn before
  // they went up): kept, with Upload and Delete, so no photo is stranded.
  const started = allBooks.filter(b => !b.uploaded && !items.some(it => it.rid === b.requestId)).sort((a, b) => a.created - b.created);
  if (!items.length) list.innerHTML = '<p class="empty">Nothing waiting.<br>Your curator\'s requests appear here.</p>';
  // Grouped by shelf, in the order the shelves were shot; within a shelf by photo, then left to right.
  const groupOf = it => byFolder[it.key] ? byFolder[it.key].label : held[it.key] ? held[it.key].label : (it.where || 'Other');
  const orderOf = it => byFolder[it.key] ? byFolder[it.key].created : Infinity;
  items.sort((a, b) => (orderOf(a) - orderOf(b)) || groupOf(a).localeCompare(groupOf(b)) ||
    String(a.box && a.box.file || '').localeCompare(String(b.box && b.box.file || '')) || ((a.box ? a.box.x : 2) - (b.box ? b.box.x : 2)));
  let cur = null;
  for (const it of items) {
    const g = groupOf(it);
    if (g !== cur) { cur = g; const h = document.createElement('h2'); h.className = 'sect'; h.textContent = g; list.appendChild(h); }
    const st = reqState(it, answered, books);
    const row = document.createElement('button');
    row.className = 'reqitem ' + st.key;
    row.dataset.rid = it.rid;
    row.innerHTML = `<div class="rq-t">${esc(it.title || '(no title)')}</div><div class="rq-a">${esc(it.author || '')}</div>` +
      `<div class="rq-w">${esc(it.where || '')}</div><div class="rq-s">${esc(st.text)}</div>`;
    row.onclick = () => openRequest(it.rid);
    list.appendChild(row);
  }
  if (!started.length) return;
  const h = document.createElement('h2'); h.className = 'sect'; h.textContent = 'Started on this phone';
  list.appendChild(h);
  for (const bk of started) {
    const row = document.createElement('div');
    row.className = 'reqitem started';
    row.dataset.book = bk.id;
    row.innerHTML = `<div class="rq-t">${esc(bk.title || '(no title)')}</div><div class="rq-a">${esc(bk.author || '')}</div>` +
      `<div class="rq-s">${esc(bk.upload ? uploadLabel(bk) : '')}</div>` +
      '<div class="row2" style="margin-top:10px"><button class="secondary st-up">☁ Upload</button><button class="secondary danger st-del">Delete</button></div>';
    const up = row.querySelector('.st-up');
    up.disabled = (uploadActive(bk) && bk.upload.state !== 'paused') || !bookReady(await shotsFor(bk.id));
    if (token !== openRequests.n) return;   // a newer draw of this screen has started
    up.onclick = () => startBookUpload(bk, up);
    row.querySelector('.st-del').onclick = () => deleteBook(bk.id, () => openRequests());
    list.appendChild(row);
  }
}
$('#btnReqCheck').onclick = async () => { $('#rqsStatus').textContent = 'Checking…'; await refreshRequests({ force: true }); openRequests(); };
function reqFreeUrl() { if (reqObjUrl) { URL.revokeObjectURL(reqObjUrl); reqObjUrl = null; } }
// One request: the words, and the spine marked on this phone's own shelf photo
// (never drawn on a photo retaken after the curator saw it).
async function openRequest(rid) {
  const c = (await dbGet('kv', 'requests')) || { items: [] };
  const it = (c.items || []).find(x => x.rid === rid);
  if (!it) return openRequests();
  reqFreeUrl();
  show('scr-request', { title: 'Request', back: () => { reqFreeUrl(); openRequests(); } });
  $('#btnRqShoot').onclick = () => openBookFromRequest(rid);
  $('#rqTitle').textContent = it.title || '';
  $('#rqAuthor').textContent = it.author || '';
  $('#rqWhere').textContent = it.where || '';
  $('#rqAsked').textContent = it.asked || '';
  const wrap = $('#rqPhoto'), note = $('#rqNote');
  wrap.innerHTML = '';
  note.textContent = '';
  const box = it.box && typeof it.box === 'object' ? it.box : null;
  let photo = null;
  if (box && box.file) {
    const sh = (await dbAll('shelves')).find(s => s.driveFolderId === it.key);
    if (sh) photo = (await photosFor(sh.id)).find(p => pad2(p.n) + '.jpg' === box.file) || null;
  }
  if (!box) { note.textContent = 'Find the book by the words above.'; return; }
  if (!photo) { note.textContent = 'This phone no longer holds that shelf photo. Find the book by the words above.'; return; }
  const at = Date.parse(box.at || '');
  if (!isFinite(at) || photo.when > at) { note.textContent = 'This shelf photo was retaken after your curator saw it. Find the book by the words above.'; return; }
  reqObjUrl = URL.createObjectURL(photo.blob);
  const pct = v => (Math.max(0, Math.min(1, Number(v) || 0)) * 100).toFixed(3) + '%';
  wrap.innerHTML = `<div class="rq-frame"><img id="rqImg" alt="Shelf photo"><div class="rq-box" style="left:${pct(box.x)};top:${pct(box.y)};width:${pct(box.w)};height:${pct(box.h)}"></div></div>` +
    '<p class="hint">The book is inside the box. Close up:</p><canvas id="rqZoom"></canvas>';
  const img = $('#rqImg');
  img.onload = () => {
    // A close-up about five spine widths wide, so a thin spine's print can be read.
    const W = img.naturalWidth, H = img.naturalHeight, bx = box.x * W, by = box.y * H, bw = box.w * W, bh = box.h * H;
    const half = Math.max(bw * 2.5, W * 0.04), x0 = Math.max(0, bx + bw / 2 - half), x1 = Math.min(W, bx + bw / 2 + half);
    const y0 = Math.max(0, by - 0.03 * H), y1 = Math.min(H, by + bh + 0.03 * H);
    const cv = $('#rqZoom');
    if (!cv) return;
    const s = Math.min(1, 900 / (y1 - y0));
    cv.width = Math.max(1, Math.round((x1 - x0) * s)); cv.height = Math.max(1, Math.round((y1 - y0) * s));
    const g = cv.getContext('2d');
    g.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, cv.width, cv.height);
    g.strokeStyle = '#d9a441'; g.lineWidth = Math.max(3, cv.width / 120);
    g.strokeRect((bx - x0) * s, (by - y0) * s, bw * s, bh * s);
  };
  img.src = reqObjUrl;
}
$('#btnReqTest').onclick = async () => {
  const u = ($('#inRequestsUrl').value.trim() || BUILTIN.requestsUrl || '').trim();
  if (!REQ_URL_RE.test(u)) { $('#reqTestNote').textContent = 'That is not a request service address.'; return; }
  $('#reqTestNote').textContent = 'Testing…';
  try {
    const r = await fetch(u + '?ping=1');
    const o = JSON.parse(await r.text());
    $('#reqTestNote').textContent = o && o.ok && o.ping ? 'Connected (build ' + o.build + ')' : 'No answer from that address';
  } catch (e) { $('#reqTestNote').textContent = 'No answer from that address'; }
};

/* ---------- a book your curator asked for ----------
 * One record per request, made (and pointed at from answered[rid]) before the
 * camera opens. Author and title are the request's and stay locked: they name
 * the folder and the files, and a filing name is never edited. A
 * different book in the hand is said in the note, which reaches the curator in
 * book.json. There is no "another copy": two copies are two requests. */
let curBook = null, bookThumbs = [];
async function answeredMap() { return (await dbGet('kv', 'answered')) || {}; }
async function setAnswered(rid, patch) {
  if (!rid) return;
  const a = await answeredMap();
  a[rid] = { ...(a[rid] || {}), ...patch };
  await dbPut('kv', a, 'answered');
}
function bookReady(shots) { return BOOK_SHOTS.every(s => shots.some(x => x.shotId === s.id && x.blob)); }
async function openBookFromRequest(rid) {
  const c = (await dbGet('kv', 'requests')) || { items: [] };
  const it = (c.items || []).find(x => x.rid === rid);
  const a = (await answeredMap())[rid];
  let bk = a && a.bookId ? await dbGet('books', a.bookId) : null;
  if (!bk && !it) return openRequests();
  if (!bk) {
    // A record deleted after an upload is made again with the folder it used,
    // so a second answer goes into the same folder.
    const box = it.box && typeof it.box === 'object' ? it.box : null;
    bk = {
      id: Date.now().toString(36), kind: 'book', template: 'spot',
      author: String(it.author || ''), title: String(it.title || ''),
      requestId: rid, requestBookId: String(it.bookId || ''),
      shelfRef: { shelfId: String(it.shelfId || ''), shelfFolderId: it.key, file: box ? String(box.file || '') : '',
        box: box ? [box.x, box.y, box.w, box.h] : null, where: String(it.where || '') },
      asked: String(it.asked || ''), note: '',
      operator: settings.operator || '', created: Date.now(), startedAt: Date.now(), finishedAt: null,
      driveFolderId: (a && a.driveFolderId) || '', driveFolderName: '',
    };
    await dbPut('books', bk);
    await setAnswered(rid, { bookId: bk.id, driveFolderId: bk.driveFolderId, ready: false });
  }
  curBook = bk;
  reqFreeUrl();
  backToBook();
}
function backToBook() {
  stopCam();
  stopLevel();
  freeGate();
  stopVoice();
  if (!curBook) return openRequests();
  show('scr-book', { title: 'Book', back: async () => { await leaveBook(); openRequest(curBook.requestId); } });
  renderBook();
}
async function renderBook() {
  const bk = curBook;
  bookThumbs.forEach(u => URL.revokeObjectURL(u));
  bookThumbs = [];
  const shots = await shotsFor(bk.id);
  $('#bkTitle').textContent = bk.title || '(no title)';
  $('#bkAuthor').textContent = bk.author ? 'by ' + bk.author : '';
  $('#bkWhere').textContent = (bk.shelfRef && bk.shelfRef.where) || '';
  $('#bkAsked').textContent = bk.asked || '';
  $('#bkAsked').classList.toggle('hidden', !bk.asked);
  $('#inBkNote').value = bk.note || '';
  $('#bkNoteWrap').classList.toggle('hidden', !bk.note);
  $('#btnBkDifferent').classList.toggle('hidden', !!bk.note);
  const list = $('#bkShots');
  list.innerHTML = '';
  for (const s of BOOK_SHOTS) {
    const got = shots.find(x => x.shotId === s.id && x.blob);
    const row = document.createElement('div');
    row.className = 'bkshot' + (got ? ' got' : '');
    row.dataset.shot = s.id;
    let thumb = '<span class="bk-thumb empty">📷</span>';
    if (got) { const u = URL.createObjectURL(got.blob); bookThumbs.push(u); thumb = `<img class="bk-thumb" alt="${esc(s.id)}" src="${u}">`; }
    row.innerHTML = `<button class="bk-view" aria-label="${got ? 'View' : 'Take'} ${esc(s.id)}">${thumb}</button>` +
      `<div class="bk-body"><div class="bk-name"><span class="bk-req">●</span> ${esc(s.id)} ${esc(s.label)}</div>` +
      `<button class="bk-take">${got ? 'Re-shoot' : '📷 Take this photo'}</button></div>`;
    row.querySelector('.bk-take').onclick = () => openBookCamera(s.id);
    row.querySelector('.bk-view').onclick = () => got ? openViewer(got) : openBookCamera(s.id);
    list.appendChild(row);
  }
  const words = shots.find(x => x.shotId === BOOK_WORDS.id);
  $('#inBkWords').value = words ? words.text || '' : '';
  $('#btnBkWordsVoice').classList.toggle('hidden', !SpeechRec);
  $('#btnBkNoteVoice').classList.toggle('hidden', !SpeechRec);
  paintBookUpload(bk, bookReady(shots));
}
function paintBookUpload(bk, ready) {
  const up = uploadActive(bk), paused = !!(bk.upload && bk.upload.state === 'paused');
  $('#btnBkUpload').disabled = !ready || (up && !paused) || !!bk.uploaded;
  $('#btnBkUpload').textContent = paused ? '☁ Sign in to continue the upload' : up ? uploadLabel(bk) : bk.uploaded ? 'Sent - waiting for your curator' : '☁ Upload to Google Drive';
  // While it is queued or going up, the words stay as they were sent: a note typed
  // now would be overwritten by the upload's own copy of the record.
  ['#inBkNote', '#inBkWords', '#btnBkNoteVoice', '#btnBkWordsVoice', '#btnBkDifferent'].forEach(q => { $(q).disabled = up && !paused; });
  $('#bkStatus').textContent = bk.upload && bk.upload.state === 'failed' ? uploadLabel(bk)
    : !ready ? 'Both photos are needed before this can be sent.' : '';
}
async function keepBookShot(shotId, bmp, blob) {
  const bk = curBook;
  await dbPut('shots', { bookId: bk.id, shotId, blob, w: bmp.width, h: bmp.height, when: Date.now() });
  await bookChanged(bk);
  backToBook();
  toast(`${shotId} saved ✓`);
}
// Anything kept, deleted or retyped: the book is no longer what was uploaded,
// and the request's state on this phone follows.
async function bookChanged(bk) {
  const ready = bookReady(await shotsFor(bk.id));
  bk.finishedAt = ready ? Date.now() : null;
  bk.uploaded = null;
  await dbPut('books', bk);
  await setAnswered(bk.requestId, { bookId: bk.id, ready, uploaded: null });
}
const NOTE_START = 'The book I found is: ';
// The note and the copyright words are read off the screen when it is left
// (dictation fills the boxes without a change event).
async function leaveBook() {
  stopVoice();
  const bk = curBook;
  if (!bk || !$('#scr-book').classList.contains('active')) return;
  let note = $('#inBkNote').value.trim();
  if (note === NOTE_START.trim()) note = '';
  const words = tidyVerbatim($('#inBkWords').value);
  const had = (await shotsFor(bk.id)).find(x => x.shotId === BOOK_WORDS.id);
  if (note === (bk.note || '') && words === (had ? had.text || '' : '')) return;
  bk.note = note;
  await dbPut('books', bk);
  if (words) await dbPut('shots', { bookId: bk.id, shotId: BOOK_WORDS.id, text: words, when: Date.now() });
  else if (had) await dbDel('shots', [bk.id, BOOK_WORDS.id]);
  await bookChanged(bk);
}
$('#btnBkDifferent').onclick = () => {
  $('#bkNoteWrap').classList.remove('hidden');
  $('#btnBkDifferent').classList.add('hidden');
  const n = $('#inBkNote');
  if (!n.value.trim()) n.value = NOTE_START;
  n.focus();
};
$('#inBkNote').onchange = () => leaveBookText();
$('#inBkWords').onchange = () => leaveBookText();
async function leaveBookText() { await leaveBook(); if (curBook) paintBookUpload(curBook, bookReady(await shotsFor(curBook.id))); }
$('#btnBkNoteVoice').onclick = () => beginDictation('#inBkNote', '#btnBkNoteVoice', voiceToNote);
$('#btnBkWordsVoice').onclick = () => beginDictation('#inBkWords', '#btnBkWordsVoice', voiceToVerbatim);
$('#btnBkDelete').onclick = () => deleteBook(curBook.id, () => openRequests());
async function deleteBook(id, then) {
  const bk = await dbGet('books', id);
  if (!bk) return then();
  if (bk.upload && bk.upload.state === 'uploading') return toast('Wait for the upload to finish');
  if (!confirm('This book answers a request from your curator; delete it from the phone anyway?')) return;
  stopVoice();
  for (const s of await shotsFor(id)) await dbDel('shots', [id, s.shotId]);
  await dbDel('books', id);
  // answered keeps the request's folder: a new record for it goes back there.
  await setAnswered(bk.requestId, { ready: false });
  if (curBook && curBook.id === id) curBook = null;
  bookThumbs.forEach(u => URL.revokeObjectURL(u));
  bookThumbs = [];
  then();
}
$('#btnBkUpload').onclick = () => startBookUpload(curBook, $('#btnBkUpload'));
// Sign in (a tap may open Google's sign-in), then queue. A book is never shared
// on its own: it goes under the root that was shared when the shelves went up.
async function startBookUpload(bk, btn) {
  if (!bk) return;
  // A paused upload (the sign-in ran out) is continued from here as well as from home.
  const paused = !!(bk.upload && bk.upload.state === 'paused');
  if (uploadActive(bk) && !paused) return;
  btn.disabled = true;
  try {
    if (curBook && curBook.id === bk.id) await leaveBook();
    if (!bookReady(await shotsFor(bk.id))) throw new Error('Both photos are needed first');
    if (!cred('clientId')) throw new Error('This build has no Google Client ID yet — add one in ⚙ Settings');
    btn.textContent = 'Signing in to Google…';
    await getToken();
    if (paused) await setUpload(bk, { state: 'queued', error: '' });
    else await queueBook(bk);
    toast('Queued — uploading while you carry on', 3000);
    openRequests();
    pumpUploads();
  } catch (e) {
    console.error(e);
    toast(e.message, 4500);
    btn.disabled = false;
    btn.textContent = '☁ Upload to Google Drive';
  }
}
async function queueBook(bk) {
  const shots = await shotsFor(bk.id);
  if (!bookReady(shots)) return false;
  if (!bk.finishedAt) bk.finishedAt = Date.now();
  const words = shots.some(s => s.shotId === BOOK_WORDS.id && s.text);
  bk.upload = { state: 'queued', done: 0, total: BOOK_SHOTS.length + (words ? 1 : 0) + 1, queued: Date.now(), error: '' };
  await dbPut('books', bk);
  if (curBook && curBook.id === bk.id) curBook = bk;
  return true;
}

/* ---------- uploaded shelves ---------- */
$('#btnArchive').onclick = () => openArchive();
async function openArchive() {
  show('scr-archive', { title: 'Uploaded shelves', back: goHome });
  const list = $('#arcList');
  list.innerHTML = '';
  const done = (await dbAll('shelves')).filter(s => s.uploaded).sort((a, b) => b.uploaded - a.uploaded);
  $('#arcStatus').textContent = done.length
    ? 'These are in your Google Drive under Books Curator / _Shelves. The photos are still on this phone until you delete them.'
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
  $('#inDriveFolder').value = settings.driveFolder || 'Books Curator';
  $('#inQuality').value = String(settings.quality || 0.95);
  $('#inRequestsUrl').value = settings.requestsUrl || '';
  $('#inRequestsUrl').placeholder = BUILTIN.requestsUrl || 'https://script.google.com/macros/s/…/exec';
  $('#reqTestNote').textContent = '';
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
    if (!confirm('Unlink the Drive folder? Uploads go back to a “' + (settings.driveFolder || 'Books Curator') + '” folder the app creates in My Drive.')) return;
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
  const folder = sanitize($('#inDriveFolder').value) || 'Books Curator';
  if (folder !== settings.driveFolder) { settings.driveFolderId = ''; rootCache = null; }
  settings.driveFolder = folder;
  settings.quality = Number($('#inQuality').value) || 0.95;
  const rq = $('#inRequestsUrl').value.trim();
  if (rq && !REQ_URL_RE.test(rq)) { toast('The request service address must be a script.google.com …/exec address', 4500); return; }
  if (rq !== settings.requestsUrl) reqLastTry = 0;
  settings.requestsUrl = rq;
  tokenInfo = tokenInfo.token && settings.clientId === cred('clientId') ? tokenInfo : { token: null, exp: 0 };
  await saveSettings();
  toast('Settings saved');
  goHome();
};
$('#btnWipe').onclick = async () => {
  if (!confirm('Delete ALL shelves, photos, and settings stored by this app on this phone?')) return;
  // Which shelves this phone uploaded is how it finds your curator's requests:
  // kept unless you say otherwise. The client id is never cleared (BUILTIN wins).
  const held = await heldIds(), answered = (await dbGet('kv', 'answered')) || {};
  const forget = Object.keys(held).length > 0 && confirm('Also forget which shelves this phone uploaded? Your curator\'s requests for them will stop appearing.');
  await dbClear('photos');
  await dbClear('shelves');
  await dbClear('books');
  await dbClear('shots');
  await dbClear('kv');
  if (!forget) {
    if (Object.keys(held).length) await dbPut('kv', held, 'heldIds');
    if (Object.keys(answered).length) await dbPut('kv', answered, 'answered');
  }
  Object.assign(settings, { clientId: '', apiKey: '', projectNumber: '', shareWith: '', operator: '', quality: 0.95, driveFolder: 'Books Curator', driveFolderId: '', requestsUrl: '' });
  reqLastTry = 0;
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
  await seedHeldIds();   // before the first requests check
  await goHome();
  pumpUploads();   // an interrupted queue: no token yet, so this marks it paused and shows the sign-in
})().catch(e => {
  console.error(e);
  toast('The app could not open its saved photos - close it and open it again, or tell your curator', 8000);
});
