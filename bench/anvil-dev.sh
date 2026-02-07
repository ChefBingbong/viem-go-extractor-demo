#!/bin/bash
#
# Anvil Dev Orchestrator
#
# Starts TWO Anvil instances (one per language) and both extractors,
# waits for health, then optionally runs a command (e.g., make k6-all).
#
# Each extractor gets its own isolated Anvil fork so there is no shared
# RPC contention or rate limiting.
#
# Usage:
#   ./bench/anvil-dev.sh                  # Interactive — Ctrl+C to stop
#   ./bench/anvil-dev.sh make k6-all      # Run k6 suites then shutdown
#
# Environment variables (all optional):
#   FORK_URL          Remote RPC to fork from   (default: https://eth.drpc.org)
#   FORK_BLOCK        Pin to a specific block    (default: latest)
#   ANVIL_PORT_TS     Anvil port for TS          (default: 8545)
#   ANVIL_PORT_GO     Anvil port for Go          (default: 8546)
#   TS_PORT           TS extractor HTTP port     (default: 8000)
#   GO_PORT           Go extractor HTTP port     (default: 8001)
#   HEALTH_TIMEOUT    Seconds to wait for health (default: 120)

set -e

# ─── Config ───────────────────────────────────────────────────────────────────

FORK_URL=${FORK_URL:-"https://eth.drpc.org"}
FORK_BLOCK=${FORK_BLOCK:-}
ANVIL_PORT_TS=${ANVIL_PORT_TS:-8545}
ANVIL_PORT_GO=${ANVIL_PORT_GO:-8546}
TS_PORT=${TS_PORT:-8000}
GO_PORT=${GO_PORT:-8001}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
ANVIL_TIMEOUT=${ANVIL_TIMEOUT:-30}

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${CYAN}[STEP]${NC} $1"; }

# ─── Preflight checks ────────────────────────────────────────────────────────

if ! command -v anvil &> /dev/null; then
    log_error "Anvil not found. Please install Foundry: https://getfoundry.sh"
    exit 1
fi

# ─── PID tracking ─────────────────────────────────────────────────────────────

ANVIL_PID_TS=""
ANVIL_PID_GO=""
EXTRACTOR_PID_TS=""
EXTRACTOR_PID_GO=""

cleanup() {
    echo ""
    log_info "Shutting down..."

    # Kill extractors first (they depend on Anvil)
    for pid_var in EXTRACTOR_PID_TS EXTRACTOR_PID_GO; do
        pid=${!pid_var}
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            log_info "  Stopping ${pid_var} (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
        fi
    done

    # Wait briefly for extractors to exit
    for pid_var in EXTRACTOR_PID_TS EXTRACTOR_PID_GO; do
        pid=${!pid_var}
        if [ -n "$pid" ]; then
            wait "$pid" 2>/dev/null || true
        fi
    done

    # Kill Anvil instances
    for pid_var in ANVIL_PID_TS ANVIL_PID_GO; do
        pid=${!pid_var}
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            log_info "  Stopping ${pid_var} (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done

    log_info "All processes stopped."
}

trap cleanup EXIT INT TERM

# ─── Helper: start Anvil ──────────────────────────────────────────────────────

start_anvil() {
    local port=$1
    local label=$2

    # Check if port is already in use
    if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        log_warn "Port $port already in use — reusing for $label"
        return 0
    fi

    local cmd="anvil --port $port --fork-url $FORK_URL --no-mining --accounts 10 --balance 10000 --silent"
    if [ -n "$FORK_BLOCK" ]; then
        cmd="$cmd --fork-block-number $FORK_BLOCK"
    fi

    $cmd &
    local pid=$!

    # Wait for readiness
    local start_time=$(date +%s)
    while true; do
        if curl -s -X POST -H "Content-Type: application/json" \
            --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
            "http://127.0.0.1:$port" > /dev/null 2>&1; then
            break
        fi
        local elapsed=$(($(date +%s) - start_time))
        if [ $elapsed -ge $ANVIL_TIMEOUT ]; then
            log_error "Timeout waiting for Anvil ($label) on port $port"
            exit 1
        fi
        sleep 0.1
    done

    local ready_time=$(($(date +%s) - start_time))
    log_info "  Anvil ($label) ready in ${ready_time}s on port $port (PID: $pid)"
    echo "$pid"
}

# ─── Helper: wait for extractor health ────────────────────────────────────────

wait_for_health() {
    local url=$1
    local label=$2

    local start_time=$(date +%s)
    while true; do
        local status=$(curl -s -o /dev/null -w "%{http_code}" "$url/health" 2>/dev/null || echo "000")
        if [ "$status" = "200" ]; then
            local elapsed=$(($(date +%s) - start_time))
            log_info "  $label healthy in ${elapsed}s"
            return 0
        fi
        local elapsed=$(($(date +%s) - start_time))
        if [ $elapsed -ge $HEALTH_TIMEOUT ]; then
            log_error "Timeout waiting for $label health at $url/health"
            return 1
        fi
        sleep 1
    done
}

# ─── Step 1: Start Anvil instances ────────────────────────────────────────────

log_step "Starting Anvil instances (forking $FORK_URL)..."

ANVIL_PID_TS=$(start_anvil $ANVIL_PORT_TS "TS")
ANVIL_PID_GO=$(start_anvil $ANVIL_PORT_GO "Go")

ANVIL_RPC_TS="http://127.0.0.1:$ANVIL_PORT_TS"
ANVIL_RPC_GO="http://127.0.0.1:$ANVIL_PORT_GO"

# ─── Step 2: Start extractors ────────────────────────────────────────────────

log_step "Starting extractors..."

# TS extractor — override RPC_URL to point at its Anvil
RPC_URL="$ANVIL_RPC_TS" TS_PORT="$TS_PORT" bun run mini-extractor-ts/index.ts &
EXTRACTOR_PID_TS=$!
log_info "  TS extractor started (PID: $EXTRACTOR_PID_TS, RPC: $ANVIL_RPC_TS, HTTP: :$TS_PORT)"

# Go extractor — override RPC_URL to point at its Anvil
RPC_URL="$ANVIL_RPC_GO" GO_PORT="$GO_PORT" go run ./mini-extractor-go &
EXTRACTOR_PID_GO=$!
log_info "  Go extractor started (PID: $EXTRACTOR_PID_GO, RPC: $ANVIL_RPC_GO, HTTP: :$GO_PORT)"

# ─── Step 3: Wait for health ─────────────────────────────────────────────────

log_step "Waiting for extractors to become healthy..."

wait_for_health "http://localhost:$TS_PORT" "TS extractor"
wait_for_health "http://localhost:$GO_PORT" "Go extractor"

log_info "Both extractors are healthy."
echo ""

# ─── Step 4: Run command or wait ──────────────────────────────────────────────

if [ $# -gt 0 ]; then
    log_step "Running: $@"
    echo ""

    # Export ports so make targets pick them up
    export TS_PORT GO_PORT

    "$@"
    EXIT_CODE=$?

    echo ""
    log_info "Command completed with exit code: $EXIT_CODE"
    exit $EXIT_CODE
else
    log_info "Both extractors running against local Anvil forks."
    log_info "  TS: http://localhost:$TS_PORT  (Anvil :$ANVIL_PORT_TS)"
    log_info "  Go: http://localhost:$GO_PORT  (Anvil :$ANVIL_PORT_GO)"
    log_info ""
    log_info "Press Ctrl+C to stop all processes."

    # Wait for any child to exit
    wait
fi
