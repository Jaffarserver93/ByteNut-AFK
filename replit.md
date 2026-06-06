# ByteNut AFK Bot

A Puppeteer-powered AFK bot for bytenut.com with a glass-themed dashboard for monitoring, controlling, and live-previewing the bot session.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (default port 8080 in dev)
- `pnpm --filter @workspace/dashboard run dev` — run the dashboard (port set by $PORT)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `./start.sh` — production start script for Ubuntu (loads .env, builds everything, starts both servers)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot engine: puppeteer-real-browser (real Chromium, bypasses bot detection)
- Dashboard: React + Vite + Tailwind CSS (glass dark theme)
- Validation: Zod (`zod/v4`)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `artifacts/api-server/src/services/bot.ts` — bot state machine & puppeteer logic
- `artifacts/api-server/src/routes/bot.ts` — REST routes for bot control
- `artifacts/dashboard/src/pages/home.tsx` — main dashboard page
- `artifacts/dashboard/src/index.css` — dark navy/cyan theme tokens
- `.env.example` — template for all required env vars
- `start.sh` — Ubuntu startup script

## Environment Variables

See `.env.example` for the full template. Required vars:

| Variable | Description |
|----------|-------------|
| `LOGIN_URL` | URL of the login page (e.g. `https://www.bytenut.com/login`) |
| `TARGET_URL` | Page to stay active on after login |
| `BOT_USERNAME` | Account username |
| `BOT_PASSWORD` | Account password |
| `PORT` | Single port for both API and dashboard (default: 3000) |
| `SESSION_SECRET` | Secret for session signing |

## Architecture decisions

- Bot state lives entirely in-memory — no database needed (fast, simple, restartable)
- `puppeteer-real-browser` is dynamically imported so the API server bundles cleanly with esbuild
- Dashboard polls the API every 2–5s with React Query — no WebSocket complexity
- Login uses a prioritized list of common CSS selectors to handle most login pages generically
- On Ubuntu: API server serves on `API_PORT`, dashboard static build serves on `DASHBOARD_PORT` via `serve`; `VITE_API_BASE_URL` is baked into the dashboard build by `start.sh`

## Product

- **Start/Stop Bot**: Launch or terminate the Puppeteer session from the dashboard
- **Live Preview**: See a real-time screenshot of what the bot's browser is currently showing
- **Uptime Counter**: Live HH:MM:SS counter showing how long the bot has been running
- **Reload Count**: Tracks how many times the target page has been reloaded (every 60s)
- **Audit Log**: Full timestamped log of all bot actions (login, navigation, reloads, errors)

## User preferences

- Glass dark theme (deep navy + blue-to-cyan gradient), mobile-friendly
- Use puppeteer-real-browser with Chromium
- All credentials and ports configured via .env
- Deployable on Ubuntu with ./start.sh

## Gotchas

- `puppeteer-real-browser` requires a real Chromium browser — on Ubuntu, install with: `apt-get install chromium-browser`
- On Linux without a display, the package uses Xvfb automatically — install with: `apt-get install xvfb`
- On Replit's sandbox, the bot engine may not launch a browser (no Chromium available) — the API and dashboard still run fine for development
- esbuild externalizes `puppeteer-real-browser` — it must be installed as a production dependency
- `start.sh` bakes `VITE_API_BASE_URL` into the dashboard build — if you change API_PORT, rebuild the dashboard

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
