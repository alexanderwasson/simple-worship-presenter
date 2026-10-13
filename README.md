# Simple Worship Presenter

Free, browser-based worship presentation software. Build service plans, organise songs and
media, and project lyrics to a second screen — on our hosted service or on your own server.

**Website:** https://simpleworshippresenter.com · **Application:** https://app.simpleworshippresenter.com

---

## What it does

- **Service plans** — group presentations for a date, add notes, duplicate for next week, and
  launch the plan straight into presenter mode.
- **Song library** — store lyrics as labelled sections (Verse, Chorus, Bridge, custom), reorder
  them, and generate correctly spaced slides with your chosen line count.
- **Storage quotas** — everything an account stores counts: presentations, songs, service plans and uploads are measured and enforced server-side.
- **Media library** — upload images, video and audio, and use any image as a slide or
  presentation background.
- **Presentation editor** — undo/redo, duplicate and reorder slides, 16:9 and 4:3 canvases,
  themes, backgrounds, autosave.
- **Live audience display** — a separate projector window that follows the operator live, with
  blanking, direct slide selection and fullscreen.
- **Mobile remote** — pair a phone by QR code and drive the service from the pews or the sound desk:
  previous/next, tap any slide, black screen, and live current/next previews.
- **Built-in scripture** — the public domain World English Bible, 66 books and 1,189 chapters, stored
  once per installation and free of any storage quota. Look up a reference or search the text, then
  generate correctly spaced slides with verse numbers and a reference label.
- **Animated backgrounds** — any video or animated image from your media library can back a slide or
  a whole presentation, with an adjustable overlay to keep text readable.
- **Import and backup** — bring in a converted backup or a package archive, and get back a summary of
  every song, presentation and service plan created, plus anything skipped and why.

The software does **not** ship copyrighted song lyrics or Bible translations. Bring content you
own or are licensed to use, and record your CCLI licence in Settings.

## Requirements

- Node.js 18 or newer
- npm
- A persistent directory for data (database + uploads)

## Project layout

Two independently deployable units live side by side:

```
app/          The application client — deploy behind app.simpleworshippresenter.com
  index.html      Workspace
  presenter.html  Audience display
  app.js          Workspace client
  presenter.js    Audience display client
  styles.css      Application styles

website/      The public marketing site — deploy to simpleworshippresenter.com
  index.html, features.html, self-hosting.html,
  docs.html, privacy.html, terms.html
  styles.css      Standalone site styles
  site.js         Resolves the application link in one place

server.js     Node/Express server: serves app/ and the JSON API
src/          Configuration, logging, data store, auth, rate limiting, routes
test/         Automated tests
```

`website/` has no dependency on the application: copy that folder to any static host.
`app/` is served by the Node process on the application domain.

When running a single instance locally, the public site is also previewable under
`http://localhost:3000/site/` while the workspace is at the root.

## Quick start

```bash
git clone https://github.com/alexanderwasson/simple-worship-presenter
cd simple-worship-presenter
npm ci

cp .env.example .env
# set SESSION_SECRET to a long random value

npm start
```

Open http://localhost:3000 and create the **administrator account**. That first-run prompt only
appears while the instance has no users.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the server |
| `npm test` | Syntax checks + the automated test suite |
| `npm run test:all` | Syntax checks + smoke test + full test suite |
| `npm run check` | Syntax checks only |

## Publishing and deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full runbook. In short:

- **GitHub** — commit everything except `node_modules/`, `data/` and `.env` (`.gitignore` handles
  all three). `data/` contains live church content and must never be published.
- **Application** — `app.simpleworshippresenter.com`, Node on **port 3002**, started with
  `server.js`. `ecosystem.config.js` is ready for pm2, or use CloudPanel's Node.js app or Docker.
- **Website** — upload the `website/` folder to `simpleworshippresenter.com` as plain static files.
  The application URL lives in one place: `website/site.js`.

## Configuration

Every setting is documented in [.env.example](.env.example). The important ones:

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | **Required in production.** Signs session tokens. |
| `DATA_DIR` | Persistent data root. Keep it outside the release directory. |
| `DEFAULT_QUOTA_BYTES` | Storage granted to each new account (25 MB by default). |
| `MAX_UPLOAD_BYTES` | Largest single upload accepted. |
| `ALLOW_REGISTRATION` | Set `0` to close public sign-ups. |
| `TRUST_PROXY` | Set `1` behind nginx/CloudPanel. |

Full instructions, including CloudPanel and Docker, are on the
[self-hosting page](website/self-hosting.html), or in `website/self-hosting.html`.

## Data and upgrades

All user data lives in `DATA_DIR`:

```
data/
  lumenstage-data.json   # users, presentations, service plans, songs, media metadata
  uploads/               # uploaded media files
```

Back up that directory to back up the instance. Application updates never touch it. Database
schema changes run automatically as numbered, additive migrations on startup. If the data file
cannot be read, the instance preserves a `*.corrupt-<timestamp>` copy instead of overwriting it.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the technical design, [API.md](API.md) for the HTTP
API, and [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) for what is complete and what
is still open.

## Security

- Passwords hashed with bcrypt (cost 12); plaintext passwords are never stored.
- Signed, `HttpOnly`, `SameSite` session cookies; `Secure` in production.
- Every protected request is authorised server-side and scoped to the account.
- Rate limits on authentication and write endpoints.
- Uploads validated by file content (magic bytes), not just extension.
- Source, data and dependency directories are never served over HTTP.
- Slide text is escaped before rendering to prevent stored XSS.

## Browser support

Latest Chrome, Edge, Firefox and Safari. The audience display opens as a separate browser
window; drag it to the projector and press `F` for fullscreen. Browsers cannot select a physical
monitor programmatically, so window arrangement is manual on every platform.

## Licence and attribution

Independent software created and maintained by
[Alexander Wasson](https://alexanderwasson.dev/). Not affiliated with or a reproduction of any
other presentation product. See `terms.html` for terms of use and `privacy.html` for the privacy
policy.

Parts of this software were produced with AI-assisted development and reviewed by a human before
release. That applies to source code and interface copy only — AI is not used to generate or store
your worship content.
