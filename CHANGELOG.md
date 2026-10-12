# Changelog

All notable changes to Simple Worship Presenter are recorded here.

## Unreleased

## 0.3.5 — 2026-10-12

### Added
- **The World English Bible is built in.** All 66 books of the Protestant canon — 1,189 chapters,
  31,103 verses — imported from the official eBible.org USFM source and stored as shared instance
  data. The text is not copied into anyone's account and never counts against a storage quota.
  Looking up a passage or searching makes no external request.
- **Reproducible importer.** `npm run import:bible` downloads the official archive, normalises USFM
  book codes, strips Strong's-number and styling markup while leaving wording untouched, and writes
  one file per book. Running it again replaces the translation cleanly instead of duplicating it.
  `--from <file>` imports an archive you already have.
- **Reference parsing** for `John 3:16`, `Jn 3:16`, `1 Jn 1:9`, `Psalm 23`, `1 Cor 13:4-7` and
  `Gen 1:1-2:3`, with errors that explain what to correct rather than guessing.
- **Chapter lookup and word search** across the translation, each result carrying its reference and
  translation.
- **Slide generation for passages** with configurable line count, verse numbers, reference and
  translation labels. A verse is never split across slides and text is never trimmed to fit.

### Verification
Text integrity was checked against known WEB quotations. Genesis 1:1, Psalm 23:1, John 3:16 and
Romans 8:28 match the source exactly, and a scan of all 31,103 verses found **zero** with leftover
USFM markup. Psalm superscriptions are stored as chapter headings so verse numbering stays faithful.

178 automated tests pass, including 22 for the Bible: all 66 books in canonical order, expected
chapter and verse counts, representative verses, reference parsing and rejection, cross-chapter
ranges, search accuracy, verse order, slide generation that loses nothing, and operation with no
external Bible service.

### Documented
Privacy policy and terms now cover Bible translation licensing and attribution, the mobile remote
and its session data, and the distinction between the hosted service and self-hosted instances.

### Not included in this release
Stated plainly because the work is not done: the Bible browser interface, adding passages to
presentations and service plans from the UI, Bible export/import in presentation packages,
animated video backgrounds, the media gallery in the editor, the design-system pass, slide
transitions, and the youth games library and game engine. The data layer and API for scripture are
in place and tested; the interface work remains.

## 0.3.4 — 2026-10-11

### Added
- **Mobile remote control.** A phone can drive the live presentation from `/remote`. It pairs by
  scanning a QR code or typing a short code, then offers previous/next, current and next slide
  previews, a tap-to-jump slide list, black screen, restore output, and the current item and slide
  position. Buttons are sized for one-handed use during a service.
- **Server-authoritative live state.** The workspace, audience display and every paired phone now
  converge on one state held by the server instead of only a same-device BroadcastChannel. A remote
  command updates that state and is broadcast to every display, so the projector and the phone
  always agree.
- **Connect Mobile Remote** in the Tools menu: pairing QR and code, live connection status, list of
  paired devices, and per-device or all-device revocation.
- **Pairing credentials that expire and cannot be replayed.** Codes live five minutes, are consumed
  before a token is issued, and are replaced rather than stacked when regenerated. The QR carries
  only the code, never an account token.
- **Scoped remotes.** A pairing can grant only a subset of controls, and the server enforces it.

### Security
- Every command is validated server-side. Ownership is derived from the credential, never from a
  client-supplied user or presentation id.
- Remote tokens are short lived, bound to one user and one live session, and die the moment the
  device is revoked.
- Pairing attempts and remote commands are rate limited independently of other endpoints.
- WebSocket messages are size limited, schema checked, and authentication must complete within five
  seconds. Tokens travel in messages, not URLs, so they stay out of proxy logs.
- Malformed and oversized messages are rejected; an unknown action is a `400` and an action the
  device does not hold is a `403`.
- Pairing secrets are never written to disk or logged.

### Fixed
- `goto` with a missing or non-numeric index no longer silently selects slide 0.

### Documentation
- WebSocket reverse-proxy configuration for nginx and CloudPanel, including how to verify the
  upgrade and what to expect if a proxy blocks WebSockets.
- Guidance for local-network-only installations and pairing without port forwarding.

### Verified
- 144 automated tests, including 29 for the remote: pairing, single-use codes, expiry, rate limits,
  cross-account isolation, revocation, scoped controls, two phones at once, WebSocket
  authentication, malformed messages, and live state reaching both the phone and the display.
- Exercised in a real browser at phone width: pairing from a code, the slide rundown, current/next
  previews, and `Next` moving the presentation from 1/4 to 2/4 through the server.

## Unreleased

### Added
- **A cooldown between pairing codes.** Generating a code is throttled per account (30 seconds by
  configurable via `PAIRING_COOLDOWN_SECONDS`), so an operator cannot flood the pairing screen by
  clicking repeatedly — deliberate or accidental. A second request inside the window returns `429`
  with a `Retry-After` header and the remaining wait, and an already-issued code keeps working. The
  dashboard disables the button and counts the wait down.
- The dashboard now states whether an update setting came from `.env` or is the built-in default,
  so an override left over from troubleshooting is immediately visible.

## 0.3.3 — 2026-10-11

### Added
- **Self-updater that works without a git checkout.** The default update command assumed a git
  repository, which fails on deployments made by copying or uploading files. `scripts/self-update.js`
  detects the layout and uses `git pull` or downloads and installs the release archive accordingly.
  It never touches `data/`, `uploads/`, `.env`, `node_modules` or `.git`, and reports clearly when
  npm, git or tar are missing. `UPDATE_TARGET_DIR`, `UPDATE_REPO`, `UPDATE_REF` and
  `UPDATE_ARCHIVE_URL` are available for mirrors and air-gapped installs.

### Fixed
- **Update failures were undiagnosable.** The dashboard showed only "Update command failed". It now
  shows the exit code, signal, stderr and stdout, plus the exact command to run yourself.
- `/api/admin/update` reports whether `git` and `npm` are on PATH, so a missing tool is visible
  before pressing the button.
- `tar` exiting non-zero after a successful extraction (for example `Cannot utime` when it cannot
  restore a timestamp) no longer aborts the update; the installer judges by what landed on disk.

### Security
- The self-updater accepts `UPDATE_TARGET_DIR` so automated tests run against a throwaway directory.
  Without that override, tests could run the updater against the real installation. Fixed here as
  well as in the test harness, and the suite now proves it leaves user data byte-identical.

## 0.3.2 — 2026-10-11

### Fixed
- **Stale client-side caching.** The application relied on hand-managed `?v=` query strings, so
  browsers held on to old JavaScript and markup after an upgrade. The server now sets explicit
  cache headers: API responses are `no-store`, versioned assets are `immutable`, and everything
  else revalidates on every request. A missing version bump can no longer strand users on old code.
- **Presentations, songs and service plans did not count towards storage.** Only uploads were
  measured, so an account could store far more than its quota. Every category now counts.
- **Update checks could report "up to date" wrongly.** Version parsing trimmed before stripping the
  `v` prefix, so a release named `v 0.3.1` failed to parse and fell back to the raw tag. Also fixed
  pre-release ordering: `0.3.2-rc1` now correctly sorts before `0.3.2`.

### Changed
- **Storage usage is recomputed from what is actually stored** rather than incremented as things
  change, so it cannot drift when content is edited or when older records predate a change in
  accounting rules. Existing accounts are corrected automatically the next time they change.
- Settings now show a storage breakdown: media, presentations, songs and plans.
- Version parsing moved into `src/version.js` so it can be unit tested.

### Verified
- Auto-update exercised end to end against the real release feed: the check reads the published
  release notes and link, compares versions correctly, and `Run update` captures output, reports a
  non-zero exit code on failure and persists the result for the dashboard.
- 106 automated tests, including cache-control headers, storage accounting for every content type,
  and version parsing against real release payload shapes.

## 0.3.1 — 2026-10-11

The release candidate for publication. Everything below is new since 0.3.0.

### Added
- **Service plan playback.** "Save & present" runs the whole plan: it saves, opens the audience
  display and starts at item one. The editor shows the running order with the current item marked
  *LIVE*, plus Previous/Next item controls and jump-to-item. Advancing past the last slide of an
  item moves into the next item, so a whole service can be walked with <kbd>Space</kbd>.
- **Running-order editor** with ↑ / ↓ / ✕ controls, so the saved order is exactly the order shown.
- **Text animations** per slide: none, fade, rise, blur in, scale up, and word-by-word with
  staggered timing. Replays on slide change; disabled under `prefers-reduced-motion`.
- **14 font families** with proportional scaling so the editor and a projector match.
- **Text sizing and positioning**: 18–160 pt, bold, text colour, horizontal alignment and vertical
  position, all stored per slide.
- **Search** in every collection plus a global search (<kbd>Ctrl</kbd>+<kbd>K</kbd>) with grouped
  jump-to results.
- **Editor action bar**: Save, Present, Blank, previous/next slide, undo and redo.
- **Administrator user management**: list accounts, create accounts, change names, promote/demote
  between User and Admin, and delete accounts along with all their content.
- **Editable storage quotas** per account and a default for new accounts. A quota cannot be set
  below what the account already stores, and an administrator cannot lock themselves out.
- **Instance maintenance panel**: version, Node and schema versions, uptime, downloadable database
  backup, update check and self-update.
- **Self-update support**, opt-in via `UPDATE_CHECK_URL` and `UPDATE_COMMAND`. Nothing runs and
  nothing is contacted unless the operator configures it.
- MIT licence.

### Changed
- **Application and public website are separate deployable units.** `app/` is the application for
  `app.simpleworshippresenter.com`; `website/` is a standalone static site with its own stylesheet
  and no dependency on the Node process. The workspace now sits at the application domain root and
  the public site is previewable at `/site`.
- **Storage is displayed in megabytes** throughout the workspace and admin panel. The server still
  stores exact bytes.
- Upgraded `multer` 1.x → 2.x, patching a number of vulnerabilities in the 1.x line.
- Slide previews and queue rows truncate long text instead of overflowing.

### Fixed
- **First-run administrator setup failed.** The name field was hidden in setup mode, so `name` was
  sent empty and the account was rejected. It is now shown for setup and registration and hidden
  only for sign-in.
- Sign-in and registration failures show a persistent inline error instead of a passing toast, and
  the dialog stays open so the form is not lost.
- Opening the registration tab directly did not stay on that tab.
- **Alignment buttons rendered blank.** The glyphs had been written as corrupted bytes; they are now
  drawn in CSS. All remaining corrupted characters were removed from the source.
- **Slide thumbnails overlapped in the editor.** The slide column sized its implicit grid track to
  max-content, so thumbnails were 210 px wide inside a 175 px track.
- **Test suite could fail intermittently.** Test servers picked random ports, so parallel test files
  could collide and silently talk to each other's servers. Servers now bind to port 0 and report the
  port the OS assigned. Also fixed a hang caused by an orphaned test server.

### Migration notes
- **Routing:** the workspace moved from `/app` to `/` on the application domain; the public site is
  now served from `website/` and previewed at `/site`.
- **Files:** `app.html` → `app/index.html`; `app.js`, `presenter.js`, `presenter.html`, `styles.css`
  → `app/`; the marketing pages → `website/`.
- **No data migration is required.** Existing user data loads unchanged.
## 0.3.0 — 2026-10-11

A structural release: the application was reorganised behind stable interfaces and the highest
priority security defects were closed. Existing user data is migrated automatically on startup.

### Added
- **Public marketing site separated from the application.** `/` is now the marketing homepage;
  the workspace lives at `/app`. New pages: `/features`, `/self-hosting`, `/docs`, `/privacy`,
  `/terms`. *(Breaking route change — see below.)*
- **Song library** with sections (Verse/Chorus/Bridge/custom), reordering, credits, CCLI fields
  and slide generation with a configurable line count and repeatable section order.
- **Media library** with uploads, thumbnails, per-account access and quota-aware deletion.
- **Slide editor**: undo/redo, duplicate slide, move up/down, 16:9 and 4:3 canvases, font and
  alignment controls, image backgrounds.
- **Presentation management**: rename, duplicate and delete presentations from the library.
- **Service plans**: notes, duplicate-for-next-week, and launch directly into presenter mode.
- **Account management**: change password, sign out, delete account (releases storage).
- **Settings**: per-account CCLI licence, storage usage bar against the included quota.
- **Instance administration**: administrator can change the default quota; operators can disable
  registration via configuration.
- **Structured JSON logging**, request timing, and `GET /api/health`.
- **Configuration validation** with clear startup failures for production.
- **Dockerfile** and **docker-compose.yml** with a persistent data volume and health check.
- **Automated tests**: 48 tests across authentication, quotas, content, security and data
  durability, plus a boot smoke test.

### Fixed
- **Stored XSS (high).** Slide text is now escaped before rendering in the editor and the
  audience display.
- **Source/data exposure (high).** `express.static(__dirname)` was serving `server.js`, `src/`,
  `data/`, `node_modules/` and environment files. Replaced with an explicit public-file allowlist.
- **Missing rate limiting (high).** Authentication and write endpoints are now rate limited.
- **Uploads were not content-validated.** Files are now sniffed by magic bytes; unrecognised
  content is rejected with `415`.
- **`openModal()` was undefined**, breaking the Help menu.
- **Migrated schema was not written back to disk**, so old data files stayed at the old shape.
- **Error responses could be empty.** All errors now return the documented `{ error }` shape.
- **Theme/background state leaked between presentations.** Backgrounds are scoped per
  presentation and stored with the slide data.
- **Media previews were static placeholders.** They now reflect the real slide list.
- Removed the unused `lowdb` dependency.

### Changed
- Package renamed to `simple-worship-presenter`; version 0.3.0.
- Data layer split into `src/db.js` (store, migrations, accounting), `src/auth.js`,
  `src/rateLimit.js`, `src/config.js`, `src/log.js` and `src/routes/content.js`.
- Presentation routes now return parsed `slides` alongside metadata.

### Migration notes
- **Routing:** bookmarks to `/` for the workspace should move to `/app`. `/presenter.html`
  continues to work alongside the new `/presenter`.
- **Data:** no manual migration is required. The data file is upgraded to schema version 4 on
  first start and is not otherwise rewritten.
- **Dependencies:** run `npm ci` after upgrading.

## 0.2.0 — 2026-10-10
- Added the Node.js/Express backend with accounts, presentations, service plans, uploads and
  per-account quotas.
- Added the separate audience display window with live synchronisation.
- Added the SSP-inspired control-room editor layout.

## 0.1.0 — 2026-10-10
- Initial static prototype: library, editor, presenter window, terms and AI disclosure.
