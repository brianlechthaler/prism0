#!/usr/bin/env bash
set -euo pipefail

# Run Ollama and prism0 in separate Docker containers on a shared network.
# prism0 talks to Ollama's OpenAI-compatible API; the web UI is exposed on the host.

readonly NETWORK_NAME="${NETWORK_NAME:-prism0-ollama-net}"
readonly OLLAMA_CONTAINER="${OLLAMA_CONTAINER:-prism0-ollama}"
readonly PRISM0_CONTAINER="${PRISM0_CONTAINER:-prism0-app}"
readonly OLLAMA_VOLUME="${OLLAMA_VOLUME:-prism0-ollama-data}"
readonly OLLAMA_IMAGE="${OLLAMA_IMAGE:-ollama/ollama:latest}"
readonly PRISM0_IMAGE="${PRISM0_IMAGE:-ghcr.io/brianlechthaler/prism0:latest}"
readonly OLLAMA_CPU_MODEL_DEFAULT="qwen2.5-coder:7b"
readonly OLLAMA_GPU_MODEL_DEFAULT="qwen2.5-coder:32b"
OLLAMA_MODEL="${OLLAMA_MODEL:-}"
OLLAMA_GPU="${OLLAMA_GPU:-all}"
readonly PRISM0_PORT="${PRISM0_PORT:-8787}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
readonly OPENAI_API_KEY="${OPENAI_API_KEY:-ollama}"
readonly REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-600000}"
readonly OPENAI_CONTEXT_WINDOW="${OPENAI_CONTEXT_WINDOW:-32768}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

usage() {
  cat <<'EOF'
Usage: ./scripts/ollama-docker.sh [--cpu] [start|stop|status|logs]

Run prism0 against Ollama in Docker. The web UI is published on the host at
http://localhost:8787 by default. GPU acceleration is enabled by default.

Commands:
  start   Pull the prism0 image, start Ollama, pull the model, start prism0.
  stop    Stop and remove the prism0 and Ollama containers (keeps the Ollama model volume).
  status  Show container status and recent health.
  logs    Follow logs from both containers (optional: ollama|prism0|all).

Flags:
  --cpu   Disable GPU passthrough and use CPU inference (equivalent to OLLAMA_GPU=0)

Environment overrides:
  OLLAMA_MODEL            Coding model to pull and use (default: qwen2.5-coder:32b with GPU, qwen2.5-coder:7b on CPU)
  OLLAMA_GPU              GPU devices for Ollama (default: all; use 0 or none for CPU-only)
  OLLAMA_ENABLE_GPU       Set to 1 to enable GPU passthrough when OLLAMA_GPU=0 (same as OLLAMA_GPU=all)
  PRISM0_PORT             Host port for the prism0 web UI (default: 8787)
  OLLAMA_PORT             Host port for the Ollama API (default: 11434; auto-falls back to 11435 if 11434 is taken)
  PRISM0_IMAGE            prism0 image to run (default: ghcr.io/brianlechthaler/prism0:latest)
  REQUEST_TIMEOUT_MS      Upstream timeout for slow local models (default: 600000)
  OPENAI_CONTEXT_WINDOW   UI context bar size (default: 32768)
  PRISM0_BUILD=1          Build PRISM0_IMAGE from the local repo instead of pulling
  PRISM0_PULL_ONLY=1      Fail instead of falling back to a local build when pull fails
  SKIP_IMAGE_PULL=1       Skip "docker pull" for the prism0 image (use a preloaded tag)
  SKIP_MODEL_PULL=1       Skip "ollama pull" if the model is already cached

The default model targets a 24 GiB GPU (for example RTX 3090/4090). Smaller cards may
need a lighter model; 40+ GiB cards can use a larger one.

Examples:
  ./scripts/ollama-docker.sh start
  ./scripts/ollama-docker.sh start --cpu
  OLLAMA_GPU=0 ./scripts/ollama-docker.sh start
  OLLAMA_MODEL=qwen2.5-coder:14b PRISM0_PORT=8080 ./scripts/ollama-docker.sh start
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

resolve_gpu_settings() {
  if [[ "${OLLAMA_ENABLE_GPU:-0}" == "1" && "$OLLAMA_GPU" == "0" ]]; then
    OLLAMA_GPU=all
  fi
}

parse_global_flags() {
  local -a remaining=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cpu)
        OLLAMA_GPU=0
        shift
        ;;
      --gpu)
        OLLAMA_GPU=all
        shift
        ;;
      -h | --help | help)
        remaining+=("$1")
        shift
        ;;
      *)
        remaining+=("$1")
        shift
        ;;
    esac
  done

  if ((${#remaining[@]})); then
    printf '%s\n' "${remaining[@]}"
  fi
}

gpu_enabled() {
  [[ "$OLLAMA_GPU" != "0" && "$OLLAMA_GPU" != "none" ]]
}

host_port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :${port}" 2>/dev/null | grep -q .
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$"
    return
  fi

  return 1
}

host_port_owner_container() {
  local port="$1"
  docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
    | awk -v port=":${port}->" '$0 ~ port { print $1; exit }'
}

resolve_ollama_port() {
  if host_port_in_use "$OLLAMA_PORT"; then
    local owner=""
    owner="$(host_port_owner_container "$OLLAMA_PORT" | head -n1 || true)"
    if [[ -n "$owner" && "$owner" != "$OLLAMA_CONTAINER" ]]; then
      if [[ "$OLLAMA_PORT" == "11434" ]]; then
        echo "Host port 11434 is in use by container: ${owner}" >&2
        echo "Using host port 11435 for ${OLLAMA_CONTAINER} (prism0 still uses http://ollama:11434 on the Docker network)." >&2
        OLLAMA_PORT=11435
      else
        echo "Host port ${OLLAMA_PORT} is already in use by container: ${owner}" >&2
        echo "Stop the conflicting container or set OLLAMA_PORT to a free port." >&2
        exit 1
      fi
    fi
  fi
}

verify_gpu_available() {
  if ! gpu_enabled; then
    return 0
  fi

  if ! docker info 2>/dev/null | grep -qi nvidia; then
    cat >&2 <<EOF
ERROR: GPU acceleration is required by default but Docker does not report NVIDIA GPU support.
Install the NVIDIA Container Toolkit:
  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html
Or pass --cpu / OLLAMA_GPU=0 to opt into CPU-only inference.
EOF
    exit 1
  fi

  echo "Running GPU preflight check (docker run --gpus ${OLLAMA_GPU})..."
  if ! docker run --rm --gpus "$OLLAMA_GPU" nvidia/cuda:12.0.0-base-ubuntu22.04 \
    nvidia-smi --query-gpu=name --format=csv,noheader >/dev/null 2>&1; then
    echo "ERROR: GPU preflight check failed. Verify NVIDIA drivers and Container Toolkit." >&2
    exit 1
  fi

  docker run --rm --gpus "$OLLAMA_GPU" nvidia/cuda:12.0.0-base-ubuntu22.04 \
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
}

ollama_container_has_gpu_passthrough() {
  local device_requests=""
  device_requests="$(docker inspect "$OLLAMA_CONTAINER" --format '{{json .HostConfig.DeviceRequests}}' 2>/dev/null || true)"
  [[ -n "$device_requests" && "$device_requests" != "null" && "$device_requests" != "[]" ]]
}

ollama_container_needs_recreate() {
  if ! container_running "$OLLAMA_CONTAINER"; then
    return 1
  fi

  local has_gpu="false"
  if ollama_container_has_gpu_passthrough; then
    has_gpu="true"
  fi

  if gpu_enabled && [[ "$has_gpu" == "false" ]]; then
    echo "Recreating ${OLLAMA_CONTAINER}: running without GPU passthrough but GPU is required." >&2
    return 0
  fi

  if ! gpu_enabled && [[ "$has_gpu" == "true" ]]; then
    echo "Recreating ${OLLAMA_CONTAINER}: GPU passthrough enabled but --cpu was requested." >&2
    return 0
  fi

  return 1
}

verify_ollama_gpu_passthrough() {
  if ! gpu_enabled; then
    return 0
  fi

  if ! ollama_container_has_gpu_passthrough; then
    echo "ERROR: ${OLLAMA_CONTAINER} is running without --gpus despite GPU being enabled." >&2
    exit 1
  fi

  echo "GPU passthrough verified on ${OLLAMA_CONTAINER}."
}

verify_ollama_inference_device() {
  if ! gpu_enabled; then
    return 0
  fi

  echo "Verifying model inference device (warming ${OLLAMA_MODEL})..."
  docker exec "$OLLAMA_CONTAINER" ollama run "$OLLAMA_MODEL" "Reply with exactly: OK" >/dev/null 2>&1 || true

  local ps_line=""
  ps_line="$(docker exec "$OLLAMA_CONTAINER" ollama ps 2>/dev/null | awk 'NR==2' || true)"
  if [[ "$ps_line" == *"100% CPU"* ]]; then
    echo "ERROR: ${OLLAMA_MODEL} is running on CPU only (${ps_line}). GPU inference is required." >&2
    docker exec "$OLLAMA_CONTAINER" ollama ps >&2 || true
    exit 1
  fi

  echo "Inference device verified: ${ps_line}"
  docker exec "$OLLAMA_CONTAINER" ollama ps 2>/dev/null || true
}

resolve_model_settings() {
  if [[ -n "$OLLAMA_MODEL" ]]; then
    return 0
  fi

  if gpu_enabled; then
    OLLAMA_MODEL="$OLLAMA_GPU_MODEL_DEFAULT"
  else
    OLLAMA_MODEL="$OLLAMA_CPU_MODEL_DEFAULT"
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
  for _ in $(seq 1 60); do
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

local_repo_available() {
  [[ -f "${REPO_ROOT}/Dockerfile" && -f "${REPO_ROOT}/package.json" ]]
}

build_prism0_image() {
  echo "Building prism0 image from local repo: $PRISM0_IMAGE"
  docker build -t "$PRISM0_IMAGE" "$REPO_ROOT"
}

print_pull_failure_help() {
  cat >&2 <<EOF
Failed to pull prism0 image: $PRISM0_IMAGE

If the GHCR package is public, stale Docker credentials for ghcr.io often cause
"denied" errors. Clear them and retry:

  docker logout ghcr.io
  ./scripts/ollama-docker.sh start

Or build from a local clone instead:

  PRISM0_BUILD=1 ./scripts/ollama-docker.sh start
EOF
}

ensure_prism0_image() {
  if [[ "${PRISM0_BUILD:-0}" == "1" ]]; then
    build_prism0_image
    return 0
  fi

  if [[ "${SKIP_IMAGE_PULL:-0}" == "1" ]]; then
    if docker image inspect "$PRISM0_IMAGE" >/dev/null 2>&1; then
      echo "Using existing prism0 image: $PRISM0_IMAGE (SKIP_IMAGE_PULL=1)"
      return 0
    fi

    echo "prism0 image not found locally: $PRISM0_IMAGE (SKIP_IMAGE_PULL=1)" >&2
    exit 1
  fi

  echo "Pulling latest prism0 image: $PRISM0_IMAGE"
  local pull_output=""
  if pull_output="$(docker pull "$PRISM0_IMAGE" 2>&1)"; then
    printf '%s\n' "$pull_output"
    return 0
  fi

  printf '%s\n' "$pull_output" >&2

  if [[ "${PRISM0_PULL_ONLY:-0}" == "1" ]]; then
    print_pull_failure_help
    exit 1
  fi

  if local_repo_available; then
    echo "Could not pull $PRISM0_IMAGE; building from local repo instead." >&2
    build_prism0_image
    return 0
  fi

  print_pull_failure_help
  exit 1
}

start_ollama() {
  ensure_network
  resolve_ollama_port
  verify_gpu_available

  if container_running "$OLLAMA_CONTAINER"; then
    if ollama_container_needs_recreate; then
      remove_container_if_exists "$OLLAMA_CONTAINER"
    else
      echo "Ollama container already running: $OLLAMA_CONTAINER"
      verify_ollama_gpu_passthrough
      return 0
    fi
  else
    remove_container_if_exists "$OLLAMA_CONTAINER"
  fi

  local -a gpu_args=()
  if gpu_enabled; then
    gpu_args=(--gpus "$OLLAMA_GPU")
    echo "GPU acceleration enabled (OLLAMA_GPU=${OLLAMA_GPU})."
  else
    echo "GPU acceleration disabled (CPU inference)."
  fi

  echo "Starting Ollama container: $OLLAMA_CONTAINER (model: $OLLAMA_MODEL, host port: ${OLLAMA_PORT})"
  docker run -d \
    --name "$OLLAMA_CONTAINER" \
    "${gpu_args[@]}" \
    --network "$NETWORK_NAME" \
    --network-alias ollama \
    -v "${OLLAMA_VOLUME}:/root/.ollama" \
    -p "${OLLAMA_PORT}:11434" \
    "$OLLAMA_IMAGE" >/dev/null

  wait_for_ollama
  verify_ollama_gpu_passthrough
  pull_model
  verify_ollama_inference_device
}

prism0_container_needs_recreate() {
  if ! container_running "$PRISM0_CONTAINER"; then
    return 1
  fi

  local current_model current_base_url
  current_model="$(docker exec "$PRISM0_CONTAINER" printenv OPENAI_MODEL 2>/dev/null || true)"
  current_base_url="$(docker exec "$PRISM0_CONTAINER" printenv OPENAI_BASE_URL 2>/dev/null || true)"

  if [[ "$current_model" != "$OLLAMA_MODEL" || "$current_base_url" != "http://ollama:11434/v1" ]]; then
    echo "Recreating ${PRISM0_CONTAINER}: model or Ollama URL changed." >&2
    return 0
  fi

  return 1
}

start_prism0() {
  if container_running "$PRISM0_CONTAINER"; then
    if prism0_container_needs_recreate; then
      remove_container_if_exists "$PRISM0_CONTAINER"
    else
      echo "prism0 container already running: $PRISM0_CONTAINER"
      print_access_info
      return 0
    fi
  else
    remove_container_if_exists "$PRISM0_CONTAINER"
  fi
  ensure_prism0_image

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
  for _ in $(seq 1 60); do
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
  local gpu_note="GPU: disabled (CPU inference; GPU is enabled by default)"
  if gpu_enabled; then
    gpu_note="GPU: ${OLLAMA_GPU} (target ~24 GiB VRAM for default model)"
  fi

  cat <<EOF

prism0 web UI:  http://localhost:${PRISM0_PORT}
Health check:   http://localhost:${PRISM0_PORT}/api/health
Ollama API:     http://localhost:${OLLAMA_PORT}
Model:          ${OLLAMA_MODEL}
${gpu_note}

View logs:      ./scripts/ollama-docker.sh logs
Stop stack:     ./scripts/ollama-docker.sh stop
EOF
}

cmd_start() {
  require_docker
  resolve_gpu_settings
  resolve_model_settings
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

  if container_running "$OLLAMA_CONTAINER"; then
    if ollama_container_has_gpu_passthrough; then
      echo "${OLLAMA_CONTAINER}: GPU passthrough enabled"
    else
      echo "${OLLAMA_CONTAINER}: CPU-only (no --gpus)"
    fi
    docker exec "$OLLAMA_CONTAINER" ollama ps 2>/dev/null || true
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
  local -a args=()
  if ((${#@})); then
    mapfile -t args < <(parse_global_flags "$@")
  fi

  local command="${args[0]:-start}"

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
      cmd_logs "${args[1]:-all}"
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
