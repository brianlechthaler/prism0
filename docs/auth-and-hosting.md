# Authentication, accounts, and hosted projects

prism0 includes username/password accounts with email verification, a per-user dashboard, and the ability to **publish** generated apps to stable public URLs. Generation and most API routes require a verified session.

This document covers user flows, routes, APIs, persistence, configuration, and production notes. For generation pipeline details, see [architecture.md](./architecture.md).

## Overview

| Area | Summary |
| --- | --- |
| **Accounts** | Register with username, email, and password. Email must be verified before login. |
| **Sessions** | HttpOnly cookie `prism0_session` (7-day default TTL). |
| **Persistence** | SQLite via `better-sqlite3` at `DATABASE_PATH` (default `./data/prism0.db`). |
| **Dashboard** | Projects, generation history, token usage, profile settings. |
| **Hosting** | Published apps are served at `/h/:slug` with a separate manage link `/manage/:editToken`. |
| **Generator** | Authenticated users open `/app` (or `/app/:projectId` to continue a hosted project). |

Backend modules:

- `backend/src/auth.ts` — registration, login, sessions, verification, profile
- `backend/src/authRoutes.ts` — `/api/auth/*` and `/api/dashboard`
- `backend/src/authMiddleware.ts` — session cookie read/write, `requireAuth()`
- `backend/src/db.ts` — schema and `openDatabase()`
- `backend/src/crypto.ts` — scrypt password hashing, random tokens
- `backend/src/email.ts` — verification email content (console sender in dev)
- `backend/src/projectStore.ts` — publish, versions, page views, slugs
- `backend/src/projectRoutes.ts` — `/api/projects/*`
- `backend/src/hosting.ts` — public static hosting at `/h/:slug`
- `backend/src/generationHistory.ts` — per-user run history and token totals

Frontend:

- `frontend/src/hooks/useAuth.tsx` — auth context and API wrappers
- `frontend/src/ui/App.tsx` — React Router routes
- `frontend/src/ui/SplashPage.tsx`, `LoginPage.tsx`, `RegisterPage.tsx`, `VerifyEmailPage.tsx`
- `frontend/src/ui/DashboardPage.tsx`, `GeneratorApp.tsx`, `ProjectManagePage.tsx`
- `frontend/src/ui/ProtectedRoute.tsx` — requires login + verified email

## User flows

### Registration and verification

1. User opens `/register` and submits username (3–32 chars, `[a-zA-Z0-9_]`), email, and password (min 8 chars).
2. Backend creates the user with `email_verified = 0`, stores a scrypt password hash, and creates a 24-hour verification token.
3. A verification email is sent (logged to stdout in development via the console email sender).
4. User visits `/verify-email?token=…` (from the email link) or uses the verify page UI.
5. `GET /api/auth/verify-email?token=…` marks the account verified and deletes the token.
6. User logs in at `/login`.

**Development:** set `AUTH_EXPOSE_VERIFICATION_TOKEN=true` to include `verificationToken` in register/resend API responses so you can verify without reading server logs. **Do not enable in production.**

### Login and session

1. `POST /api/auth/login` with `{ username, password }`.
2. On success, the response sets `Set-Cookie: prism0_session=…` with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when `NODE_ENV=production`.
3. The browser sends the cookie on subsequent requests (`credentials: "include"` in `frontend/src/api.ts`).
4. `POST /api/auth/logout` deletes the server-side session and clears the cookie.

Unverified users receive `400` with *"Email address is not verified yet"*.

### Dashboard

Authenticated, verified users open `/dashboard` to see:

- Hosted projects (links to public URL and manage page)
- Recent generation history and token usage summary
- Profile settings (display name, change email, change password, delete account)

Data comes from `GET /api/dashboard`.

### Generation (authenticated)

The generator moved from the root URL to **`/app`** (protected). Flow:

1. User submits an idea; `POST /api/generate` requires auth.
2. Progress streams on `GET /api/generate/:runId/events` (auth required).
3. Stop / pause / resume: `POST /api/generate/:runId/stop|pause|resume`.
4. Follow-ups, repairs, and download behave as before but require auth.

Optional body field `projectId` associates the run with an existing hosted project for history tracking.

### Publish and manage hosted apps

After a run completes (`status: "done"`):

1. User can **publish** from the generator UI → `POST /api/projects` with `{ runId, name }`.
2. Backend stores files, assigns a unique public **slug** and secret **edit token**, and returns URLs:
   - **Public:** `/h/:slug` (anyone can view; page views are counted on `index.html` loads)
   - **Manage:** `/manage/:editToken` (view metadata, versions, files; owner can revert/delete when logged in)
3. Saving a new version: `POST /api/projects/:projectId/versions` with `{ runId, idea? }`.
4. Revert: `POST /api/projects/:projectId/revert` or manage-route variant with auth.
5. Delete: `DELETE /api/projects/:projectId` or manage-route with auth.

The manage link is a **capability URL** — anyone with the token can read project details; destructive actions require the owning user to be logged in.

## Frontend routes

| Path | Access | Purpose |
| --- | --- | --- |
| `/` | Public | Splash / marketing |
| `/login` | Public | Log in |
| `/register` | Public | Create account |
| `/verify-email` | Public | Email verification UI (`?token=` supported) |
| `/dashboard` | Auth + verified | User dashboard |
| `/app` | Auth + verified | Generator |
| `/app/:projectId` | Auth + verified | Generator scoped to a hosted project |
| `/manage/:editToken` | Public (capability) | Project manage page |
| `/h/:slug` | Public | Hosted app (served by backend, not SPA) |

Vite dev server proxies `/api` and `/h` to the backend (`frontend/vite.config.ts`).

## Authentication API

All auth routes are under `/api/auth`. Unless noted, errors return `400` with a plain-text message for `AuthError`, or `401` when authentication is required.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/auth/me` | Optional | `{ authenticated, user? }` from session cookie |
| `POST` | `/api/auth/register` | No | Body: `{ username, email, password }`. Returns `{ user, verificationToken? }` |
| `POST` | `/api/auth/login` | No | Body: `{ username, password }`. Sets session cookie; returns `{ user }` |
| `POST` | `/api/auth/logout` | Yes | Clears session |
| `GET` | `/api/auth/verify-email` | No | Query: `token`. Returns `{ verified: true, user }` |
| `POST` | `/api/auth/resend-verification` | No | Body: `{ username, password }`. Sends new token |
| `PATCH` | `/api/auth/profile` | Yes | Body: `{ displayName: string \| null }` |
| `POST` | `/api/auth/change-email` | Yes | Body: `{ email, password }`. Resets verification; clears session cookie |
| `POST` | `/api/auth/change-password` | Yes | Body: `{ currentPassword, newPassword }`. Invalidates all sessions |
| `DELETE` | `/api/auth/account` | Yes | Body: `{ password }`. Deletes user and related rows (cascade) |
| `GET` | `/api/dashboard` | Yes | `{ user, projects, history, tokenSummary }` |

## Projects and hosting API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | Yes | List current user's projects |
| `POST` | `/api/projects` | Yes | Publish run: `{ runId, name }` |
| `GET` | `/api/projects/:projectId` | Yes | Project detail (owner only) |
| `GET` | `/api/projects/manage/:editToken` | Optional | Manage view; `canEdit` if logged-in owner |
| `POST` | `/api/projects/:projectId/versions` | Yes | Save new version from `{ runId, idea? }` |
| `POST` | `/api/projects/:projectId/revert` | Yes | `{ versionId }` |
| `POST` | `/api/projects/manage/:editToken/revert` | Owner session | Revert via manage link |
| `DELETE` | `/api/projects/:projectId` | Yes | Soft-delete project |
| `DELETE` | `/api/projects/manage/:editToken` | Owner session | Delete via manage link |
| `GET` | `/h/:slug` | No | Serve hosted `index.html` (+ page view) |
| `GET` | `/h/:slug/*file` | No | Serve other hosted static assets |

## Generation API (auth required)

These routes existed before accounts; they now require a valid verified session:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/models` | Model picker / YOLO flags |
| `POST` | `/api/generate` | Optional `projectId` in body |
| `POST` | `/api/generate/:runId/follow-up` | Optional `projectId` |
| `POST` | `/api/generate/:runId/fix` | Runtime repair |
| `POST` | `/api/generate/:runId/validation-fix` | Validation repair |
| `POST` | `/api/generate/:runId/stop` | Stop generation |
| `POST` | `/api/generate/:runId/pause` | Pause generation |
| `POST` | `/api/generate/:runId/resume` | Resume generation |
| `GET` | `/api/generate/:runId/events` | SSE stream |
| `GET` | `/api/project/:runId/download` | ZIP export |

Rate limits (`GENERATION_RATE_LIMIT_*`) and `MAX_ACTIVE_RUNS` still apply per client IP / process.

## Database

SQLite file at `DATABASE_PATH` (created automatically; parent directory is `mkdir`’d).

**Tables:**

- `users` — credentials, email verification flag, profile
- `email_verification_tokens` — one-time tokens (24h TTL)
- `sessions` — opaque session tokens with expiry
- `projects` — hosted apps (slug, edit_token, soft delete)
- `project_versions` — immutable file snapshots per project
- `page_views` — aggregate view counts per project
- `generation_history` — per-user run records and token totals

**Password storage:** scrypt (`N=16384`, `r=8`, `p=1`) with random 16-byte salt, stored as `salt:hash` hex.

**Sessions:** random 32-byte hex tokens in the `sessions` table; cookie mirrors the token.

### Persistence in production

The database file **must survive restarts** or all accounts and hosted projects are lost.

**Docker:**

```bash
docker run --rm -p 8787:8787 \
  -e OPENAI_API_KEY="your-key" \
  -e APP_BASE_URL="https://your-domain.example" \
  -v prism0-data:/app/data \
  prism0
```

**Kubernetes:** mount a `PersistentVolumeClaim` at `/app/data` (or set `DATABASE_PATH` to the mount path). The default manifest only mounts validation harness `emptyDir`; add a data volume for production multi-user use.

The Docker image compiles `better-sqlite3` in the build stage and copies the native module into the runtime image (see root `Dockerfile`).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/prism0.db` | SQLite database file path |
| `APP_BASE_URL` | `http://localhost:8787` | Base URL for verification links in emails |
| `SESSION_TTL_MS` | `604800000` (7 days) | Session cookie / DB expiry |
| `AUTH_EXPOSE_VERIFICATION_TOKEN` | `false` | Return verification tokens in API JSON (dev/tests only) |

All existing generation-related variables (`OPENAI_*`, `MAX_RUNS`, rate limits, etc.) still apply. See `.env.example` and [README.md](../README.md).

## Email

Production deployments need a real email sender. The current implementation uses a **console sender** that logs messages to stdout (`backend/src/email.ts`). Wire a transactional provider (SMTP, SendGrid, etc.) before inviting real users.

Verification emails contain a link:

```text
{APP_BASE_URL}/verify-email?token={token}
```

Set `APP_BASE_URL` to the public HTTPS origin users will open in the browser.

## Security notes

**Implemented:**

- HttpOnly session cookies, `SameSite=Lax`, `Secure` in production
- scrypt password hashing with timing-safe comparison
- Email verification gate before login
- Owner checks on project APIs (`userId` match → 404 to avoid IDOR hints)
- Parameterized SQL queries
- Password required for email change, password change, and account deletion
- Password change invalidates all sessions

**Operators should plan for:**

- Login/register rate limiting (not yet implemented; generation endpoints are rate-limited)
- Real email delivery and correct `APP_BASE_URL`
- Database backups and encrypted volumes
- Treat manage URLs (`/manage/:editToken`) as secrets
- HTTPS termination at the proxy (required for `Secure` cookies)

## Local development

```bash
export OPENAI_API_KEY="your-key"
export AUTH_EXPOSE_VERIFICATION_TOKEN=true   # optional: show tokens in API responses
npm run dev
```

- UI: http://localhost:5173
- Register → copy verification token from response or backend logs → verify → log in → `/app`

Tests use in-memory / temporary databases and mock email; see `backend/test/helpers.ts`.

## Related docs

- [README.md](../README.md) — feature summary and quick API reference
- [architecture.md](./architecture.md) — system components and scaling
- [production.md](./production.md) — deployment checklist including persistence
