/**
 * routes/kiosk.js
 * -----------------------------------------------------------------------------
 * The two endpoints that actually look at a face.
 *
 *   POST /api/enroll  { name, image, overwrite? }  -> save a person's descriptor
 *   POST /api/attend  { image }                    -> identify and mark them in
 *
 * Both follow the same shape: validate input -> run the face pipeline ->
 * touch the database -> respond.
 */

'use strict';

const express = require('express');
const db = require('../db');
const {
  getFaceDescriptor,
  findBestMatch,
  MATCH_THRESHOLD,
} = require('../faceEngine');
const { sendFailure } = require('./respond');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* POST /api/enroll                                                           */
/* -------------------------------------------------------------------------- */
router.post('/enroll', async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const { image, overwrite } = req.body;

    if (name.length < 2) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_NAME',
        message: 'Enter a name of at least two characters.',
      });
    }
    if (name.length > 80) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_NAME',
        message: 'That name is too long. Keep it under 80 characters.',
      });
    }

    const existing = db.findUserByName(name);
    if (existing && !overwrite) {
      return res.status(409).json({
        ok: false,
        code: 'DUPLICATE_NAME',
        message: `${existing.name} is already enrolled. Re-enroll to replace their stored face.`,
      });
    }

    // 1. Face -> 128-point descriptor. Throws if zero or 2+ faces are in frame.
    const { descriptor, confidence } = await getFaceDescriptor(image);

    // 2. Guard against the same person being enrolled twice under two names.
    //    Without this, "Priya" and "Priya S" both match every scan and whichever
    //    is marginally closer wins at random.
    const others = db
      .getUsersWithDescriptors()
      .filter((u) => !existing || u.id !== existing.id);

    const clash = findBestMatch(descriptor, others);
    if (clash.matched) {
      return res.status(409).json({
        ok: false,
        code: 'FACE_ALREADY_ENROLLED',
        message: `This face is already enrolled as ${clash.user.name}. Delete that record first if the name is wrong.`,
      });
    }

    // 3. Save.
    if (existing) {
      db.replaceDescriptor(existing.id, descriptor);
      return res.json({
        ok: true,
        replaced: true,
        user: { id: existing.id, name: existing.name },
        confidence,
        message: `Updated the stored face for ${existing.name}.`,
      });
    }

    const user = db.createUser(name, descriptor);
    return res.status(201).json({
      ok: true,
      replaced: false,
      user,
      confidence,
      message: `${user.name} is enrolled and can now mark attendance.`,
    });
  } catch (err) {
    return sendFailure(res, err);
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/attend                                                           */
/* -------------------------------------------------------------------------- */
router.post('/attend', async (req, res) => {
  try {
    const users = db.getUsersWithDescriptors();

    if (users.length === 0) {
      return res.status(409).json({
        ok: false,
        code: 'NO_USERS',
        message: 'Nobody is enrolled yet. Add the first person from the admin dashboard.',
      });
    }

    // 1. Live frame -> descriptor.
    const { descriptor, confidence } = await getFaceDescriptor(req.body.image);

    // 2. Nearest enrolled descriptor, if any is within the threshold.
    const { matched, user, distance } = findBestMatch(descriptor, users);

    if (!matched) {
      return res.status(404).json({
        ok: false,
        code: 'NO_MATCH',
        message: 'Face not recognised. Ask an administrator to enroll you.',
        distance,
        threshold: MATCH_THRESHOLD,
      });
    }

    // 3. Mark, once per calendar day. markAttendance returns the original time
    //    if they have already been seen — this is the idempotency guarantee.
    const record = db.markAttendance(user.id);

    return res.json({
      ok: true,
      alreadyMarked: record.alreadyMarked,
      user: { id: user.id, name: user.name },
      date: record.date,
      time: record.time,
      status: record.status,
      confidence,
      distance,
    });
  } catch (err) {
    return sendFailure(res, err);
  }
});

module.exports = router;
