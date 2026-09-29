/**
 * scripts/download-models.js
 * -----------------------------------------------------------------------------
 * Downloads the three pretrained networks into ./models.
 *
 *   npm run models
 *
 * Each network is a small JSON manifest plus one or two binary weight shards.
 * Total download is about 12 MB. Node 18+ is required (uses global fetch).
 *
 * If your network blocks GitHub, see the manual instructions in README.md —
 * dropping the files into ./models by hand works exactly the same.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', 'models');

// Mirrors are tried in order for each file. The weights are byte-identical.
const MIRRORS = [
  'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/',
  'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/',
  'https://raw.githubusercontent.com/vladmandic/face-api/master/model/',
];

const FILES = [
  // tinyFaceDetector — finds faces in the frame. The default detector: much
  // smaller and faster than ssdMobilenetv1 below, at a small cost in
  // precision — the right tradeoff for a live webcam kiosk. See DETECTOR in
  // the README if you want to switch to ssdMobilenetv1 instead.
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',

  // ssdMobilenetv1 — the slower, more precise alternative detector. Always
  // downloaded too (it's small) so switching via the DETECTOR env var never
  // requires re-running this script.
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',

  // faceLandmark68Net — 68 landmarks, used to align the crop
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',

  // faceRecognitionNet — produces the 128-point descriptor
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
];

function human(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

async function downloadOne(file) {
  const target = path.join(MODELS_DIR, file);

  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log(`  skip  ${file} (already present)`);
    return true;
  }

  for (const base of MIRRORS) {
    try {
      const res = await fetch(base + file);
      if (!res.ok) continue;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) continue;

      fs.writeFileSync(target, buffer);
      console.log(`  ok    ${file} (${human(buffer.length)})`);
      return true;
    } catch {
      // Try the next mirror.
    }
  }

  console.error(`  FAIL  ${file} — no mirror responded`);
  return false;
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('This script needs Node 18 or newer (global fetch). Check: node -v');
    process.exit(1);
  }

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  console.log(`Downloading models into ${MODELS_DIR}\n`);

  const results = [];
  for (const file of FILES) {
    results.push(await downloadOne(file));
  }

  const failed = results.filter((ok) => !ok).length;

  if (failed > 0) {
    console.error(
      `\n${failed} file(s) failed. Download them manually from\n` +
        `  https://github.com/justadudewhohacks/face-api.js/tree/master/weights\n` +
        `and place them in ${MODELS_DIR}\n`
    );
    process.exit(1);
  }

  console.log('\nAll models downloaded. Start the server with: npm start\n');
}

main();
