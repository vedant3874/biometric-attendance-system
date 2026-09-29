/**
 * user.js
 * -----------------------------------------------------------------------------
 * Kiosk page logic: run the clock, boot the camera, capture a frame on demand,
 * POST it to /api/attend, and render the outcome.
 *
 * There are exactly four outcomes worth distinguishing to the person standing
 * at the kiosk, and each gets its own colour and copy:
 *   marked          they are checked in for today
 *   already marked  they came back; show their original time
 *   not recognised  the face is not enrolled
 *   unusable frame  no face, or a crowd, in the picture
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    video: $('video'),
    fallback: $('camera-fallback'),
    fallbackText: $('camera-fallback-text'),
    retry: $('retry-camera'),
    sweep: $('sweep'),
    dot: $('cam-dot'),
    camStatus: $('cam-status'),
    scan: $('scan'),
    scanLabel: $('scan-label'),
    scanIcon: $('scan-icon'),
    result: $('result'),
    clock: $('clock'),
    today: $('today'),
    enrolled: $('enrolled-count'),
  };

  const camera = new window.Camera(els.video);
  let busy = false;

  /* ------------------------------------------------------------------------ */
  /* Clock                                                                    */
  /* ------------------------------------------------------------------------ */

  function tick() {
    const now = new Date();
    els.clock.textContent = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    els.today.textContent = now.toLocaleDateString([], {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  tick();
  setInterval(tick, 1000);

  /* ------------------------------------------------------------------------ */
  /* Camera                                                                   */
  /* ------------------------------------------------------------------------ */

  function setCameraState(state, message) {
    const map = {
      connecting: ['bg-slate-400', 'Connecting'],
      live: ['bg-emerald-400', 'Camera live'],
      scanning: ['bg-brand-400', 'Reading face'],
      error: ['bg-rose-400', 'Camera off'],
    };
    const [dotClass, label] = map[state] || map.connecting;

    els.dot.className = 'h-1.5 w-1.5 rounded-full ' + dotClass;
    els.camStatus.textContent = message || label;
  }

  async function startCamera() {
    setCameraState('connecting');
    els.fallback.classList.remove('hidden');
    els.fallbackText.textContent = 'Starting the camera…';
    els.retry.classList.add('hidden');

    try {
      await camera.start();
      els.fallback.classList.add('hidden');
      els.scan.disabled = false;
      setCameraState('live');
    } catch (err) {
      els.fallbackText.textContent = err.message;
      els.retry.classList.remove('hidden');
      els.scan.disabled = true;
      setCameraState('error');
    }
  }

  els.retry.addEventListener('click', startCamera);

  /* ------------------------------------------------------------------------ */
  /* Scanning                                                                 */
  /* ------------------------------------------------------------------------ */

  function setBusy(isBusy) {
    busy = isBusy;
    els.scan.disabled = isBusy || !camera.isRunning();
    els.scanLabel.textContent = isBusy
      ? 'Checking…'
      : 'Scan face & mark attendance';
    els.scanIcon.classList.toggle('spin', isBusy);
    els.sweep.classList.toggle('hidden', !isBusy);
    els.sweep.classList.toggle('scan-sweep', isBusy);
    setCameraState(isBusy ? 'scanning' : 'live');
  }

  async function scan() {
    if (busy || !camera.isRunning()) return;

    setBusy(true);
    els.result.innerHTML = '';

    try {
      const image = camera.capture(0.85);

      const res = await fetch('/api/attend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      });

      const data = await res.json();
      render(data);
    } catch (err) {
      render({
        ok: false,
        code: 'NETWORK',
        message:
          'Could not reach the server. Check that it is still running, then scan again.',
      });
    } finally {
      setBusy(false);
    }
  }

  els.scan.addEventListener('click', scan);

  // Space or Enter anywhere fires a scan — kiosks often have a footswitch or a
  // wireless presenter clicker mapped to one of those keys.
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, button, a')) return;
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      scan();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Result rendering                                                         */
  /* ------------------------------------------------------------------------ */

  const ICONS = {
    check:
      '<path d="m5 13 4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />',
    clock:
      '<circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" stroke-linecap="round" stroke-linejoin="round" />',
    cross:
      '<path d="M15.5 8.5 8.5 15.5M8.5 8.5l7 7" stroke-linecap="round" /><circle cx="12" cy="12" r="9" />',
    warn: '<path d="M12 8.5v4.2M12 16.2v.2" stroke-linecap="round" /><path d="M10.3 4.3 2.7 17.5A2 2 0 0 0 4.4 20.5h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" stroke-linejoin="round" />',
  };

  const TONES = {
    success: {
      card: 'border-emerald-200 bg-emerald-50',
      badge: 'bg-emerald-600',
      title: 'text-emerald-900',
      body: 'text-emerald-800/80',
    },
    info: {
      card: 'border-amber-200 bg-amber-50',
      badge: 'bg-amber-600',
      title: 'text-amber-900',
      body: 'text-amber-800/80',
    },
    error: {
      card: 'border-rose-200 bg-rose-50',
      badge: 'bg-rose-600',
      title: 'text-rose-900',
      body: 'text-rose-800/80',
    },
    neutral: {
      card: 'border-slate-200 bg-white',
      badge: 'bg-slate-600',
      title: 'text-slate-900',
      body: 'text-slate-600',
    },
  };

  /** 'HH:MM:SS' -> 'HH:MM', which is all anyone reads off a check-in screen. */
  function shortTime(t) {
    return typeof t === 'string' ? t.slice(0, 5) : '';
  }

  function banner({ tone, icon, title, body, meta }) {
    const t = TONES[tone] || TONES.neutral;

    return `
      <div class="result-in flex gap-4 rounded-2xl border ${t.card} p-5 shadow-lift">
        <span class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${t.badge}">
          <svg class="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" aria-hidden="true">${ICONS[icon]}</svg>
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[17px] font-bold leading-snug ${t.title}">${title}</p>
          <p class="mt-1 text-sm leading-relaxed ${t.body}">${body}</p>
          ${meta ? `<p class="tnum mt-2.5 text-[11px] font-medium ${t.body}">${meta}</p>` : ''}
        </div>
      </div>`;
  }

  function render(data) {
    // Recognised and checked in — the happy path.
    if (data.ok && !data.alreadyMarked) {
      const late = data.status === 'Late';
      els.result.innerHTML = banner({
        tone: 'success',
        icon: 'check',
        title: `Welcome, ${escapeHtml(data.user.name)}!`,
        body: `Attendance marked for today at ${shortTime(data.time)}.${
          late ? ' You are recorded as late.' : ''
        }`,
        meta: `${data.date} · ${data.status} · match ${data.distance}`,
      });
      return;
    }

    // Recognised, but they already checked in earlier today.
    if (data.ok && data.alreadyMarked) {
      els.result.innerHTML = banner({
        tone: 'info',
        icon: 'clock',
        title: 'Attendance already marked for today',
        body: `${escapeHtml(data.user.name)}, you checked in at ${shortTime(
          data.time
        )}. Nothing further to do.`,
        meta: `${data.date} · ${data.status}`,
      });
      return;
    }

    // Everything else is a failure of some kind. The server already wrote copy
    // that says what to do about it, so pass it through rather than replacing
    // it with something vaguer.
    const tone = data.code === 'NO_MATCH' ? 'error' : 'neutral';
    const icon = data.code === 'NO_MATCH' ? 'cross' : 'warn';

    const titles = {
      NO_MATCH: 'Face not recognised',
      NO_FACE: 'No face in frame',
      MULTIPLE_FACES: 'More than one person in frame',
      NO_USERS: 'Nobody is enrolled yet',
      MODELS_NOT_LOADED: 'Recognition is still starting up',
      NETWORK: 'Cannot reach the server',
    };

    els.result.innerHTML = banner({
      tone,
      icon,
      title: titles[data.code] || 'Scan failed',
      body: escapeHtml(data.message || 'Try scanning again.'),
      meta:
        data.distance != null
          ? `closest match ${data.distance} · needs to be under ${data.threshold}`
          : '',
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------------------ */
  /* Boot                                                                     */
  /* ------------------------------------------------------------------------ */

  async function loadFooter() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      els.enrolled.textContent =
        data.enrolled === 0
          ? 'No one is enrolled yet'
          : `${data.enrolled} ${data.enrolled === 1 ? 'person' : 'people'} enrolled`;
    } catch {
      els.enrolled.textContent = 'Server unreachable';
    }
  }

  startCamera();
  loadFooter();

  // Free the camera when the tab is hidden, and pick it back up on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      camera.stop();
      els.scan.disabled = true;
      setCameraState('error', 'Paused');
    } else if (!camera.isRunning()) {
      startCamera();
    }
  });
})();
