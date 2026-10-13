# Simple Worship Presenter — Architecture

## Overview

One Node.js process serves both the JSON API and the static client. There is no build step: the
client is plain JavaScript, HTML and CSS. This keeps self-hosting to `npm ci && npm start` and
works on modest hardware.

```
                      +---------------------------+
   browser ---------->|  Express (server.js)      |
                      |                           |
                      |  static allowlist  -----> |  index.html   (marketing site)
                      |                    -----> |  app.html     (workspace)
                      |                    -----> |  presenter.html (audience display)
                      |                    -----> |  *.html, styles.css, app.js, presenter.js
                      |                           |
                      |  /api/*            -----> |  src/routes/content.js
                      |  /api/auth/*       -----> |  src/auth.js
                      |                           |
                      |  middleware: helmet, json, cookies, logging, rate limiting
                      +------------+--------------+
                                   |
                     src/db.js (JSON document store, migrations,
                                atomic writes, storage accounting)
                                   |
                DATA_DIR/lumenstage-data.json   +   DATA_DIR/uploads/
```

## Runtime and tooling

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js >= 18 | Developed and tested against 24 |
| Package manager | npm | `package-lock.json` is committed; use `npm ci` |
| Backend | Express 4 (CommonJS) | |
| Client | Vanilla JS + HTML + CSS | No bundler, no framework |
| Data store | JSON document file | Atomic replace on write, serialised write queue |
| Auth | `jsonwebtoken` + `bcryptjs` (cost 12) | Signed JWT in an `HttpOnly` cookie |
| Uploads | `multer` | Magic-byte content validation |
| Security headers | `helmet` | |
| Tests | `node:test` | No test framework dependency |

## Module layout

| Path | Responsibility |
| --- | --- |
| `server.js` | Bootstrap, middleware, static allowlist, setup/auth routes |
| `src/config.js` | Validated environment configuration |
| `src/log.js` | Structured JSON logging with levels |
| `src/db.js` | Data store, migrations, atomic persistence, storage accounting |
| `src/auth.js` | Password hashing, session issue/verify, authorisation middleware |
| `src/rateLimit.js` | In-memory token buckets for auth and write endpoints |
| `src/routes/content.js` | Media, songs, presentations, service plans, settings, account |
| `app/` | **Application client**, deployed to the app domain |
| `app/app.js` | Workspace client (all user text escaped before rendering) |
| `app/presenter.js` | Audience display client |
| `website/` | **Public marketing site**, deployed to the apex domain as plain static files |
| `website/site.js` | Resolves the application URL in one configurable place |
| `test/` | `node:test` suites with a real-server harness |

The application client and the public website are separate deployable units with separate
stylesheets. The website has no dependency on the Node process or the application code, so it can
be hosted on a static host, a CDN, or CloudPanel's static site feature while the application runs
on `app.` under Node.

## Configuration

Validated at startup; production refuses to boot without a real `SESSION_SECRET`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Persistent data root. Keep outside the release directory. |
| `SESSION_SECRET` | dev fallback | Signs session tokens. Required in production. |
| `NODE_ENV` | `development` | Enables `Secure` cookies and rejects default secrets |
| `TRUST_PROXY` | `0` | Trust `X-Forwarded-*` behind a reverse proxy |
| `INSTANCE_NAME` | `Simple Worship Presenter` | Branding in UI and health output |
| `PUBLIC_URL` | — | Configurable public base URL; no domain is hardcoded |
| `DEFAULT_QUOTA_BYTES` | `26214400` | New account quota (25 MB) |
| `MAX_UPLOAD_BYTES` | `26214400` | Largest single upload |
| `ALLOW_REGISTRATION` | `1` | Close public sign-ups on self-hosted instances |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `RATE_LIMIT_MAX_AUTH` | `10` | Sign-in attempts per minute per IP |
| `RATE_LIMIT_MAX_WRITE` | `240` | Write requests per minute per IP |

## Data model

`DATA_DIR/lumenstage-data.json`, schema version 4:

```
{
  schema_version: 4,
  users:         [{ id, name, email, password_hash, role, quota_bytes, used_bytes, created_at }],
  presentations: [{ id, user_id, title, slides_json, created_at, updated_at }],
  programs:      [{ id, user_id, title, date, notes, presentation_ids[], created_at }],
  songs:         [{ id, user_id, title, artist, author, copyright, ccli, tags[],
                    sections[{ id, label, text }], theme, created_at, updated_at }],
  media:         [{ id, user_id, original_name, stored_name, mime, kind, size, created_at }],
  files:         [{ id, user_id, original_name, stored_name, mime, kind, size, created_at }],
  settings:      { "ccli:<userId>": "...", "default_quota_bytes": 26214400 }
}
```

A slide is either a string (plain text) or an object `{ text, image?, background?, name? }`.
Both shapes are supported everywhere so older data keeps working.

### Migrations

Numbered and additive, applied on startup:

| Version | Change |
| --- | --- |
| 1 | Base collections: `users`, `presentations`, `files` |
| 2 | Service plans (`programs`) |
| 3 | Song and media libraries |
| 4 | Instance settings, `schema_version` tracking |

Migrations never delete user data. When a migration runs, the upgraded schema is written back to
disk immediately. If the data file cannot be parsed, it is preserved as
`*.corrupt-<timestamp>` and the instance starts from an empty store rather than destroying it.

Writes are serialised through a queue and committed with write-to-temp plus rename, so a crash
mid-write leaves the previous file intact.

## Sessions and authorisation

`POST /api/auth/login` issues a 7-day JWT in `lumen_session`:

- `HttpOnly` — not readable from JavaScript
- `SameSite=Lax`
- `Secure` when `NODE_ENV=production`

Every protected handler runs `auth.requireAuth`, which verifies the token and re-resolves the
user from the store. Ownership is enforced in the data layer (`db.owned`, `db.allOwned`) by
matching `user_id`; the client never supplies an owner. `auth.requireAdmin` adds a role check.

## Presentation engine (Phase 11)

The workspace (`app.html`) drives the audience display (`presenter.html`) over a
`BroadcastChannel` named `simple-worship-live`, with `localStorage` fallbacks for browsers where
BroadcastChannel is unavailable or unreliable.

```
{ type:'slide', index, title, image, count, background, kicker, footer }
{ type:'blank' } | { type:'unblank' }
{ type:'presenter-ready' }
```

The audience window sends `presenter-ready` when it loads so the operator's current slide is
re-sent immediately. The display is output-only: no editing controls, no close button.

This is same-origin, same-device synchronisation. Cross-device remote control would need a
WebSocket or SSE channel and is not part of the current design.

**Browser limitation:** browsers cannot select a physical monitor. The supported workflow is to
open the display window, drag it to the projector, then press `F`. This is documented for users.

## Storage accounting

`users.used_bytes` tracks stored media. Quotas are checked and incremented in the same request
that accepts the upload, and released when media or an account is deleted. Uploads that fail
validation or exceed the quota are removed from disk before the error is returned.

## Routing

| Route | Serves |
| --- | --- |
| `/` | Workspace (application domain root) |
| `/app` | Workspace alias |
| `/presenter` | Audience display |
| `/site`, `/site/*` | The public site, previewable when running a single instance |
| `/api/*` | JSON API, `404` JSON for unknown paths |
| anything else | Workspace shell |

When the website is deployed on its own, `/` on that host is the marketing homepage and
`features.html`, `docs.html` and friends are plain relative links.

Only the files listed in `APP_FILES` / `SITE_FILES` are sent by the static handlers. `server.js`,
`src/`, `data/`, `uploads/`, `node_modules/`, `test/`, `Dockerfile` and environment files are
never reachable over HTTP.

## Testing

| Command | Coverage |
| --- | --- |
| `npm run check` | Syntax checks across server and client |
| `npm run smoke` | Boots the real server; health, static surface, error shape, registration |
| `npm run test:unit` | 187 tests: auth, account isolation, quotas, uploads, songs, presentations, service plans, importing, migrations, durability, security surface, rate limiting |
| `npm run test:all` | Everything above |

The test harness (`test/helpers.js`) boots a real server on a temporary port and a temporary
`DATA_DIR`, so tests exercise the deployed code path rather than mocks.

## Known limitations

1. The JSON store is single-process. Multiple replicas would need a shared database.
2. Rate limiting is in-memory and per-process.
3. Password reset and email verification are not implemented (no SMTP in scope yet).
4. Undo/redo covers slide content and ordering, not settings.
5. Video and audio are stored and can be referenced, but there is no in-editor playback control.
6. Song slide generation uses plain line chunking; no lyric-aware line breaking.
7. Backups are manual (copy `DATA_DIR`); no built-in export yet.
