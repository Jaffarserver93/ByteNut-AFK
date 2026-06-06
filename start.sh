#!/usr/bin/env bash
# ============================================================
# ByteNut AFK Bot — Start Script
# Usage: ./start.sh
# Runs API + dashboard on a single port.
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${CYAN}[bot]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}  $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[err]${NC}  $*" >&2; }

# ---- Load .env -----------------------------------------------
if [ -f .env ]; then
  log "Loading .env..."
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
  ok ".env loaded"
else
  warn "No .env file found — using environment variables as-is"
  warn "Copy .env.example to .env and fill in your values"
fi

# ---- Validate required variables ----------------------------
REQUIRED_VARS=(LOGIN_URL TARGET_URL BOT_USERNAME BOT_PASSWORD)
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    err "Required variable \$$var is not set. Check your .env file."
    exit 1
  fi
done

# ---- Defaults -----------------------------------------------
PORT="${PORT:-3000}"
SESSION_SECRET="${SESSION_SECRET:-dev-secret-please-change}"

ok "Server will run on port $PORT (API + dashboard)"

# ---- Check for pnpm -----------------------------------------
if ! command -v pnpm &>/dev/null; then
  err "pnpm is not installed. Install it with: npm install -g pnpm"
  exit 1
fi

# ---- Install dependencies -----------------------------------
log "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed"

# ---- Build dashboard ----------------------------------------
log "Building dashboard (will be served by API server)..."
NODE_ENV=production \
  BASE_PATH=/ \
  pnpm --filter @workspace/dashboard run build
ok "Dashboard built → artifacts/dashboard/dist/public"

# ---- Build API server ---------------------------------------
log "Building API server..."
pnpm --filter @workspace/api-server run build
ok "API server built"

# ---- Cleanup on exit ----------------------------------------
cleanup() {
  log "Shutting down..."
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  ok "Stopped."
}
trap cleanup EXIT INT TERM

# ---- Start server -------------------------------------------
log "Starting server on port $PORT..."
PORT="$PORT" \
  LOGIN_URL="$LOGIN_URL" \
  TARGET_URL="$TARGET_URL" \
  BOT_USERNAME="$BOT_USERNAME" \
  BOT_PASSWORD="$BOT_PASSWORD" \
  SESSION_SECRET="$SESSION_SECRET" \
  pnpm --filter @workspace/api-server run start &
SERVER_PID=$!
ok "Server started (PID: $SERVER_PID)"

echo ""
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}  ByteNut AFK Bot is running!${NC}"
echo -e "${GREEN}=================================================${NC}"
echo -e "  Open in browser: http://localhost:${PORT}"
echo -e ""
echo -e "  API:       http://localhost:${PORT}/api"
echo -e "  Dashboard: http://localhost:${PORT}/"
echo -e ""
echo -e "  Click 'Start Bot' to begin the AFK session."
echo -e "${GREEN}=================================================${NC}"
echo ""

wait "$SERVER_PID"
