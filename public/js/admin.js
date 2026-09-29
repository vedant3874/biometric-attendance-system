/**
 * admin.js
 * -----------------------------------------------------------------------------
 * Dashboard logic. Three sections swapped client-side, each loading its data
 * when it becomes visible rather than all at once on page load.
 *
 *   today    stat cards + a table for one calendar day (defaults to today)
 *   history  every record, filterable, exportable as CSV
 *   enroll   webcam capture + name -> POST /api/enroll, plus the people list
 *
 * The enrollment camera is started only while that section is open, so the
 * webcam light is not on the whole time someone leaves the dashboard up.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------------ */
  /* Small shared helpers                                                     */
  /* ------------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * A session can end between page load and any later request — the 8-hour
   * cookie expires, or someone signs out in another tab. Every admin API call
   * goes through here so that a 401 sends the browser to the login page
   * instead of rendering an "UNAUTHENTICATED" message inside a data table.
   */
  function handleUnauthenticated() {
    window.location.href = '/login';
    // Never resolves — the navigation above is already underway, and nothing
    // downstream should keep running against a page that's about to unload.
    return new Promise(() => {});
  }

  async function getJSON(url) {
    const res = await fetch(url);
    if (res.status === 401) return handleUnauthenticated();
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Request failed.');
    return data;
  }

  /** 'HH:MM:SS' -> 'HH:MM'. Seconds are noise in a table people scan. */
  const shortTime = (t) => (typeof t === 'string' ? t.slice(0, 5) : '');

  /** '2026-09-17' -> 'Thu 17 Sep 2026'. Parsed as local, not UTC. */
  function prettyDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y) return iso;
    return new Date(y, m - 1, d).toLocaleDateString([], {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  function statusPill(status) {
    const tone =
      status === 'Late'
        ? 'bg-amber-50 text-amber-700 ring-amber-600/20'
        : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20';
    return `<span class="inline-flex rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${tone}">${escapeHtml(
      status
    )}</span>`;
  }

  /** Initials avatar. Deterministic colour so the same person looks the same. */
  function avatar(name) {
    const initials = String(name)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();

    const palette = [
      'bg-brand-100 text-brand-700',
      'bg-emerald-100 text-emerald-700',
      'bg-amber-100 text-amber-700',
      'bg-rose-100 text-rose-700',
      'bg-sky-100 text-sky-700',
      'bg-violet-100 text-violet-700',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;

    return `<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold ${
      palette[hash % palette.length]
    }">${escapeHtml(initials)}</span>`;
  }

  /** An empty screen is an invitation to act, so each one says what to do. */
  function emptyState(title, body, actionHtml) {
    return `
      <div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
        <p class="text-sm font-bold text-slate-700">${escapeHtml(title)}</p>
        <p class="max-w-xs text-sm leading-relaxed text-slate-500">${escapeHtml(body)}</p>
        ${actionHtml || ''}
      </div>`;
  }

  function table(headers, rows) {
    return `
      <table class="w-full border-collapse text-left text-sm">
        <thead class="sticky top-0 bg-slate-50/95 backdrop-blur">
          <tr class="border-b border-slate-200">
            ${headers
              .map(
                (h) =>
                  `<th scope="col" class="px-5 py-3 text-xs font-bold text-slate-500">${h}</th>`
              )
              .join('')}
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">${rows.join('')}</tbody>
      </table>`;
  }

  /* ------------------------------------------------------------------------ */
  /* Navigation                                                               */
  /* ------------------------------------------------------------------------ */

  const NAV_ON = 'bg-brand-600 text-white';
  const NAV_OFF = 'text-slate-400 hover:bg-white/5 hover:text-white';

  const PAGES = {
    today: { title: 'Daily attendance', sub: 'Who has checked in, and when.' },
    history: { title: 'Attendance history', sub: 'Every record, newest first.' },
    enroll: { title: 'Enroll user', sub: 'Register a face so it can be recognised at the kiosk.' },
  };

  let current = 'today';

  function show(section) {
    current = section;

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      const on = btn.dataset.section === section;
      btn.className =
        'nav-btn group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ' +
        (on ? NAV_ON : NAV_OFF);
      btn.setAttribute('aria-current', on ? 'page' : 'false');
    });

    document.querySelectorAll('.section').forEach((el) => {
      el.classList.toggle('hidden', el.id !== `section-${section}`);
    });

    $('page-title').textContent = PAGES[section].title;
    $('page-sub').textContent = PAGES[section].sub;
    $('refresh').classList.toggle('sm:inline-flex', section !== 'enroll');
    $('refresh').classList.toggle('hidden', section === 'enroll');

    closeDrawer();

    // The camera only runs while the enroll section is actually on screen.
    if (section === 'enroll') {
      loadUsers();
    } else {
      stopEnrollCamera();
    }

    if (section === 'today') loadToday();
    if (section === 'history') loadHistory();

    if (location.hash.slice(1) !== section) location.hash = section;
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => show(btn.dataset.section));
  });

  $('refresh').addEventListener('click', async () => {
    const icon = $('refresh-icon');
    icon.classList.add('spin');
    if (current === 'today') await loadToday();
    if (current === 'history') await loadHistory();
    icon.classList.remove('spin');
  });

  /* Mobile drawer ---------------------------------------------------------- */

  function openDrawer() {
    $('sidebar').classList.remove('-translate-x-full');
    $('scrim').classList.remove('hidden');
  }
  function closeDrawer() {
    $('sidebar').classList.add('-translate-x-full');
    $('scrim').classList.add('hidden');
  }

  $('menu').addEventListener('click', openDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  /* ------------------------------------------------------------------------ */
  /* Section 1 — Daily attendance                                             */
  /* ------------------------------------------------------------------------ */

  function statCard({ label, value, hint, tone }) {
    const tones = {
      brand: 'text-brand-600',
      emerald: 'text-emerald-600',
      amber: 'text-amber-600',
      slate: 'text-slate-500',
    };
    return `
      <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-lift">
        <p class="text-xs font-bold text-slate-500">${escapeHtml(label)}</p>
        <p class="tnum mt-2 text-3xl font-extrabold leading-none ${tones[tone] || tones.slate}">${value}</p>
        <p class="mt-2 text-xs text-slate-400">${escapeHtml(hint)}</p>
      </div>`;
  }

  async function loadToday() {
    const date = $('date-picker').value || undefined;
    const holder = $('today-table');
    holder.innerHTML = skeleton(4);

    try {
      const data = await getJSON(
        '/api/admin/today' + (date ? `?date=${encodeURIComponent(date)}` : '')
      );

      if (!$('date-picker').value) $('date-picker').value = data.date;

      $('page-sub').textContent = `${prettyDate(data.date)} · late after ${data.lateAfter}`;

      $('stats').innerHTML = [
        statCard({
          label: 'Checked in',
          value: data.stats.presentToday,
          hint: 'people scanned on this day',
          tone: 'brand',
        }),
        statCard({
          label: 'On time',
          value: data.stats.presentToday - data.stats.lateToday,
          hint: `arrived before ${data.lateAfter}`,
          tone: 'emerald',
        }),
        statCard({
          label: 'Late',
          value: data.stats.lateToday,
          hint: `arrived after ${data.lateAfter}`,
          tone: 'amber',
        }),
        statCard({
          label: 'Not seen',
          value: data.stats.absentToday,
          hint: `of ${data.stats.totalUsers} enrolled`,
          tone: 'slate',
        }),
      ].join('');

      if (!data.records.length) {
        holder.innerHTML = emptyState(
          'No check-ins on this day',
          'Records appear here as soon as someone scans at the kiosk.',
          '<a href="/" class="mt-3 rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-700">Open the kiosk</a>'
        );
        return;
      }

      const rows = data.records.map(
        (r) => `
        <tr class="transition hover:bg-slate-50">
          <td class="px-5 py-3.5">
            <div class="flex items-center gap-3">
              ${avatar(r.name)}
              <span class="font-semibold">${escapeHtml(r.name)}</span>
            </div>
          </td>
          <td class="tnum px-5 py-3.5 font-medium text-slate-600">${shortTime(r.time)}</td>
          <td class="px-5 py-3.5">${statusPill(r.status)}</td>
          <td class="tnum px-5 py-3.5 text-slate-400">#${r.id}</td>
        </tr>`
      );

      holder.innerHTML = table(['Name', 'Time in', 'Status', 'Record'], rows);
    } catch (err) {
      holder.innerHTML = emptyState('Could not load this day', err.message);
    }
  }

  $('date-picker').addEventListener('change', loadToday);

  /* ------------------------------------------------------------------------ */
  /* Section 2 — History                                                      */
  /* ------------------------------------------------------------------------ */

  let historyRows = [];

  async function loadHistory() {
    const holder = $('history-table');
    holder.innerHTML = skeleton(6);

    try {
      const data = await getJSON('/api/admin/history');
      historyRows = data.records;
      renderHistory();
    } catch (err) {
      holder.innerHTML = emptyState('Could not load history', err.message);
    }
  }

  function renderHistory() {
    const holder = $('history-table');
    const q = $('history-search').value.trim().toLowerCase();

    const rows = q
      ? historyRows.filter(
          (r) => r.name.toLowerCase().includes(q) || r.date.includes(q)
        )
      : historyRows;

    $('page-sub').textContent = `${rows.length} ${
      rows.length === 1 ? 'record' : 'records'
    }${q ? ` matching “${q}”` : ''}`;

    if (!historyRows.length) {
      holder.innerHTML = emptyState(
        'No records yet',
        'Once people start checking in at the kiosk, every scan is logged here.'
      );
      return;
    }

    if (!rows.length) {
      holder.innerHTML = emptyState(
        'Nothing matches that filter',
        'Try part of a name, or a date written as YYYY-MM-DD.'
      );
      return;
    }

    // Group by day so the eye can find a date without reading every row.
    let lastDate = null;
    const html = [];

    rows.forEach((r) => {
      if (r.date !== lastDate) {
        lastDate = r.date;
        html.push(`
          <tr class="bg-slate-50/70">
            <td colspan="4" class="px-5 py-2 text-xs font-bold text-slate-500">
              ${escapeHtml(prettyDate(r.date))}
            </td>
          </tr>`);
      }

      html.push(`
        <tr class="transition hover:bg-slate-50">
          <td class="px-5 py-3.5">
            <div class="flex items-center gap-3">
              ${avatar(r.name)}
              <span class="font-semibold">${escapeHtml(r.name)}</span>
            </div>
          </td>
          <td class="tnum px-5 py-3.5 text-slate-500">${escapeHtml(r.date)}</td>
          <td class="tnum px-5 py-3.5 font-medium text-slate-600">${shortTime(r.time)}</td>
          <td class="px-5 py-3.5">${statusPill(r.status)}</td>
        </tr>`);
    });

    holder.innerHTML = table(['Name', 'Date', 'Time in', 'Status'], html);
  }

  $('history-search').addEventListener('input', renderHistory);

  $('export-csv').addEventListener('click', () => {
    if (!historyRows.length) return;

    const csv = [
      ['id', 'user_id', 'name', 'date', 'time', 'status'],
      ...historyRows.map((r) => [r.id, r.userId, r.name, r.date, r.time, r.status]),
    ]
      // Quote every field and double any embedded quotes — a name containing a
      // comma would otherwise split into two columns.
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  /* ------------------------------------------------------------------------ */
  /* Section 3 — Enroll                                                       */
  /* ------------------------------------------------------------------------ */

  const enrollCam = new window.Camera($('enroll-video'));
  let enrolling = false;

  async function startEnrollCamera() {
    $('enroll-fallback-text').textContent = 'Starting the camera…';
    $('enroll-start').classList.add('hidden');

    try {
      await enrollCam.start();
      $('enroll-fallback').classList.add('hidden');
      $('enroll-submit').disabled = false;
    } catch (err) {
      $('enroll-fallback').classList.remove('hidden');
      $('enroll-fallback-text').textContent = err.message;
      $('enroll-start').classList.remove('hidden');
      $('enroll-start').textContent = 'Try again';
      $('enroll-submit').disabled = true;
    }
  }

  function stopEnrollCamera() {
    if (!enrollCam.isRunning()) return;
    enrollCam.stop();
    $('enroll-fallback').classList.remove('hidden');
    $('enroll-fallback-text').textContent = 'Camera stopped.';
    $('enroll-start').classList.remove('hidden');
    $('enroll-start').textContent = 'Start camera';
    $('enroll-submit').disabled = true;
  }

  $('enroll-start').addEventListener('click', startEnrollCamera);

  function enrollMessage(tone, text) {
    const tones = {
      success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      error: 'border-rose-200 bg-rose-50 text-rose-800',
      info: 'border-amber-200 bg-amber-50 text-amber-800',
    };
    $('enroll-result').innerHTML = `
      <p class="result-in rounded-xl border px-4 py-3 text-sm font-medium leading-relaxed ${tones[tone]}">
        ${escapeHtml(text)}
      </p>`;
  }

  async function submitEnrollment(overwrite) {
    if (enrolling || !enrollCam.isRunning()) return;

    const name = $('enroll-name').value.trim();
    if (name.length < 2) {
      enrollMessage('error', 'Enter a name of at least two characters first.');
      $('enroll-name').focus();
      return;
    }

    enrolling = true;
    $('enroll-submit').disabled = true;
    $('enroll-label').textContent = 'Reading face…';
    $('enroll-sweep').classList.remove('hidden');
    $('enroll-sweep').classList.add('scan-sweep');
    $('enroll-result').innerHTML = '';

    try {
      const image = enrollCam.capture(0.9);

      const res = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, image, overwrite: Boolean(overwrite) }),
      });
      if (res.status === 401) return handleUnauthenticated();
      const data = await res.json();

      if (data.ok) {
        enrollMessage('success', data.message);
        $('enroll-name').value = '';
        loadUsers();
      } else if (data.code === 'DUPLICATE_NAME') {
        // Offer the replace rather than making them guess how to fix it.
        $('enroll-result').innerHTML = `
          <div class="result-in rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p class="text-sm font-medium leading-relaxed text-amber-800">${escapeHtml(data.message)}</p>
            <button id="confirm-overwrite" class="mt-2.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-amber-700">
              Replace their stored face
            </button>
          </div>`;
        $('confirm-overwrite').addEventListener('click', () => submitEnrollment(true));
      } else {
        enrollMessage('error', data.message || 'Enrollment failed.');
      }
    } catch {
      enrollMessage('error', 'Could not reach the server. Check that it is still running.');
    } finally {
      enrolling = false;
      $('enroll-submit').disabled = !enrollCam.isRunning();
      $('enroll-label').textContent = 'Capture & enroll';
      $('enroll-sweep').classList.add('hidden');
      $('enroll-sweep').classList.remove('scan-sweep');
    }
  }

  $('enroll-submit').addEventListener('click', () => submitEnrollment(false));
  $('enroll-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitEnrollment(false);
  });

  async function loadUsers() {
    const holder = $('users-table');
    holder.innerHTML = skeleton(4);

    try {
      const { users } = await getJSON('/api/admin/users');
      $('users-count').textContent = users.length;

      if (!users.length) {
        holder.innerHTML = emptyState(
          'Nobody is enrolled yet',
          'Capture the first face on the left. Until someone is enrolled, the kiosk cannot recognise anyone.'
        );
        return;
      }

      const rows = users.map(
        (u) => `
        <tr class="transition hover:bg-slate-50">
          <td class="px-5 py-3.5">
            <div class="flex items-center gap-3">
              ${avatar(u.name)}
              <span class="font-semibold">${escapeHtml(u.name)}</span>
            </div>
          </td>
          <td class="tnum px-5 py-3.5 text-slate-500">${escapeHtml(u.createdAt.slice(0, 10))}</td>
          <td class="px-5 py-3.5 text-right">
            <button
              data-delete="${u.id}"
              data-name="${escapeHtml(u.name)}"
              class="rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-500 transition hover:bg-rose-50 hover:text-rose-700"
            >Remove</button>
          </td>
        </tr>`
      );

      holder.innerHTML = table(['Name', 'Enrolled', ''], rows);

      holder.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', () => removeUser(btn.dataset.delete, btn.dataset.name));
      });
    } catch (err) {
      holder.innerHTML = emptyState('Could not load people', err.message);
    }
  }

  async function removeUser(id, name) {
    // Deleting a person cascades to their attendance rows, which is not
    // obvious from the button, so the confirmation says so explicitly.
    const ok = window.confirm(
      `Remove ${name}? Their enrolled face and every attendance record for them will be deleted. This cannot be undone.`
    );
    if (!ok) return;

    try {
      const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
      if (res.status === 401) return handleUnauthenticated();
      const data = await res.json();
      if (!data.ok) throw new Error(data.message);
      loadUsers();
    } catch (err) {
      enrollMessage('error', err.message || 'Could not remove that person.');
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Loading placeholder                                                      */
  /* ------------------------------------------------------------------------ */

  function skeleton(rows) {
    return (
      '<div class="animate-pulse space-y-3 p-5">' +
      Array.from({ length: rows })
        .map(
          () =>
            '<div class="flex items-center gap-3"><div class="h-8 w-8 rounded-full bg-slate-100"></div><div class="h-3 flex-1 rounded bg-slate-100"></div><div class="h-3 w-16 rounded bg-slate-100"></div></div>'
        )
        .join('') +
      '</div>'
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Session                                                                  */
  /* ------------------------------------------------------------------------ */

  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    $('logout').textContent = 'Signing out…';
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // Redirect regardless of whether the request succeeded — an admin
      // asking to sign out should never be stuck on the dashboard because a
      // network blip ate the response.
      window.location.href = '/login';
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Boot                                                                     */
  /* ------------------------------------------------------------------------ */

  (async function boot() {
    try {
      const health = await getJSON('/api/health');
      $('side-meta').textContent = `Threshold ${health.matchThreshold} · late after ${health.lateAfter}`;
    } catch {
      $('side-meta').textContent = 'Server unreachable';
    }

    try {
      const res = await fetch('/api/auth/session');
      const session = await res.json();
      const name = (session.username || 'Admin').trim();
      $('signed-in-as').textContent = name;
      $('signed-in-avatar').textContent = name.slice(0, 1).toUpperCase();
    } catch {
      $('signed-in-as').textContent = 'Admin';
    }

    const start = location.hash.slice(1);
    show(PAGES[start] ? start : 'today');
  })();

  window.addEventListener('hashchange', () => {
    const next = location.hash.slice(1);
    if (PAGES[next] && next !== current) show(next);
  });

  window.addEventListener('beforeunload', stopEnrollCamera);
})();
