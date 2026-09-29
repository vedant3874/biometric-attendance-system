/**
 * routes/index.js
 * -----------------------------------------------------------------------------
 * Mounts the two route groups under /api and adds a health check.
 */

'use strict';

const express = require('express');
const kiosk = require('./kiosk');
const admin = require('./admin');
const authRoutes = require('./auth');
const db = require('../db');
const { MATCH_THRESHOLD } = require('../faceEngine');
const { requireApiAuth } = require('../auth');

const router = express.Router();

/** GET /api/health — used by the frontend to show the connection pill. */
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    date: db.todayDate(),
    time: db.nowTime(),
    enrolled: db.getUsers().length,
    matchThreshold: MATCH_THRESHOLD,
    lateAfter: db.LATE_AFTER,
  });
});

router.use('/auth', authRoutes); // /api/auth/login, /logout, /session — public
router.use('/', kiosk); // /api/attend is public; /api/enroll guards itself
router.use('/admin', requireApiAuth, admin); // every /api/admin/* route requires login

module.exports = router;
