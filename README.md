# Book Curator

A camera app for photographing bookshelves on a phone, so a curator can read the
spines remotely and say which volumes are worth a closer look. It records one
labelled photo per shelf (or a few overlapping frames for a wide one), shows a
level line while you shoot, makes you check the smallest spine is legible before
the photo is kept, and saves the set to your own Google Drive.

This repository holds the phone app only. The companion Google Sheet, its
research tools and the user documentation are private and supplied to clients
directly. Contact pnicol66@gmail.com.

## What it records

Per shelf: a label in your own words ("Study, case 2, shelf 3"), the photo(s), a
few optional chips (second row behind, stacked flat, shot from below, glass
door), a note, a rough count, who shot it and how long it took. The printed
**shelf cards** stood on the shelf before shooting make the photo carry its own
label.

Files land in your Drive as:

    Book Curator / _Shelves / Study, case 2, shelf 3 / 01.jpg
    Book Curator / _Shelves / Study, case 2, shelf 3 / 02.jpg
    Book Curator / _Shelves / Study, case 2, shelf 3 / shelf.json

Shelf photos are kept at the camera's full resolution: the small type at the
foot of a spine is what the read needs.

## Getting it on your phone

Open https://pnicol66-sketch.github.io/book-curator/ on the phone and install it —
Android: **Install app on this phone** on the home screen (or menu ⋮ → Install
app); iPhone: **Share** → **Add to Home Screen**, which the app prompts for. It
then runs full-screen and works offline after the first load.

## Saving to Google Drive

Tap **Upload**, sign in with your own Google account, allow. The app uploads
into `My Drive / Book Curator / _Shelves / <label>/` and queues the shelf so the
photos go up in the background while the next shelf is being shot; **Upload all
finished shelves** on the home screen sends a whole visit's shelves after one
sign-in. The queue survives an app close and resumes on the next open.

The app requests only Google's `drive.file` scope: it can see and write the
folders it created itself and nothing else in your Drive. On the first upload it
asks whether to share the Book Curator folder, read-only, with the curator; you
stay the owner, nothing else in your Drive is shared, and you can stop sharing
at any time from Drive itself. Declining is remembered too.

## Shooting tips

- Stand the shelf card at the left end of the shelf, in frame.
- Turn the phone sideways, stand square to the shelf, flash off, fill the width
  edge to edge. The line in the viewfinder turns green when the phone is level.
- A wide shelf takes two or three frames; overlap each by about a quarter at the
  same distance and height.
- After the shot, drag the loupe over the smallest spine. If you cannot read it,
  re-shoot: move the lamp, open the glass door, get closer.

## Privacy

Everything (photos, labels, settings) is stored locally in the browser on the
phone. Nothing leaves the phone except when you explicitly upload to your own
Google Drive. See [privacy.html](privacy.html).

## Developer notes

**Local testing on a PC.** Run `powershell -ExecutionPolicy Bypass -File serve.ps1`
in this folder and open http://localhost:8322/ — on localhost the camera works
without https (or use the 🖼 import button to test with existing image files).
Unregister the service worker first (DevTools → Application → Service Workers →
Unregister), otherwise the previous build is served from cache.

**Shipping an update.** Edit, commit, `git push` — Pages redeploys. Installed
phones then show a bar ("A new version is ready") and reload when the user taps
**Update**. That relies on the service worker's cache name changing, so
`bump-version.ps1` rewrites it — along with `APP_VERSION` in app.js, which
Settings displays — on every commit that touches `index.html` or `app.js`. The
hook that runs it is in `hooks/`, and hooks don't survive a clone, so install it
once per working copy:

    cp hooks/pre-commit .git/hooks/pre-commit

**Google credentials.** The app has its own Google Cloud project and OAuth client,
separate from every other app by the same author. The client id is baked into
`BUILTIN` in app.js; until it is, Settings has a box for one.

## License

© 2026 pnicol66. Shared for personal use; please don't redistribute the app, the
sheet template, or the script without permission — contact pnicol66@gmail.com.
