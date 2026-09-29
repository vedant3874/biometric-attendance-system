# Face Recognition Attendance

A biometric check-in system. People mark attendance by looking at a webcam; administrators enroll faces and review the log. Express + `@vladmandic/face-api` + SQLite, with a Tailwind frontend served as plain static files.

Two interfaces:

| Route | Who it's for | What it does |
|---|---|---|
| `/` or `/user` | Anyone checking in | Live camera, one button, one check-in per day |
| `/login` | Administrators | Sign in |
| `/admin` | Administrators (signed in) | Daily attendance, full history, enrollment |

---

## ⚠️ Default admin login

```
Username: admin
Password: password123
```

**Change this before the machine is reachable by anyone but you.** Set both before starting the server:

```bash
ADMIN_USERNAME=yourname ADMIN_PASSWORD="something long and not password123" npm start
```

or put them in a `.env` file (see `.env.example`) so you don't have to type them every time. The server prints a loud reminder on startup for as long as you're still on the defaults.

---

## Running it locally

You need **Node 18 or newer** (`node -v` to check).

```bash
npm install          # installs dependencies
npm run models       # downloads ~12 MB of model weights into ./models
npm run doctor       # optional: checks everything is in place
npm start            # http://localhost:3000
```

If anything fails to start, run `npm run doctor` first. It checks your Node version, every dependency, the canvas backend and all eight model files, and prints the fix for each problem it finds — rather than reporting only the first missing piece as a stack trace.

Then open:

- **http://localhost:3000/admin** — sign in (`admin` / `password123` by default), then enroll yourself under "Enroll user"
- **http://localhost:3000/** — scan to check in

Nothing works until at least one person is enrolled, so start with the admin page.

### Configuration

All optional, set as environment variables:

```bash
PORT=8080 npm start              # default 3000
LATE_AFTER=10:00 npm start       # default 09:30 — after this, check-ins are 'Late'
MATCH_THRESHOLD=0.55 npm start   # default 0.6 — lower is stricter
DETECTOR=ssd npm start           # default tiny — see "Performance" below
TINY_INPUT_SIZE=224 npm start    # default 320 — smaller is faster
PERF_LOG=false npm start         # default true — per-scan timing in the console
```

### If the camera doesn't start

Browsers only expose `getUserMedia` on `localhost` or HTTPS. `http://localhost:3000` is fine. Opening the page from another machine via `http://192.168.x.x:3000` is **not** — the camera will be blocked. To run a real kiosk on a LAN, put the server behind HTTPS with a certificate, or run the browser on the same machine as the server.

### If `npm run models` is blocked

The script tries three mirrors. If your network blocks all of them, download these eight files by hand from [face-api.js/weights](https://github.com/justadudewhohacks/face-api.js/tree/master/weights) into `./models/`:

```
ssd_mobilenetv1_model-weights_manifest.json   ssd_mobilenetv1_model-shard1   ssd_mobilenetv1_model-shard2
face_landmark_68_model-weights_manifest.json  face_landmark_68_model-shard1
face_recognition_model-weights_manifest.json  face_recognition_model-shard1  face_recognition_model-shard2
```

---

## Folder structure

```
face-attendance-pro/
├── server.js                  Entry point. Sessions, page routes, then listens.
├── package.json
├── .env.example                Copy to .env for your admin credentials
│
├── src/
│   ├── db.js                  SQLite schema, prepared statements, all queries
│   ├── faceEngine.js          face-api setup, descriptor extraction, matching
│   ├── canvasAdapter.js       Picks a canvas backend, falls back if needed
│   ├── auth.js                Admin credential check, sessions, lockout
│   └── routes/
│       ├── index.js           Mounts every router under /api
│       ├── auth.js            POST /api/auth/login, /logout, GET /session
│       ├── kiosk.js           POST /api/enroll (admin), POST /api/attend (public)
│       ├── admin.js           GET /api/admin/*  — every route here needs login
│       └── respond.js         Shared error -> HTTP mapping
│
├── views/                      NOT served statically — see below
│   ├── admin.html              Admin dashboard (behind requirePageAuth)
│   └── login.html              Sign-in form
│
├── public/                     Served statically — reachable by anyone
│   ├── index.html              User portal (public kiosk)
│   ├── css/app.css             Fonts, camera overlay, keyframes
│   └── js/
│       ├── camera.js           Shared webcam controller
│       ├── user.js             Kiosk logic
│       ├── admin.js            Dashboard logic
│       └── login.js            Sign-in form logic
│
├── scripts/
│   ├── download-models.js
│   └── doctor.js               Preflight check — run: npm run doctor
├── models/                     Downloaded weights (gitignored)
└── data/                       attendance.db (gitignored)
```

**Why `admin.html` lives in `views/` and not `public/`.** `express.static` serves everything under `public/` to anyone who asks, with no way to check a session first. If `admin.html` sat there, a browser could load `/admin.html` directly and see the full dashboard HTML regardless of whether `/admin` itself is protected — the login check would exist but be trivially skippable. Moving both admin pages out of the static folder means the *only* way to reach them is through `server.js`'s guarded routes.

---

## Database

`data/attendance.db`, created automatically on first run.

```sql
users
  id          INTEGER PRIMARY KEY AUTOINCREMENT
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE
  descriptor  TEXT NOT NULL          -- JSON array of 128 floats
  created_at  TEXT NOT NULL

attendance
  id       INTEGER PRIMARY KEY AUTOINCREMENT
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  date     TEXT NOT NULL             -- YYYY-MM-DD, local calendar day
  time     TEXT NOT NULL             -- HH:MM:SS, local clock
  status   TEXT NOT NULL             -- 'Present' | 'Late'
  UNIQUE (user_id, date)
```

**`UNIQUE (user_id, date)` is what makes check-in idempotent.** `markAttendance()` checks for an existing row first and returns the original time if it finds one, but the constraint is the thing that actually holds if two scans ever land in the same millisecond — the insert throws, and the code falls back to reading the existing row rather than returning a 500. Scanning fifty times in a row produces exactly one record.

Dates are computed from **local** time, not UTC. Someone checking in at 1 a.m. IST belongs to that calendar day, not to yesterday in London.

---

## API

Every response carries an `ok` boolean, so the frontend has one branch to write.

### `POST /api/enroll` — requires an admin session

```jsonc
// request
{ "name": "Ananya Deshmukh", "image": "data:image/jpeg;base64,...", "overwrite": false }

// 201
{ "ok": true, "replaced": false, "user": { "id": 1, "name": "Ananya Deshmukh" },
  "confidence": 0.9981, "message": "Ananya Deshmukh is enrolled and can now mark attendance." }
```

Rejects with `409 DUPLICATE_NAME` if the name is taken (resend with `overwrite: true` to replace the stored face), and `409 FACE_ALREADY_ENROLLED` if that face already belongs to someone else. That second check matters: without it, one person enrolled twice under two spellings makes every later scan a coin flip between them. Without a signed-in session, this returns `401 UNAUTHENTICATED` instead of touching the face pipeline at all.

### `POST /api/attend` — public, no login

```jsonc
// request
{ "image": "data:image/jpeg;base64,..." }

// matched, first scan today
{ "ok": true, "alreadyMarked": false, "user": { "id": 1, "name": "Ananya Deshmukh" },
  "date": "2026-09-17", "time": "09:12:04", "status": "Present", "distance": 0.3814 }

// matched, already checked in — returns the ORIGINAL time
{ "ok": true, "alreadyMarked": true, "user": { ... }, "time": "09:12:04", "status": "Present" }

// 404 — closest enrolled face was still too far away
{ "ok": false, "code": "NO_MATCH", "distance": 0.71, "threshold": 0.6,
  "message": "Face not recognised. Ask an administrator to enroll you." }
```

This is the one endpoint anyone can call with no session — it's what the public kiosk hits on every scan.

### `GET /api/admin/today?date=YYYY-MM-DD` — requires an admin session

Today's attendance joined with user names, plus counts for the dashboard cards. `date` is optional and lets the dashboard look at any past day.

### `GET /api/admin/history?limit=1000` — requires an admin session

Every record, newest first, joined with user names.

### Also available — all require an admin session

`GET /api/admin/users`, `GET /api/admin/stats`, `DELETE /api/admin/users/:id` (cascades to that person's attendance rows).

### Authentication

```jsonc
// POST /api/auth/login   { "username": "admin", "password": "password123" }
{ "ok": true, "username": "admin" }
// wrong credentials -> 401 { "ok": false, "code": "INVALID_CREDENTIALS", ... }
// too many failures  -> 429 { "ok": false, "code": "LOCKED_OUT", "retryAfter": 240, ... }

// POST /api/auth/logout   (no body)
{ "ok": true }

// GET /api/auth/session
{ "ok": true, "authenticated": true, "username": "admin" }
```

A session is a cookie (`attendance.sid`), valid for 8 hours or until `/api/auth/logout` is called. Five wrong passwords from the same IP locks that IP out for 5 minutes — the response tells you exactly how many seconds are left.

`GET /api/health` stays public — it's just counts and thresholds, used by the kiosk's footer.

### Error codes

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No admin session — sign in at `/login` |
| `INVALID_CREDENTIALS` | 401 | Wrong username or password |
| `LOCKED_OUT` | 429 | Too many failed logins from this IP — wait `retryAfter` seconds |
| `NO_FACE` | 422 | Nobody in frame |
| `MULTIPLE_FACES` | 422 | More than one person in frame |
| `NO_MATCH` | 404 | Face not close enough to anyone enrolled |
| `NO_USERS` | 409 | Nobody enrolled yet |
| `DUPLICATE_NAME` | 409 | Name taken — resend with `overwrite: true` |
| `FACE_ALREADY_ENROLLED` | 409 | That face belongs to a different record |
| `BAD_IMAGE` | 400 | Undecodable or oversized image |
| `MODELS_NOT_LOADED` | 503 | Server still starting |

---

## How recognition works

1. **Detect** — finds faces in the frame. Two interchangeable detectors are available (see "Performance" below): `tinyFaceDetector` (the default) or `ssdMobilenetv1`. Zero faces and two-or-more faces are both errors, because with a crowd in frame we'd be guessing whose face we just saved.
2. **Align** — `faceLandmark68Net` finds 68 landmarks and normalises the crop for pose.
3. **Describe** — `faceRecognitionNet` produces 128 floats. Same person under different lighting lands near the same point; different people land far apart.
4. **Match** — Euclidean distance against every enrolled descriptor:

   ```
   distance = sqrt( Σ (a[i] − b[i])² )
   ```

   Below `0.6` is a match. Descriptors are labelled by user **id**, not name, so two people called "Priya" never collide.

Tuning: lower the threshold if people are being matched as the wrong person, raise it if legitimate people are being rejected. Don't go above about `0.65` — in an attendance system a false positive means one person clocking in as another, which is worse than an occasional retry.

---

## Performance

If a scan feels slow, two independent things are each contributing latency. One is fixed by this project's design and isn't worth fighting; the other is a one-line env var.

### The detector: fixed by default, and the actual lever

face-api.js ships two detectors with a real tradeoff between them: `ssdMobilenetv1` is precise but heavy — built for finding faces accurately in arbitrary photos — while `tinyFaceDetector` is a much smaller network built for exactly this app's situation, a live camera feed where the face is front-on and reasonably close. **This project defaults to `tinyFaceDetector`.** If you're seeing multi-second scans, check the server console output for a startup line like:

```
detector             tiny (input size 320)
```

If it says `ssd` instead, someone set `DETECTOR=ssd` — remove that, or set `DETECTOR=tiny` explicitly, and restart.

Every scan also prints a timing breakdown:

```
[face] decode 12ms · detect+describe 380ms · total 392ms (tiny@320)
```

`detect+describe` is almost always where the time goes. If that number is still large with `tiny` active, drop `TINY_INPUT_SIZE` — it's the size (in pixels) the frame is resized to before the net runs, so smaller is directly faster:

```bash
TINY_INPUT_SIZE=224 npm start   # default 320
TINY_INPUT_SIZE=160 npm start   # faster still; fine if faces fill most of the frame
```

Valid sizes are `128, 160, 224, 320, 416, 512, 608`. Go too small and faces at the edge of the frame or at an angle stop being found — if that happens, step back up one size. If scans are still unreliable at `320`, `DETECTOR=ssd` trades the speed back for precision.

Once you're happy with the numbers, `PERF_LOG=false` quiets the per-scan line.

### The math backend: not fixed, on purpose

The other cost is that all of this runs on `@tensorflow/tfjs`, the pure-JavaScript build — see "A note on `@tensorflow/tfjs-node`" below for exactly why. The real native `@tensorflow/tfjs-node` package runs the same networks through compiled C++ instead of JavaScript and is dramatically faster, often by an order of magnitude — but it has the identical installation problem `canvas` had (platform-specific prebuilt binaries, a C++ toolchain if none exists for your platform). Auto-detecting and falling back between two *separate* TensorFlow.js installations — the way `src/canvasAdapter.js` does for the canvas backend — isn't safe to do silently here: face-api.js's internal math engine is a shared global registry, and two independently-loaded copies of TensorFlow.js can silently end up as two disconnected registries, so a "successful" fallback could quietly do nothing while looking like it worked. That's a worse failure mode than just being slow, so this project doesn't attempt it automatically.

If you want to try the real native backend yourself: install the true package (not the alias already in this project) and see if a prebuilt binary exists for your platform —

```bash
npm install @tensorflow/tfjs-node --save-exact
```

— then restart. If it installs cleanly, face-api.js will use it automatically (it's what `require('@tensorflow/tfjs-node')` was always going to resolve to, once something real is actually there instead of the pure-JS alias). If it fails to install, `npm uninstall @tensorflow/tfjs-node` to get back to the working pure-JS setup — nothing else in this project needs to change either way.

### A note on the canvas backend

face-api has no idea what a browser is when it runs under Node, so it has to be handed implementations of `Canvas`, `Image` and `ImageData`. Two packages can supply those, and `package.json` installs both:

```json
"dependencies":         { "@napi-rs/canvas": "^0.1.60" },
"optionalDependencies": { "canvas": "^3.2.3" }
```

`canvas` (node-canvas) is the reference implementation and is preferred when it works. It is listed as **optional** on purpose: npm does not abort the install when an optional dependency fails to build, so a machine with no prebuilt binary and no C++ toolchain still ends up with a working project instead of a failed `npm install`.

`@napi-rs/canvas` is the fallback. It ships prebuilt binaries as platform-specific optional dependencies, so nothing ever compiles. That makes it dependable on Windows and on brand-new Node releases where node-canvas has no prebuild yet.

`src/canvasAdapter.js` picks between them at startup and prints which one it chose. It also papers over the one API difference that matters: face-api calls `new Canvas()` with no arguments and assigns `.width`/`.height` afterwards, which node-canvas tolerates and `@napi-rs/canvas` rejects.

One deliberate detail: the adapter only falls back when node-canvas is genuinely *absent* (`MODULE_NOT_FOUND`). If node-canvas is installed but broken — a missing DLL, a wrong-ABI binary — that error is re-thrown rather than swallowed, because silently falling back would hide a problem you need to know about.

### A note on `@tensorflow/tfjs-node`

`package.json` aliases it:

```json
"@tensorflow/tfjs-node": "npm:@tensorflow/tfjs@^4.22.0"
```

face-api's Node build has a hardcoded `require('@tensorflow/tfjs-node')`. The native addon's prebuilt binaries are often unavailable (especially on Windows) and building from source needs a full C++ toolchain. The alias satisfies that `require` by name while delivering the pure-JavaScript build, so `npm install` just works everywhere, at the cost of running math in JS instead of compiled native code. See "The math backend" under **Performance** above for what that costs in practice and how to try the real native package if you want to.

---

## Before you deploy this

This is written as a single-machine kiosk app, and there are things it deliberately does not do.

**The admin login is real, but it's still one account with no audit trail.** Every dashboard route and `/api/enroll` require a signed-in session now, with bcrypt-hashed credentials and a lockout after repeated failed logins — so this is no longer "anyone who reaches the server can do anything." What it doesn't give you: no record of *which* admin enrolled or deleted someone (there's only one), no per-admin permissions, and sessions live in memory (`express-session`'s default `MemoryStore`), so they reset on every restart and won't work if you ever run more than one server process. If you need multiple admin accounts with their own logins, add an `admins` table (`id, username, password_hash`) and swap `verifyCredentials()` in `src/auth.js` to look up a row instead of comparing against the one env-var account — everything else (sessions, the route guards, the lockout) stays as-is.

**There's no CSRF protection on the login form.** For a single admin on a local network this is a low-priority gap, but it's a real one — worth closing with a CSRF token before this is reachable from the open internet.

**`/api/attend` has no rate limiting.** Anyone who can reach the kiosk endpoint can hammer it; each call runs the full face-detection pipeline, which is the expensive part of this app. Add a rate limiter (e.g. `express-rate-limit`) in front of it before exposing this beyond a trusted LAN.

**Face descriptors are biometric data.** In many jurisdictions — India's DPDP Act, the GDPR, Illinois' BIPA — they're a special category with consent, retention and disclosure obligations attached, and the penalties are not small. `data/` is gitignored and the descriptors are stored unencrypted on disk. If this goes past a class project, get the consent and retention story right before you enroll real people, and consider encrypting the database at rest.

A smaller note: the 128-float descriptor is not a picture, and you can't reconstruct someone's face from it. That's a genuine privacy advantage over storing photos, and worth keeping — don't add photo storage without a reason.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything at all | Start with `npm run doctor` |
| `Cannot find module 'canvas'` | `npm install @napi-rs/canvas`. See "A note on the canvas backend" above. |
| `npm install` fails on Node 24 | Node 22 LTS is the best-tested version here. Install [nvm-windows](https://github.com/coreybutler/nvm-windows/releases), then `nvm install 22 && nvm use 22`, delete `node_modules` and `package-lock.json`, and reinstall. |
| Native module errors after switching Node versions | Delete `node_modules` and `package-lock.json`, then `npm install`. Native binaries are per-ABI and do not survive a version change. |
| `Models folder not found` | `npm run models` |
| `npm install` fails on `canvas` | Linux: `sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`. macOS: `brew install pkg-config cairo pango libpng jpeg giflib librsvg` |
| "No face detected" every time | Add light in front of you, not behind. Fill more of the frame. |
| Recognised as the wrong person | Lower `MATCH_THRESHOLD` to `0.55`, and re-enroll both people in even lighting |
| Camera blocked on a LAN address | Expected — browsers require `localhost` or HTTPS |
| Signed out every time the server restarts | Set `SESSION_SECRET` in `.env` — without it, a new one is generated on every boot |
| `/admin` redirects straight to `/login` in a loop | Cookies are blocked or the browser is in a mode that clears them (private browsing on some settings). Check that cookies are allowed for `localhost`. |
| Forgot the admin password | It's whatever `ADMIN_PASSWORD` is set to (default `password123`). Set a new one in `.env` and restart — there's no "forgot password" flow for a single fixed account. |
| `429 LOCKED_OUT` when signing in | Five wrong attempts locks that IP for 5 minutes. Wait it out, or restart the server to clear it. |
| Everyone shows as "Late" | Set `LATE_AFTER` to match your start time |

MIT licensed.
