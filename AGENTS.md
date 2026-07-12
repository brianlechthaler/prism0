# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

**prism0** is an npm workspaces monorepo (`backend`, `frontend`) that generates small frontend apps from text prompts. Login and accounts are **disabled by default**; pass `--enable-login` to the backend to turn on register/login flows. The generator lives at `/app`. Published apps are served at `/h/:slug`. Dev runs two processes; production is a single Node process serving `frontend/dist`, `/api` routes, and hosted projects.

### Services

| Service | Port | Required for |
|---------|------|--------------|
| Backend (Express) | 8787 | API, SSE generation stream, health check |
| Frontend (Vite dev) | 5173 | Browser UI in development (proxies `/api` and `/h` → backend) |

SQLite (`DATABASE_PATH`, default `./data/prism0.db`) is created automatically on first backend start. No Redis or Docker is required for local development.

Auth/hosting detail: `docs/auth-and-hosting.md`.

### Environment variables

`OPENAI_API_KEY` is **required** to start the backend (use any non-empty string for UI-only smoke tests; real generation needs a valid key). See `.env.example` and `README.md` for optional `OPENAI_BASE_URL`, `OPENAI_MODEL`, `DATABASE_PATH`, `APP_BASE_URL`, etc. For local auth testing without reading server logs, `AUTH_EXPOSE_VERIFICATION_TOKEN=true` returns verification tokens in API responses.

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
- **OpenCode config is embedded** — prism0 passes a standalone OpenCode provider config at runtime (custom `llm` provider with `@ai-sdk/openai-compatible` + model registry from `OPENAI_MODEL` / `OPENAI_MODELS`). No manual `~/.config/opencode/opencode.json` edits are required for Ollama or other OpenAI-compatible endpoints.
- **SSE**: generation progress streams on `/api/generate/:runId/events`; keep long read timeouts when testing behind a proxy.
- **Sandpack** (embedded preview) may fetch bundler assets from the public internet in the browser.

### Starting dev servers

Run both services from the repo root:

```bash
export OPENAI_API_KEY="your-key"
npm run dev
```

- Frontend: http://localhost:5173 (splash; login/register UI only when backend runs with `--enable-login`)
- Generator: http://localhost:5173/app (works without login by default)
- Backend: http://localhost:8787

For backend-only or frontend-only work: `npm run dev -w backend` or `npm run dev -w frontend`. Enable accounts with `npm run dev -w backend -- --enable-login`.
