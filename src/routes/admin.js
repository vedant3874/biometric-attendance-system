/**
 * routes/admin.js
 * -----------------------------------------------------------------------------
 * Read endpoints for the dashboard, plus user management.
 *
 *   GET    /api/admin/today          today's attendance, joined with names
 *   GET    /api/admin/history        every record, newest first
 *   GET    /api/admin/users          enrolled people (no descriptors)
 *   GET    /api/admin/stats          headline counts for the dashboard cards
 *   DELETE /api/admin/users/:id      remove a person and their records
 *
 * There is deliberately no authentication here. This is a LAN kiosk app —
 * see the "Before you deploy this" section of the README, which explains what
 * you need to add before this is exposed to anything beyond your own machine.
 */

'use strict';

const express = require('express');
const db = require('../db');
const { sendFailure } = require('./respond');

const router = express.Router();

/** GET /api/admin/today — optional ?date=YYYY-MM-DD to look at another day. */
router.get('/today', (req, res) => {
  try {
    const date = isValidDate(req.query.date) ? req.query.date : db.todayDate();
    return res.json({
      ok: true,
      date,
      records: db.getAttendanceForDate(date),
      stats: db.getStats(date),
      lateAfter: db.LATE_AFTER,
    });
  } catch (err) {
    return sendFailure(res, err);
  }
});

/** GET /api/admin/history — every record, newest first. ?limit= caps the page. */
router.get('/history', (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 5000);
    return res.json({
      ok: true,
      records: db.getAttendanceHistory(limit),
      limit,
    });
  } catch (err) {
    return sendFailure(res, err);
  }
});

/** GET /api/admin/users — enrolled people, descriptors withheld. */
router.get('/users', (req, res) => {
  try {
    return res.json({ ok: true, users: db.getUsers() });
  } catch (err) {
    return sendFailure(res, err);
  }
});

/** GET /api/admin/stats — counts for the dashboard cards. */
router.get('/stats', (req, res) => {
  try {
    return res.json({ ok: true, date: db.todayDate(), stats: db.getStats() });
  } catch (err) {
    return sendFailure(res, err);
  }
});

/** DELETE /api/admin/users/:id — cascades to that person's attendance rows. */
router.delete('/users/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_ID',
        message: 'That user id is not valid.',
      });
    }

    const removed = db.deleteUser(id);
    if (!removed) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        message: 'No user with that id.',
      });
    }

    return res.json({ ok: true, message: 'User removed, along with their records.' });
  } catch (err) {
    return sendFailure(res, err);
  }
});

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

module.exports = router;
