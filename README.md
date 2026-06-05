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

## Configure the model endpoint

Backend reads configuration from env vars (or CLI flags — see below):

- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (optional, default: `https://api.openai.com/v1`)
- `OPENAI_MODEL` (optional, default: `gpt-4.1-mini`)

Example (NVIDIA NIM-style, similar to `generate.js`):

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://integrate.api.nvidia.com/v1"
export OPENAI_MODEL="nvidia/nemotron-3-ultra-550b-a55b"
```

## Run in dev

```bash
export OPENAI_API_KEY="your-key"
npm run dev
```

- Frontend: `http://localhost:5173` (proxies `/api` to backend)
- Backend: `http://localhost:8787`

You can also pass CLI flags to the backend dev process:

```bash
npm run dev -w backend -- --api-key "$OPENAI_API_KEY" --base-url "https://integrate.api.nvidia.com/v1" --model "nvidia/nemotron-3-ultra-550b-a55b"
```

## Production build

```bash
npm run build
npm start -w backend
```

## Notes

- Generated apps run in the browser using an embedded sandbox preview/editor.
- Generated code is validated server-side with ESLint + Vitest before it’s offered in the UI.

