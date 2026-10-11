# Simple Worship Presenter — HTTP API

All endpoints are JSON. Errors always use the shape `{ "error": "message" }` with an appropriate
HTTP status. Protected endpoints require the `lumen_session` cookie issued at sign-in.

## Health

### `GET /api/health`
Public. Returns `{ status, name, version, schema_version, uptime }`.

## Setup

### `GET /api/setup/status`
Public. Returns `{ needsAdmin, instance }`. `needsAdmin` is true only while the instance has no
users.

### `POST /api/setup/admin`
Public, but only accepted while the instance has no users. Body: `{ name, email, password }`.
Creates the administrator and starts a session. Passwords must be 10–200 characters.

## Authentication

### `POST /api/auth/register`
Body: `{ name, email, password }`. Creates an account with the configured default quota.
Rejected with `403` when `ALLOW_REGISTRATION=0`.

### `POST /api/auth/login`
Body: `{ email, password }`. Returns `{ user }` and sets the session cookie.

### `POST /api/auth/logout`
Clears the session cookie.

### `GET /api/auth/me`
Returns the signed-in `{ user }`. `401` when not authenticated.

## Account

### `POST /api/account/password`
Body: `{ current_password, new_password }`. `401` when the current password is wrong.

### `DELETE /api/account`
Body: `{ password }`. Permanently removes the account and all of its content, releases the
storage, and clears the session.

## Settings

### `GET /api/settings`
Returns `{ instance, public_url, quota_bytes, used_bytes, allow_registration, ccli_license }`.

### `PUT /api/settings`
Body: `{ ccli_license? }`. Per-account settings.

## Media

### `GET /api/media`
Returns `{ media }` for the signed-in account only.

### `POST /api/media`
Multipart field `file`. Content is validated by magic bytes; accepted: PNG, JPEG, GIF, WebP,
MP4, MP3, WAV, OGG. `415` for unrecognised content, `413` over the account quota or the
configured maximum size.

### `GET /api/media/:id/file`
Streams the file. `404` unless the media belongs to the caller.

### `DELETE /api/media/:id`
Removes the file from disk, the record, and the accounted usage.

## Songs

### `GET /api/songs` · `POST /api/songs` · `PUT /api/songs/:id` · `DELETE /api/songs/:id`
Song shape: `{ title, artist, author, copyright, ccli, tags[], sections[{ id, label, text }], theme }`.
`title` is required. Ownership is enforced on every operation.

### `POST /api/songs/:id/generate`
Body: `{ lines_per_slide?, order? }`. `order` is a list of section ids and may repeat sections.
Returns `{ slides, title }`, where each slide is `{ text, section, background }`.

## Presentations

### `GET /api/presentations`
Returns `{ presentations }`, each with its parsed `slides` array. A slide is either a string or
`{ text, image?, background?, name? }`.

### `POST /api/presentations`
Body: `{ title, slides }`. Returns the created presentation.

### `PUT /api/presentations/:id`
Body: `{ title?, slides? }`.

### `POST /api/presentations/:id/duplicate`
Creates a copy titled `<title> copy`.

### `DELETE /api/presentations/:id`

## Service plans ("programs")

### `GET /api/programs` · `POST /api/programs` · `PUT /api/programs/:id` · `DELETE /api/programs/:id`
Plan shape: `{ title, date, notes, presentation_ids[] }`. Removing a plan never deletes the
presentations it references.

### `POST /api/programs/:id/duplicate`

## Legacy

### `POST /api/import`
Multipart `file`. Media is stored in the media library; readable text is returned as `{ text }`
for conversion into slides. Kept for backward compatibility.

## Admin

All admin routes require the `admin` role and return `403` otherwise.

### `GET /api/admin/instance` · `PUT /api/admin/instance`
Reads and updates the instance default quota and returns usage statistics.
Body: `{ default_quota_bytes? }`.

### `GET /api/admin/users`
Returns `{ default_quota_bytes, users[] }` with each account's name, email, role, quota and usage.

### `POST /api/admin/users`
Body: `{ name, email, password, quota_bytes?, role? }`. Creates an account that can sign in
immediately. `quota_bytes` defaults to the instance default.

### `PUT /api/admin/users/:id`
Body: `{ name?, quota_bytes?, role? }`. Quotas cannot be set below the storage the account already
uses. An administrator cannot remove their own `admin` role.

### `DELETE /api/admin/users/:id`
Deletes the account and all of its presentations, plans, songs and media, and frees the storage.
An administrator cannot delete their own account here.

### `GET /api/admin/update`
Version and maintenance information: current version, Node version, schema version, uptime, data
directory, whether update checking and self-update are configured, and the last check/run results.

### `POST /api/admin/update/check`
Requires `UPDATE_CHECK_URL` to be configured. Fetches a JSON endpoint returning
`{ version, notes, url }` and compares it against the installed version.

### `POST /api/admin/update/run`
Body: `{ confirm: true }`. Requires `UPDATE_COMMAND` to be configured by the operator. Runs that
command in the application directory and returns the captured output. The command comes from
environment configuration, never from the request.

### `GET /api/admin/backup`
Downloads the data file (accounts, presentations, plans, songs, media metadata) as a dated JSON
attachment. Uploaded media live alongside it in `DATA_DIR/uploads`.

## Rate limits

| Endpoint group | Default limit |
| --- | --- |
| `/api/auth/*`, `/api/setup/admin` | 10 requests / minute / IP |
| All other `/api` writes | 240 requests / minute / IP |

Exceeding a limit returns `429` with a `Retry-After` header. Limits are configurable through
`RATE_LIMIT_MAX_AUTH` and `RATE_LIMIT_MAX_WRITE`.
