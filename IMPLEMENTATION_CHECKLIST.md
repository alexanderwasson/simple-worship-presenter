# Simple Worship Presenter — Implementation Checklist

Status: `[x]` complete · `[~]` partial · `[ ]` not started
Verified by the test suite where possible; unverified work is marked `[~]`.

## Phase 0 — Audit
- [x] Repository inspected (2026-10-10)
- [x] Frontend: vanilla JS + static HTML/CSS, no bundler
- [x] Backend: Node 18+, Express 4, CommonJS
- [x] Package manager: npm, `package-lock.json` committed
- [x] Database: JSON document store with numbered migrations
- [x] Auth: bcryptjs + signed JWT in an HttpOnly cookie
- [x] Uploads: multer with magic-byte content validation
- [x] Routing and endpoints enumerated
- [x] Design system identified (`styles.css` custom properties)
- [x] Tests identified (none existed) and added
- [x] Environment configuration documented
- [x] Known bugs recorded in ARCHITECTURE.md
- [x] IMPLEMENTATION_CHECKLIST.md and ARCHITECTURE.md created

## Phase 1 — Architecture
- [x] Presentation logic, routes, data access and storage separated into modules
- [x] Consistent interfaces for auth, data access and storage
- [x] Hosted-only concerns are configuration, not code forks
- [x] Environment variables validated at startup
- [x] No hardcoded production domains
- [x] Configurable public URL (`PUBLIC_URL`)
- [x] Development/production behaviour split (`NODE_ENV`)
- [x] Secrets out of source and client bundles
- [x] Numbered, additive database migrations
- [x] Structured JSON logging with levels
- [x] Consistent `{ error }` API responses
- [x] Health-check endpoint (`/api/health`)
- [x] Runtime and dependencies documented
- [x] Unused dependencies removed
- [x] Existing user data preserved (migration test)

## Phase 2 — Website and application routing
- [x] Marketing site separate from the application
- [x] Homepage explaining the software
- [x] Features page
- [x] Self-hosting and installation page
- [x] Documentation page
- [x] Privacy policy
- [x] Terms of service
- [x] Clear links to sign in / open the app
- [x] Responsive navigation
- [x] Titles, descriptions and landmarks on each page
- [x] Application entry point at `/app`
- [x] Registration, login and logout
- [x] Protected application data
- [x] Refresh-safe routing (each page is a real document)
- [x] Secure cookie configuration
- [ ] Password reset / account recovery (no mail transport yet)
- [ ] Email verification
- [ ] Downloads / source-code page

## Phase 3 — Authentication and accounts
- [x] Free account registration
- [x] Secure login and logout
- [x] bcrypt hashing, cost 12
- [x] Session management with expiry
- [x] Profile and settings
- [x] Account deletion (removes content, releases storage)
- [x] Password change
- [x] Rate limiting on authentication endpoints
- [x] Timing-equalised login response
- [x] Server-side permission checks and per-account isolation
- [x] Clear feedback for failed registration and login
- [x] Automated authentication and authorisation tests
- [ ] Password reset
- [ ] Email verification
- [ ] Additional lockout/CAPTCHA options

## Phase 4 — Storage and quotas
- [x] 25 MB default quota per account
- [x] Administrator-configurable default quota
- [x] Per-account usage tracking
- [x] Used/available storage shown in Settings
- [x] Server-side quota enforcement
- [x] Upload byte accounting from real file size
- [x] Oversized files rejected with a clear explanation
- [x] Storage released on media deletion
- [x] Storage released on account deletion
- [x] Failed uploads cleaned up from disk
- [x] Per-account access control on stored files
- [x] Global and per-file upload size configuration
- [x] Quota boundary tests
- [ ] Concurrent upload guard (accounting is atomic per request but not across processes)
- [ ] Upload progress and cancellation
- [ ] Background reconciliation job

## Phase 5 — Self-hosting and installation
- [x] Complete installation guide
- [x] Example environment configuration
- [x] Documented environment variables
- [x] Dockerfile and docker-compose.yml
- [x] Health checks (HTTP + container healthcheck)
- [x] First administrator creation flow
- [x] Upgrade guidance
- [x] Backup and restore procedure
- [x] Reverse proxy guidance (CloudPanel)
- [x] Configurable instance name and quota
- [x] Configurable maximum upload size
- [x] Operator can disable registration
- [x] Independent of the hosted service (no licence key, no API call home)
- [x] Instance operator controls database and files
- [ ] Built-in data export / migration tool
- [ ] SMTP configuration for email features
- [ ] Clean-room install test on a separate machine

## Phase 6 — Database and data ownership
- [x] Models for users, presentations, slides, service plans, songs, sections, media, settings
- [x] Ownership enforced at the data-access layer
- [x] Numbered migrations
- [x] Write validation and length limits
- [x] Intentional, documented deletion behaviour
- [x] Backup/restore documented
- [x] Data persists across restarts (tested)
- [x] No hardcoded user IDs
- [ ] Concurrent edit safety beyond serialised writes
- [ ] Formal schema documentation for external tools

## Phase 7 — Song library
- [x] Create, edit, delete songs
- [x] Search by title and lyrics (client-side filter)
- [x] Authors, artists, copyright, CCLI and tags
- [x] Verses, choruses, bridges and custom sections
- [x] Custom section ordering and repeats
- [x] Line breaks preserved
- [x] Slide generation with configurable lines per slide
- [x] Song-specific backgrounds (theme field)
- [x] Preview before presenting
- [ ] Import/export songs
- [ ] Reusable named song themes

## Phase 8 — Media library
- [x] Upload images
- [x] Upload video and audio
- [x] Thumbnails and file details
- [x] Set image as background
- [x] File type and size validation (magic bytes)
- [x] Per-account access control
- [x] Delete with storage release
- [x] Quota rules applied consistently
- [ ] Search and filter
- [ ] Rename and replace
- [ ] In-editor video/audio playback
- [ ] Orphaned asset sweep

## Phase 9 — Slide editor
- [x] Create and edit slides
- [x] Edit text content
- [x] Backgrounds and image backgrounds
- [x] 16:9 and 4:3
- [x] Accurate preview matching live output
- [x] Add, duplicate, delete slides
- [x] Reorder slides
- [x] Undo and redo
- [x] Autosave with unsaved-change warning
- [x] Persistent saves
- [ ] Font family, size, weight and colour controls
- [ ] Text positioning and margins
- [ ] Overlays
- [ ] Per-slide alignment persistence

## Phase 10 — Presentations and service plans
- [x] Create presentations
- [x] Rename, duplicate, delete
- [x] Add songs, scripture-ready custom slides, images
- [x] Reorder presentation items
- [x] Original library content preserved when items are removed
- [x] Service plans with dates and notes
- [x] Duplicate service plans
- [x] Launch a plan directly into presenter mode
- [x] Safe handling of missing content
- [ ] Add content types directly from the plan view
- [ ] Upcoming item list in the presenter

## Phase 11 — Live presentation engine
- [x] Dedicated presenter interface (operator)
- [x] Separate audience display window
- [x] Live synchronisation between them
- [x] Next, previous and direct slide selection
- [x] Black/blank screen with restore
- [x] Browser fullscreen
- [x] Keyboard shortcuts
- [x] Reconnect on refresh (presenter-ready handshake + state fallback)
- [x] Output-only audience surface
- [x] Display selection limitations documented
- [ ] Current and upcoming previews on the operator side
- [ ] Disconnect feedback in the operator UI
- [ ] Per-session control tokens to isolate multiple operators
- [ ] Cross-browser matrix testing

## Phase 12 — Additional presentation features
- [ ] Scripture reference lookup
- [ ] Custom announcement slide templates
- [ ] Countdown timers and clocks
- [ ] Automatic slide advancement
- [ ] Rehearsal mode
- [ ] Stage display
- [ ] Private presenter notes
- [ ] Operator messages
- [ ] Audio/video playback controls
- [ ] Browser content slides
- [ ] Full-instance backup export
- [ ] Keyboard shortcut customisation
- [x] Theme and appearance settings (per presentation)

## Phase 13 — Security
- [x] Authorisation on every protected operation
- [x] Input validation and length limits
- [x] Upload content validation by magic bytes
- [x] XSS protection (all user text escaped before render)
- [x] No SQL; JSON store with structured writes
- [x] Rate limiting on auth and write endpoints
- [x] Secure cookies and sessions
- [x] Path traversal and source exposure prevented (allowlist + tests)
- [x] Secrets kept in environment configuration
- [x] Production refuses default secrets
- [x] Uploaded content served from a non-executable directory
- [x] Errors do not leak internals
- [x] Dependency audit clean (`npm audit`)
- [ ] Content Security Policy with nonces
- [ ] Security update policy document

## Phase 14 — Testing and quality assurance
- [x] Test harness boots a real server
- [x] Registration, login, logout, password change, account deletion
- [x] Account isolation
- [x] Storage quota enforcement and release
- [x] Failed and oversized uploads
- [x] Song CRUD and slide generation
- [x] Presentation ordering and duplication
- [x] Service plan behaviour
- [x] Migration and corrupt-file handling
- [x] Data survives restart
- [x] Static surface and rate limiting
- [x] Syntax checks and smoke test
- [ ] Presenter synchronisation tests
- [ ] Backup/restore automation
- [ ] Responsive layout checks
- [ ] Browser matrix

## Phase 15 — NPM and build quality
- [x] npm preserved, lockfile committed
- [x] Documented scripts (`start`, `test`, `check`, `smoke`, `test:unit`, `test:all`)
- [x] Dependency audit clean
- [x] Unused dependencies removed
- [x] Server-only dependencies absent from the client bundle
- [ ] Linting and type checking
- [ ] CI pipeline

## Phase 16 — Documentation and releases
- [x] README.md
- [x] ARCHITECTURE.md
- [x] API.md
- [x] CHANGELOG.md with migration notes
- [x] IMPLEMENTATION_CHECKLIST.md
- [x] Local development setup
- [x] Environment variables
- [x] Hosted deployment guidance
- [x] Self-hosting installation
- [x] Backup and restore
- [x] Browser limitations
- [x] API behaviour documented
- [ ] Release notes publication process

## Highest priority remaining
1. Password reset and email verification (Phase 3)
2. Operator-side current/next slide previews and disconnect feedback (Phase 11)
3. Font/size/weight/colour controls and overlays (Phase 9)
4. Media search, rename and in-editor playback (Phase 8)
5. Song import/export (Phase 7)
