/**
 * routes/respond.js
 * -----------------------------------------------------------------------------
 * One place that turns a thrown error into a JSON response, so every route
 * handler can just `catch (err) { sendFailure(res, err); }`.
 *
 * Every response in this app — success or failure — carries an `ok` boolean,
 * which means the frontend has exactly one branch to write.
 */

'use strict';

const { FaceError } = require('../faceEngine');

// 422 = "I understood the request, but the image itself is unusable".
const STATUS_BY_CODE = {
  NO_FACE: 422,
  MULTIPLE_FACES: 422,
  BAD_IMAGE: 400,
  MODELS_NOT_LOADED: 503,
};

function sendFailure(res, err) {
  if (err instanceof FaceError) {
    return res
      .status(STATUS_BY_CODE[err.code] || 400)
      .json({ ok: false, code: err.code, message: err.message });
  }

  console.error('[api] unexpected error:', err);
  return res.status(500).json({
    ok: false,
    code: 'SERVER_ERROR',
    message: 'Something went wrong on the server. Check the terminal for details.',
  });
}

module.exports = { sendFailure };
