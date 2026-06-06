#!/usr/bin/env bash
# ============================================================
# ByteNut AFK Bot — One-Shot Setup & Start
# Usage: sudo bash start.sh   (first time)
#        ./start.sh           (subsequent runs)
# Installs all system deps, Chrome, Node.js, pnpm, then starts
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[setup]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}   $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()  { echo -e "${RED}[err]${NC}   $*" >&2; }
head() { echo -e "\n${BOLD}${GREEN}━━━ $* ━━━${NC}"; }

# ---- Detect sudo/root ----------------------------------------
SUDO=""
if [ "$EUID" -ne 0 ]; then
  if command -v sudo &>/dev/null; then
    SUDO="sudo"
    log "Running as non-root — will use sudo for system installs"
  else
    warn "Not root and no sudo found — system package installs may fail"
  fi
fi

# ============================================================
head "System Dependencies"
# ============================================================

if command -v apt-get &>/dev/null; then
  log "Updating apt package lists..."
  $SUDO apt-get update -qq

  log "Installing base system packages..."
  $SUDO apt-get install -y -qq \
    curl wget gnupg ca-certificates \
    libglib2.0-0 libnss3 libnspr4 \
    libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 \
    libxcb1 libxkbcommon0 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 libx11-xcb1 libxcursor1 \
    libxi6 libxtst6 fonts-liberation \
    xdg-utils git 2>/dev/null || true
  ok "Base packages installed"
else
  warn "apt-get not found — skipping system package install (non-Ubuntu system?)"
fi

# ============================================================
head "Google Chrome (official, non-snap)"
# ============================================================

if command -v google-chrome-stable &>/dev/null || [ -x /usr/bin/google-chrome-stable ]; then
  CHROME_VER=$(google-chrome-stable --version 2>/dev/null || echo "unknown")
  ok "Google Chrome already installed: $CHROME_VER"
else
  if command -v apt-get &>/dev/null; then
    log "Adding Google Chrome apt repository..."
    $SUDO install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | $SUDO gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg 2>/dev/null \
      || wget -q -O- https://dl.google.com/linux/linux_signing_key.pub \
      | $SUDO gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] \
https://dl.google.com/linux/chrome/deb/ stable main" \
      | $SUDO tee /etc/apt/sources.list.d/google-chrome.list > /dev/null
    $SUDO apt-get update -qq
    log "Installing Google Chrome stable..."
    $SUDO apt-get install -y google-chrome-stable
    ok "Google Chrome stable installed: $(google-chrome-stable --version 2>/dev/null)"
  else
    warn "Cannot auto-install Chrome (no apt-get). Install manually:"
    warn "  wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
    warn "  sudo dpkg -i google-chrome-stable_current_amd64.deb && sudo apt-get -f install -y"
  fi
fi

# ============================================================
head "Node.js"
# ============================================================

REQUIRED_NODE_MAJOR=20

install_node() {
  log "Installing Node.js $REQUIRED_NODE_MAJOR LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
}

if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo "0")
  if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
    warn "Node.js $NODE_MAJOR found but $REQUIRED_NODE_MAJOR+ required — upgrading..."
    install_node
  else
    ok "Node.js $(node --version) is installed"
  fi
else
  install_node
  ok "Node.js $(node --version) installed"
fi

# ============================================================
head "pnpm"
# ============================================================

if ! command -v pnpm &>/dev/null; then
  log "Installing pnpm..."
  npm install -g pnpm
  ok "pnpm $(pnpm --version) installed"
else
  ok "pnpm $(pnpm --version) is installed"
fi

# ============================================================
head "Node.js Dependencies + Chromium Download"
# ============================================================

log "Installing workspace dependencies..."
log "(First run: Puppeteer will download its own Chromium ~170MB as a fallback)"
pnpm install
ok "Dependencies installed"

# ============================================================
head "Environment Configuration"
# ============================================================

if [ -f .env ]; then
  log "Loading .env..."
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
  ok ".env loaded"
else
  err ".env file not found!"
  err "Copy the example and fill in your values:"
  err "  cp .env.example .env && nano .env"
  exit 1
fi

REQUIRED_VARS=(LOGIN_URL TARGET_URL BOT_USERNAME BOT_PASSWORD)
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    err "Required variable \$$var is not set. Edit your .env file."
    exit 1
  fi
done
ok "All required environment variables are set"

PORT="${PORT:-3000}"
SESSION_SECRET="${SESSION_SECRET:-change-this-secret-$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)}"

# ============================================================
head "Build"
# ============================================================

log "Building dashboard..."
NODE_ENV=production BASE_PATH=/ \
  pnpm --filter @workspace/dashboard run build
ok "Dashboard built"

log "Building API server..."
pnpm --filter @workspace/api-server run build
ok "API server built"

# ============================================================
head "Starting Bot Server"
# ============================================================

# Kill any process already holding the port so re-runs don't hit EADDRINUSE
if command -v fuser &>/dev/null; then
  fuser -k "${PORT}/tcp" 2>/dev/null && log "Killed existing process on port $PORT" || true
elif command -v lsof &>/dev/null; then
  OLD_PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null && log "Killed PID $OLD_PID on port $PORT" || true
else
  # Fallback: kill any node process running dist/index.mjs
  pkill -f "dist/index\.mjs" 2>/dev/null && log "Killed existing bot process" || true
fi
sleep 1

cleanup() {
  echo ""
  log "Shutting down..."
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  ok "Stopped."
}
trap cleanup EXIT INT TERM

log "Starting server on port $PORT..."
PORT="$PORT" \
  LOGIN_URL="$LOGIN_URL" \
  TARGET_URL="$TARGET_URL" \
  BOT_USERNAME="$BOT_USERNAME" \
  BOT_PASSWORD="$BOT_PASSWORD" \
  SESSION_SECRET="$SESSION_SECRET" \
  pnpm --filter @workspace/api-server run start &
SERVER_PID=$!

sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  err "Server failed to start. Check the logs above."
  exit 1
fi

ok "Server started (PID: $SERVER_PID)"

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       ByteNut AFK Bot is running!             ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  Dashboard: ${BOLD}http://localhost:${PORT}/${NC}"
echo -e "${GREEN}║${NC}  API:       ${BOLD}http://localhost:${PORT}/api${NC}"
echo -e "${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Open the dashboard and click ${BOLD}Start Bot${NC}"
echo -e "${GREEN}║${NC}  Press ${BOLD}Ctrl+C${NC} to stop"
echo -e "${GREEN}╚═══════════════════════════════════════════════╝${NC}"
echo ""

wait "$SERVER_PID"
