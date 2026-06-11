#!/usr/bin/env bash
set -euo pipefail

# Run Ollama and prism0 in separate Docker containers on a shared network.
# prism0 talks to Ollama's OpenAI-compatible API; the web UI is exposed on the host.

readonly NETWORK_NAME="${NETWORK_NAME:-prism0-ollama-net}"
readonly OLLAMA_CONTAINER="${OLLAMA_CONTAINER:-prism0-ollama}"
readonly PRISM0_CONTAINER="${PRISM0_CONTAINER:-prism0-app}"
readonly OLLAMA_VOLUME="${OLLAMA_VOLUME:-prism0-ollama-data}"
readonly OLLAMA_IMAGE="${OLLAMA_IMAGE:-ollama/ollama:latest}"
readonly PRISM0_IMAGE="${PRISM0_IMAGE:-prism0:local}"
readonly OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
readonly PRISM0_PORT="${PRISM0_PORT:-8787}"
readonly OLLAMA_PORT="${OLLAMA_PORT:-11434}"
readonly OPENAI_API_KEY="${OPENAI_API_KEY:-ollama}"
readonly REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-600000}"
readonly OPENAI_CONTEXT_WINDOW="${OPENAI_CONTEXT_WINDOW:-32768}"

usage() {
  cat <<'EOF'
Usage: ./scripts/ollama-docker.sh [start|stop|status|logs]

Run prism0 against Ollama in Docker. The web UI is published on the host at
http://localhost:8787 by default.

Commands:
  start   Build the prism0 image if needed, start Ollama, pull the model, start prism0.
  stop    Stop and remove the prism0 and Ollama containers (keeps the Ollama model volume).
  status  Show container status and recent health.
  logs    Follow logs from both containers (optional: ollama|prism0|all).

Environment overrides:
  OLLAMA_MODEL            Coding model to pull and use (default: qwen2.5-coder:7b)
  PRISM0_PORT             Host port for the prism0 web UI (default: 8787)
  OLLAMA_PORT             Host port for the Ollama API (default: 11434)
  PRISM0_IMAGE            Local prism0 image tag (default: prism0:local)
  REQUEST_TIMEOUT_MS      Upstream timeout for slow local models (default: 600000)
  OPENAI_CONTEXT_WINDOW   UI context bar size (default: 32768)
  REBUILD=1               Force rebuild of the prism0 image on start
  SKIP_MODEL_PULL=1       Skip "ollama pull" if the model is already cached

Examples:
  ./scripts/ollama-docker.sh start
  OLLAMA_MODEL=deepseek-coder-v2:16b PRISM0_PORT=8080 ./scripts/ollama-docker.sh start
  ./scripts/ollama-docker.sh stop
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required but was not found in PATH." >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not reachable. Start Docker and try again." >&2
    exit 1
  fi
}

ensure_network() {
  if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    docker network create "$NETWORK_NAME" >/dev/null
    echo "Created Docker network: $NETWORK_NAME"
  fi
}

container_running() {
  local name="$1"
  docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -qx true
}

remove_container_if_exists() {
  local name="$1"
  if docker container inspect "$name" >/dev/null 2>&1; then
    docker rm -f "$name" >/dev/null
  fi
}

wait_for_ollama() {
  echo "Waiting for Ollama to become ready..."
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$OLLAMA_CONTAINER" ollama list >/dev/null 2>&1; then
      echo "Ollama is ready."
      return 0
    fi

    if ! container_running "$OLLAMA_CONTAINER"; then
      echo "Ollama container exited before becoming ready." >&2
      docker logs "$OLLAMA_CONTAINER" >&2 || true
      exit 1
    fi

    sleep 2
  done

  echo "Timed out waiting for Ollama." >&2
  docker logs "$OLLAMA_CONTAINER" >&2 || true
  exit 1
}

pull_model() {
  if [[ "${SKIP_MODEL_PULL:-0}" == "1" ]]; then
    echo "Skipping model pull (SKIP_MODEL_PULL=1)."
    return 0
  fi

  echo "Pulling Ollama model: $OLLAMA_MODEL (this can take several minutes)..."
  docker exec "$OLLAMA_CONTAINER" ollama pull "$OLLAMA_MODEL"
}

build_prism0_image() {
  if [[ "${REBUILD:-0}" != "1" ]] && docker image inspect "$PRISM0_IMAGE" >/dev/null 2>&1; then
    echo "Using existing prism0 image: $PRISM0_IMAGE"
    return 0
  fi

  echo "Building prism0 image: $PRISM0_IMAGE"
  docker build -t "$PRISM0_IMAGE" .
}

start_ollama() {
  ensure_network

  if container_running "$OLLAMA_CONTAINER"; then
    echo "Ollama container already running: $OLLAMA_CONTAINER"
    return 0
  fi

  remove_container_if_exists "$OLLAMA_CONTAINER"

  echo "Starting Ollama container: $OLLAMA_CONTAINER"
  docker run -d \
    --name "$OLLAMA_CONTAINER" \
    --network "$NETWORK_NAME" \
    --network-alias ollama \
    -v "${OLLAMA_VOLUME}:/root/.ollama" \
    -p "${OLLAMA_PORT}:11434" \
    "$OLLAMA_IMAGE" >/dev/null

  wait_for_ollama
  pull_model
}

start_prism0() {
  if container_running "$PRISM0_CONTAINER"; then
    echo "prism0 container already running: $PRISM0_CONTAINER"
    print_access_info
    return 0
  fi

  remove_container_if_exists "$PRISM0_CONTAINER"
  build_prism0_image

  echo "Starting prism0 container: $PRISM0_CONTAINER"
  docker run -d \
    --name "$PRISM0_CONTAINER" \
    --network "$NETWORK_NAME" \
    -p "${PRISM0_PORT}:8787" \
    -e "OPENAI_API_KEY=${OPENAI_API_KEY}" \
    -e "OPENAI_BASE_URL=http://ollama:11434/v1" \
    -e "OPENAI_MODEL=${OLLAMA_MODEL}" \
    -e "REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS}" \
    -e "OPENAI_CONTEXT_WINDOW=${OPENAI_CONTEXT_WINDOW}" \
    -e "HOST=0.0.0.0" \
    -e "PORT=8787" \
    "$PRISM0_IMAGE" >/dev/null

  wait_for_prism0
  print_access_info
}

prism0_health_check() {
  docker exec "$PRISM0_CONTAINER" node -e \
    "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
    >/dev/null 2>&1
}

wait_for_prism0() {
  echo "Waiting for prism0 health check..."
  local attempt
  for attempt in $(seq 1 60); do
    if prism0_health_check; then
      echo "prism0 is ready."
      return 0
    fi

    if ! container_running "$PRISM0_CONTAINER"; then
      echo "prism0 container exited before becoming healthy." >&2
      docker logs "$PRISM0_CONTAINER" >&2 || true
      exit 1
    fi

    sleep 2
  done

  echo "Timed out waiting for prism0." >&2
  docker logs "$PRISM0_CONTAINER" >&2 || true
  exit 1
}

print_access_info() {
  cat <<EOF

prism0 web UI:  http://localhost:${PRISM0_PORT}
Health check:   http://localhost:${PRISM0_PORT}/api/health
Ollama API:     http://localhost:${OLLAMA_PORT}
Model:          ${OLLAMA_MODEL}

View logs:      ./scripts/ollama-docker.sh logs
Stop stack:     ./scripts/ollama-docker.sh stop
EOF
}

cmd_start() {
  require_docker
  start_ollama
  start_prism0
}

cmd_stop() {
  require_docker
  remove_container_if_exists "$PRISM0_CONTAINER"
  remove_container_if_exists "$OLLAMA_CONTAINER"
  echo "Stopped prism0 and Ollama containers."
  echo "Model cache volume preserved: ${OLLAMA_VOLUME}"
}

cmd_status() {
  require_docker

  for name in "$OLLAMA_CONTAINER" "$PRISM0_CONTAINER"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      docker ps --filter "name=^/${name}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    else
      echo "${name}: not created"
    fi
  done

  if container_running "$PRISM0_CONTAINER" && prism0_health_check; then
    echo "${PRISM0_CONTAINER}: healthy"
  elif container_running "$PRISM0_CONTAINER"; then
    echo "${PRISM0_CONTAINER}: running but not healthy yet"
  fi
}

cmd_logs() {
  require_docker

  if ! docker container inspect "$OLLAMA_CONTAINER" >/dev/null 2>&1 \
    && ! docker container inspect "$PRISM0_CONTAINER" >/dev/null 2>&1; then
    echo "No containers found. Start them with:" >&2
    echo "  ./scripts/ollama-docker.sh start" >&2
    exit 1
  fi

  local target="${1:-all}"
  case "$target" in
    ollama)
      docker logs -f "$OLLAMA_CONTAINER"
      ;;
    prism0)
      docker logs -f "$PRISM0_CONTAINER"
      ;;
    all)
      docker logs -f "$OLLAMA_CONTAINER" 2>&1 | sed -u "s/^/[ollama] /" &
      local ollama_pid=$!
      trap 'kill "$ollama_pid" 2>/dev/null || true' EXIT INT TERM
      docker logs -f "$PRISM0_CONTAINER" 2>&1 | sed -u "s/^/[prism0] /"
      ;;
    *)
      echo "Unknown logs target: $target (use ollama, prism0, or all)" >&2
      exit 1
      ;;
  esac
}

main() {
  local command="${1:-start}"

  case "$command" in
    start)
      cmd_start
      ;;
    stop)
      cmd_stop
      ;;
    status)
      cmd_status
      ;;
    logs)
      cmd_logs "${2:-all}"
      ;;
    -h | --help | help)
      usage
      ;;
    *)
      echo "Unknown command: $command" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
