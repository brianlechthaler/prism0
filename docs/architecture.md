# Architecture

prism0 turns a text idea into a small browser app, validates the generated project, and streams progress back to the UI.

## Components

### Frontend

- React application built with Vite and **React Router**.
- `frontend/src/ui/App.tsx` defines public routes (splash, login, register, verify) and protected routes (dashboard, generator).
- `frontend/src/ui/GeneratorApp.tsx` renders the prompt form, progress log, Sandpack preview, publish flow, download link, and runtime repair UI.
- `frontend/src/hooks/useAuth.tsx` manages session state and account API calls (`credentials: "include"`).
- `frontend/src/hooks/useGeneration.ts` owns generation API calls, Server-Sent Events, and client-side generation state.
- Generated app runtime errors are reported from the preview frame back to the parent UI and can trigger a repair run.

### Backend

- Express service in `backend/src/server.ts`.
- Static frontend assets are served from `frontend/dist`.
- Route modules: `routes.ts` (generation), `authRoutes.ts` (accounts), `projectRoutes.ts` (publish/manage), `hosting.ts` (public `/h/:slug`).
- **SQLite** (`backend/src/db.ts`, `better-sqlite3`) stores users, sessions, hosted projects, and generation history.
- Auth middleware (`authMiddleware.ts`) loads the session from the `prism0_session` cookie on every request.
- `/api/health` is used by CI, Docker, Kubernetes, and PaaS health checks.
- Security and proxy headers are set at the Express layer.

### Generation pipeline

- `backend/src/generator.ts` orchestrates generation, JSON repair, validation repair, runtime repair, logging, and final publication.
- `backend/src/llm.ts` calls an OpenAI-compatible streaming chat completions API with request, first-token, idle, and hard-limit timeouts.
- `backend/src/prompts.ts` centralizes prompts and retry limits.
- `backend/src/parseGenerated.ts` validates the model response shape.

### Validation harness

- `backend/src/validateProject.ts` creates an isolated run directory under `backend/validation-harness/runs`.
- The generated project is linted and tested before it is returned to the UI.
- Runtime containers and Kubernetes pods keep this path writable.

### Run state

- `backend/src/runStore.ts` stores run metadata, logs, generated files, status, and SSE subscribers in memory.
- `MAX_RUNS` bounds retained completed/failed runs per process.
- Active runs are not pruned just because the retention cap is exceeded.

## Request flow

### Authentication (first visit)

1. User registers at `POST /api/auth/register`; backend stores credentials and sends a verification email.
2. User verifies via `POST /api/auth/verify-email` (email links use `/verify-email#token=…`).
3. User logs in at `POST /api/auth/login`; backend sets an HttpOnly session cookie.
4. `GET /api/auth/me` and auth middleware attach `user` to subsequent requests.

### Generation

When login is enabled (`--enable-login`), generation requires a session. Otherwise the generator works anonymously.

1. Browser posts an idea to `POST /api/generate`.
2. Backend creates a run, records generation history for the user when login is enabled, and starts generation asynchronously.
3. Browser connects to `GET /api/generate/:runId/events`.
4. Backend streams logs and terminal events over SSE.
5. Backend validates the generated project (unless YOLO mode skips harness on initial generation).
6. Browser receives generated files and displays them in Sandpack.
7. Browser can download the project zip from `GET /api/project/:runId/download`.
8. If the preview reports a runtime error, the browser can post to `POST /api/generate/:runId/fix`.
9. User may publish via `POST /api/projects`; visitors open the app at `GET /h/:slug`.

See [auth-and-hosting.md](./auth-and-hosting.md) for account, dashboard, and hosting API detail.

## Production stability choices

- Health checks are consistent across shell, Docker, CI, Kubernetes, Railway, Fly.io, and Render.
- The Docker runtime image runs as a non-root user.
- Kubernetes manifests set resource requests/limits, startup/readiness/liveness probes, and non-root pod security.
- SSE responses set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.
- Model streams have first-token, idle-token, and total-duration timeouts.
- Completed/failed run retention is bounded by `MAX_RUNS`.
- Validation workspaces are disposable and isolated by run ID.

## Scaling model

The current implementation is intentionally simple: one backend process owns its active runs and SSE subscribers.

Safe default:

- Run one backend replica.
- Use platform health checks and restart policies.
- Increase CPU/memory before increasing replicas.

Horizontal scaling options:

1. Sticky sessions: keep all requests from the same user on the same pod/process for the duration of a run. The Kubernetes Service enables client-IP affinity, and ingress-specific affinity should be configured when using multiple replicas behind an ingress controller.
2. External state: move run records, generated files, and pub/sub events to a shared service such as Redis or a database-backed queue. After that, any pod can serve event streams, repairs, and downloads.

The optional Kubernetes HPA is provided for deployments that satisfy one of those options.

## Performance notes

- Static frontend assets are served by Express in the single-process deployment. For higher traffic, place a CDN or reverse proxy in front of the app.
- Generated project validation runs child processes. Size CPU and memory limits to account for both the backend and validation subprocesses.
- `REQUEST_TIMEOUT_MS` controls the initial upstream request timeout. Streaming idle and hard limits are enforced separately in code.
- `MAX_RUNS` should be tuned lower for small memory instances and higher when users need longer download windows.

## Reliability boundaries

- **In-memory run state** (active generations, SSE subscribers, Sandpack files for unpublished runs) is lost on process restart. Users can re-run generation after a restart.
- **SQLite** (`DATABASE_PATH`) persists users, sessions, hosted projects, and generation history. Back up this file in production; mount a volume in Docker/Kubernetes.
- Generated validation workspaces under `backend/validation-harness/runs` are ephemeral and do not need backups.
- API keys remain in environment variables only.
- Generation endpoints are rate-limited per client IP; login/register endpoints are not yet rate-limited — plan accordingly for public deployments.
- Horizontal scaling still requires sticky sessions or external run state for **in-flight generations**; the database can be shared only when all replicas use the same `DATABASE_PATH` on shared storage (single-writer SQLite) or when the storage layer is redesigned.
