/**
 * faceEngine.js
 * -----------------------------------------------------------------------------
 * Everything face-api related lives here:
 *   - monkey-patching face-api so it can run in Node (it expects a browser DOM)
 *   - loading the three networks into memory once, at server startup
 *   - turning a base64 image into a 128-float face descriptor
 *   - matching a descriptor against everyone already enrolled
 */

'use strict';

const path = require('path');
const fs = require('fs');
const canvasBackend = require('./canvasAdapter');

// @vladmandic/face-api's Node build has a hardcoded require('@tensorflow/tfjs-node')
// baked into its bundle. The native tfjs-node addon's prebuilt binaries are
// frequently unavailable (especially on Windows), and building from source needs
// a full C++ toolchain.
//
// The fix lives in package.json, not here: it aliases the name
// "@tensorflow/tfjs-node" to the contents of the pure-JavaScript
// "@tensorflow/tfjs" package. So the require() below still asks for tfjs-node by
// name — satisfying face-api — but receives the plain-JS build, which has no
// native addon to compile. Inference is slower; see the README if that matters.
require('@tensorflow/tfjs-node');
const faceapi = require('@vladmandic/face-api');

const { Canvas, Image, ImageData, loadImage } = canvasBackend;

// The patch. Must happen before any model loads or any image is processed.
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

console.log(`Canvas backend: ${canvasBackend.backend}`);

const MODELS_DIR = path.join(__dirname, '..', 'models');

// tinyFaceDetector is the default: a much smaller, much faster network than
// ssdMobilenetv1, at a small cost in precision. face-api.js's own guidance is
// exactly this tradeoff — ssdMobilenetv1 for precision on static photos,
// tinyFaceDetector for real-time/webcam use — and a live kiosk is squarely
// the second case. Set DETECTOR=ssd to go back to the slower, more precise
// detector if you find tiny missing faces at odd angles or in poor light.
const DETECTOR = (process.env.DETECTOR || 'tiny').toLowerCase() === 'ssd' ? 'ssd' : 'tiny';

// TinyFaceDetector resizes the input to a square of this size before running
// the net — it's the main speed/accuracy knob. face-api.js's valid sizes are
// 128, 160, 224, 320, 416, 512, 608. Smaller is faster; 320 is a solid default
// for a face that fills a reasonable portion of a 640x480 kiosk frame. Drop to
// 224 or even 160 for more speed if the camera is always close-up.
const VALID_TINY_SIZES = [128, 160, 224, 320, 416, 512, 608];
const TINY_INPUT_SIZE = VALID_TINY_SIZES.includes(Number(process.env.TINY_INPUT_SIZE))
  ? Number(process.env.TINY_INPUT_SIZE)
  : 320;

// Logs one line per scan with a timing breakdown, so a slow scan is
// diagnosable instead of just "it feels slow". On by default; set
// PERF_LOG=false to quiet it once you've confirmed things are fast enough.
const PERF_LOG = process.env.PERF_LOG !== 'false';

// Two faces are the same person when the Euclidean distance between their
// descriptors is below this. 0.6 is the face-api authors' recommendation.
// Lower = stricter (more "not recognised"), higher = more false positives.
// Do not go above ~0.65 for attendance, where a false positive means one person
// clocking in as another.
const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD) || 0.6;

// Minimum confidence for something to count as a face at all. Same meaning
// for both detectors; face-api just names the option differently on each
// (see getDetectorOptions below).
const MIN_DETECTION_CONFIDENCE = 0.5;

// Reject anything bigger than this before decoding (~8 MB of base64).
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let modelsLoaded = false;

/** Lets routes map failure reasons to HTTP codes and friendly copy. */
class FaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FaceError';
    this.code = code; // NO_FACE | MULTIPLE_FACES | BAD_IMAGE | MODELS_NOT_LOADED
  }
}

/**
 * Loads the detector (tinyFaceDetector or ssdMobilenetv1, per DETECTOR),
 * faceLandmark68Net and faceRecognitionNet from disk, then runs one dummy
 * detection to warm up the backend's lazily-compiled kernels.
 *
 * Called once from server.js before the HTTP listener starts, so the first
 * request never pays the load cost — and now never pays the warmup cost
 * either, since that dummy detection absorbs it here instead of during
 * someone's first real scan.
 */
async function loadModels() {
  if (modelsLoaded) return;

  if (!fs.existsSync(MODELS_DIR)) {
    throw new Error(
      `Models folder not found at ${MODELS_DIR}. Run "npm run models" first.`
    );
  }

  if (DETECTOR === 'tiny') {
    await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR); // finds faces — fast
  } else {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR); // finds faces — precise, slower
  }
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR); // aligns them
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR); // 128-d vector

  modelsLoaded = true;

  const warmupStart = Date.now();
  try {
    const blank = new Canvas(TINY_INPUT_SIZE, TINY_INPUT_SIZE);
    await faceapi.detectAllFaces(blank, getDetectorOptions());
  } catch {
    // A blank canvas finding no face is fine and expected — the point was
    // only to force the net's kernels to compile once, now, rather than on
    // whoever scans first.
  }
  console.log(`Warmup pass: ${Date.now() - warmupStart} ms`);
}

function assertModelsLoaded() {
  if (!modelsLoaded) {
    throw new FaceError(
      'MODELS_NOT_LOADED',
      'Face recognition models are not loaded yet. Restart the server.'
    );
  }
}

/** The active detector's options object — the two detectors name their confidence option differently. */
function getDetectorOptions() {
  return DETECTOR === 'tiny'
    ? new faceapi.TinyFaceDetectorOptions({
        inputSize: TINY_INPUT_SIZE,
        scoreThreshold: MIN_DETECTION_CONFIDENCE,
      })
    : new faceapi.SsdMobilenetv1Options({ minConfidence: MIN_DETECTION_CONFIDENCE });
}

/** Decodes `data:image/jpeg;base64,...` (or a bare base64 string) into an Image. */
async function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length < 100) {
    throw new FaceError('BAD_IMAGE', 'No image data was received.');
  }

  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  const base64 = match ? match[2] : dataUrl;

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new FaceError('BAD_IMAGE', 'The image data could not be decoded.');
  }

  if (buffer.length === 0) {
    throw new FaceError('BAD_IMAGE', 'The image data was empty.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new FaceError('BAD_IMAGE', 'That image is too large. Use a smaller snapshot.');
  }

  try {
    return await loadImage(buffer);
  } catch {
    throw new FaceError('BAD_IMAGE', 'That file is not a readable image.');
  }
}

/**
 * The core operation: image in, 128-float descriptor out.
 *
 * Uses detectAllFaces rather than detectSingleFace so we can tell "nobody" apart
 * from "a crowd" and say something useful either way. Both enrollment and
 * attendance need exactly one subject — with two people in frame we would be
 * guessing whose face we just saved or matched.
 *
 * @param {string} dataUrl base64 image from the webcam
 * @returns {Promise<{descriptor: number[], confidence: number, box: object}>}
 */
async function getFaceDescriptor(dataUrl) {
  assertModelsLoaded();

  const t0 = Date.now();
  const img = await decodeDataUrl(dataUrl);
  const t1 = Date.now();

  const results = await faceapi
    .detectAllFaces(img, getDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptors();
  const t2 = Date.now();

  if (PERF_LOG) {
    console.log(
      `[face] decode ${t1 - t0}ms · detect+describe ${t2 - t1}ms · total ${t2 - t0}ms ` +
        `(${DETECTOR}${DETECTOR === 'tiny' ? `@${TINY_INPUT_SIZE}` : ''})`
    );
  }

  if (results.length === 0) {
    throw new FaceError(
      'NO_FACE',
      'No face detected. Move closer to the camera and check the lighting.'
    );
  }
  if (results.length > 1) {
    throw new FaceError(
      'MULTIPLE_FACES',
      `${results.length} faces in frame. Only one person should be visible.`
    );
  }

  const { detection, descriptor } = results[0];

  return {
    // Float32Array -> plain array, so it can be JSON-serialised into SQLite.
    descriptor: Array.from(descriptor),
    confidence: Number(detection.score.toFixed(4)),
    box: {
      x: Math.round(detection.box.x),
      y: Math.round(detection.box.y),
      width: Math.round(detection.box.width),
      height: Math.round(detection.box.height),
    },
  };
}

/**
 * Compares one descriptor against every enrolled user.
 *
 * FaceMatcher does the Euclidean distance you would otherwise write by hand:
 *   distance = sqrt( sum( (a[i] - b[i])^2 ) )
 * and labels anything at or above the threshold as 'unknown'. The manual
 * equivalent is one line if you would rather skip the matcher:
 *   const d = faceapi.euclideanDistance(probe, candidate);
 *
 * Labels are user ids, not names, so two people called "Priya" never collide.
 *
 * @param {number[]} probe descriptor from the live frame
 * @param {Array<{id:number,name:string,descriptor:number[]}>} users
 * @returns {{matched: boolean, user: object|null, distance: number|null}}
 */
function findBestMatch(probe, users) {
  if (!users.length) {
    return { matched: false, user: null, distance: null };
  }

  const labelled = users.map(
    (u) =>
      new faceapi.LabeledFaceDescriptors(String(u.id), [
        new Float32Array(u.descriptor),
      ])
  );

  const matcher = new faceapi.FaceMatcher(labelled, MATCH_THRESHOLD);
  const best = matcher.findBestMatch(new Float32Array(probe));
  const distance = Number(best.distance.toFixed(4));

  if (best.label === 'unknown') {
    return { matched: false, user: null, distance };
  }

  const user = users.find((u) => String(u.id) === best.label) || null;
  return { matched: Boolean(user), user, distance };
}

module.exports = {
  loadModels,
  getFaceDescriptor,
  findBestMatch,
  FaceError,
  MATCH_THRESHOLD,
  MODELS_DIR,
  DETECTOR,
  TINY_INPUT_SIZE,
};
