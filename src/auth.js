'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');

const COOKIE = 'lumen_session';
const BCRYPT_COST = 12;
const SESSION_DAYS = 7;

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    quota_bytes: u.quota_bytes,
    used_bytes: u.used_bytes,
    created_at: u.created_at
  };
}

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.sessionSecret, { expiresIn: SESSION_DAYS + 'd' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/' });
}

function sessionUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.sessionSecret);
    return db.findUserById(payload.sub) || null;
  } catch {
    return null;
  }
}

// Every protected handler must pass through this. Ownership checks happen in
// the data-access layer (db.owned / db.allOwned), never in the client.
function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
    next();
  });
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 200) return 'Password must be 200 characters or fewer';
  return null;
}

function validateName(name) {
  const value = String(name || '').trim();
  if (value.length < 1) return 'Name is required';
  if (value.length > 100) return 'Name must be 100 characters or fewer';
  return null;
}

function validateEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'A valid email address is required';
  if (value.length > 254) return 'Email must be 254 characters or fewer';
  return null;
}

async function verifyPassword(user, password) {
  return bcrypt.compare(String(password || ''), user.password_hash);
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

module.exports = {
  publicUser,
  setSession,
  clearSession,
  sessionUser,
  requireAuth,
  requireAdmin,
  validatePassword,
  validateName,
  validateEmail,
  verifyPassword,
  hashPassword
};
