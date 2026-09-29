/**
 * login.js
 * -----------------------------------------------------------------------------
 * Submits the login form to /api/auth/login and follows the session cookie
 * the server sets on success. Nothing here decides whether the credentials
 * are right — that's entirely the server's call.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('login-form');
  const submit = $('submit');
  const label = $('submit-label');
  const errorBox = $('form-error');

  function showError(text) {
    errorBox.innerHTML = `
      <p class="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
        ${escapeHtml(text)}
      </p>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.innerHTML = '';

    const username = $('username').value.trim();
    const password = $('password').value;

    if (!username || !password) {
      showError('Enter both a username and a password.');
      return;
    }

    submit.disabled = true;
    label.textContent = 'Signing in…';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (data.ok) {
        // Full navigation, not a fetch-based redirect — this lets the browser
        // resend the session cookie as a normal page load, and lets /admin's
        // own requirePageAuth check take over cleanly.
        window.location.href = '/admin';
        return;
      }

      showError(data.message || 'Sign in failed.');
    } catch {
      showError('Could not reach the server. Check that it is still running.');
    } finally {
      submit.disabled = false;
      label.textContent = 'Sign in';
    }
  });

  $('username').focus();
})();
