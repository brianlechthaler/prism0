# Production deployment guide

This guide describes how to build, run, and operate prism0 in production.

prism0 deploys as one Node.js service:

1. Vite builds the frontend into `frontend/dist`.
2. TypeScript compiles the backend into `backend/dist`.
3. The backend serves `/api/*` plus the static frontend bundle.
4. Generated apps are validated in `backend/validation-harness/runs`.

## Required runtime configuration

Set secrets in the deployment platform, not in source control or container images.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes | none | API key for the OpenAI-compatible endpoint. |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | Use this for NVIDIA NIM or another compatible endpoint. |
| `OPENAI_MODEL` | No | `gpt-4.1-mini` | Model used for generation and repair. |
| `HOST` | No | `0.0.0.0` | Bind address inside the container or VM. |
| `PORT` | No | `8787` | HTTP port. |
| `REQUEST_TIMEOUT_MS` | No | `120000` | Initial upstream API request timeout. |
| `MAX_RUNS` | No | `100` | Maximum retained completed/failed run records per process. |
| `CORS_ORIGIN` | No | unset | Set only when frontend and API are on different origins. |
| `TRUST_PROXY` | No | `false` | Set to `true` behind trusted platform/load balancer proxies. |

## Verify before deploying

Run the same checks used by CI:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The backend and frontend Vitest configs enforce 100% line, function, branch, and statement coverage for source files.

## Run in a shell

Use this on a VM, bare-metal server, or platform that runs shell commands directly.

```bash
export OPENAI_API_KEY="your-key"
export NODE_ENV=production
export HOST=0.0.0.0
export PORT=8787

npm ci
npm run build
npm start
```

Or use the included production script:

```bash
export OPENAI_API_KEY="your-key"
./scripts/production.sh
```

If the platform already ran `npm ci`, set `SKIP_INSTALL=1`.

Health check:

```bash
curl -f http://127.0.0.1:8787/api/health
```

## Run with Docker

Build and run locally:

```bash
docker build -t prism0 .
docker run --rm \
  -p 8787:8787 \
  -e OPENAI_API_KEY="your-key" \
  prism0
```

The image:

- Builds frontend and backend artifacts in a separate build stage.
- Runs only the production backend command in the runtime stage.
- Uses the image health check at `/api/health`.
- Runs as the non-root `node` user.
- Keeps the validation harness writable for generated project checks.

Publish an image for production:

```bash
docker build -t ghcr.io/OWNER/prism0:VERSION .
docker push ghcr.io/OWNER/prism0:VERSION
```

Use immutable tags or digests in production manifests.

## Deploy to Kubernetes

Kubernetes manifests live in `k8s/` and are rendered with Kustomize.

Default resources:

- Namespace: `prism0`
- ConfigMap: non-secret runtime settings
- Deployment: one replica, probes, resources, non-root pod security
- Service: `ClusterIP` with client-IP affinity
- Ingress: nginx-compatible annotations for Server-Sent Events

Create the secret:

```bash
kubectl create namespace prism0
kubectl -n prism0 create secret generic prism0-secrets \
  --from-literal=OPENAI_API_KEY="your-key"
```

Set the image tag before applying:

```bash
kubectl kustomize k8s
kubectl set image -n prism0 deployment/prism0 prism0=ghcr.io/OWNER/prism0:VERSION --local -o yaml -f k8s/deployment.yaml
```

A straightforward deployment path is:

```bash
kubectl apply -k k8s
kubectl -n prism0 rollout status deployment/prism0
kubectl -n prism0 get pods,svc,ingress
```

Update `k8s/ingress.yaml` before production:

- Replace `prism0.example.com` with the real host.
- Configure TLS with cert-manager or your ingress controller.
- Keep proxy buffering disabled for `/api/generate/:runId/events`.
- Keep long proxy read/send timeouts so model generation streams do not disconnect.

### Kubernetes scaling

The current run store is process-local. The default manifest uses one replica to keep generate, SSE, repair, and download requests on the same process.

To scale horizontally, use one of these approaches:

1. Enable sticky routing from the ingress/load balancer through the service so one client stays on one pod for a full run.
2. Externalize run state and pub/sub to a shared store such as Redis, then raise Deployment replicas and apply `k8s/hpa.yaml`.

The optional HPA is not included in `k8s/kustomization.yaml` by default. Apply it only after the routing/state requirement above is handled:

```bash
kubectl apply -f k8s/hpa.yaml
```

## Deploy to Railway

`railway.json` configures Railway to build with the repository Dockerfile and check `/api/health`.

Steps:

1. Create a Railway project from the GitHub repository.
2. Add `OPENAI_API_KEY` as a Railway variable.
3. Optionally set `OPENAI_BASE_URL`, `OPENAI_MODEL`, `MAX_RUNS`, and `TRUST_PROXY=true`.
4. Deploy from the branch.
5. Confirm the deployment health check passes and open the generated Railway URL.

Railway provides the external port and proxy. Keep `HOST=0.0.0.0`.

## Deploy to Fly.io

`fly.toml` configures Docker builds, health checks, HTTPS, one always-running machine, and conservative request concurrency.

First-time setup:

```bash
fly launch --no-deploy
fly secrets set OPENAI_API_KEY="your-key"
fly deploy
```

If you change the app name in `fly.toml`, keep it globally unique. Set additional secrets or variables as needed:

```bash
fly secrets set OPENAI_BASE_URL="https://api.openai.com/v1"
fly secrets set OPENAI_MODEL="gpt-4.1-mini"
```

Check health and logs:

```bash
fly status
fly logs
```

## Deploy to Render

`render.yaml` defines a Docker-backed web service with `/api/health` checks.

Steps:

1. Create a Blueprint from this repository, or create a Web Service and point it at the Dockerfile.
2. Add `OPENAI_API_KEY` as a secret environment variable.
3. Keep `HOST=0.0.0.0`, `PORT=8787`, and `TRUST_PROXY=true`.
4. Deploy and wait for the health check to pass.

Render terminates TLS and proxies to the container, so same-origin deployments usually do not need `CORS_ORIGIN`.

## Operations notes

- Health endpoint: `GET /api/health`.
- Logs are written to stdout/stderr for platform collection.
- Generated validation workspaces are ephemeral and safe to discard on restart.
- `MAX_RUNS` bounds retained completed/failed run metadata per process.
- Long generation requests depend on upstream model availability; tune `REQUEST_TIMEOUT_MS` and model choice for your provider.
- Keep secrets in the platform secret manager.
- Terminate TLS at the platform load balancer, ingress, or reverse proxy.
- Preserve streaming for SSE by disabling proxy buffering and allowing long read timeouts.
