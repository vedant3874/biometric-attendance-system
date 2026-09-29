/**
 * routes/auth.js
 * -----------------------------------------------------------------------------
 *   POST /api/auth/login    { username, password } -> starts a session
 *   POST /api/auth/logout   -> ends it
 *   GET  /api/auth/session  -> whether the current request is signed in
 */

'use strict';

const express = require('express');
const {
  ADMIN_USERNAME,
  verifyCredentials,
  lockoutRemaining,
  recordFailure,
  recordSuccess,
} = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const ip = req.ip;

  const waitSeconds = lockoutRemaining(ip);
  if (waitSeconds > 0) {
    return res.status(429).json({
      ok: false,
      code: 'LOCKED_OUT',
      message: `Too many failed attempts. Try again in ${waitSeconds}s.`,
      retryAfter: waitSeconds,
    });
  }

  const { username, password } = req.body || {};
  const valid = await verifyCredentials(username, password);

  if (!valid) {
    recordFailure(ip);
    return res.status(401).json({
      ok: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Incorrect username or password.',
    });
  }

  recordSuccess(ip);

  // Regenerate the session id on login so a session id issued before
  // authentication (e.g. to an attacker who primed one) can't be reused
  // after it succeeds.
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({
        ok: false,
        code: 'SERVER_ERROR',
        message: 'Could not start a session. Try again.',
      });
    }
    req.session.isAdmin = true;
    req.session.username = ADMIN_USERNAME;
    res.json({ ok: true, username: ADMIN_USERNAME });
  });
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/session', (req, res) => {
  res.json({
    ok: true,
    authenticated: Boolean(req.session && req.session.isAdmin),
    username: (req.session && req.session.username) || null,
  });
});

module.exports = router;
