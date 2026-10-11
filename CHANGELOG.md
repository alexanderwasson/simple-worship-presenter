# Changelog

All notable changes to Simple Worship Presenter are recorded here.

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
