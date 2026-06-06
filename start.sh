#!/usr/bin/env bash
# ============================================================
# ByteNut AFK Bot — Start Script
# Usage: ./start.sh
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
API_PORT="${API_PORT:-3000}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"
SESSION_SECRET="${SESSION_SECRET:-dev-secret-please-change}"

ok "API server will run on port $API_PORT"
ok "Dashboard will run on port $DASHBOARD_PORT"

# ---- Check for pnpm -----------------------------------------
if ! command -v pnpm &>/dev/null; then
  err "pnpm is not installed. Install it with: npm install -g pnpm"
  exit 1
fi

# ---- Install dependencies -----------------------------------
log "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed"

# ---- Build API server ---------------------------------------
log "Building API server..."
pnpm --filter @workspace/api-server run build
ok "API server built"

# ---- Build dashboard ----------------------------------------
log "Building dashboard (API base URL: http://localhost:$API_PORT)..."
VITE_API_BASE_URL="http://localhost:$API_PORT" \
  pnpm --filter @workspace/dashboard run build
ok "Dashboard built"

# ---- Install serve for dashboard (if not available) ---------
if ! command -v serve &>/dev/null; then
  log "Installing 'serve' for dashboard hosting..."
  npm install -g serve --quiet
fi

# ---- Cleanup on exit ----------------------------------------
cleanup() {
  log "Shutting down..."
  [ -n "${API_PID:-}" ]  && kill "$API_PID"  2>/dev/null || true
  [ -n "${DASH_PID:-}" ] && kill "$DASH_PID" 2>/dev/null || true
  ok "Stopped."
}
trap cleanup EXIT INT TERM

# ---- Start API server ---------------------------------------
log "Starting API server on port $API_PORT..."
PORT="$API_PORT" \
  LOGIN_URL="$LOGIN_URL" \
  TARGET_URL="$TARGET_URL" \
  BOT_USERNAME="$BOT_USERNAME" \
  BOT_PASSWORD="$BOT_PASSWORD" \
  SESSION_SECRET="$SESSION_SECRET" \
  pnpm --filter @workspace/api-server run start &
API_PID=$!
ok "API server started (PID: $API_PID)"

# ---- Start dashboard server ---------------------------------
log "Starting dashboard on port $DASHBOARD_PORT..."
serve -s artifacts/dashboard/dist/public -l "$DASHBOARD_PORT" --no-clipboard &
DASH_PID=$!
ok "Dashboard started (PID: $DASH_PID)"

echo ""
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}  ByteNut AFK Bot is running!${NC}"
echo -e "${GREEN}=================================================${NC}"
echo -e "  API Server:  http://localhost:${API_PORT}"
echo -e "  Dashboard:   http://localhost:${DASHBOARD_PORT}"
echo -e ""
echo -e "  Open the dashboard in your browser and click"
echo -e "  'Start Bot' to begin the AFK session."
echo -e "${GREEN}=================================================${NC}"
echo ""

# Wait for both processes
wait "$API_PID" "$DASH_PID"
