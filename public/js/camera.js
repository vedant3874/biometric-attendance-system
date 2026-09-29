/**
 * camera.js
 * -----------------------------------------------------------------------------
 * A small webcam controller shared by the kiosk and the enrollment form.
 *
 * Responsibilities: ask for the camera, stream it into a <video>, grab a JPEG
 * frame on demand, and translate the browser's rather unhelpful getUserMedia
 * error names into something a person at a kiosk can act on.
 *
 * Exposed as window.Camera — no bundler, no modules, so both pages can use it
 * with a plain <script> tag.
 */

(function () {
  'use strict';

  // 640x480 is plenty for a 150x150 face crop and keeps the base64 payload
  // around 60 KB instead of 400 KB at 720p. The round trip is noticeably
  // faster and recognition accuracy is unchanged.
  const CONSTRAINTS = {
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      facingMode: 'user',
    },
    audio: false,
  };

  const FRIENDLY_ERRORS = {
    NotAllowedError:
      'Camera access was blocked. Allow it in your browser’s address bar, then reload.',
    PermissionDeniedError:
      'Camera access was blocked. Allow it in your browser’s address bar, then reload.',
    NotFoundError: 'No camera found. Connect one and reload the page.',
    DevicesNotFoundError: 'No camera found. Connect one and reload the page.',
    NotReadableError:
      'The camera is already in use by another app. Close it and reload.',
    TrackStartError:
      'The camera is already in use by another app. Close it and reload.',
    OverconstrainedError: 'This camera does not support the requested resolution.',
    SecurityError:
      'Browsers only allow the camera on localhost or HTTPS. Open the site over one of those.',
  };

  function Camera(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.canvas = document.createElement('canvas');
  }

  /**
   * Requests the camera and begins playback.
   * @returns {Promise<void>} rejects with a human-readable Error
   */
  Camera.prototype.start = async function start() {
    if (this.stream) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        'This browser cannot access the camera. Try Chrome, Edge or Firefox.'
      );
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    } catch (err) {
      throw new Error(
        FRIENDLY_ERRORS[err.name] || `The camera could not start (${err.name}).`
      );
    }

    this.stream = stream;
    this.video.srcObject = stream;

    // Wait for real dimensions — capturing before this gives a 0x0 canvas.
    await new Promise((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.onloadedmetadata = () => resolve();
    });

    await this.video.play();
  };

  /** Releases the camera so the indicator light goes off. */
  Camera.prototype.stop = function stop() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  };

  Camera.prototype.isRunning = function isRunning() {
    return Boolean(this.stream);
  };

  /**
   * Grabs the current frame as a JPEG data URL.
   *
   * The preview is mirrored in CSS so it behaves like a mirror, but we capture
   * the *unmirrored* frame. Face descriptors are not mirror-invariant, so
   * flipping the pixels we send would put every scan slightly further from its
   * enrolled descriptor.
   *
   * @param {number} quality 0..1 JPEG quality
   * @returns {string} data:image/jpeg;base64,...
   */
  Camera.prototype.capture = function capture(quality) {
    if (!this.stream) {
      throw new Error('The camera is not running.');
    }

    const w = this.video.videoWidth;
    const h = this.video.videoHeight;

    if (!w || !h) {
      throw new Error('The camera is still warming up. Try again in a second.');
    }

    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').drawImage(this.video, 0, 0, w, h);

    return this.canvas.toDataURL('image/jpeg', quality || 0.85);
  };

  window.Camera = Camera;
})();
