# prism0

Type an idea (e.g. “make a tetris game”) and `prism0` generates a small browser app with live progress, validation, editing, and export.

## Experimental status

**prism0 is experimental software.** It is under active development: features may change, break, or produce unreliable output. Generated apps are not reviewed for safety or correctness — treat them as untrusted code and use at your own risk. The web UI shows a persistent banner with this notice.

## Features

### Generation and validation

- **Prompt-to-app** — Describe an idea in plain text; the backend calls an **OpenAI-compatible** chat completions API and returns a vanilla HTML/CSS/JS project.
- **Test-driven output** — Generated projects include Vitest tests (`index.test.js`) and ESLint-clean code. Prompts require mobile-first layout, accessibility, and exported testable logic.
- **Backend validation harness** — Before results reach the UI, each project is linted and tested in an isolated subprocess workspace under `backend/validation-harness/runs/`.
- **Automatic JSON repair** — Invalid model JSON is retried up to 3 times with a dedicated fix prompt before the run fails.
- **Automatic validation repair** — ESLint or Vitest failures trigger up to 5 model-driven fix-and-revalidate attempts during generation.

### Iteration and repair

- **Follow-up prompts** — After a run completes, choose **Update the current app** to apply incremental changes without starting over, or **Start a new app instead** for a fresh generation.
- **Runtime repair** — Preview crashes and Sandpack bundler errors are reported to the UI. Click **Fix with LLM** to send the stack trace back to the model (`POST /api/generate/:runId/fix`). Runtime repairs always run validation.
- **Validation repair** — If validation still fails after automatic retries, the UI shows the error and a **Fix with LLM** button (`POST /api/generate/:runId/validation-fix`).
- **YOLO mode** — Optional fast path that skips the validation harness on initial generation and follow-ups. Repair flows still validate. Enabled on the backend by default; pass `--disable-yolo-mode` to turn off.

### Progress and observability

- **Server-Sent Events (SSE)** — `GET /api/generate/:runId/events` streams logs, LLM output, and completion events in real time.
- **LLM thinking stream** — Models that emit reasoning tokens (for example Nemotron with `reasoning_content`) show a live **LLM thinking** panel.
- **Generated code stream** — Model JSON/code output streams into a dedicated panel as it is produced.
- **Validation output** — ESLint and Vitest output from the backend harness appears in its own panel.
- **Usage metrics** — Input/output token counts, output tokens per second, and a context-window usage bar broken down by call type (generate, follow-up, JSON fix, validation fix, runtime fix, context compression).
- **Context compression** — When cumulative context usage crosses `OPENAI_CONTEXT_COMPRESS_THRESHOLD`, the run context is summarized, the usage counter resets, and generation continues.

### Editor, preview, and export

- **Sandpack editor + preview** — Completed projects open in an in-browser code editor with a live preview (vanilla template, auto-reload).
- **Editable generated code** — Edit files directly in Sandpack; changes reload the preview immediately.
- **Preview error reporting** — A small script injected into `index.html` posts runtime errors and unhandled rejections from the preview iframe back to the parent UI.
- **Download as ZIP** — Export the generated project from `GET /api/project/:runId/download`.
- **Multiline prompts** — Focus the prompt field to expand it to a larger textarea; press **Shift+Enter** to submit.

### Model configuration

- **Any OpenAI-compatible endpoint** — Configure `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` for OpenAI, NVIDIA NIM, Ollama, or other compatible providers. See `generate.js` for a minimal streaming example against NVIDIA NIM.
- **Model picker** — With `--enable-model-picker` and `OPENAI_MODELS`, the UI exposes a model dropdown.
- **Multi-model fallback** — Each request tries the selected model first, then falls back through the remaining configured models on failure.

### Accounts, dashboard, and hosting

- **User accounts** — Register with username and password. Email verification is disabled by default; set `AUTH_EMAIL_ENABLED=true` to allow optional email at signup.
- **Sessions** — HttpOnly cookie (`prism0_session`); generation and most API routes require an authenticated, verified session.
- **Dashboard** — `/dashboard` shows hosted projects, generation history, token usage, and profile settings.
- **Publish to the web** — After a successful run, publish to a stable public URL at `/h/:slug` with a separate manage link at `/manage/:editToken` (page views, versioning, revert, delete).
- **SQLite persistence** — Users, sessions, projects, and generation history are stored in a local SQLite database (`DATABASE_PATH`). Back up this file in production.

See [docs/auth-and-hosting.md](docs/auth-and-hosting.md) for flows, API detail, and deployment notes.

### Safety and limits

- **Per-client rate limiting** — `GENERATION_RATE_LIMIT_MAX` requests per `GENERATION_RATE_LIMIT_WINDOW_MS` per client IP (generation, follow-up, and repair endpoints).
- **Active-run cap** — `MAX_ACTIVE_RUNS` limits simultaneous pending/running generations per process.
- **Run retention** — `MAX_RUNS` bounds how many completed/failed runs are kept in memory for downloads and repairs.
- **Generated file safety** — Paths must be relative and safe; projects are capped at 50 files, 1 MB total, and 200 KB per file.
- **Security headers** — The backend sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` on responses.
- **Stream timeouts** — Model streams enforce first-token, idle-token, and hard-duration limits to avoid hung runs.

## Requirements

- Node.js **20+**

## Setup

```bash
npm install
```

For Cursor/cloud-agent or CI-like bootstrap, install exact locked dependencies and optional local validation CLIs:

```bash
npm run bootstrap
```

## Configure the model endpoint

Backend reads configuration from env vars (or CLI flags — see below):

- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (optional, default: `https://api.openai.com/v1`)
- `OPENAI_MODEL` (optional, default: `gpt-4.1-mini`)
- `OPENAI_MODELS` (optional comma-separated picker/fallback list; used only with `--enable-model-picker`; `OPENAI_MODEL` is always included first)
- `HOST` (optional, default: `0.0.0.0`)
- `PORT` (optional, default: `8787`)
- `REQUEST_TIMEOUT_MS` (optional, default: `120000`)
- `OPENAI_CONTEXT_WINDOW` (optional, default: `128000`; used for the UI context-usage bar)
- `OPENAI_CONTEXT_COMPRESS_THRESHOLD` (optional, default: `0.9`; when cumulative context usage reaches this fraction of the window, the run context is summarized and the usage counter reset; set to `0` to disable)
- `MAX_RUNS` (optional, default: `100`; caps retained completed/failed run metadata per process)
- `MAX_ACTIVE_RUNS` (optional, default: `5`; caps simultaneous pending/running generations per process)
- `GENERATION_RATE_LIMIT_WINDOW_MS` (optional, default: `60000`; request throttle window)
- `GENERATION_RATE_LIMIT_MAX` (optional, default: `10`; generation/repair requests allowed per client per window)
- `CORS_ORIGIN` (optional, unset by default; set only when serving the API cross-origin)
- `TRUST_PROXY` (optional, default: `false`; set to `true` behind a trusted reverse proxy)
- `DATABASE_PATH` (optional, default: `./data/prism0.db`; SQLite file for users, sessions, and hosted projects)
- `APP_BASE_URL` (optional, default: `http://localhost:8787`; public origin used in verification email links)
- `SESSION_TTL_MS` (optional, default: `604800000`; session lifetime in milliseconds, 7 days)
- `AUTH_EXPOSE_VERIFICATION_TOKEN` (optional, default: `false`; dev/tests only — ignored when `NODE_ENV=production`)
- `AUTH_EMAIL_ENABLED` (optional, default: `false`; enable email verification, change-email, and related UI)
- `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX` (optional; per-IP limits on register/login/verify/resend)
- `AUTH_LOGIN_MAX_FAILURES` / `AUTH_LOGIN_LOCKOUT_MS` (optional; lock out usernames after repeated failed logins)

Example (NVIDIA NIM-style, similar to `generate.js`):

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://integrate.api.nvidia.com/v1"
export OPENAI_MODEL="nvidia/nemotron-3-ultra-550b-a55b"
```

The model picker and multi-model fallback feature is disabled by default. Start the backend with `--enable-model-picker` and set `OPENAI_MODELS` to a comma-separated list to populate the frontend picker and backend fallback order. For each generation, follow-up, or repair run, the backend tries the selected model first and falls back through the remaining configured entries if a model request fails.

**YOLO mode** skips the backend validation harness (ESLint + Vitest) for faster generation. It is enabled by default on the backend, which exposes a checkbox in the UI. Pass `--disable-yolo-mode` to hide YOLO mode. When used, the UI warns that output may be unsafe, broken, or fail in the preview. Repair flows still run validation.

### Backend CLI flags

CLI flags override environment variables when starting the backend (`npm run dev -w backend -- …` or `npm start -w backend -- …`):

| Flag | Effect |
| --- | --- |
| `--api-key <key>` | Sets `OPENAI_API_KEY` |
| `--base-url <url>` | Sets `OPENAI_BASE_URL` |
| `--model <name>` | Sets `OPENAI_MODEL` |
| `--enable-model-picker` | Enables the frontend model picker and multi-model fallback |
| `--disable-model-picker` | Disables the model picker |
| `--enable-yolo-mode` | Enables YOLO mode (default) |
| `--disable-yolo-mode` | Disables YOLO mode and hides the UI checkbox |
| `--host <host>` | Sets `HOST` |
| `--port <port>` | Sets `PORT` |

## API

**Auth:** Most routes below require a session cookie from `POST /api/auth/login` (verified email). Exceptions: `/api/health`, `/api/auth/register`, `/api/auth/login`, `/api/auth/verify-email`, `/api/auth/resend-verification`, `/api/auth/me`, public `/h/:slug` hosting, and read-only `/api/projects/manage/:editToken`.

### Health

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | No | Health check (`{ "ok": true }`) |

### Authentication and dashboard

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/auth/me` | Optional | Current session: `{ authenticated, user? }` |
| `POST` | `/api/auth/register` | No | `{ username, password, email? }` → `{ user, verificationToken? }` |
| `POST` | `/api/auth/login` | No | Sets `prism0_session` cookie; returns `{ user }` |
| `POST` | `/api/auth/logout` | Yes | Clears session |
| `POST` | `/api/auth/verify-email` | No | Body `{ token }` — verify email |
| `POST` | `/api/auth/resend-verification` | No | `{ username, password }` |
| `PATCH` | `/api/auth/profile` | Yes | `{ displayName }` |
| `POST` | `/api/auth/change-email` | Yes | `{ email, password }` |
| `POST` | `/api/auth/change-password` | Yes | `{ currentPassword, newPassword }` |
| `DELETE` | `/api/auth/account` | Yes | `{ password }` |
| `GET` | `/api/dashboard` | Yes | Projects, history, token summary |

### Generation (authenticated)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/models` | Model picker state: `enabled`, `defaultModel`, `models`, `yoloModeEnabled` |
| `POST` | `/api/generate` | Start generation. Body: `{ idea, model?, yolo?, projectId? }` → `{ runId }` |
| `POST` | `/api/generate/:runId/follow-up` | Update app. Body: `{ prompt, model?, yolo?, projectId? }` |
| `POST` | `/api/generate/:runId/fix` | Runtime repair. Body: `{ error, model? }` |
| `POST` | `/api/generate/:runId/validation-fix` | Validation repair. Body: `{ error, model? }` |
| `POST` | `/api/generate/:runId/stop` | Stop an in-progress run |
| `POST` | `/api/generate/:runId/pause` | Pause an in-progress run |
| `POST` | `/api/generate/:runId/resume` | Resume a paused run |
| `GET` | `/api/generate/:runId/events` | SSE: `log`, `stream`, `usage`, `done`, `error` |
| `GET` | `/api/project/:runId/download` | Download generated project as ZIP |

### Hosted projects

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | Yes | List user's hosted projects |
| `POST` | `/api/projects` | Yes | Publish: `{ runId, name }` |
| `GET` | `/api/projects/:projectId` | Yes | Owner project detail |
| `GET` | `/api/projects/manage/:editToken` | Optional | Manage page data; `canEdit` for owner |
| `POST` | `/api/projects/:projectId/versions` | Yes | Save version from `{ runId, idea? }` |
| `POST` | `/api/projects/:projectId/revert` | Yes | `{ versionId }` |
| `DELETE` | `/api/projects/:projectId` | Yes | Delete project |
| `GET` | `/h/:slug` | No | Public hosted app |
| `GET` | `/h/:slug/*` | No | Hosted static assets |

Full request/response detail: [docs/auth-and-hosting.md](docs/auth-and-hosting.md).

Generation, follow-up, and repair `POST` routes share the same rate-limit and active-run guards (HTTP 429 / 503 when exceeded).

## Development

From the repo root:

| Script | Description |
| --- | --- |
| `npm run dev` | Start backend (8787) and frontend dev server (5173) together |
| `npm run dev -w backend` | Backend only |
| `npm run dev -w frontend` | Frontend only (proxies `/api` to backend) |
| `npm run build` | Build frontend and compile backend |
| `npm start` | Run production server (requires `npm run build` first) |
| `npm run prod` | `build` then `start` |
| `npm run deploy:prod` | `./scripts/production.sh` — install, build, start |
| `npm run bootstrap` | `./scripts/bootstrap.sh` — locked install + validation CLIs |
| `npm test` | Vitest in both workspaces (100% coverage enforced) |
| `npm run lint` | ESLint in both workspaces |
| `npm run typecheck` | TypeScript checks in both workspaces |
| `npm run audit` | npm audit for root and validation-harness dependencies |

Tests mock the LLM; no real API key is required for `npm test`.

## Run in dev

```bash
export OPENAI_API_KEY="your-key"
npm run dev
```

- Frontend: `http://localhost:5173` (proxies `/api` and `/h` to backend)
- Backend: `http://localhost:8787`
- Generator (after login): `http://localhost:5173/app`

You can also pass CLI flags to the backend dev process:

```bash
npm run dev -w backend -- --api-key "$OPENAI_API_KEY" --base-url "$OPENAI_BASE_URL" --model "nvidia/nemotron-3-ultra-550b-a55b" --enable-model-picker --host "127.0.0.1" --port 8787
```

## Production build

The production deployment is a single Node process: build the frontend, compile the backend, then run the backend. The backend serves `frontend/dist` and all `/api` routes.

```bash
export OPENAI_API_KEY="your-key"
npm run build
npm start
```

For a one-command deployment script that installs exact dependencies, builds, and starts the app:

```bash
export OPENAI_API_KEY="your-key"
./scripts/production.sh
```

Set `SKIP_INSTALL=1` if your deployment platform already ran `npm ci`.

Health check:

```bash
curl -f http://localhost:8787/api/health
```

### Docker

Build and run the production image:

```bash
docker build -t prism0 .
docker run --rm -p 8787:8787 \
  -e OPENAI_API_KEY="your-key" \
  -e APP_BASE_URL="http://localhost:8787" \
  -v prism0-data:/app/data \
  prism0
```

The image exposes port `8787` by default and includes a healthcheck for `/api/health`. Inject secrets with environment variables; do not bake them into the image. Mount a volume at `/app/data` (or set `DATABASE_PATH`) so SQLite user and project data survives container restarts. The runtime image includes a compiled `better-sqlite3` native module (built in the Docker build stage).

#### Run with Ollama in Docker

Use `scripts/ollama-docker.sh` to run **Ollama** and **prism0** in separate containers on a shared Docker network. prism0 talks to Ollama’s OpenAI-compatible API; the web UI is published on the host.

Requirements:

- Docker
- For GPU inference: NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

Quick start (CPU inference):

```bash
./scripts/ollama-docker.sh start
```

Open **http://localhost:8787**. The first run pulls the latest `ghcr.io/brianlechthaler/prism0` image and the default coding model (`qwen2.5-coder:32b`), which can take several minutes. If the pull fails (for example `denied` from stale `ghcr.io` credentials), the script automatically builds from the local repo when run inside a clone.

Enable GPU acceleration on a 24 GiB card (for example RTX 3090/4090):

```bash
./scripts/ollama-docker.sh start --gpu
# or: OLLAMA_GPU=all ./scripts/ollama-docker.sh start
```

Other commands:

```bash
./scripts/ollama-docker.sh status
./scripts/ollama-docker.sh logs          # both containers
./scripts/ollama-docker.sh logs ollama   # Ollama only
./scripts/ollama-docker.sh stop
```

Useful environment overrides:

| Variable | Default | Notes |
| --- | --- | --- |
| `OLLAMA_MODEL` | `qwen2.5-coder:32b` | ~19–20 GiB VRAM with `--gpu`; use `qwen2.5-coder:14b` on smaller GPUs |
| `OLLAMA_GPU` | `0` | Set to `all` or pass `--gpu` to enable NVIDIA GPU passthrough |
| `PRISM0_PORT` | `8787` | Host port for the web UI |
| `PRISM0_IMAGE` | `ghcr.io/brianlechthaler/prism0:latest` | Container image for the prism0 app |
| `SKIP_MODEL_PULL` | unset | Set to `1` to skip `ollama pull` when the model is already cached |
| `SKIP_IMAGE_PULL` | unset | Set to `1` to skip `docker pull` for the prism0 image |
| `PRISM0_BUILD` | unset | Set to `1` to build `PRISM0_IMAGE` from the local repo instead of pulling from GHCR |
| `PRISM0_PULL_ONLY` | unset | Set to `1` to fail instead of falling back to a local build when pull fails |

Ollama model files are stored in the Docker volume `prism0-ollama-data`. `./scripts/ollama-docker.sh stop` removes the containers but keeps that volume for faster restarts.

See `./scripts/ollama-docker.sh --help` for the full option list.

### Kubernetes and hosted platforms

Production deployment assets are included for common targets:

- Kubernetes manifests and Kustomize entrypoint: `k8s/`
- Railway Docker deployment config: `railway.json`
- Fly.io Docker deployment config: `fly.toml`
- Render Docker web service blueprint: `render.yaml`

See the full production deployment guide for shell, Docker, Kubernetes, Railway, Fly.io, and Render instructions:

```text
docs/production.md
```

Architecture, scaling, and reliability notes:

```text
docs/architecture.md
docs/auth-and-hosting.md
```

### CI, coverage, and security

GitHub Actions cover lint, tests with 100% coverage thresholds, TypeScript checks, production builds, Docker image builds, Kubernetes manifest validation, and scheduled npm vulnerability audits.

### Reverse proxy notes

- Terminate TLS at your load balancer or reverse proxy.
- Preserve streaming for `/api/generate/:runId/events`; disable response buffering and allow long read timeouts so Server-Sent Events can stay open while generation runs.
- If the app is behind a trusted proxy and you rely on proxy headers, set `TRUST_PROXY=true`.
- Leave `CORS_ORIGIN` unset for same-origin deployments. Set it to the exact frontend origin only if you split the frontend and backend across origins.
