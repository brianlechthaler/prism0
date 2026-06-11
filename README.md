# prism0

Type an idea (e.g. “make a tetris game”), and `prism0` will:

- Ask an **OpenAI-compatible** endpoint to generate a small frontend app
- Run **lint + tests** on the generated code **on the backend**
- Show **verbose, step-by-step progress** in the UI while it works
- Let you **edit the generated code in the browser**, preview it live, and **download** it

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

Example (NVIDIA NIM-style, similar to `generate.js`):

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://integrate.api.nvidia.com/v1"
export OPENAI_MODEL="nvidia/nemotron-3-ultra-550b-a55b"
```

The model picker and multi-model fallback feature is disabled by default. Start the backend with `--enable-model-picker` and set `OPENAI_MODELS` to a comma-separated list to populate the frontend picker and backend fallback order. For each generation, follow-up, or repair run, the backend tries the selected model first and falls back through the remaining configured entries if a model request fails.

**YOLO mode** skips the backend validation harness (ESLint + Vitest) for faster generation. It is disabled by default; start the backend with `--enable-yolo-mode` to expose a checkbox in the UI. When enabled, the UI warns that output may be unsafe, broken, or fail in the preview. Repair flows still run validation.

## Run in dev

```bash
export OPENAI_API_KEY="your-key"
npm run dev
```

- Frontend: `http://localhost:5173` (proxies `/api` to backend)
- Backend: `http://localhost:8787`

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
docker run --rm -p 8787:8787 -e OPENAI_API_KEY="your-key" prism0
```

The image exposes port `8787` by default and includes a healthcheck for `/api/health`. Inject secrets with environment variables; do not bake them into the image.

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
```

### CI, coverage, and security

GitHub Actions cover lint, tests with 100% coverage thresholds, TypeScript checks, production builds, Docker image builds, Kubernetes manifest validation, and scheduled npm vulnerability audits.

### Reverse proxy notes

- Terminate TLS at your load balancer or reverse proxy.
- Preserve streaming for `/api/generate/:runId/events`; disable response buffering and allow long read timeouts so Server-Sent Events can stay open while generation runs.
- If the app is behind a trusted proxy and you rely on proxy headers, set `TRUST_PROXY=true`.
- Leave `CORS_ORIGIN` unset for same-origin deployments. Set it to the exact frontend origin only if you split the frontend and backend across origins.

## Notes

- Generated apps run in the browser using an embedded sandbox preview/editor.
- Generated code is validated server-side with ESLint + Vitest before it’s offered in the UI.

