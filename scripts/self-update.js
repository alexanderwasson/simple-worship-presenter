#!/usr/bin/env node
'use strict';
/*
 * Self-update for Simple Worship Presenter.
 *
 *   node scripts/self-update.js
 *
 * Works for both deployment styles:
 *   - a git checkout      -> git pull --ff-only, then npm ci
 *   - a copied/uploaded   -> download the release archive, overwrite the app
 *     deployment             files, then npm ci
 *
 * Never touches user data: data/, uploads/, .env, node_modules and .git are
 * preserved.
 *
 * Environment:
 *   UPDATE_TARGET_DIR    install to update (default: this script's application)
 *   UPDATE_REPO          GitHub repository (default: the upstream project)
 *   UPDATE_REF           branch or ref to install (default: main)
 *   UPDATE_ARCHIVE_URL   release archive; may also be a local file path
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(process.env.UPDATE_TARGET_DIR || path.join(__dirname, '..'));
const REPO = process.env.UPDATE_REPO || 'alexanderwasson/simple-worship-presenter';
const REF = process.env.UPDATE_REF || 'main';
const ARCHIVE_URL = process.env.UPDATE_ARCHIVE_URL ||
  'https://github.com/' + REPO + '/archive/refs/heads/' + REF + '.tar.gz';

// Never copy these over an existing installation.
const PRESERVE = new Set(['data', '.env', '.env.local', 'node_modules', '.git', 'uploads', 'logs']);

function hasCommand(cmd) {
  try {
    execSync(process.platform === 'win32' ? 'where ' + cmd : 'command -v ' + cmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write('\n  ' + message + '\n');
  process.exit(1);
}

async function main() {
  const log = message => process.stdout.write(message + '\n');

  function run(command, label) {
    log('  ' + (label || command));
    try {
      execSync(command, { cwd: APP_ROOT, stdio: 'inherit', timeout: 15 * 60 * 1000 });
    } catch (err) {
      fail((label || command) + ' failed (exit ' + (err.status || 1) + ').\n  Run it yourself in ' + APP_ROOT + ' to see the full output.');
    }
  }

  log('');
  log('Simple Worship Presenter - self-update');
  log('  application : ' + APP_ROOT);

  if (!fs.existsSync(path.join(APP_ROOT, 'package.json'))) {
    fail(APP_ROOT + ' does not look like an application directory (no package.json).');
  }
  if (!hasCommand('npm')) {
    fail('npm was not found on PATH. Install Node.js and npm, or set UPDATE_COMMAND to use their full paths.');
  }

  const isGitCheckout = fs.existsSync(path.join(APP_ROOT, '.git'));

  if (isGitCheckout) {
    log('  method      : git checkout');
    if (!hasCommand('git')) fail('This is a git checkout but git was not found on PATH.');
    run('git pull --ff-only', 'Pulling the latest code');
  } else {
    log('  method      : release archive');
    if (!hasCommand('tar')) fail('tar was not found on PATH; it is required to unpack the release.');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-update-'));
    const archive = path.join(tmp, 'release.tar.gz');
    const extractTo = path.join(tmp, 'extracted');
    fs.mkdirSync(extractTo, { recursive: true });

    log('  downloading ' + ARCHIVE_URL);
    try {
      if (fs.existsSync(ARCHIVE_URL)) {
        // Local archive, used for testing and for air-gapped installs.
        fs.copyFileSync(ARCHIVE_URL, archive);
      } else {
        const response = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      }
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fail('Could not download the release: ' + err.message);
    }

    try {
      execSync('tar -xzf "' + archive + '" -C "' + extractTo + '"', { stdio: 'inherit', timeout: 120000 });
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
      fail('Could not unpack the release archive.');
    }

    // The archive extracts into a single top-level directory.
    const entries = fs.readdirSync(extractTo);
    const source = path.join(extractTo, entries[0]);
    if (!fs.existsSync(source) || !fs.existsSync(path.join(source, 'package.json'))) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fail('The release archive did not contain an application directory.');
    }

    log('  installing new files (data/, .env and node_modules/ preserved)');
    for (const entry of fs.readdirSync(source)) {
      if (PRESERVE.has(entry)) continue;
      const from = path.join(source, entry);
      const to = path.join(APP_ROOT, entry);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  run('npm ci --omit=dev', 'Installing dependencies');

  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  log('');
  log('  Done. Installed version: ' + pkg.version);
  log('  Restart the service to activate it:');
  log('    pm2 restart simple-worship-presenter');
  log('');
}

main().catch(err => {
  process.stderr.write('\n  ' + ((err && err.message) || err) + '\n');
  process.exit(1);
});
