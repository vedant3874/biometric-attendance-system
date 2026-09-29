/**
 * db.js
 * -----------------------------------------------------------------------------
 * SQLite storage via better-sqlite3 — synchronous, no callbacks, no connection
 * pool. That is the right shape for a single-machine kiosk: every query here
 * finishes in microseconds and there is never more than one writer.
 *
 * Schema
 *   users       id, name, descriptor (JSON string of 128 floats), created_at
 *   attendance  id, user_id, date (YYYY-MM-DD), time (HH:MM:SS), status
 *
 * The UNIQUE (user_id, date) constraint on `attendance` is what makes marking
 * idempotent at the storage layer. The route also checks before inserting, but
 * the constraint is the thing that actually holds if two scans ever race.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'attendance.db'));

// WAL lets the admin dashboard read while the kiosk writes, without blocking.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    descriptor  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    date     TEXT NOT NULL,              -- YYYY-MM-DD, local calendar day
    time     TEXT NOT NULL,              -- HH:MM:SS, local clock
    status   TEXT NOT NULL,              -- 'Present' | 'Late'
    UNIQUE (user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
`);

/* -------------------------------------------------------------------------- */
/* Time helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Anyone scanning in after this local time is recorded as 'Late'.
 * Change it with the LATE_AFTER env var, e.g. LATE_AFTER=10:00 npm start
 */
const LATE_AFTER = process.env.LATE_AFTER || '09:30';

const pad = (n) => String(n).padStart(2, '0');

/**
 * Local YYYY-MM-DD — deliberately not UTC. Someone clocking in at 1 a.m. IST
 * belongs to that calendar day, not to yesterday in London.
 */
function todayDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local HH:MM:SS. */
function nowTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'Present' before the cutoff, 'Late' after it. */
function statusFor(time = nowTime()) {
  return time.slice(0, 5) > LATE_AFTER ? 'Late' : 'Present';
}

/* -------------------------------------------------------------------------- */
/* Prepared statements — compiled once, reused for the life of the process     */
/* -------------------------------------------------------------------------- */

const stmt = {
  insertUser: db.prepare(
    'INSERT INTO users (name, descriptor, created_at) VALUES (?, ?, ?)'
  ),
  updateDescriptor: db.prepare('UPDATE users SET descriptor = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  findByName: db.prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE'),
  allUsers: db.prepare(
    'SELECT id, name, descriptor, created_at FROM users ORDER BY name COLLATE NOCASE'
  ),

  insertAttendance: db.prepare(
    'INSERT INTO attendance (user_id, date, time, status) VALUES (?, ?, ?, ?)'
  ),
  findForUserOnDate: db.prepare(
    'SELECT id, time, status FROM attendance WHERE user_id = ? AND date = ?'
  ),
  forDate: db.prepare(`
    SELECT a.id, a.user_id, u.name, a.date, a.time, a.status
    FROM attendance a
    JOIN users u ON u.id = a.user_id
    WHERE a.date = ?
    ORDER BY a.time DESC
  `),
  history: db.prepare(`
    SELECT a.id, a.user_id, u.name, a.date, a.time, a.status
    FROM attendance a
    JOIN users u ON u.id = a.user_id
    ORDER BY a.date DESC, a.time DESC
    LIMIT ?
  `),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countForDate: db.prepare(
    "SELECT COUNT(*) AS present, SUM(status = 'Late') AS late FROM attendance WHERE date = ?"
  ),
};

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

/** Full rows with descriptors parsed back into number arrays — used by matching. */
function getUsersWithDescriptors() {
  return stmt.allUsers.all().map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    descriptor: JSON.parse(row.descriptor),
  }));
}

/** Lightweight list for the UI — no 2 KB descriptor blobs going over the wire. */
function getUsers() {
  return stmt.allUsers.all().map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }));
}

function findUserByName(name) {
  return stmt.findByName.get(name) || null;
}

function createUser(name, descriptor) {
  const info = stmt.insertUser.run(
    name,
    JSON.stringify(descriptor),
    new Date().toISOString()
  );
  return { id: Number(info.lastInsertRowid), name };
}

function replaceDescriptor(userId, descriptor) {
  stmt.updateDescriptor.run(JSON.stringify(descriptor), userId);
}

function deleteUser(id) {
  return stmt.deleteUser.run(id).changes > 0;
}

/* -------------------------------------------------------------------------- */
/* Attendance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Records a check-in for today, once.
 *
 * Returns { alreadyMarked, date, time, status }. When the person has already
 * been seen today we return their *original* time rather than erroring — the
 * kiosk wants to greet them, not scold them.
 */
function markAttendance(userId) {
  const date = todayDate();
  const existing = stmt.findForUserOnDate.get(userId, date);

  if (existing) {
    return {
      alreadyMarked: true,
      date,
      time: existing.time,
      status: existing.status,
    };
  }

  const time = nowTime();
  const status = statusFor(time);

  try {
    stmt.insertAttendance.run(userId, date, time, status);
  } catch (err) {
    // Two scans landed in the same millisecond and the UNIQUE constraint caught
    // the second one. Treat it as the already-marked case rather than a 500.
    if (String(err.message).includes('UNIQUE')) {
      const row = stmt.findForUserOnDate.get(userId, date);
      return { alreadyMarked: true, date, time: row.time, status: row.status };
    }
    throw err;
  }

  return { alreadyMarked: false, date, time, status };
}

function getAttendanceForDate(date = todayDate()) {
  return stmt.forDate.all(date).map(shapeRow);
}

function getAttendanceHistory(limit = 1000) {
  return stmt.history.all(limit).map(shapeRow);
}

function shapeRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    date: row.date,
    time: row.time,
    status: row.status,
  };
}

/** Headline numbers for the dashboard cards. */
function getStats(date = todayDate()) {
  const { n: totalUsers } = stmt.countUsers.get();
  const { present, late } = stmt.countForDate.get(date);
  return {
    totalUsers,
    presentToday: present || 0,
    lateToday: late || 0,
    absentToday: Math.max(totalUsers - (present || 0), 0),
  };
}

module.exports = {
  db,
  LATE_AFTER,
  todayDate,
  nowTime,
  statusFor,
  getUsers,
  getUsersWithDescriptors,
  findUserByName,
  createUser,
  replaceDescriptor,
  deleteUser,
  markAttendance,
  getAttendanceForDate,
  getAttendanceHistory,
  getStats,
};
