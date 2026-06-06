# Architecture

prism0 turns a text idea into a small browser app, validates the generated project, and streams progress back to the UI.

## Components

### Frontend

- React application built with Vite.
- `frontend/src/ui/App.tsx` renders the prompt form, progress log, Sandpack preview, download link, and runtime repair UI.
- `frontend/src/hooks/useGeneration.ts` owns API calls, Server-Sent Events, and client-side generation state.
- Generated app runtime errors are reported from the preview frame back to the parent UI and can trigger a repair run.

### Backend

- Express service in `backend/src/server.ts`.
- Static frontend assets are served from `frontend/dist`.
- API routes are registered from `backend/src/routes.ts`.
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

1. Browser posts an idea to `POST /api/generate`.
2. Backend creates a run and starts generation asynchronously.
3. Browser connects to `GET /api/generate/:runId/events`.
4. Backend streams logs and terminal events over SSE.
5. Backend validates the generated project.
6. Browser receives generated files and displays them in Sandpack.
7. Browser can download the project zip from `GET /api/project/:runId/download`.
8. If the preview reports a runtime error, the browser can post to `POST /api/generate/:runId/fix`.

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

- In-memory run state is lost on process restart. Users can re-run generation after a restart.
- Generated validation workspaces are not persistent and do not need backups.
- The app does not store user accounts, long-lived generated artifacts, or API keys outside environment variables.
- For multi-tenant or high-traffic deployments, add authentication, rate limiting, persistent storage, and shared run state before exposing the service broadly.
