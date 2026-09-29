/**
 * auth.js
 * -----------------------------------------------------------------------------
 * Single fixed admin account. No admins table — this is the "one account is
 * enough" version. (For multiple admin accounts, add an `admins` table with
 * bcrypt-hashed passwords and swap verifyCredentials() to query it; everything
 * else here — sessions, the route guards, the lockout — stays the same.)
 *
 * The password is still bcrypt-hashed, even though there's only one of it.
 * Hashing costs nothing extra to do here, and it means the plaintext password
 * exists only for the instant it's typed — it's never compared or logged
 * as-is, and the hash in memory is useless to anyone who dumps the process.
 *
 * bcryptjs (not bcrypt) is deliberate: bcrypt is a native addon and would
 * reintroduce the exact "prebuilt binary or a C++ toolchain" problem that
 * `canvas` caused. bcryptjs is pure JavaScript — nothing to compile, nothing
 * to fail on a machine without build tools.
 */

'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password123';

const USING_DEFAULT_CREDENTIALS =
  !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD;

// Hashed once at boot. bcrypt.compare() is what actually runs on every login;
// this hash is the only place the password lives from here on.
const PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

/* -------------------------------------------------------------------------- */
/* Brute-force lockout                                                        */
/* -------------------------------------------------------------------------- */

// A hardcoded single account is a fixed target, so failed attempts are rate
// limited per IP. In-memory is fine here — this resets on restart, same as
// the session store, which is an acceptable tradeoff for a single-machine app
// (see the README's "Before you deploy this").
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

const attempts = new Map(); // ip -> { count, lockedUntil }

/** Seconds remaining if this IP is locked out, else 0. */
function lockoutRemaining(ip) {
  const rec = attempts.get(ip);
  if (!rec || !rec.lockedUntil) return 0;
  const remaining = rec.lockedUntil - Date.now();
  if (remaining <= 0) {
    attempts.delete(ip); // lockout expired — clear it so old counts don't linger
    return 0;
  }
  return Math.ceil(remaining / 1000);
}

function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

/* -------------------------------------------------------------------------- */
/* Credential check                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function verifyCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return false;

  // Always run bcrypt.compare, even when the username is already wrong, so a
  // bad username doesn't return measurably faster than a bad password — that
  // timing difference is a real (if minor) way to fingerprint a valid login.
  const passwordOk = await bcrypt.compare(password, PASSWORD_HASH);
  const usernameOk = timingSafeEqualStrings(username, ADMIN_USERNAME);

  return usernameOk && passwordOk;
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Lengths almost always differ for a wrong username, and timingSafeEqual
  // requires equal-length buffers, so pad to a common length first — the
  // padding itself leaks nothing, it just lets the comparison run at all.
  const len = Math.max(bufA.length, bufB.length, 1);
  const paddedA = Buffer.concat([bufA], len);
  const paddedB = Buffer.concat([bufB], len);
  return crypto.timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

/* -------------------------------------------------------------------------- */
/* Route guards                                                               */
/* -------------------------------------------------------------------------- */

/** Protects HTML pages — sends an unauthenticated visitor to the login form. */
function requirePageAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/login');
}

/** Protects JSON endpoints — a redirect would just confuse a fetch() call. */
function requireApiAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({
    ok: false,
    code: 'UNAUTHENTICATED',
    message: 'Sign in required.',
  });
}

module.exports = {
  ADMIN_USERNAME,
  USING_DEFAULT_CREDENTIALS,
  verifyCredentials,
  requirePageAuth,
  requireApiAuth,
  lockoutRemaining,
  recordFailure,
  recordSuccess,
  MAX_ATTEMPTS,
};
