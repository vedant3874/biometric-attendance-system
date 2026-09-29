/**
 * server.js
 * -----------------------------------------------------------------------------
 * Entry point.
 *
 * The important detail is ordering: the models are loaded into memory *before*
 * app.listen() is called, so no request can ever race the loader.
 *
 *   npm start                     -> http://localhost:3000
 *   PORT=8080 npm start
 *   LATE_AFTER=10:00 npm start    -> anyone after 10:00 is recorded as 'Late'
 *   ADMIN_USERNAME=... ADMIN_PASSWORD=... npm start  -> override the default admin login
 */

'use strict';

// Loaded first, and before any of our own modules: src/auth.js reads
// ADMIN_USERNAME / ADMIN_PASSWORD from process.env the moment it's required
// (that's when it hashes the password), so .env has to be in place before
// that require happens. No .env file? This is a silent no-op — nothing here
// requires one to exist.
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const { loadModels, MODELS_DIR, MATCH_THRESHOLD, DETECTOR, TINY_INPUT_SIZE } = require('./src/faceEngine');
const api = require('./src/routes');
const db = require('./src/db'); // creates data/attendance.db on first import
const {
  requirePageAuth,
  USING_DEFAULT_CREDENTIALS,
  ADMIN_USERNAME,
} = require('./src/auth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Webcam snapshots arrive as base64 JSON, which is bulky. Express defaults to
// 100 KB, and a 720p JPEG blows straight past that.
app.use(express.json({ limit: '10mb' }));

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

// Without SESSION_SECRET, a fresh random one is generated on every boot, which
// means everyone is signed out whenever the server restarts. Fine for a kiosk
// laptop that stays running; set SESSION_SECRET to anything long and random
// if that's ever annoying, or before running two instances behind a proxy.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.log('No SESSION_SECRET set — using a random one for this run.');
  console.log('Everyone will need to sign in again after each restart. Set SESSION_SECRET to avoid that.\n');
}

app.use(
  session({
    name: 'attendance.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Browsers only send `secure` cookies over HTTPS. This app runs over
      // plain HTTP on localhost by default (see the README), so `secure`
      // stays off unless you've explicitly put HTTPS in front of it.
      secure: process.env.FORCE_SECURE_COOKIE === 'true',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
    // The default MemoryStore is fine for one admin on one machine, and is
    // called out explicitly rather than left to a startup warning — see the
    // README for when to swap in a real session store.
  })
);

// Static assets (Tailwind is on a CDN, so this is just our own JS and CSS).
// Note: only public/ is served statically. The admin and login pages live in
// views/, which express.static never exposes — the ONLY way to reach
// admin.html is through the guarded /admin route below. Serving it from
// public/ would let anyone fetch /admin.html directly and skip the login
// check entirely, so this separation is load-bearing, not just tidiness.
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', api);

/* -------------------------------------------------------------------------- */
/* Pages                                                                      */
/* -------------------------------------------------------------------------- */

const publicPage = (file) => (req, res) =>
  res.sendFile(path.join(__dirname, 'public', file));

const viewPage = (file) => (req, res) =>
  res.sendFile(path.join(__dirname, 'views', file));

app.get('/', publicPage('index.html'));
app.get('/user', publicPage('index.html'));

app.get('/login', (req, res) => {
  // Already signed in — the login form has nothing left to do.
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  return viewPage('login.html')(req, res);
});

app.get('/admin', requirePageAuth, viewPage('admin.html'));

/* -------------------------------------------------------------------------- */
/* Fallbacks                                                                  */
/* -------------------------------------------------------------------------- */

// Anything unmatched under /api is a real 404 and should stay JSON, so the
// frontend never tries to parse an HTML error page as a response body.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'No such endpoint.' });
});

// Everything else falls back to the kiosk.
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

// Malformed JSON bodies and oversized payloads.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err instanceof SyntaxError)) {
    return res.status(400).json({
      ok: false,
      code: 'BAD_REQUEST',
      message: 'The request body was malformed or too large.',
    });
  }
  return next(err);
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function start() {
  console.log('Loading face recognition models from', MODELS_DIR);
  const startedAt = Date.now();

  try {
    await loadModels();
  } catch (err) {
    console.error('\nCould not load the models:', err.message);
    console.error('Run "npm run models" to download them, then start again.\n');
    process.exit(1);
  }

  console.log(`Models ready in ${Date.now() - startedAt} ms`);
  console.log(`  detector             ${DETECTOR}${DETECTOR === 'tiny' ? ` (input size ${TINY_INPUT_SIZE})` : ' (slower, more precise)'}`);
  console.log('  faceLandmark68Net    alignment');
  console.log('  faceRecognitionNet   128-point descriptors');
  console.log(`\nMatch threshold ${MATCH_THRESHOLD}  ·  late after ${db.LATE_AFTER}`);

  if (USING_DEFAULT_CREDENTIALS) {
    console.log(
      `\n  Using the DEFAULT admin login (${ADMIN_USERNAME} / password123).\n` +
        '  Set ADMIN_USERNAME and ADMIN_PASSWORD before anyone else can reach this machine.'
    );
  }

  app.listen(PORT, () => {
    console.log(`\n  Kiosk       http://localhost:${PORT}/`);
    console.log(`  Dashboard   http://localhost:${PORT}/admin  (login required)\n`);
  });
}

start();
