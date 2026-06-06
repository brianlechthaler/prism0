# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

**prism0** is an npm workspaces monorepo (`backend`, `frontend`) that generates small frontend apps from text prompts. Dev runs two processes; production is a single Node process serving `frontend/dist` plus `/api` routes.

### Services

| Service | Port | Required for |
|---------|------|--------------|
| Backend (Express) | 8787 | API, SSE generation stream, health check |
| Frontend (Vite dev) | 5173 | Browser UI in development (proxies `/api` → backend) |

No database, Redis, or Docker is required for local development.

### Environment variables

`OPENAI_API_KEY` is **required** to start the backend (use any non-empty string for UI-only smoke tests; real generation needs a valid key). See `.env.example` and `README.md` for optional `OPENAI_BASE_URL`, `OPENAI_MODEL`, etc.

### Common commands (repo root)

See `package.json` scripts and `README.md` for full detail:

- Install: `npm install`
- Dev (both services): `export OPENAI_API_KEY="..." && npm run dev`
- Lint / typecheck / test: `npm run lint`, `npm run typecheck`, `npm test`
- Build / prod: `npm run build`, `npm start`
- Health: `curl -f http://localhost:8787/api/health`

### Dev workflow notes

- **Tests do not need a real API key** — the backend mocks the LLM in Vitest.
- **Automated tests enforce 100% coverage** on both workspaces; run `npm test` before pushing.
- **`validation-harness`** is installed automatically via the backend `postinstall` script; generation runs ESLint + Vitest in isolated subprocess workspaces under `backend/validation-harness/runs/`.
- **SSE**: generation progress streams on `/api/generate/:runId/events`; keep long read timeouts when testing behind a proxy.
- **Sandpack** (embedded preview) may fetch bundler assets from the public internet in the browser.

### Starting dev servers

Run both services from the repo root:

```bash
export OPENAI_API_KEY="your-key"
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8787

For backend-only or frontend-only work: `npm run dev -w backend` or `npm run dev -w frontend`.
