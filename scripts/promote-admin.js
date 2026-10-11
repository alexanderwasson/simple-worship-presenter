#!/usr/bin/env node
'use strict';
/*
 * Promote an existing account to administrator.
 *
 *   node scripts/promote-admin.js --list
 *   node scripts/promote-admin.js you@example.com
 *
 * Stop the service first. The server keeps the data in memory and rewrites the
 * file on save, so a change made underneath a running instance can be lost.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const DB_FILE = path.join(config.dataDir, 'lumenstage-data.json');

function fail(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    fail('No data file found at ' + DB_FILE + '\n  Check DATA_DIR in .env, or run this from the application directory.');
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    fail('Could not read ' + DB_FILE + ': ' + err.message);
  }
}

function save(data) {
  // Write to a temporary file first so a crash cannot corrupt the real one.
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function listUsers(data) {
  const users = data.users || [];
  if (!users.length) {
    console.log('\n  No accounts exist yet. Open the site and create the administrator on first run.\n');
    return;
  }
  console.log('\n  Accounts in ' + DB_FILE);
  console.log('  ' + '-'.repeat(72));
  for (const u of users) {
    console.log('  ' + (u.role === 'admin' ? '[admin]' : '[user] ').padEnd(9) + u.email.padEnd(36) + u.name);
  }
  console.log('\n  Promote one with:  node scripts/promote-admin.js <email>\n');
}

const arg = process.argv[2];

if (!arg || arg === '--list' || arg === '--help') {
  if (!arg || arg === '--help') {
    console.log('\n  Simple Worship Presenter — account maintenance\n');
    console.log('    node scripts/promote-admin.js --list          show every account');
    console.log('    node scripts/promote-admin.js <email>          make that account an administrator');
    console.log('');
  }
  listUsers(load());
  process.exit(0);
}

const email = String(arg).trim().toLowerCase();
const data = load();
const user = (data.users || []).find(u => String(u.email).toLowerCase() === email);

if (!user) {
  console.error('\n  No account with the email "' + email + '".\n');
  listUsers(data);
  process.exit(1);
}

if (user.role === 'admin') {
  console.log('\n  ' + user.email + ' (' + user.name + ') is already an administrator.\n');
  process.exit(0);
}

user.role = 'admin';
save(data);

console.log('\n  Done. ' + user.email + ' (' + user.name + ') is now an administrator.');
console.log('\n  Start the service again:');
console.log('    pm2 start simple-worship-presenter');
console.log('  then reload the site and open Settings to see the admin controls.\n');
