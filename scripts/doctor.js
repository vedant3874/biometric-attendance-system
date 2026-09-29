/**
 * scripts/doctor.js
 * -----------------------------------------------------------------------------
 * Preflight check. Run `npm run doctor` when something will not start.
 *
 * The point of this script is that `node server.js` reports only the FIRST
 * missing piece, as an opaque MODULE_NOT_FOUND stack trace. This checks
 * everything and tells you what to do about each failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let problems = 0;

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, fix) => {
  problems++;
  console.log(`  FAIL  ${m}`);
  if (fix) console.log(`        -> ${fix}`);
};

console.log('\nEnvironment\n');

// --- Node version --------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) {
  ok(`Node ${process.version}`);
  if (major >= 24) {
    console.log(
      '        note: Node 24+ is very new. If native modules misbehave,\n' +
        '        Node 22 LTS is the best-tested version for this stack.'
    );
  }
} else {
  bad(`Node ${process.version} is too old`, 'Install Node 18 or newer (22 LTS recommended).');
}

console.log('\nDependencies\n');

// --- Plain requires ------------------------------------------------------
const required = [
  ['express', 'npm install'],
  ['express-session', 'npm install'],
  ['bcryptjs', 'npm install'],
  ['dotenv', 'npm install'],
  ['better-sqlite3', 'npm install'],
  ['@vladmandic/face-api', 'npm install'],
  ['@tensorflow/tfjs-node', 'npm install  (this name is aliased to @tensorflow/tfjs)'],
];

required.forEach(([name, fix]) => {
  try {
    require.resolve(name);
    ok(name);
  } catch {
    bad(`${name} is not installed`, fix);
  }
});

// --- Canvas backend ------------------------------------------------------
// Either package satisfies face-api. Only having neither is fatal.
let canvasBackend = null;

try {
  require('canvas');
  canvasBackend = 'canvas';
} catch {
  try {
    require('@napi-rs/canvas');
    canvasBackend = '@napi-rs/canvas';
  } catch {
    /* handled below */
  }
}

if (canvasBackend === 'canvas') {
  ok('canvas (node-canvas) — the reference backend');
} else if (canvasBackend === '@napi-rs/canvas') {
  ok('@napi-rs/canvas — fallback backend, no compilation needed');
  console.log('        node-canvas is absent or failed to build. That is fine.');
} else {
  bad(
    'no canvas backend — face-api cannot decode images without one',
    'npm install @napi-rs/canvas'
  );
}

// --- Model weights -------------------------------------------------------
console.log('\nModel weights\n');

const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
];

const missing = MODEL_FILES.filter((f) => {
  const p = path.join(ROOT, 'models', f);
  return !fs.existsSync(p) || fs.statSync(p).size === 0;
});

if (missing.length === 0) {
  ok(`all ${MODEL_FILES.length} weight files present`);
} else {
  bad(`${missing.length} of ${MODEL_FILES.length} weight files missing`, 'npm run models');
  missing.forEach((f) => console.log(`        missing: ${f}`));
}

// --- Performance -----------------------------------------------------------
console.log('\nPerformance\n');

const detector = (process.env.DETECTOR || 'tiny').toLowerCase() === 'ssd' ? 'ssd' : 'tiny';
console.log(`  info  Detector: ${detector}${detector === 'tiny' ? ` (input size ${process.env.TINY_INPUT_SIZE || 320})` : ''}`);
if (detector === 'ssd') {
  console.log('        ssdMobilenetv1 is precise but slow. Unset DETECTOR (or set DETECTOR=tiny) for faster scans.');
} else {
  console.log('        tinyFaceDetector is the fast default. Set DETECTOR=ssd only if scans are missing real faces.');
}

// --- Admin login -----------------------------------------------------------
console.log('\nAdmin login\n');

['admin.html', 'login.html'].forEach((f) => {
  const p = path.join(ROOT, 'views', f);
  if (fs.existsSync(p)) {
    ok(`views/${f}`);
  } else {
    bad(`views/${f} is missing`, 'Re-extract the project — this file should ship with it.');
  }
});

if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  ok('ADMIN_USERNAME and ADMIN_PASSWORD are set');
} else {
  console.log('  note  Using the default login (admin / password123).');
  console.log('        Set ADMIN_USERNAME and ADMIN_PASSWORD before anyone else can reach this machine.');
}

// --- Database ------------------------------------------------------------
console.log('\nDatabase\n');

const dbPath = path.join(ROOT, 'data', 'attendance.db');
if (fs.existsSync(dbPath)) {
  ok(`data/attendance.db exists (${(fs.statSync(dbPath).size / 1024).toFixed(0)} KB)`);
} else {
  ok('no database yet — it is created automatically on first start');
}

// --- Verdict -------------------------------------------------------------
console.log('');
if (problems === 0) {
  console.log('Everything checks out. Run: npm start\n');
} else {
  console.log(`${problems} problem(s) found. Fix the lines marked FAIL above, then re-run: npm run doctor\n`);
  process.exitCode = 1;
}
