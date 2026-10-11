# Deploying Simple Worship Presenter

This covers the production layout you asked for:

| What | Where | Serves |
| --- | --- | --- |
| Application | `app.simpleworshippresenter.com` | Node process on **port 3002** |
| Public website | `simpleworshippresenter.com` | Static files from `website/` |

The two are independent. The website can be deployed before, after, or alongside the application.

---

## 1. Publish to GitHub

```bash
git init
git add .
git status          # review before committing
git commit -m "Simple Worship Presenter 0.4.0"
git branch -M main
git remote add origin https://github.com/<your-account>/simple-worship-presenter.git
git push -u origin main
```

**Check `git status` before pushing.** These must not appear:

- `node_modules/`
- `data/` — this is live church content: the database and user uploads
- `.env` — this holds your session secret

`.gitignore` already excludes all of them. If `git status` shows `data/`, stop: a
`.gitignore` written after files are tracked does not untrack them.

### Repository contents

| Path | Purpose |
| --- | --- |
| `app/` | Application client (workspace + audience display) |
| `website/` | Public marketing site |
| `src/` | Server modules: config, logging, data store, auth, rate limiting, routes |
| `test/` | Automated tests |
| `scripts/smoke.js` | Boot smoke test |
| `server.js` | Express entry point |
| `package.json`, `package-lock.json` | npm manifest and lockfile |
| `Dockerfile`, `docker-compose.yml` | Container deployment |
| `ecosystem.config.js` | pm2 process configuration |
| `.env.example` | Documented configuration template |
| `README.md`, `ARCHITECTURE.md`, `API.md`, `CHANGELOG.md`, `DEPLOYMENT.md`, `IMPLEMENTATION_CHECKLIST.md` | Documentation |

### Before you publish publicly

1. **Choose a licence.** The repository has no `LICENSE` file yet. For a free, self-hostable
   project, MIT or AGPL-3.0 are the usual options — AGPL keeps hosted forks sharing changes.
   Add a `LICENSE` file and set the `license` field in `package.json` to match.
2. **Set the repository to Public or Private** deliberately.
3. **Confirm no user content** is in the commit history.

---

## 2. Deploy the application on port 3002

### DNS

Create an `A` record for `app.simpleworshippresenter.com` pointing at the server.

### Option A — CloudPanel (Node.js app)

1. **Sites → New Site → Node.js App**, domain `app.simpleworshippresenter.com`.
2. Choose **Node 20** or newer.
3. Set the application root to the project directory.
4. Set the startup file to `server.js`.
5. Set the **application port to `3002`**.
6. In the application directory:

   ```bash
   npm ci --omit=dev
   cp .env.example .env
   nano .env
   ```

7. Create the production `.env`:

   ```bash
   NODE_ENV=production
   PORT=3002
   DATA_DIR=/home/cloudpanel/htdocs/simple-worship-data
   SESSION_SECRET=<48+ random hex characters>
   TRUST_PROXY=1
   INSTANCE_NAME=Simple Worship Presenter
   PUBLIC_URL=https://app.simpleworshippresenter.com
   DEFAULT_QUOTA_BYTES=262144000
   MAX_UPLOAD_BYTES=262144000
   ALLOW_REGISTRATION=1
   LOG_LEVEL=info
   ```

   Generate the secret:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

8. Point CloudPanel's proxy at port `3002` and **enable SSL**.
9. Start the application and open `https://app.simpleworshippresenter.com`.
10. Complete the **first-run administrator setup**.

### Option B — pm2

```bash
npm ci --omit=dev
cp .env.example .env        # edit as above
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup                 # then run the command it prints
```

`ecosystem.config.js` runs the app on port 3002 with `NODE_ENV=production`. Put your
`SESSION_SECRET` in `.env`, not in the config file.

### Option C — Docker

```bash
cp .env.example .env        # set SESSION_SECRET
docker compose up -d --build
```

The compose file exposes port 3002 and keeps user data in the `swp-data` volume.

---

## 2b. Start automatically on server boot (CloudPanel)

CloudPanel does not supervise Node processes for you. The supported method is **pm2 plus a
`@reboot` cron entry**, run as the **site user** — not root.

```bash
# 1. SSH in as the CloudPanel site user
ssh your-site-user@your-server-ip

# 2. Go to the application root
cd htdocs/app.simpleworshippresenter.com

# 3. Install pm2
npm install pm2@latest -g

# 4. Start the app (port 3002 and NODE_ENV=production come from ecosystem.config.js)
pm2 start ecosystem.config.js

# 5. Save the process list — without this, nothing restarts at boot
pm2 save
```

Now register the reboot hook:

```bash
# 6. Print your PATH and copy the whole line
echo $PATH

# 7. Edit the site user's crontab
crontab -e
```

Add exactly these two lines, pasting the output of step 6:

```
PATH=/home/your-site-user/.nvm/versions/node/v20.x.x/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
@reboot pm2 resurrect &> /dev/null
```

The `PATH` line is essential: cron runs with a minimal environment, so `pm2 resurrect` would
otherwise not be found and your app would stay down after a reboot.

### Verify it survives a reboot

```bash
sudo reboot
# after the server is back:
pm2 status          # should show simple-worship-presenter as "online"
pm2 logs simple-worship-presenter --lines 30
curl http://127.0.0.1:3002/api/health
```

### Notes

- **Re-run `pm2 save` after any change** — adding, removing or restarting a process updates the
  saved list that `pm2 resurrect` restores.
- `ecosystem.config.js` sets `instances: 1` deliberately. The JSON data store is single-process;
  do not cluster it.
- `.env` is loaded by the app itself from the project root, so pm2 does not need to load it.
  Keep `SESSION_SECRET` and `DATA_DIR` there.
- To see what pm2 will restore at boot: `pm2 save --force && pm2 resurrect --update-env` after a
  dry run, or simply inspect `~/.pm2/dump.pm2`.
- If you prefer systemd, a user service plus `loginctl enable-linger your-site-user` works too,
  but the pm2 + cron route is what CloudPanel documents and supports.

## 3. Deploy the public website

`website/` is plain static files. Upload the folder as-is to the
`simpleworshippresenter.com` document root.

Before uploading, confirm the application link points at the right place. It is set in exactly one
file:

```js
// website/site.js
var DEFAULT_APP_URL = 'https://app.simpleworshippresenter.com';
```

When the site is opened from `localhost`, that helper automatically follows the same origin
instead, so local preview works without editing anything.

---

## 4. After deployment

- [ ] `https://app.simpleworshippresenter.com/api/health` returns `"status":"ok"`
- [ ] `https://app.simpleworshippresenter.com/` shows the workspace
- [ ] `https://app.simpleworshippresenter.com/presenter` opens the audience display
- [ ] `https://simpleworshippresenter.com/` shows the marketing homepage
- [ ] Registration and sign-in work
- [ ] An upload succeeds and the storage meter moves
- [ ] The administrator account was created on first run

## 5. Backups

Everything that matters lives in `DATA_DIR`:

```
DATA_DIR/
  lumenstage-data.json     # users, presentations, plans, songs, media metadata
  uploads/                 # uploaded media
```

Back up that directory on a schedule. Stop the process first for a consistent snapshot, or copy it
live and accept a small window of risk.

```bash
tar -czf swp-$(date +%F).tar.gz "$DATA_DIR"
```

## 6. Upgrades

```bash
git pull
npm ci --omit=dev
# restart
pm2 restart simple-worship-presenter      # or restart in CloudPanel
```

Schema migrations run automatically on start and are additive. Back up `DATA_DIR` first.
Application updates never touch `DATA_DIR`, which is why it lives outside the release directory.

## 7. Things that can bite

| Symptom | Fix |
| --- | --- |
| Cookies are not kept behind the proxy | `TRUST_PROXY=1` and serve over HTTPS |
| The app restarts in a crash loop | Check `SESSION_SECRET` is set and `DATA_DIR` is writable |
| Uploads return 413 | Raise `MAX_UPLOAD_BYTES`, the account quota, and the proxy body size limit |
| The audience window stays blank | Reload both windows; the display announces itself on load |
| The data file will not load | A `*.corrupt-*` copy is preserved automatically — restore from backup |

## 8. Ports

| Port | Use |
| --- | --- |
| **3002** | Simple Worship Presenter application (this deployment) |
| 80 / 443 | Reverse proxy, terminating TLS for both domains |
