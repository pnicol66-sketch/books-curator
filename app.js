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
const APP_VERSION = '20261002-200541';

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

/* ---------- full capture: the whole book ----------
 * The curator asks for every photo of a book whose two spot-check photos are
 * filed. The phone adds to that book's own folder (named by the request, checked
 * by id) and never makes one; 01 and 12 stay as they were sent (locked, never
 * sent again). Shot numbers and file names are permanent from the first upload:
 * one file name per shot number, whatever the template. */
// Every word the client sees that came with full capture is here, in FULL_WORDS,
// and (each shot's label, camera tip and loupe question, and the group headings) in
// the checklist table FULL_TEMPLATES just below, so the wording can change without
// touching the code around it. File names (FULL_NAMES) never change.
const FULL_WORDS = {
  wholeBook: n => `Whole book - ${n} photos`,
  twoPhotos: '2 photos',
  progress: (n, m) => `${n} of ${m} done`,
  shoot: 'Photograph the whole book',
  keepOpen: 'Keep the app open until it says Sent.',
  sent: 'Sent - waiting for your curator',
  checkLine: 'a check for your curator, never on the website',
  cant: 'Can\'t take this one',
  cantWhy: { 'not-on-book': 'Not on this book', missing: 'Missing or torn off', other: 'Other' },
  cantOther: 'Say why',
  // The link that switches lists names the other list (owner, 2 Oct 2026), keyed by the list it switches to.
  switchLink: { pb: "It's a paperback", hc: 'It has hard covers and a jacket' },
  notSure: 'Not sure',
  notSureLine: 'Your curator will judge it from the photos.',
  driveFull: 'Your Google Drive is full',
  folderGone: 'This phone can\'t open this book\'s folder. Tell your curator.',
  needUpdate: 'This request needs the newest version of the app: pull down, then Update',
  sentEarlier: 'Sent earlier',
  optional: 'Optional',
  alsoTaken: 'Also taken (kept and sent with the rest)',
  chooseGrades: 'Choose how good the jacket and the book are.',
  chooseGrade: 'Choose how good the book is.',
  noLonger: 'Your curator no longer asks for this book',
  closed: 'Your curator no longer asks for this book. Delete it from this phone when you like.',
  // New words, awaiting the owner's yes: in place of `closed` when a new request for
  // the same book (the same folder and Book ID) is on the list above.
  askedAgain: 'Your curator has asked for this book again (above). These are the photos for the earlier request; delete them from this phone when you like.',
  // New words, still to be approved before they ship: the upload asks the curator's
  // list itself before it sends; a book whose request has left the list stays on the
  // phone until she deletes it; the first opening needs the internet.
  cantCheck: 'Could not check with your curator just now. Try the upload again in a moment.',
  tryAgain: '☁ Try the upload again',
  onPhone: 'On this phone',
  onPhoneSent: 'Sent to your curator. The photos are in your Google Drive; delete them from this phone when you like.',
  deleteUnsent: 'This book was never sent to your curator. Delete its photos from this phone anyway?',
  deleteChanged: 'Your last changes to this book were not sent. Delete it from this phone anyway?',
  deleteSent: 'Delete this book\'s photos from this phone? The ones you sent stay in your Google Drive.',
  firstOpenOnline: 'Opening a whole book needs the internet the first time. Try again when you are online; after that you can take the photos offline.',
  // The template line on the request and the checklist, by template code.
  templates: { hc: 'Hardcover with its jacket', pb: 'Paperback' },
  // "This book is different": switch to the other list, with a reason.
  switchTo: { hc: 'Switch to the list for a hardcover with its jacket', pb: 'Switch to the list for a paperback' },
  switchWhy: { hc: 'It has hard covers and a jacket', pb: 'It has soft covers, no jacket' },
  switchKeep: 'Every photo you have taken is kept.',
  switchGo: 'Switch',
  cancel: 'Cancel',
  gradeHeads: { jacket: 'The jacket', book: 'The book' },
  // One plain line per grade, in our own words.
  gradeLines: {
    F: 'Fine: like new. It may have been read, but it has no faults.',
    NF: 'Near Fine: almost Fine, with one or two very small faults.',
    'VG+': 'Very Good plus: better than Very Good, not quite Near Fine.',
    VG: 'Very Good: some light wear, but nothing torn.',
    G: 'Good: an ordinary used copy, worn but complete.',
    FR: 'Fair: well worn. All the text is there, but an endpaper or similar may be missing.',
    P: 'Poor: so worn that only the text is worth keeping (a reading copy).',
  },
  // The same seven grades for the jacket, in the same plain style (new words, still
  // to be approved before they ship): a jacket is judged by its tears, chips,
  // missing pieces, rubbing and fading, not by its text.
  jacketGradeLines: {
    F: 'Fine: like new. No tears, chips, rubbing or fading.',
    NF: 'Near Fine: almost Fine, with one or two very small faults.',
    'VG+': 'Very Good plus: better than Very Good, not quite Near Fine.',
    VG: 'Very Good: some light wear, perhaps a small tear or chip at an edge.',
    G: 'Good: an ordinary used jacket, worn, with some tears or chips.',
    FR: 'Fair: well worn, with tears, chips or small pieces missing.',
    P: 'Poor: badly torn, with large pieces missing, or in pieces.',
  },
};
// C7: the grade buttons, and the chips in the sheet's own list words.
const FULL_GRADES = ['F', 'NF', 'VG+', 'VG', 'G', 'FR', 'P'];
const FULL_FLAGS = {
  jacket: ['Price-clipped', 'Facsimile', 'Mylar (removed to shoot)'],
  book: ['Ex-library', 'Remainder mark', 'Previous-owner inscription', 'Bookplate'],
};
// C1: one file name per shot number, whatever the template. 01 and 12 keep their
// spot-check file names; 13 is the copyright page's words (.txt).
const FULL_NAMES = {
  '03': 'Back', '05': 'Spine', '06': 'Front Flap', '07': 'Corner', '08': 'Rear Flap', '09': 'Front Board',
  '10': 'Spine Jacket Off', '11': 'Title Page', '14': 'Colophon', '15': 'Signature', '16': 'Edges', '17': 'Gutter',
  '20': 'Rear Board', '23': 'Other', '27': 'Copyright Check',
};
const FULL_KEPT = ['01', '12'];
const FULL_TEXT = { id: '13', name: 'Copyright Verbatim' };
// The checklist per template, in the order her hands meet the book. Numbers are
// permanent file numbers; only the screen order follows the handling. req: true
// = required (or "Can't take this one"); kept: sent at spot-check, locked; torch:
// the torch starts on. grades: where the grade pickers sit.
const FULL_TEMPLATES = {
  hc: {
    grades: ['jacket', 'book'],
    groups: [
      { head: 'Jacket on, book closed', shots: [
        { id: '01', kept: true, label: 'Front of the jacket' },
        { id: '05', req: true, label: 'Spine of the jacket, square on', gate: 'Can you read the lettering at the foot?',
          tip: '📸 The jacket spine, square on · top to foot · flash off' },
        { id: '03', req: true, label: 'Back of the jacket', gate: 'Is the whole back in the photo, with no glare?',
          tip: '📸 The whole back of the jacket, square on · no glare' },
        { id: '16', req: true, label: 'Page edges: top and side together, book closed', gate: 'Can you see both edges?',
          tip: '📸 Book closed · the top and side edges together, at an angle' },
      ] },
      { head: 'Open the cover, flaps out', shots: [
        { id: '06', req: true, label: 'Front flap, unfolded', gate: 'Can you read the flap text?',
          tip: '📸 Open the cover · unfold the front flap flat · the whole flap' },
        { id: '07', req: true, label: 'Front flap, top corner, close up', gate: 'Can you read the small print in the corner?',
          tip: '📸 Close up on the top corner of the front flap' },
        { id: '08', req: true, label: 'Back flap, unfolded', gate: 'Can you read the small print?',
          tip: '📸 Unfold the back flap flat · the whole flap' },
      ] },
      { head: 'Book open flat', shots: [
        { id: '11', req: true, label: 'Title page, the whole page', gate: 'Can you read the smallest print?',
          tip: '📸 Open flat at the title page · the whole page, square on' },
        { id: '12', kept: true, label: 'Copyright page' },
        { id: '27', req: true, check: true, label: 'Copyright page again, the whole page', gate: 'Can you read the number line?',
          tip: '📸 The copyright page again · the whole page, square on · flash off' },
      ] },
      { head: 'Take the jacket off', shots: [
        { id: '09', req: true, label: 'Front cover of the book itself', gate: 'Is the whole cover in the photo?',
          tip: '📸 Jacket off · the whole front cover, square on' },
        { id: '10', req: true, label: 'Spine of the book itself', gate: 'Can you read the lettering?',
          tip: '📸 Jacket off · the spine, square on, top to foot' },
        { id: '20', req: true, torch: true, label: 'Back cover of the book itself, tilted so marks cast a shadow',
          gate: 'Can you see the lower corner clearly?', tip: '📸 Jacket off · the back cover, tilted so marks cast a shadow · torch on' },
      ] },
      { head: 'Put the jacket back', grades: true, shots: [] },
      { head: 'Optional', optional: true, words: true, shots: [
        { id: '14', label: 'Colophon or limitation page', gate: 'Can you read the smallest print?',
          tip: '📸 The colophon or limitation page · the whole page' },
        { id: '15', label: 'Signature or inscription', gate: 'Can you read the writing?',
          tip: '📸 The signature or inscription, close enough to read' },
        { id: '17', torch: true, label: 'Gutter: look down into the middle of the open book', gate: 'Can you see down into the gutter?',
          tip: '📸 Open in the middle · look down into the gutter · torch on' },
        { id: '23', label: 'Anything else your curator should see', gate: 'Is it sharp?',
          tip: '📸 Anything else your curator should see' },
      ] },
    ],
  },
  pb: {
    grades: ['book'],
    groups: [
      { head: 'Book closed', shots: [
        { id: '01', kept: true, label: 'Front cover' },
        { id: '05', req: true, label: 'Spine, square on', gate: 'Can you read the lettering at the foot?',
          tip: '📸 The spine, square on · top to foot · flash off' },
        { id: '03', req: true, label: 'Back cover', gate: 'Is the whole back in the photo, with no glare?',
          tip: '📸 The whole back cover, square on · no glare' },
        { id: '16', req: true, label: 'Page edges: top and side together, book closed', gate: 'Can you see both edges?',
          tip: '📸 Book closed · the top and side edges together, at an angle' },
      ] },
      { head: 'Book open flat', shots: [
        { id: '11', req: true, label: 'Title page, the whole page', gate: 'Can you read the smallest print?',
          tip: '📸 Open flat at the title page · the whole page, square on' },
        { id: '12', kept: true, label: 'Copyright page' },
        { id: '27', req: true, check: true, label: 'Copyright page again, the whole page', gate: 'Can you read the number line?',
          tip: '📸 The copyright page again · the whole page, square on · flash off' },
      ] },
      { head: 'How good is the book?', grades: true, shots: [] },
      { head: 'Optional', optional: true, words: true, shots: [
        { id: '07', label: 'Cover corner or barcode panel, close up', gate: 'Can you read the small print in the corner?',
          tip: '📸 Close up on the corner of the cover, or the barcode panel' },
        { id: '14', label: 'Colophon or limitation page', gate: 'Can you read the smallest print?',
          tip: '📸 The colophon or limitation page · the whole page' },
        { id: '15', label: 'Signature or inscription', gate: 'Can you read the writing?',
          tip: '📸 The signature or inscription, close enough to read' },
        { id: '17', torch: true, label: 'Gutter: look down into the middle of the open book', gate: 'Can you see down into the gutter?',
          tip: '📸 Open in the middle · look down into the gutter · torch on' },
        { id: '23', label: 'Anything else your curator should see', gate: 'Is it sharp?',
          tip: '📸 Anything else your curator should see' },
      ] },
    ],
  },
};
// Every shot of a template, flat, in handling order (kept entries included).
function fullShotList(t) {
  const T = FULL_TEMPLATES[t];
  return T ? T.groups.reduce((a, g) => a.concat(g.shots), []) : [];
}
// A shot's entry under this template, else under the other one (a photo taken
// before "This book is different" keeps its label).
function fullShotDef(t, id) {
  return fullShotList(t).find(s => s.id === id) ||
    Object.keys(FULL_TEMPLATES).map(k => fullShotList(k).find(s => s.id === id)).find(Boolean) || null;
}
// The new required photos a template asks for (the "Whole book - N photos" count).
function fullRequiredCount(t) { return fullShotList(t).filter(s => s.req).length; }

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
// Read, change and store one record in a single step. A record that is gone stays
// gone (fn is not called), and fn returning null stores nothing; returns what was
// stored, or null.
async function dbPatch(store, key, fn) {
  const tx = (await db()).transaction(store, 'readwrite'), os = tx.objectStore(store);
  return new Promise((res, rej) => {
    let out = null;
    const g = os.get(key);
    g.onsuccess = () => {
      if (!g.result) return;
      const next = fn(g.result);
      if (next === null) return;
      out = next || g.result;
      os.put(out);
    };
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Could not save on this phone'));
  });
}
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
  // Where the phone asks for its curator's requests: one address for every
  // client. It answers only for shelf folder ids its curator has routed, and
  // Settings > Advanced can override it for testing.
  requestsUrl: 'https://script.google.com/macros/s/AKfycbzkRU2Dmg_VMjHZtDs5PrHjziX4w8M1d8h8A_8NZuxvbp4UEHIB9Xem_WXWCjqZiSzjRg/exec',
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
  if (!confirm(`Delete “${sh.label}” and its photos from this phone? Photos that were not uploaded are lost for good.`)) return;
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
// The torch, as in the vinyl app (torchOn, #btnTorch): offered only on a whole-book
// shot; torchWant is whether it starts on for the shot being opened (20 and 17).
let torchOn = false, torchWant = false;
// What the camera, the gate and the viewer are working on: a shelf frame
// (curShelf, curFrame) or a book shot (curBook, capT.shot).
let capT = { kind: 'shelf' };
function capBack() {
  return capT.kind === 'book' ? openBookCamera(capT.shot) : capT.kind === 'full' ? openFullCamera(capT.shot) : openCamera(curFrame);
}
async function openCamera(frameNo) {
  capT = { kind: 'shelf' };
  curFrame = frameNo || null;
  freeGate();
  const photos = await photosFor(curShelf.id);
  const n = curFrame || photos.length + 1;
  show('scr-camera', { title: curShelf.label, back: backToShelf });
  $('#camLabel').textContent = n > 1 || curFrame ? `${curShelf.label} · frame ${n}` : curShelf.label;
  $('#camTip').textContent = n > 1 && !curFrame
    ? '📸 Move right · overlap the last frame by about a quarter · same distance and height'
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
  // Capture minutes time the shooting: the clock starts when the camera opens on a
  // book with no photo yet, not when the request was first opened (a request read
  // at night and shot next morning once reported 504 minutes).
  if (!(await shotsFor(curBook.id)).some(x => x.blob)) { curBook.startedAt = Date.now(); await dbPut('books', curBook); }
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
  $('#btnTorch').classList.add('hidden');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return camFail('The camera needs a secure (https) address. You can still import a photo taken with the camera app.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
  } catch (e) {
    return camFail('The camera is blocked or busy. To use it here, allow Camera for bookscurator.net in your browser’s settings, then open the app again. Or take the photo with the camera app:');
  }
  const v = $('#video');
  v.srcObject = stream;
  try { await v.play(); } catch {}
  track = stream.getVideoTracks()[0];
  imageCapture = ('ImageCapture' in window) ? new ImageCapture(track) : null;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  // Flash off for a shelf and a spot-check: a shelf photo with the torch on is a row
  // of glare. A whole-book shot offers the torch, on at the start where the shot
  // needs raking light.
  const torchOk = !!caps.torch && capT.kind === 'full';
  $('#btnTorch').classList.toggle('hidden', !torchOk);
  torchOn = torchOk && torchWant;
  $('#btnTorch').classList.toggle('on', torchOn);
  if (caps.torch) track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
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
$('#btnTorch').onclick = () => {
  torchOn = !torchOn;
  $('#btnTorch').classList.toggle('on', torchOn);
  if (track) track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
};
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
  const s = capT.kind === 'book' ? BOOK_SHOTS.find(x => x.id === capT.shot)
    : capT.kind === 'full' && curBook ? fullShotDef(curBook.template, capT.shot) : null;
  $('#gatePrompt').textContent = s && s.gate ? s.gate : SHELF_GATE;
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
    if (capT.kind === 'full') return await keepFullShot(capT.shot, bmp, blob);
    const photos = await photosFor(curShelf.id);
    const n = curFrame || (photos.length ? photos[photos.length - 1].n + 1 : 1);
    await dbPut('photos', { shelfId: curShelf.id, n, blob, w: bmp.width, h: bmp.height, when: Date.now() });
    curShelf.finishedAt = null;   // a new frame reopens the shelf
    await dbPut('shelves', curShelf);
    backToShelf();
    toast(`Frame ${n} saved ✓`);
  } catch (e) {
    console.error(e);
    toast('Could not save the photo on this phone. Is its storage full?', 4000);
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
  // A photo sent at spot-check is shown, never re-shot or deleted here (locked).
  $('#btnVRetake').classList.toggle('hidden', !!p.locked);
  $('#btnVDelete').classList.toggle('hidden', !!p.locked);
  if (p.shotId && curBook && curBook.full) {
    const s = fullShotDef(curBook.template, p.shotId) || { label: '' };
    const name = FULL_NAMES[p.shotId] || s.label;
    $('#viewerName').textContent = `${curBook.title} · ${p.shotId} ${name} · ${p.w}×${p.h}`;
    $('#btnVRetake').textContent = 'Re-shoot this photo';
    $('#btnVDelete').textContent = 'Delete this photo';
    show('scr-viewer', { title: `${p.shotId} ${name}`, back: backToFull });
    return;
  }
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
$('#btnVRetake').onclick = () => {
  if (viewPhoto.locked) return;
  if (viewPhoto.shotId && curBook && curBook.full) return openFullCamera(viewPhoto.shotId);
  return viewPhoto.shotId ? openBookCamera(viewPhoto.shotId) : openCamera(viewPhoto.n);
};
$('#btnVDelete').onclick = async () => {
  if (viewPhoto.locked) return;
  if (viewPhoto.shotId && curBook && curBook.full) {
    if (!fullEditable(curBook)) return toast('Wait for the upload to finish');
    if (!confirm('Delete this photo?')) return;
    await dbDel('shots', [curBook.id, viewPhoto.shotId]);
    await fullChanged(curBook);
    return backToFull();
  }
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
      toast('Dictation is not working just now (no connection?). You can type it instead.', 3500);
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
  if (!res.ok) throw await driveError(res);
  return res.json();
}
// The message is the one every caller has always read ("Drive error 403: ..."); the
// status and the whole body ride along, so a full Drive can be told apart.
async function driveError(res) {
  const body = await res.text();
  const e = new Error('Drive error ' + res.status + ': ' + body.slice(0, 200));
  e.status = res.status;
  e.body = body;
  return e;
}
// The same call, for a file's own contents (alt=media): the text exactly as stored.
async function driveText(url) {
  const token = await getToken();
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw await driveError(res);
  return res.text();
}
// Drive's answer when her storage is full (403, reason storageQuotaExceeded).
function driveIsFull(e) {
  return !!e && e.status === 403 && /storageQuotaExceeded|storage quota/i.test(String(e.body || e.message || ''));
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
    throw new Error('Link… is for your curator only (it needs the API key and project number under Advanced). Type the folder name your curator gave you in the box instead.');
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
        'stop sharing at any time from Drive itself.\n\nIf you tap Cancel, your curator cannot see your shelves, and the app will not ask again.');
      if (!ok) {
        seen[folderId] = 'declined';
        await dbPut('kv', seen, 'sharedFolders');
        toast('Not shared. Your curator cannot see these shelves, and the app will not ask again: tell your curator.', 4500);
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
  if (u.state === 'paused') return u.why === 'check' ? '⏸ ' + FULL_WORDS.cantCheck : '⏸ Upload paused — sign in from the home screen';
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
  // Why a whole book paused ('check': the curator's list could not be read) lasts
  // only until its state changes.
  if (patch.state && !('why' in patch)) delete sh.upload.why;
  // A whole book's upload stores only its own part of the record (fullStoreUpload),
  // so a change made on the checklist meanwhile is never written over.
  if (sh.full) await fullStoreUpload(sh);
  else await dbPut(storeOf(sh), sh);
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
  st('Finding your Drive folder…');
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
      // A paused whole book waits for her tap (Upload on its checklist, or the home
      // screen's sign-in): she may be changing it, and a run started on its own would
      // send what it read before her change.
      const queue = (await uploadQueue()).filter(s => !(s.full && s.upload.state === 'paused'));
      if (!queue.length) break;
      if (!tokenFresh()) {
        for (const sh of queue) if (sh.upload.state !== 'paused') await setUpload(sh, { state: 'paused' });
        refreshUploadCards();
        break;
      }
      const sh = queue[0];
      await (sh.kind === 'book' ? (sh.full ? uploadFull(sh) : uploadBook(sh)) : uploadShelf(sh));
      // A sign-in that ran out pauses everything; a whole book paused because the
      // curator's list could not be read pauses only itself.
      if (sh.upload && sh.upload.state === 'paused' && sh.upload.why !== 'check') break;
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
const SHELF_GONE = 'Could not open this shelf’s folder. Reopen the app, sign in with your shelves’ Google account, or tell your curator';
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
  if ($('#scr-full').classList.contains('active') && curBook && curBook.full) {
    const bk = curBook;
    shotsFor(bk.id).then(shots => { if (curBook === bk) paintFullUpload(bk, fullTally(bk, shots)); });
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
    toast(`Queued ${n} ${n === 1 ? 'shelf' : 'shelves'} — uploading while you carry on`, 3200);
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
// The kinds of request this version of the app can answer. The request service
// serves any other kind only to an app that names it (an older app never sees a
// Full capture, so it can never answer one as a two-photo spot-check).
const REQ_TYPES = ['Spot-check', 'Full capture'];
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
      rep = await requestsPost({ op: 'list', v: 1, ids, types: REQ_TYPES });
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
  // A kind of request this app cannot answer is shown (asking for the newest app),
  // never reported as seen.
  const rids = items.filter(i => reqKind(i) !== 'other').map(i => i.rid).filter(r => !seen[r]).slice(0, 500);
  if (!rids.length) return;
  const rep = await requestsPost({ op: 'seen', v: 1, ids, rids, types: REQ_TYPES });
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
  const kind = reqKind(it);
  if (kind === 'other') return { key: 'todo', text: FULL_WORDS.needUpdate };
  if (kind === 'full' && bk && bk.full && bk.progress && bk.progress.started)
    return { key: 'todo', text: FULL_WORDS.progress(bk.progress.done, bk.progress.total) };
  return { key: 'todo', text: 'To do' };
}
// What a request asks for: 'spot' (blank Type counts as Spot-check), 'full' (a
// Full capture whose template this app knows), or 'other' (this app cannot answer it).
function reqKind(it) {
  const t = String(it && it.type || '').trim();
  if (!t || t === 'Spot-check') return 'spot';
  if (t === 'Full capture' && FULL_TEMPLATES[it.template]) return 'full';
  return 'other';
}
// The line under the title on the list: how many photos the book needs, by the list she is
// using (after a switch, hers; owner, 2 Oct 2026), else the one the request asks for. A
// record this request will take over keeps only her own switch, as the takeover does.
function reqKindLine(it, rec) {
  const k = reqKind(it);
  const hers = rec && FULL_TEMPLATES[rec.template] && (rec.requestId === it.rid || rec.templateWhy);
  const t = hers ? rec.template : it.template;
  return k === 'spot' ? FULL_WORDS.twoPhotos : k === 'full' ? FULL_WORDS.wholeBook(fullRequiredCount(t)) : '';
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
  const liveRids = items.map(it => it.rid);
  // Two-photo books started here whose request the list no longer returns (withdrawn
  // before they went up): kept, with Upload and Delete, so no photo is stranded.
  const started = allBooks.filter(b => !b.full && !b.uploaded && liveRids.indexOf(b.requestId) < 0).sort((a, b) => a.created - b.created);
  // Whole books on this phone whose request has left the list (filed, withdrawn or
  // closed), sent or not: listed with Delete, so their photos never fill the phone.
  // One that a new request for the same book will take over is left to it. Only
  // once the list has been read at least once.
  const hasRecord = it => !!(answered[it.rid] && books[answered[it.rid].bookId]);
  const takers = items.filter(it => reqKind(it) === 'full' && !hasRecord(it));
  const onPhone = !c.fetchedAt ? [] : allBooks.filter(b => b.full && liveRids.indexOf(b.requestId) < 0 &&
    !takers.some(it => fullAdoptable(b, it, liveRids))).sort((a, b) => a.created - b.created);
  if (!items.length) list.innerHTML = '<p class="empty">Nothing waiting.<br>Your curator\'s requests appear here.</p>';
  // Grouped by shelf, in the order the shelves were shot; within a shelf by photo, then
  // left to right; requests with no spine marked (words only) after the marked ones.
  const groupOf = it => byFolder[it.key] ? byFolder[it.key].label : held[it.key] ? held[it.key].label : (it.where || 'Other');
  const orderOf = it => byFolder[it.key] ? byFolder[it.key].created : Infinity;
  items.sort((a, b) => (orderOf(a) - orderOf(b)) || groupOf(a).localeCompare(groupOf(b)) || ((a.box ? 0 : 1) - (b.box ? 0 : 1)) ||
    String(a.box && a.box.file || '').localeCompare(String(b.box && b.box.file || '')) || ((a.box ? a.box.x : 2) - (b.box ? b.box.x : 2)));
  let cur = null;
  for (const it of items) {
    const g = groupOf(it);
    if (g !== cur) { cur = g; const h = document.createElement('h2'); h.className = 'sect'; h.textContent = g; list.appendChild(h); }
    let st = reqState(it, answered, books);
    // A whole book this request will take over (its earlier request was replaced):
    // the photos already taken count, on the list the takeover will use
    // (fullTakeTemplate), as the line above them does.
    const taken = st.key === 'todo' && takers.indexOf(it) >= 0 ? fullAdoptFor(it, allBooks, liveRids) : null;
    if (taken) {
      const tt = fullTakeTemplate(taken, it);
      const tl = FULL_TEMPLATES[tt] ? fullTally({ ...taken, template: tt }, await shotsFor(taken.id)) : null;
      if (token !== openRequests.n) return;   // a newer draw of this screen has started
      if (tl && tl.started) st = { key: 'todo', text: FULL_WORDS.progress(tl.done, tl.total) };
    }
    const row = document.createElement('button');
    row.className = 'reqitem ' + st.key;
    row.dataset.rid = it.rid;
    const kl = reqKindLine(it, (answered[it.rid] && books[answered[it.rid].bookId]) || taken);
    row.innerHTML = `<div class="rq-t">${esc(it.title || '(no title)')}</div><div class="rq-a">${esc(it.author || '')}</div>` +
      (kl ? `<div class="rq-k">${esc(kl)}</div>` : '') +
      `<div class="rq-w">${esc(it.where || '')}</div><div class="rq-s">${esc(st.text)}</div>`;
    row.onclick = () => openRequest(it.rid);
    list.appendChild(row);
  }
  if (started.length) {
    const h = document.createElement('h2'); h.className = 'sect'; h.textContent = 'No longer asked for';
    list.appendChild(h);
  }
  for (const bk of started) {
    const row = document.createElement('div');
    row.className = 'reqitem started';
    row.dataset.book = bk.id;
    row.innerHTML = `<div class="rq-t">${esc(bk.title || '(no title)')}</div><div class="rq-a">${esc(bk.author || '')}</div>` +
      `<div class="rq-s">${esc(bk.upload ? uploadLabel(bk) : 'Upload it if both photos were taken; otherwise delete it.')}</div>` +
      '<div class="row2" style="margin-top:10px"><button class="secondary st-up">☁ Upload</button><button class="secondary danger st-del">Delete</button></div>';
    const up = row.querySelector('.st-up');
    up.disabled = (uploadActive(bk) && bk.upload.state !== 'paused') || !bookReady(await shotsFor(bk.id));
    if (token !== openRequests.n) return;   // a newer draw of this screen has started
    up.onclick = () => startBookUpload(bk, up);
    row.querySelector('.st-del').onclick = () => deleteBook(bk.id, () => openRequests());
    list.appendChild(row);
  }
  if (token !== openRequests.n || !onPhone.length) return;
  const h2 = document.createElement('h2'); h2.className = 'sect'; h2.textContent = FULL_WORDS.onPhone;
  list.appendChild(h2);
  for (const bk of onPhone) {
    // Nothing more goes up for it; Delete says first whether it was ever sent.
    const row = document.createElement('div');
    row.className = 'reqitem started onphone';
    row.dataset.book = bk.id;
    // A new request for the same book (its folder and Book ID) is on the list above:
    // never "no longer asks".
    const again = !!bk.folderId && !!bk.requestBookId && items.some(it => reqKind(it) === 'full' &&
      String(it.folderId || '') === bk.folderId && String(it.bookId || '') === bk.requestBookId);
    const line = bk.upload && bk.upload.state === 'uploading' ? uploadLabel(bk) : bk.uploaded ? FULL_WORDS.onPhoneSent
      : again ? FULL_WORDS.askedAgain : FULL_WORDS.closed;
    row.innerHTML = `<div class="rq-t">${esc(bk.title || '(no title)')}</div><div class="rq-a">${esc(bk.author || '')}</div>` +
      `<div class="rq-s">${esc(line)}</div>` +
      '<div class="row2" style="margin-top:10px"><button class="secondary danger st-del">Delete</button></div>';
    row.querySelector('.st-del').onclick = () => deleteBook(bk.id, () => openRequests());
    list.appendChild(row);
  }
}
$('#btnReqCheck').onclick = async () => { $('#rqsStatus').textContent = 'Checking…'; await refreshRequests({ force: true }); openRequests(); };
function reqFreeUrl() {
  if (reqObjUrl) { URL.revokeObjectURL(reqObjUrl); reqObjUrl = null; }
  if (reqPrevUrl) { URL.revokeObjectURL(reqPrevUrl); reqPrevUrl = null; }
}
let reqPrevUrl = null;
// The spot-check answer this phone sent for a book, if it still holds it: only the
// record that went into the request's own folder. Never one found by Book ID alone:
// that could be a copy the curator refused, sent into another folder, and the
// picture is there so she picks up the right book.
async function spotRecordFor(it) {
  if (!it.folderId) return null;
  return (await dbAll('books')).find(b => !b.full && b.driveFolderId === it.folderId) || null;
}
// One request: the words, and the spine marked on this phone's own shelf photo
// (never drawn on a photo retaken after the curator saw it).
async function openRequest(rid) {
  const c = (await dbGet('kv', 'requests')) || { items: [] };
  const it = (c.items || []).find(x => x.rid === rid);
  if (!it) return openRequests();
  reqFreeUrl();
  show('scr-request', { title: 'Request', back: () => { reqFreeUrl(); openRequests(); } });
  $('#btnRqShoot').onclick = () => openBookFromRequest(rid);
  $('#btnRqShoot').dataset.rid = rid;
  $('#rqTitle').textContent = it.title || '';
  $('#rqAuthor').textContent = it.author || '';
  $('#rqWhere').textContent = it.where || '';
  $('#rqAsked').textContent = it.asked || '';
  const wrap = $('#rqPhoto'), note = $('#rqNote');
  wrap.innerHTML = '';
  note.textContent = '';
  // What kind of request: a spot-check reads exactly as before; a whole book names
  // its template and shows the jacket front sent earlier; anything else asks for
  // the newest app.
  const kind = reqKind(it), shootBtn = $('#btnRqShoot'), kindEl = $('#rqKind'), prev = $('#rqPrev');
  shootBtn.disabled = false;
  shootBtn.classList.toggle('hidden', kind === 'other');
  shootBtn.textContent = kind === 'full' ? FULL_WORDS.shoot : 'Photograph this book';
  kindEl.textContent = kind === 'full' ? FULL_WORDS.templates[it.template] : '';
  kindEl.classList.toggle('hidden', kind !== 'full');
  prev.innerHTML = '';
  if (kind === 'other') { note.textContent = FULL_WORDS.needUpdate; return; }
  if (kind === 'full') {
    const sp = await spotRecordFor(it);
    const p01 = sp ? (await shotsFor(sp.id)).find(x => x.shotId === '01' && x.blob) : null;
    if (p01) {
      reqPrevUrl = URL.createObjectURL(await keptThumb(p01));
      prev.innerHTML = `<img class="rq-prev" alt="01" src="${reqPrevUrl}"><span class="hint">01 · ${esc(FULL_WORDS.sentEarlier)}</span>`;
    }
  }
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
  // By the request's type: a Full capture opens the whole-book checklist; a kind
  // this app does not know is never answered as a two-photo spot-check.
  const kind = it ? reqKind(it) : 'spot';
  if (kind === 'full') return openFullFromRequest(rid);
  if (kind === 'other') { toast(FULL_WORDS.needUpdate, 6000); return; }
  const a = (await answeredMap())[rid];
  let bk = a && a.bookId ? await dbGet('books', a.bookId) : null;
  // A whole book whose request has left her list is closed on the phone: never the
  // two-photo screen (the list keeps it, with Delete).
  if (bk && bk.full) return openRequests();
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
  // A whole book says first whether it was ever sent (book.json written, or tried:
  // its answer may have been lost), and whether its last changes were.
  const ask = !bk.full ? 'This book answers a request from your curator; delete it from the phone anyway?'
    : bk.uploaded ? FULL_WORDS.deleteSent : (bk.manifestAt || bk.manifestTry) ? FULL_WORDS.deleteChanged : FULL_WORDS.deleteUnsent;
  if (!confirm(ask)) return;
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

/* ---------- the whole book: a Full capture request ----------
 * The curator asks for the rest of a book whose two spot-check photos are filed.
 * The request names that book's own answer folder; the phone checks it by id
 * (root, bin, the row's Book ID in its book.json, 01 and 12 listed) before
 * anything else and never makes a folder (never bookFolderFor). 01 and 12 stay
 * locked: shown as "Sent earlier", never sent again. New files sit beside the
 * old ones under the folder's own filing words. book.json goes last,
 * with the spot-check record kept whole beside it (book.spot.json) and in
 * `previous`. One record per request on this phone, pointed at from answered[rid].
 */
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_LIST = 'https://www.googleapis.com/drive/v3/files';
const SPOT_JSON = 'book.spot.json';
const ASIDE_PREFIX = '_not this book ';
let fullThumbs = [];

function fullGone(why) { const e = new Error(FULL_WORDS.folderGone); e.fullGone = true; e.why = why; return e; }
// The filing words: the text before " - 01 " in the 01 file the folder's book.json
// lists (the last " - 01 ", so a title that starts with a number reads right).
function filingWordsOf(file) {
  const f = String(file || '');
  const i = f.lastIndexOf(' - 01 ');
  if (i <= 0 || !/\.jpg$/i.test(f)) return '';
  const w = f.slice(0, i);
  return /[\\/]/.test(w) || !w.trim() ? '' : w;
}
// Every file a manifest lists, photos and texts.
function listedNames(m) {
  if (!m || typeof m !== 'object') return [];
  return [].concat(Array.isArray(m.photos) ? m.photos : [], Array.isArray(m.texts) ? m.texts : [])
    .map(p => p && typeof p.file === 'string' ? p.file : '').filter(Boolean);
}
function localDay() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
// A whole book on this phone that a new request may take over: its own request has
// left the list (the curator withdrew it and asked again, say to fix the template or
// the words), the new one names the same folder and the same Book ID, and it never
// wrote book.json, so the curator never saw it and never refused it ("Not this book"
// refuses only a capture he saw). Never one that tried to write book.json (manifestTry:
// the write may have landed though its answer was lost), and the takeover also reads
// the folder (fullWroteIn). Not while it is going up.
function fullAdoptable(rec, it, liveRids) {
  return !!rec && !!rec.full && !rec.manifestAt && !rec.manifestTry && !rec.uploaded && rec.requestId !== it.rid &&
    liveRids.indexOf(rec.requestId) < 0 && !!it.folderId && rec.folderId === String(it.folderId) &&
    !!rec.requestBookId && rec.requestBookId === String(it.bookId || '') &&
    !(rec.upload && /^(queued|uploading)$/.test(rec.upload.state));
}
// The newest such record, if any.
function fullAdoptFor(it, allBooks, liveRids) {
  return allBooks.filter(b => fullAdoptable(b, it, liveRids)).sort((a, b) => b.created - a.created)[0] || null;
}
// The book.json this record wrote, if the folder shows one: a full capture's record
// (manifest 2) of its request or of this record, the folder's own book.json or one
// kept in the `previous` of a later one. Such a capture reached the curator.
function fullWroteIn(m, rec) {
  for (let p = m, n = 0; p && typeof p === 'object' && !Array.isArray(p) && n < 50; p = p.previous, n++) {
    if (p.manifest === 2 && ((!!rec.requestId && p.requestId === rec.requestId) || (!!rec.id && p.appBookId === rec.id))) return p;
  }
  return null;
}
// The list a whole book taken over by request `it` will use: her own switch to the
// other list (templateWhy) stands; otherwise the list the request asks for.
function fullTakeTemplate(rec, it) {
  return rec.templateWhy && rec.template !== it.template ? rec.template : it.template;
}
// What a whole-book record takes from its request and its checked folder.
function fullFromItem(it, chk) {
  const box = it.box && typeof it.box === 'object' ? it.box : null;
  return {
    author: String(it.author || ''), title: String(it.title || ''),
    filing: { words: chk.words, author: chk.author, title: chk.title },
    requestId: it.rid, requestBookId: String(it.bookId || ''), folderId: chk.folder.id, folderName: chk.folder.name,
    shelfRef: { shelfId: String(it.shelfId || ''), shelfFolderId: it.key, file: box ? String(box.file || '') : '',
      box: box ? [box.x, box.y, box.w, box.h] : null, where: String(it.where || '') },
    asked: String(it.asked || ''),
  };
}
// No connection (or Google's sign-in could not load): the browser's own words are
// no help to her.
function isOffline(e) {
  const m = String((e && e.message) || e || '');
  return navigator.onLine === false || (e instanceof TypeError) || /offline|Failed to fetch|Load failed|NetworkError/i.test(m);
}
// Is this request still asked for? Asked of the request service itself, never the
// list kept on this phone (that one may be minutes old, and a photo sent after the
// curator filed the book would replace the one he filed): 'live', 'gone' (the
// service answered and does not serve it), or 'unknown' (no good answer, or the
// service could not open the curator's sheet just now).
async function fullStillAsked(bk) {
  const key = String((bk.shelfRef && bk.shelfRef.shelfFolderId) || '');
  if (!requestsUrl() || !REQ_KEY_RE.test(key)) return 'unknown';
  let rep = null;
  for (let a = 1; a <= 2 && !rep; a++) {
    rep = await requestsPost({ op: 'list', v: 1, ids: [key], types: REQ_TYPES });
    if (!(rep && rep.ok === true && Array.isArray(rep.items))) {
      rep = null;
      if (a < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (!rep) return 'unknown';
  if (Array.isArray(rep.unavailable) && rep.unavailable.indexOf(key) >= 0) return 'unknown';
  return rep.items.some(x => reqItemOk(x) && x.rid === bk.requestId && x.key === key) ? 'live' : 'gone';
}
// The service no longer serves it: take it off the list kept on this phone too.
async function dropCachedRequest(rid) {
  const c = await dbGet('kv', 'requests');
  if (!c || !Array.isArray(c.items) || !c.items.some(x => x && x.rid === rid)) return;
  await dbPut('kv', { ...c, items: c.items.filter(x => !x || x.rid !== rid) }, 'requests');
  renderReqCard();
}
// The folder the request names: it opens with her sign-in and is not in the bin;
// it sits in the root found from the shelf's own folder (by id, never the name in
// Settings); its one book.json names this row (requestBookId) and lists 01 and 12.
// Any failure is "can't open this book's folder": nothing written, no folder made.
async function fullFolderCheck(ref) {
  const fid = String(ref.folderId || '');
  if (!REQ_KEY_RE.test(fid) || !ref.bookId) throw fullGone('no folder id');
  let root;
  try { root = await requestRootFolder(ref.shelfFolderId); }
  catch (e) { if (String(e && e.message) === SHELF_GONE) throw fullGone('shelf root'); throw e; }
  let f;
  try { f = await drive(DRIVE_FILES + encodeURIComponent(fid) + '?fields=id,name,mimeType,parents,trashed'); }
  catch (e) { if (/Drive error (403|404)/.test(String(e.message))) throw fullGone('folder'); throw e; }
  if (!f || f.id !== fid || f.trashed || f.mimeType !== FOLDER_MIME || !Array.isArray(f.parents) ||
      f.parents.length !== 1 || f.parents[0] !== root.id) throw fullGone('folder place');
  const q = `name='book.json' and '${fid}' in parents and trashed=false`;
  const r = await drive(DRIVE_LIST + '?q=' + encodeURIComponent(q) + '&fields=files(id,name)');
  const hits = (r && r.files) || [];
  if (hits.length !== 1) throw fullGone('book.json count ' + hits.length);
  let text;
  try { text = await driveText(DRIVE_FILES + encodeURIComponent(hits[0].id) + '?alt=media'); }
  catch (e) { if (/Drive error (403|404)/.test(String(e.message))) throw fullGone('book.json read'); throw e; }
  let m = null;
  try { m = JSON.parse(text); } catch (e) { m = null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.bookCurator !== 1 || m.kind !== 'book') throw fullGone('not a book');
  if (String(m.requestBookId || '') !== String(ref.bookId)) throw fullGone('another row');
  const photos = Array.isArray(m.photos) ? m.photos.filter(p => p && typeof p === 'object') : [];
  const kept = {};
  for (const id of FULL_KEPT) {
    const ps = photos.filter(p => p.shot === id);
    if (ps.length !== 1 || typeof ps[0].file !== 'string' || !ps[0].file) throw fullGone('no ' + id);
    kept[id] = { file: ps[0].file, w: ps[0].w == null ? null : ps[0].w, h: ps[0].h == null ? null : ps[0].h };
  }
  const words = filingWordsOf(kept['01'].file);
  if (!words) throw fullGone('filing words');
  return { root, folder: { id: f.id, name: f.name }, book: { id: hits[0].id, text, m }, words, kept,
    author: String(m.author || ''), title: String(m.title || '') };
}
// Ask once, before the first whole book, that the browser keep the photos stored
// on this phone (a whole book is many photos, and some go up only later).
async function askPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;
    if (await dbGet('kv', 'persistAsked')) return;
    if (!(navigator.storage.persisted && await navigator.storage.persisted())) await navigator.storage.persist();
    await dbPut('kv', Date.now(), 'persistAsked');
  } catch (e) { /* a refusal never blocks the capture */ }
}
async function openFullFromRequest(rid) {
  const c = (await dbGet('kv', 'requests')) || { items: [] };
  const it = (c.items || []).find(x => x.rid === rid);
  if (!it) return openRequests();
  if (reqKind(it) !== 'full') { toast(FULL_WORDS.needUpdate, 6000); return; }
  const a = (await answeredMap())[rid];
  const had = a && a.bookId ? await dbGet('books', a.bookId) : null;
  // Leaving and coming back reopens the checklist with its ticks (no network needed).
  if (had && had.full && had.folderId === String(it.folderId || '')) { curBook = had; reqFreeUrl(); return backToFull(); }
  const btn = $('#btnRqShoot'), note = $('#rqNote');
  // The check takes a few calls to Drive. If she has moved to another screen by the
  // time it answers, it never takes that screen over or writes on it.
  const here = () => $('#scr-request').classList.contains('active') && btn.dataset.rid === rid;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  let chk;
  try {
    if (!cred('clientId')) throw new Error('This build has no Google Client ID yet — add one in ⚙ Settings');
    chk = await fullFolderCheck({ folderId: it.folderId, shelfFolderId: it.key, bookId: it.bookId });
  } catch (e) {
    console.error('full capture check', rid, (e && e.why) || e);
    if (!here()) return;
    // The first opening checks her folder in Drive; with no connection she is told
    // so in plain words (once the checklist is on the phone, shooting works offline).
    const msg = e && e.fullGone ? FULL_WORDS.folderGone : isOffline(e) ? FULL_WORDS.firstOpenOnline : (e && e.message) || String(e);
    if (e && e.fullGone || msg === FULL_WORDS.firstOpenOnline) note.textContent = msg;
    toast(msg, 6000);
    btn.disabled = false;
    btn.textContent = FULL_WORDS.shoot;
    return;
  }
  await askPersist();
  // A second tap that checked at the same time has made the record already: use it.
  const a2 = (await answeredMap())[rid];
  const had2 = a2 && a2.bookId ? await dbGet('books', a2.bookId) : null;
  if (had2 && had2.full && had2.folderId === chk.folder.id) {
    if (here()) { curBook = had2; reqFreeUrl(); backToFull(); }
    return;
  }
  const t = it.template;
  // A whole book begun here under a request the curator has since replaced (same
  // folder, same Book ID, never sent): this request takes it over with its photos and
  // choices, so nothing is stranded and nothing is shot twice.
  const live = ((((await dbGet('kv', 'requests')) || {}).items) || []).map(x => x && x.rid);
  // Never one whose book.json is in this folder (the phone may not know it landed):
  // the curator may have seen it and refused it. It is marked as having written
  // book.json, so the list and Delete say so, and this request starts afresh.
  for (const b of await dbAll('books')) {
    const m = fullAdoptable(b, it, live) ? fullWroteIn(chk.book.m, b) : null;
    if (m) await dbPatch('books', b.id, r => { if (r.manifestAt) return null; r.manifestAt = Date.parse(m.updated) || Date.now(); return r; });
  }
  const old = fullAdoptFor(it, await dbAll('books'), live);
  let bk = null;
  if (old) {
    const shots = await shotsFor(old.id);
    let ready = false;
    bk = await dbPatch('books', old.id, r => {
      if (!fullAdoptable(r, it, live)) return null;
      Object.assign(r, fullFromItem(it, chk));
      r.kept = chk.kept;
      r.askedTemplate = t;
      // Her own switch stands; otherwise the list the request asks for (fullTakeTemplate,
      // which the Requests list counts by too).
      if (fullTakeTemplate(r, it) === t) { r.template = t; r.templateWhy = ''; }
      delete r.upload;
      r.uploaded = null;
      r.rev = (r.rev || 0) + 1;
      const tl = fullTally(r, shots);
      ready = tl.ready;
      r.finishedAt = tl.ready ? (r.finishedAt || Date.now()) : null;
      r.progress = { done: tl.done, total: tl.total, started: tl.started };
      return r;
    });
    if (bk && bk.requestId === rid) await setAnswered(rid, { bookId: bk.id, ready, uploaded: null });
    else bk = null;
  }
  if (!bk) {
    bk = {
      id: Date.now().toString(36), kind: 'book', full: true, requestType: 'Full capture',
      template: t, askedTemplate: t, templateWhy: '',
      ...fullFromItem(it, chk), note: '',
      kept: chk.kept, skipped: {}, grades: { jacket: null, book: null }, flags: { jacket: [], book: [] },
      operator: settings.operator || '', created: Date.now(), startedAt: Date.now(), finishedAt: null,
      sent: {}, fileIds: {}, aside: null, progress: { done: 0, total: fullRequiredCount(t), started: false }, rev: 0,
    };
    await dbPut('books', bk);
    await setAnswered(rid, { bookId: bk.id, ready: false, uploaded: null });
  }
  // Checked and kept: the next tap opens it at once, even if she has moved on.
  if (!here()) return;
  curBook = bk;
  reqFreeUrl();
  backToFull();
}
// A "Can't take this one" reason: 'not-on-book', 'missing', or 'other: <typed line>'.
function whyKey(why) { return /^other:/.test(String(why || '')) ? 'other' : String(why || ''); }
function whyText(why) { return String(why || '').replace(/^other: ?/, ''); }
function fullSkipOk(why) { const k = whyKey(why); return k === 'other' ? !!whyText(why).trim() : !!FULL_WORDS.cantWhy[k]; }
// Required entries done (taken, or marked can't with a reason), and the grades.
function fullTally(bk, shots) {
  const T = FULL_TEMPLATES[bk.template];
  const req = fullShotList(bk.template).filter(s => s.req);
  const sk = bk.skipped || {};
  const got = id => shots.some(x => x.shotId === id && x.blob);
  const done = req.filter(s => got(s.id) || fullSkipOk(sk[s.id])).length;
  const g = bk.grades || {};
  const gradesOk = !!T && T.grades.every(k => g[k] != null);
  const started = shots.some(x => x.blob) || req.some(s => sk[s.id]);
  return { done, total: req.length, gradesOk, ready: !!T && done === req.length && gradesOk, started };
}
// May the book be changed now? Not while it is queued or going up.
function fullEditable(bk) { return !!bk && !(uploadActive(bk) && bk.upload.state !== 'paused'); }
// The upload and the checklist each work on their own copy of a whole book's record,
// and each stores only its own part, in one step (dbPatch): the upload stores what
// it sent, the files' ids, any move aside, its state, when it last tried to write
// book.json and when it last wrote it (FULL_UP_KEYS, and `uploaded` when it is done);
// the checklist stores everything
// else. So neither ever writes back an older copy of the other's part (which would
// send files again, move this capture's own files aside as if they were a refused
// one's, or undo a change made while the files went up). Every change she makes
// counts one more revision (`rev`); an upload that finds the revision moved goes
// round again rather than calling the book Sent.
const FULL_UP_KEYS = ['upload', 'sent', 'fileIds', 'aside', 'manifestTry', 'manifestAt'];
function fullTakeUp(bk, rec) {
  for (const k of FULL_UP_KEYS.concat(['uploaded', 'rev'])) { if (rec && k in rec) bk[k] = rec[k]; else delete bk[k]; }
  bk.sent = bk.sent || {};
  bk.fileIds = bk.fileIds || {};
  if (!('aside' in bk)) bk.aside = null;
}
async function fullSyncStored(bk) {
  const stored = await dbGet('books', bk.id);
  if (stored) fullTakeUp(bk, stored);
}
async function fullStoreUpload(bk) {
  return dbPatch('books', bk.id, r => {
    for (const k of FULL_UP_KEYS) { if (k in bk) r[k] = bk[k]; else delete r[k]; }
    return r;
  });
}
// The checklist's part; `changed` counts a new revision and means "not Sent".
async function fullStoreScreen(bk, changed) {
  const rec = await dbPatch('books', bk.id, r => {
    const out = { ...bk };
    for (const k of FULL_UP_KEYS.concat(['uploaded', 'rev'])) { if (k in r) out[k] = r[k]; else delete out[k]; }
    if (changed) { out.uploaded = null; out.rev = (r.rev || 0) + 1; }
    return out;
  });
  if (rec) fullTakeUp(bk, rec);
  return rec;
}
// Anything kept, deleted, marked or chosen: the book is no longer what was sent.
async function fullChanged(bk) {
  const t = fullTally(bk, await shotsFor(bk.id));
  bk.finishedAt = t.ready ? Date.now() : null;
  bk.progress = { done: t.done, total: t.total, started: t.started };
  await fullStoreScreen(bk, true);
  await setAnswered(bk.requestId, { bookId: bk.id, ready: t.ready, uploaded: null });
  return t;
}
function backToFull() {
  stopCam();
  stopLevel();
  freeGate();
  stopVoice();
  if (!curBook || !curBook.full) return openRequests();
  show('scr-full', { title: 'Book', back: async () => { await leaveFull(); openRequest(curBook.requestId); } });
  renderFull();
}
// The note, the copyright words and any typed "Other" reason are read off the
// screen when it is left (dictation fills the boxes without a change event).
async function leaveFull() {
  stopVoice();
  const bk = curBook;
  if (!bk || !bk.full || !$('#scr-full').classList.contains('active') || !fullEditable(bk)) return;
  // Only what the screen shows of THIS book: while it is still being drawn the boxes
  // are empty (renderFull), never another book's words.
  if ($('#scr-full').dataset.book !== bk.id) return;
  let note = $('#inFlNote').value.trim();
  if (note === NOTE_START.trim()) note = '';
  const words = tidyVerbatim($('#inFlWords').value);
  const had = (await shotsFor(bk.id)).find(x => x.shotId === FULL_TEXT.id);
  const wordsChanged = words !== (had ? had.text || '' : '');
  let changed = note !== (bk.note || '') || wordsChanged;
  bk.skipped = bk.skipped || {};
  $$('#flList .fl-other').forEach(inp => {
    const id = inp.dataset.shot, cur = bk.skipped[id];
    if (whyKey(cur) !== 'other') return;
    const v = 'other: ' + inp.value.replace(/\s+/g, ' ').trim();
    if (v !== cur) { bk.skipped[id] = v; changed = true; }
  });
  if (!changed) return;
  bk.note = note;
  if (wordsChanged) {
    if (words) await dbPut('shots', { bookId: bk.id, shotId: FULL_TEXT.id, text: words, when: Date.now() });
    else if (had) await dbDel('shots', [bk.id, FULL_TEXT.id]);
  }
  await fullChanged(bk);
}
async function renderFull() {
  const bk = curBook;
  if (!bk || !bk.full) return;
  const scr = $('#scr-full');
  // Another book (or the first drawing since the app opened): empty the boxes and the
  // list before waiting for anything, so a tap or Back in that moment can neither
  // read the last book's note and words into this one nor act on its rows; the
  // screen is stamped with this book only once it shows this book's own values.
  if (scr.dataset.book !== bk.id) {
    scr.dataset.book = '';
    $('#flList').innerHTML = '';
    $('#flExtra').innerHTML = '';
    $('#inFlNote').value = '';
    $('#inFlWords').value = '';
    $('#btnFlUpload').disabled = true;
  }
  const shots = await shotsFor(bk.id);
  const spot = await spotRecordFor({ folderId: bk.folderId, bookId: bk.requestBookId });
  // 01 and 12 from the spot-check carry no small copy: one is made once a session.
  const spotShots = await Promise.all((spot ? await shotsFor(spot.id) : [])
    .map(async x => FULL_KEPT.indexOf(x.shotId) >= 0 && x.blob ? { ...x, thumb: await keptThumb(x) } : x));
  if (curBook !== bk || !$('#scr-full').classList.contains('active')) return;
  fullThumbs.forEach(u => URL.revokeObjectURL(u));
  fullThumbs = [];
  $('#flTitle').textContent = bk.title || '(no title)';
  $('#flAuthor').textContent = bk.author ? 'by ' + bk.author : '';
  $('#flWhere').textContent = (bk.shelfRef && bk.shelfRef.where) || '';
  $('#flAsked').textContent = bk.asked || '';
  $('#flAsked').classList.toggle('hidden', !bk.asked);
  $('#inFlNote').value = bk.note || '';
  $('#flNoteWrap').classList.toggle('hidden', !bk.note);
  $('#btnFlDifferent').classList.toggle('hidden', !!bk.note);
  $('#flKind').textContent = FULL_WORDS.templates[bk.template] || '';
  $('#btnFlSwitch').textContent = FULL_WORDS.switchLink[bk.template === 'hc' ? 'pb' : 'hc'];
  $('#flSwitch').classList.add('hidden');
  const T = FULL_TEMPLATES[bk.template];
  const list = $('#flList');
  list.innerHTML = '';
  for (const g of T.groups) {
    if (g.optional) { const hr = document.createElement('hr'); hr.className = 'fl-line'; list.appendChild(hr); }
    const h = document.createElement('h2');
    h.className = 'sect';
    h.textContent = g.optional ? FULL_WORDS.optional : g.head;
    list.appendChild(h);
    for (const s of g.shots) list.appendChild(fullShotRow(bk, s, shots, spotShots));
    if (g.grades) for (const k of T.grades) list.appendChild(fullGradeBox(bk, k));
  }
  // Photos taken before "This book is different" that the new list does not ask
  // for: kept, and sent with the rest (the curator can leave one out).
  const inT = new Set(fullShotList(bk.template).map(s => s.id));
  const extra = $('#flExtra');
  extra.innerHTML = '';
  const extras = shots.filter(x => x.blob && !inT.has(x.shotId) && FULL_NAMES[x.shotId]);
  if (extras.length) {
    const h = document.createElement('h2');
    h.className = 'sect';
    h.textContent = FULL_WORDS.alsoTaken;
    extra.appendChild(h);
    for (const x of extras) extra.appendChild(fullShotRow(bk, fullShotDef(bk.template, x.shotId), shots, spotShots, true));
  }
  const words = shots.find(x => x.shotId === FULL_TEXT.id);
  $('#inFlWords').value = words ? words.text || '' : '';
  $('#btnFlWordsVoice').classList.toggle('hidden', !SpeechRec);
  $('#btnFlNoteVoice').classList.toggle('hidden', !SpeechRec);
  $('#flKeepOpen').textContent = FULL_WORDS.keepOpen;
  scr.dataset.book = bk.id;
  paintFullUpload(bk, fullTally(bk, shots));
}
// One line of the checklist: a kept shot (Sent earlier, locked), or a shot to take,
// with "Can't take this one" on a required one.
function fullShotRow(bk, s, shots, spotShots, extra) {
  const row = document.createElement('div');
  row.dataset.shot = s.id;
  if (s.kept) {
    const held = spotShots.find(x => x.shotId === s.id && x.blob);
    row.className = 'bkshot got kept';
    let thumb = '<span class="bk-thumb empty">✓</span>';
    if (held) { const u = URL.createObjectURL(held.thumb || held.blob); fullThumbs.push(u); thumb = `<img class="bk-thumb" alt="${esc(s.id)}" src="${u}">`; }
    row.innerHTML = `<button class="bk-view" aria-label="View ${esc(s.id)}">${thumb}</button>` +
      `<div class="bk-body"><div class="bk-name">${esc(s.id)} ${esc(s.label)}</div>` +
      `<div class="fl-kept">✓ ${esc(FULL_WORDS.sentEarlier)}</div></div>`;
    row.querySelector('.bk-view').onclick = () => { if (held) openViewer({ ...held, locked: true }); };
    return row;
  }
  const got = shots.find(x => x.shotId === s.id && x.blob);
  const why = extra ? '' : (bk.skipped || {})[s.id] || '';
  const wk = whyKey(why);
  row.className = 'bkshot' + (got ? ' got' : fullSkipOk(why) ? ' got skip' : '');
  let thumb = '<span class="bk-thumb empty">📷</span>';
  if (got) { const u = URL.createObjectURL(got.thumb || got.blob); fullThumbs.push(u); thumb = `<img class="bk-thumb" alt="${esc(s.id)}" src="${u}">`; }
  else if (fullSkipOk(why)) thumb = '<span class="bk-thumb empty">–</span>';
  const label = s.check ? `${s.label}: ${FULL_WORDS.checkLine}` : s.label;
  let html = `<button class="bk-view" aria-label="${got ? 'View' : 'Take'} ${esc(s.id)}">${thumb}</button>` +
    `<div class="bk-body"><div class="bk-name">${s.req && !extra ? '<span class="bk-req">●</span> ' : ''}${esc(s.id)} ${esc(label)}</div>` +
    `<button class="bk-take">${got ? 'Re-shoot' : '📷 Take this photo'}</button>`;
  if (s.req && !got && !extra) {
    html += `<button class="linkbtn fl-cant">${esc(FULL_WORDS.cant)}${wk ? ': ' + esc(FULL_WORDS.cantWhy[wk] || '') : ''}</button>` +
      `<div class="chips fl-why${wk ? '' : ' hidden'}">` +
      Object.keys(FULL_WORDS.cantWhy).map(k => `<button class="chip${wk === k ? ' on' : ''}" data-why="${k}">${esc(FULL_WORDS.cantWhy[k])}</button>`).join('') +
      '</div>' +
      `<input type="text" class="fl-other${wk === 'other' ? '' : ' hidden'}" data-shot="${esc(s.id)}" autocomplete="off" autocapitalize="sentences" placeholder="${esc(FULL_WORDS.cantOther)}">`;
  }
  row.innerHTML = html + '</div>';
  row.querySelector('.bk-take').onclick = () => openFullCamera(s.id);
  row.querySelector('.bk-view').onclick = () => got ? openViewer(got) : openFullCamera(s.id);
  const cant = row.querySelector('.fl-cant');
  if (cant) {
    const other = row.querySelector('.fl-other');
    other.value = whyText(why);
    cant.onclick = () => row.querySelector('.fl-why').classList.toggle('hidden');
    row.querySelectorAll('.fl-why .chip').forEach(c => c.onclick = () => fullSetSkip(s.id, c.dataset.why, other.value));
    other.onchange = () => { if (whyKey((curBook.skipped || {})[s.id]) === 'other') fullSetSkip(s.id, 'other', other.value, true); };
  }
  return row;
}
// Mark a required shot "can't take", with its reason; the same chip again clears it.
async function fullSetSkip(id, k, typed, keep) {
  const bk = curBook;
  if (!fullEditable(bk)) return toast('Wait for the upload to finish');
  await leaveFull();
  bk.skipped = bk.skipped || {};
  if (!keep && whyKey(bk.skipped[id]) === k) delete bk.skipped[id];
  else bk.skipped[id] = k === 'other' ? 'other: ' + String(typed || '').replace(/\s+/g, ' ').trim() : k;
  await fullChanged(bk);
  await renderFull();
  if (k === 'other' && bk.skipped[id]) {
    const inp = $(`#flList .fl-other[data-shot="${id}"]`);
    if (inp && !inp.value) inp.focus();
  }
}
// A grade picker (one plain line per grade, plus Not sure) and its flag chips.
function fullGradeBox(bk, k) {
  const box = document.createElement('div');
  box.className = 'fl-grade';
  box.dataset.grade = k;
  const cur = (bk.grades || {})[k];
  const lines = k === 'jacket' ? FULL_WORDS.jacketGradeLines : FULL_WORDS.gradeLines;
  const opts = FULL_GRADES.map(g => `<button class="grow${cur === g ? ' on' : ''}" data-g="${esc(g)}"><b>${esc(g)}</b><span>${esc(lines[g])}</span></button>`).join('') +
    `<button class="grow${cur === '' ? ' on' : ''}" data-g=""><b>${esc(FULL_WORDS.notSure)}</b><span>${esc(FULL_WORDS.notSureLine)}</span></button>`;
  const flags = FULL_FLAGS[k].map(f => `<button class="chip${((bk.flags || {})[k] || []).includes(f) ? ' on' : ''}" data-flag="${esc(f)}">${esc(f)}</button>`).join('');
  box.innerHTML = `<div class="fl-ghead">${esc(FULL_WORDS.gradeHeads[k])}</div><div class="grows">${opts}</div><div class="chips fl-flags">${flags}</div>`;
  box.querySelectorAll('.grow').forEach(b => b.onclick = () => fullSetGrade(k, b.dataset.g));
  box.querySelectorAll('.fl-flags .chip').forEach(c => c.onclick = () => fullToggleFlag(k, c.dataset.flag));
  return box;
}
async function fullSetGrade(k, g) {
  const bk = curBook;
  if (!fullEditable(bk)) return toast('Wait for the upload to finish');
  if (g !== '' && FULL_GRADES.indexOf(g) < 0) return;
  await leaveFull();
  bk.grades = { ...(bk.grades || {}), [k]: g };
  await fullChanged(bk);
  await renderFull();
}
async function fullToggleFlag(k, f) {
  const bk = curBook;
  if (!fullEditable(bk)) return toast('Wait for the upload to finish');
  if (FULL_FLAGS[k].indexOf(f) < 0) return;
  await leaveFull();
  const set = new Set(((bk.flags || {})[k]) || []);
  if (set.has(f)) set.delete(f); else set.add(f);
  bk.flags = { ...(bk.flags || {}), [k]: FULL_FLAGS[k].filter(x => set.has(x)) };
  await fullChanged(bk);
  await renderFull();
}
// "This book is different": the other list, with a reason. Every photo is kept;
// one file name per shot number, so a switch never leaves two files for a shot.
$('#btnFlSwitch').onclick = () => {
  const bk = curBook;
  if (!bk || !bk.full) return;
  if (!fullEditable(bk)) return toast('Wait for the upload to finish');
  const to = bk.template === 'hc' ? 'pb' : 'hc';
  const panel = $('#flSwitch');
  panel.dataset.to = to;
  panel.dataset.why = '';
  $('#flSwitchQ').textContent = FULL_WORDS.switchTo[to];
  $('#flSwitchKeep').textContent = FULL_WORDS.switchKeep;
  const chips = $('#flSwitchChips');
  chips.innerHTML = [['as', FULL_WORDS.switchWhy[to]], ['other', FULL_WORDS.cantWhy.other]]
    .map(([k, w]) => `<button class="chip" data-k="${k}">${esc(w)}</button>`).join('');
  chips.querySelectorAll('.chip').forEach(c => c.onclick = () => {
    panel.dataset.why = c.dataset.k;
    chips.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    $('#inFlSwitchOther').classList.toggle('hidden', c.dataset.k !== 'other');
    if (c.dataset.k === 'other') $('#inFlSwitchOther').focus();
  });
  $('#inFlSwitchOther').value = '';
  $('#inFlSwitchOther').placeholder = FULL_WORDS.cantOther;
  $('#inFlSwitchOther').classList.add('hidden');
  $('#btnFlSwitchGo').textContent = FULL_WORDS.switchGo;
  $('#btnFlSwitchNo').textContent = FULL_WORDS.cancel;
  panel.classList.remove('hidden');
};
$('#btnFlSwitchNo').onclick = () => $('#flSwitch').classList.add('hidden');
$('#btnFlSwitchGo').onclick = async () => {
  const bk = curBook, panel = $('#flSwitch');
  if (!bk || !bk.full || !fullEditable(bk)) return;
  const to = panel.dataset.to, k = panel.dataset.why;
  const typed = $('#inFlSwitchOther').value.replace(/\s+/g, ' ').trim();
  if (!FULL_TEMPLATES[to] || !k || (k === 'other' && !typed)) return toast(FULL_WORDS.cantOther);
  await leaveFull();
  bk.template = to;
  bk.templateWhy = to === bk.askedTemplate ? '' : k === 'other' ? 'other: ' + typed : FULL_WORDS.switchWhy[to];
  await fullChanged(bk);
  await renderFull();
  toast(FULL_WORDS.templates[to] + ' ✓');
};
function paintFullUpload(bk, t) {
  const up = uploadActive(bk), paused = !!(bk.upload && bk.upload.state === 'paused');
  const btn = $('#btnFlUpload');
  btn.disabled = !t.ready || (up && !paused) || !!bk.uploaded;
  btn.textContent = paused ? (bk.upload.why === 'check' ? FULL_WORDS.tryAgain : '☁ Sign in to continue the upload') : up ? uploadLabel(bk) : bk.uploaded ? FULL_WORDS.sent
    : t.done < t.total ? FULL_WORDS.progress(t.done, t.total) : '☁ Upload to Google Drive';
  $('#flProgress').textContent = FULL_WORDS.progress(t.done, t.total);
  const lock = up && !paused;
  ['#inFlNote', '#inFlWords', '#btnFlNoteVoice', '#btnFlWordsVoice', '#btnFlDifferent', '#btnFlSwitch'].forEach(q => { $(q).disabled = lock; });
  $$('#flList .grow, #flList .chip, #flList .fl-other, #flList .fl-cant').forEach(x => { x.disabled = lock; });
  const T = FULL_TEMPLATES[bk.template];
  $('#flStatus').textContent = bk.upload && (bk.upload.state === 'failed' || (paused && bk.upload.why === 'check')) ? uploadLabel(bk)
    : t.done === t.total && !t.gradesOk ? (T.grades.length > 1 ? FULL_WORDS.chooseGrades : FULL_WORDS.chooseGrade) : '';
  $('#flKeepOpen').classList.toggle('hidden', !!bk.uploaded && !up);
}
// A shot of the whole book: the loupe gate as at spot-check; the torch button is
// offered, on at the start for the shots that need raking light (20, 17).
async function openFullCamera(shotId) {
  const bk = curBook;
  const s = bk && bk.full ? fullShotDef(bk.template, shotId) : null;
  if (!s || s.kept) return bk && bk.full ? backToFull() : goHome();
  if (!fullEditable(bk)) return toast('Wait for the upload to finish');
  if ($('#scr-full').classList.contains('active')) await leaveFull();
  // Capture minutes time the shooting: the clock starts when the camera first opens
  // on this book with no photo yet.
  if (!(await shotsFor(bk.id)).some(x => x.blob)) { bk.startedAt = Date.now(); await fullStoreScreen(bk, false); }
  capT = { kind: 'full', shot: shotId };
  torchWant = !!s.torch;
  freeGate();
  stopLevel();
  show('scr-camera', { title: bk.title || 'Book', back: backToFull });
  $('#camLabel').textContent = `${s.id} ${FULL_NAMES[s.id] || s.label}`;
  $('#camTip').textContent = s.tip || '';
  $('#camFallback').classList.add('hidden');
  await startCam();
}
// A small JPEG for the checklist, made once when a shot is kept (the list never
// decodes a full-size photo into a tile).
// A small copy of a photo sent at spot-check (made by an older app, with none of its
// own), once a session; the full photo if it cannot be made.
const keptThumbs = new Map();
function keptThumb(x) {
  const k = `${x.bookId}|${x.shotId}|${x.when || ''}|${x.blob ? x.blob.size : 0}`;
  if (!keptThumbs.has(k)) keptThumbs.set(k, (async () => {
    let bmp = null;
    try { bmp = await createImageBitmap(x.blob); return await makeThumb(bmp); }
    catch (e) { return x.blob; }
    finally { if (bmp && bmp.close) bmp.close(); }
  })());
  return keptThumbs.get(k);
}
function makeThumb(bmp, max = 200) {
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('thumbnail')), 'image/jpeg', 0.8));
}
// A frame kept is never thrown away. Should an upload of this book be running all the
// same (the camera opens only on a book that is not going up, and a paused one waits
// for her tap), the change counts a new revision and that upload goes round again
// before it says Sent.
async function keepFullShot(shotId, bmp, blob) {
  const bk = curBook;
  let thumb = null;
  try { thumb = await makeThumb(bmp); } catch (e) { thumb = null; }
  await dbPut('shots', { bookId: bk.id, shotId, blob, thumb, w: bmp.width, h: bmp.height, when: Date.now() });
  if (bk.skipped && bk.skipped[shotId]) delete bk.skipped[shotId];
  await fullChanged(bk);
  backToFull();
  toast(`${shotId} saved ✓`);
}
$('#btnFlDifferent').onclick = () => {
  $('#flNoteWrap').classList.remove('hidden');
  $('#btnFlDifferent').classList.add('hidden');
  const n = $('#inFlNote');
  if (!n.value.trim()) n.value = NOTE_START;
  n.focus();
};
$('#inFlNote').onchange = () => leaveFullText();
$('#inFlWords').onchange = () => leaveFullText();
async function leaveFullText() {
  await leaveFull();
  if (curBook && curBook.full) paintFullUpload(curBook, fullTally(curBook, await shotsFor(curBook.id)));
}
$('#btnFlNoteVoice').onclick = () => beginDictation('#inFlNote', '#btnFlNoteVoice', voiceToNote);
$('#btnFlWordsVoice').onclick = () => beginDictation('#inFlWords', '#btnFlWordsVoice', voiceToVerbatim);
$('#btnFlDelete').onclick = () => deleteBook(curBook.id, () => openRequests());
$('#btnFlUpload').onclick = () => startFullUpload(curBook, $('#btnFlUpload'));
// Sign in (a tap may open Google's sign-in), then queue. The screen stays open and
// says "Keep the app open until it says Sent." (a phone may pause a page in the
// background).
async function startFullUpload(bk, btn) {
  if (!bk || !bk.full) return;
  const paused = !!(bk.upload && bk.upload.state === 'paused');
  if (uploadActive(bk) && !paused) return;
  btn.disabled = true;
  try {
    if (curBook && curBook.id === bk.id) await leaveFull();
    const t = fullTally(bk, await shotsFor(bk.id));
    if (!t.ready) throw new Error(t.done < t.total ? FULL_WORDS.progress(t.done, t.total)
      : FULL_TEMPLATES[bk.template].grades.length > 1 ? FULL_WORDS.chooseGrades : FULL_WORDS.chooseGrade);
    if (!cred('clientId')) throw new Error('This build has no Google Client ID yet — add one in ⚙ Settings');
    btn.textContent = 'Signing in to Google…';
    await getToken();
    await askPersist();
    await fullSyncStored(bk);
    if (paused) await setUpload(bk, { state: 'queued', error: '' });
    else {
      bk.upload = { state: 'queued', done: 0, total: 1, queued: Date.now(), error: '' };
      await fullStoreUpload(bk);
    }
    if (curBook && curBook.id === bk.id) curBook = bk;
    toast(FULL_WORDS.keepOpen, 4000);
    if ($('#scr-full').classList.contains('active')) renderFull();
    pumpUploads();
  } catch (e) {
    console.error(e);
    toast(e.message, 4500);
    if (curBook && curBook.id === bk.id && $('#scr-full').classList.contains('active')) renderFull();
  }
}
// Every child of a folder this app may see (drive.file: the ones it made).
async function folderChildren(fid) {
  const out = [];
  let page = '';
  do {
    const q = `'${fid}' in parents and trashed=false`;
    const r = await drive(DRIVE_LIST + '?q=' + encodeURIComponent(q) + '&pageSize=1000&fields=nextPageToken,files(id,name,mimeType)' +
      (page ? '&pageToken=' + encodeURIComponent(page) : ''));
    out.push(...((r && r.files) || []));
    page = (r && r.nextPageToken) || '';
  } while (page);
  return out;
}
// Create a new file, never replacing one (book.spot.json is written once).
async function createFile(folder, name, mime, blob) {
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
// Move one file from a folder into another (both made by this app).
async function driveMove(fileId, from, to) {
  return drive(DRIVE_FILES + encodeURIComponent(fileId) + '?addParents=' + encodeURIComponent(to) +
    '&removeParents=' + encodeURIComponent(from) + '&fields=id,parents', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}
// The copyright words file. When the spot-check record already lists a words file of
// its own (shot 13), this capture's words go into "... - 13 Copyright Verbatim (whole
// book).txt", so the spot-check's file is never written over and book.spot.json keeps
// pointing at the words the spot-check filing read; otherwise the one name of C1. The
// sheet reads the words from whichever file book.json's texts entry names.
function fullTextName(words, spotM) {
  const spot13 = !!spotM && Array.isArray(spotM.texts) &&
    spotM.texts.some(x => x && x.shot === FULL_TEXT.id && typeof x.file === 'string' && x.file);
  return `${words} - ${FULL_TEXT.id} ${FULL_TEXT.name}${spot13 ? ' (whole book)' : ''}.txt`;
}
// This capture's files: every photo taken (never 01 or 12: they are locked and
// never sent again), and the copyright page's words if typed. One file name per
// shot number, whatever the template.
function fullFiles(bk, shots, words, spotM) {
  const inT = {};
  fullShotList(bk.template).forEach(s => { inT[s.id] = s; });
  const out = [];
  for (const x of shots) {
    if (FULL_KEPT.indexOf(x.shotId) >= 0) continue;
    if (x.shotId === FULL_TEXT.id) {
      if (x.text) out.push({ shot: FULL_TEXT.id, name: fullTextName(words, spotM), mime: 'text/plain',
        blob: new Blob([x.text], { type: 'text/plain' }), when: x.when, text: true });
      continue;
    }
    if (!x.blob || !FULL_NAMES[x.shotId]) continue;
    const s = inT[x.shotId];
    out.push({ shot: x.shotId, name: `${words} - ${x.shotId} ${FULL_NAMES[x.shotId]}.jpg`, mime: 'image/jpeg', blob: x.blob,
      w: x.w, h: x.h, when: x.when, required: !!(s && s.req), check: x.shotId === '27' });
  }
  return out;
}
// The spot-check record in a chain of manifests: the first that is not a full capture.
function spotOfChain(m) {
  for (let p = m, n = 0; p && typeof p === 'object' && !Array.isArray(p) && n < 50; p = p.previous, n++) if (p.manifest !== 2) return p;
  return null;
}
// An edit made on the checklist since this upload read the record.
async function fullRevMoved(bk, rev0) {
  const r = await dbGet('books', bk.id);
  return !!r && (r.rev || 0) !== rev0;
}
// Is the request still asked for, just now? 'live' goes on; 'gone' stops with "Your
// curator no longer asks for this book" and nothing more is written; no good answer
// pauses the upload (her tap on Upload tries again), never trusting the list kept on
// this phone.
async function fullAskedOrStop(bk) {
  const asked = await fullStillAsked(bk);
  if (asked === 'live') return true;
  if (asked === 'gone') { await dropCachedRequest(bk.requestId); throw new Error(FULL_WORDS.noLonger); }
  await setUpload(bk, { state: 'paused', why: 'check' });
  return false;
}
async function uploadFull(bk) {
  try {
    // The revision of her choices this run works from (fullStoreScreen).
    const rev0 = bk.rev || 0;
    // Once the request has left her list (filed or closed), nothing more goes up: asked
    // of the request service before anything is written, and again before book.json.
    if (!(await fullAskedOrStop(bk))) return;
    const shots = await shotsFor(bk.id);
    const t = fullTally(bk, shots);
    if (!t.ready) throw new Error(FULL_WORDS.progress(t.done, t.total));
    await setUpload(bk, { state: 'uploading', done: 0, total: 1, error: '' });
    // The same checks as when the book was opened, on the folder as it is now.
    const chk = await fullFolderCheck({ folderId: bk.folderId, shelfFolderId: bk.shelfRef && bk.shelfRef.shelfFolderId, bookId: bk.requestBookId });
    if (chk.words !== (bk.filing && bk.filing.words)) throw fullGone('filing words changed');
    const fid = chk.folder.id, cur = chk.book.m;
    let kids = await folderChildren(fid);
    // 1. The spot-check record, kept whole beside the new one: book.spot.json, written
    //    only when absent and never replaced. Steps 2 and 3 rest on it (what to keep,
    //    and the words file's name), so the run never goes on without it: a read that
    //    fails stops it here with nothing written, and a record that cannot be found
    //    (in book.spot.json, or in book.json and its `previous`) refuses it.
    let spotM = null;
    const spotKid = kids.filter(k => k.name === SPOT_JSON);
    if (spotKid.length) {
      let text;
      try { text = await driveText(DRIVE_FILES + encodeURIComponent(spotKid[0].id) + '?alt=media'); }
      catch (e) { if (/Drive error (403|404)/.test(String(e.message))) throw fullGone('book.spot.json read'); throw e; }
      try { spotM = JSON.parse(text); } catch (e) { spotM = null; }
      if (!spotM || typeof spotM !== 'object' || Array.isArray(spotM)) spotM = spotOfChain(cur);
    } else {
      spotM = spotOfChain(cur);
      if (spotM) await createFile(fid, SPOT_JSON, 'application/json',
        new Blob([spotM === cur ? chk.book.text : JSON.stringify(spotM, null, 2)], { type: 'application/json' }));
    }
    if (!spotM) throw fullGone('no spot-check record');
    // 2. The files of an earlier capture that book.json still lists (one the
    //    curator refused as "Not this book") go into a sub-folder before anything
    //    new goes up: every file it lists that book.spot.json does not. Never 01 or
    //    12, never a file this capture sent. Done once per earlier capture.
    const asideKey = cur.manifest === 2 && cur.requestId !== bk.requestId ? `${cur.requestId || ''}|${cur.updated || ''}` : '';
    if (asideKey && !(bk.aside && bk.aside.key === asideKey)) {
      const keep = new Set(listedNames(spotM).concat(FULL_KEPT.map(id => chk.kept[id].file), ['book.json', SPOT_JSON]));
      const mine = new Set(Object.values(bk.fileIds || {}));
      const go = new Set(listedNames(cur).filter(n => !keep.has(n)));
      const move = kids.filter(k => go.has(k.name) && !mine.has(k.id) && k.mimeType !== FOLDER_MIME);
      let sub = '';
      if (move.length) {
        sub = await findOrCreateFolder(ASIDE_PREFIX + localDay(), fid);
        for (const k of move) await driveMove(k.id, fid, sub);
      }
      bk.aside = { key: asideKey, rid: String(cur.requestId || ''), folderId: sub, moved: move.length, at: Date.now() };
      await fullStoreUpload(bk);
      kids = await folderChildren(fid);
    }
    // 3. Only files not sent yet, or changed since they were sent: the photos two at
    //    a time, then the copyright page's words, then book.json. Never a file the
    //    spot-check record lists (01, 12 and its words keep what the spot-check filed).
    const files = fullFiles(bk, shots, chk.words, spotM);
    const spotNames = new Set(listedNames(spotM));
    if (files.some(f => spotNames.has(f.name))) throw fullGone('a name the spot-check record lists');
    const have = {};
    kids.forEach(k => { (have[k.name] = have[k.name] || []).push(k.id); });
    bk.sent = bk.sent || {};
    bk.fileIds = bk.fileIds || {};
    const todo = files.filter(f => !(bk.sent[f.name] === f.when && (have[f.name] || []).indexOf(bk.fileIds[f.name]) >= 0));
    await setUpload(bk, { done: files.length - todo.length, total: files.length + 1 });
    let failed = null, paused = false;
    const send = async list => {
      let next = 0;
      const worker = async () => {
        while (next < list.length && !failed && !paused) {
          if (!tokenFresh()) { paused = true; break; }
          const f = list[next++];
          try {
            const up = await uploadFile(fid, f.name, f.mime, f.blob);
            if (up && up.id) bk.fileIds[f.name] = up.id;
            bk.sent[f.name] = f.when;
            await setUpload(bk, { done: bk.upload.done + 1 });
          } catch (e) { failed = e; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, list.length) }, worker));
    };
    await send(todo.filter(f => !f.text));
    if (!failed && !paused) await send(todo.filter(f => f.text));
    if (failed) throw failed;
    // A whole book can take long enough for the sign-in to run low during the last
    // photo: renewing it opens Google's sign-in, which only a tap may do, so pause
    // and write book.json when she signs in again (every file is already sent).
    if (!paused && !tokenFresh()) paused = true;
    if (paused) { await setUpload(bk, { state: 'paused' }); return; }
    // 4. book.json last, in place of the one it read, which `previous` keeps whole.
    //    First: a change she made while the files went up sends this round again with
    //    it (queued: the pump picks it up at once); and the request is asked about
    //    again, so book.json is never written for a book the curator has filed since.
    if (await fullRevMoved(bk, rev0)) { await setUpload(bk, { state: 'queued' }); return; }
    if (!(await fullAskedOrStop(bk))) return;
    // Noted on the phone before book.json is written: if its answer is lost (the page
    // closed, no signal) the write may still have landed, so a new request never takes
    // this capture over and Delete never says it was never sent. Not noted, not written.
    bk.manifestTry = Date.now();
    if (!(await fullStoreUpload(bk))) return;
    await writeFullManifest(fid, bk, files, chk);
    await setUpload(bk, { done: files.length + 1 });
    // Sent, unless she changed something while book.json went up: then round again.
    const at = Date.now();
    let moved = false;
    bk.manifestAt = at;
    const rec = await dbPatch('books', bk.id, r => {
      for (const k of FULL_UP_KEYS) { if (k in bk) r[k] = bk[k]; else delete r[k]; }
      if ((r.rev || 0) !== rev0) { moved = true; r.upload = { ...bk.upload, state: 'queued' }; delete r.upload.why; return r; }
      r.uploaded = at;
      delete r.upload;
      return r;
    });
    if (!rec) return;
    if (moved) {
      bk.upload = rec.upload;
      if (curBook && curBook.id === bk.id) curBook.upload = rec.upload;
      refreshUploadCards();
      return;
    }
    bk.uploaded = at;
    delete bk.upload;
    if (curBook && curBook.id === bk.id) fullTakeUp(curBook, rec);
    await setAnswered(bk.requestId, { uploaded: bk.uploaded });
    toast(`Sent “${bk.title}” ✓`, 3600);
    renderReqCard();
    if ($('#scr-requests').classList.contains('active')) openRequests();
    if ($('#scr-full').classList.contains('active') && curBook && curBook.id === bk.id) renderFull();
  } catch (e) {
    console.error('upload', bk.id, (e && e.why) || '', e);
    const full = driveIsFull(e);
    const msg = full ? FULL_WORDS.driveFull : String((e && e.message) || e);
    if (!full && !(e && e.fullGone) && /sign-in|token|401/i.test(msg)) { await setUpload(bk, { state: 'paused' }); return; }
    await setUpload(bk, { state: 'failed', error: msg.slice(0, 120) });
    if ($('#scr-full').classList.contains('active') && curBook && curBook.id === bk.id) renderFull();
  }
}
// book.json of a full capture, written LAST.
async function writeFullManifest(folder, bk, files, chk) {
  const started = bk.startedAt || bk.created, finished = bk.finishedAt || Date.now();
  const r = bk.shelfRef || {}, t = bk.template, T = FULL_TEMPLATES[t];
  const was = Array.isArray(chk.book.m.photos) ? chk.book.m.photos : [];
  const photos = FULL_KEPT.map(id => {
    const p = was.find(x => x && x.shot === id) || {};
    return { shot: id, file: chk.kept[id].file, w: p.w == null ? null : p.w, h: p.h == null ? null : p.h, required: true, kept: true, check: false };
  }).concat(files.filter(f => !f.text).map(f => ({ shot: f.shot, file: f.name, w: f.w, h: f.h, required: f.required, kept: false, check: f.check })))
    .sort((a, b) => a.shot.localeCompare(b.shot));
  const sent = new Set(files.map(f => f.shot));
  const sk = bk.skipped || {};
  const skipped = fullShotList(t).filter(s => s.req && !sent.has(s.id) && fullSkipOk(sk[s.id]))
    .map(s => ({ shot: s.id, why: whyKey(sk[s.id]) === 'other' ? 'other: ' + whyText(sk[s.id]).trim() : sk[s.id] }));
  const g = bk.grades || {}, fl = bk.flags || {}, jacket = T.grades.indexOf('jacket') >= 0;
  const grade = v => FULL_GRADES.indexOf(v) >= 0 ? v : '';
  const manifest = {
    bookCurator: 1,
    kind: 'book',
    manifest: 2,
    requestType: 'Full capture',
    template: t,
    askedTemplate: bk.askedTemplate || t,
    templateWhy: bk.templateWhy || '',
    appBookId: bk.id,
    author: chk.author,
    title: chk.title,
    requestId: bk.requestId || '',
    requestBookId: bk.requestBookId || '',
    folderId: folder,
    shelfRef: { shelfId: r.shelfId || '', shelfFolderId: r.shelfFolderId || '', file: r.file || '', box: r.box || null, where: r.where || '' },
    note: bk.note || '',
    photos,
    texts: files.filter(f => f.text).map(f => ({ shot: f.shot, file: f.name })),
    skipped,
    grades: { jacket: jacket ? grade(g.jacket) : '', book: grade(g.book) },
    flags: { jacket: jacket ? FULL_FLAGS.jacket.filter(x => (fl.jacket || []).indexOf(x) >= 0) : [],
      book: FULL_FLAGS.book.filter(x => (fl.book || []).indexOf(x) >= 0) },
    operator: bk.operator || settings.operator || '',
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    captureMinutes: Math.round((finished - started) / 6000) / 10,
    previous: chk.book.m,
    app: APP_VERSION,
    updated: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  await uploadFile(folder, 'book.json', 'application/json', blob);
}

/* ---------- uploaded shelves ---------- */
$('#btnArchive').onclick = () => openArchive();
async function openArchive() {
  show('scr-archive', { title: 'Uploaded shelves', back: goHome });
  const list = $('#arcList');
  list.innerHTML = '';
  const done = (await dbAll('shelves')).filter(s => s.uploaded).sort((a, b) => b.uploaded - a.uploaded);
  $('#arcStatus').textContent = done.length
    ? `These are in your Google Drive, in “${settings.driveFolder}” / _Shelves. Keep the photos on this phone until your curator says the work is finished: a request shows the book on your own shelf photo.`
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
      if (!confirm(`Delete “${sh.label}” from this phone? It stays in your Google Drive, but your curator’s requests can no longer show a book on its photo.`)) return;
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
    ? '🔗 Linked to a folder that already exists in Drive.'
    : '';
  $('#btnLink').textContent = settings.driveFolderId ? 'Unlink…' : 'Link…';
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
  if (!confirm('Delete every shelf, photo and setting this app holds on this phone? Photos not yet uploaded are lost for good, and the app forgets your folder name. Your curator does not need you to do this.')) return;
  // Which shelves this phone uploaded is how it finds your curator's requests:
  // kept unless you say otherwise. The client id is never cleared (BUILTIN wins).
  const held = await heldIds(), answered = (await dbGet('kv', 'answered')) || {};
  const forget = Object.keys(held).length > 0 && confirm('Also forget which shelves this phone uploaded? OK forgets them, and your curator\'s requests for them stop appearing. Cancel keeps them, so the requests still appear.');
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
  toast('Deleted. Before your next upload, ask your curator what to type in ⚙ Settings.', 4500);
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
