# Studio Audio Router — Project Context

## Stack
- **Backend:** Node.js 24 (ESM), Express 4, ws 8
- **Frontend:** Vanilla JS, CSS3, HTML5 (no frameworks/bundlers)
- **Container:** Docker + Docker Compose (Alpine-based)
- **Proxy:** Apache httpd (CentOS) — reverse proxy SSL + WebSocket upgrade

## Running
| Command | Description |
|---|---|
| `npm install` | Install deps |
| `npm start` | Start on `0.0.0.0:3003` |
| `docker compose up -d` | Run via Docker (`localhost:3003`) |
| `docker compose down` | Stop containers |

## Architecture
**Selective-Mesh WebRTC** — signaling server only relays offers/answers/candidates.

- **Guest** ↔ Host-1, Host-2, Host-3 (bidirectional)
- **Hosts** connect only to Guest (no cross-host links — they hear each other in-room)
- Roles: `guest`, `host-1`, `host-2`, `host-3`

## Deployment
- **Internal:** `http://localhost:3003`
- **Public:** `https://labens.dct.ufrn.br/audiochat` (Apache reverse proxy)
- Apache config: SSL termination + `mod_proxy_wstunnel` for ws:// upgrade
- The app runs under the `/audiochat` sub-path. Apache proxies:
  - `ProxyPass /audiochat http://localhost:3003/` (static files)
  - `RewriteRule ^/audiochat/(.*) ws://localhost:3003/$1 [P,L]` (WebSocket upgrade)
- Active Apache configs: `labens.conf` (HTTP→HTTPS redirect) and `labens-le-ssl.conf` (SSL + proxy) in `/etc/httpd/sites-available/`
- `audiochat.conf` exists in `sites-available` as a draft but is NOT active

## Project Structure
```
/
├── server.js          # Signaling server (WebSocket + Express static)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example       # PORT=3003, NODE_ENV=development
├── public/
│   ├── index.html     # Role selection + dashboard UI
│   ├── app.js         # WebRTC client logic
│   └── style.css      # Glassmorphism design system
└── AGENTS.md
```

## Code Conventions
- ES Modules (`import/export`)
- No TypeScript, no linter, no test framework
- `camelCase` for variables/functions
- `kebab-case` for CSS classes and HTML IDs
- No JS comments in production code
- WebRTC audio constraints at `app.js:117-132`
- Opus HQ override (128kbps stereo) at `app.js:403-432`

## Critical Gotchas (Reverse Proxy Sub-path)
- Apache proxies `/audiochat` → `localhost:3003/` (strips prefix). The Express app sees paths at root.
- **`index.html:8`** — `<base href="/audiochat/">` required so relative CSS/JS paths resolve correctly.
- **`app.js:139`** — WebSocket URL must include `/audiochat` path to match Apache's RewriteRule.
- `docker compose up -d --build` needed when static files (HTML/CSS/JS) change.

## Useful Patterns
- `clients` Map in `server.js` tracks role→socket, overwrites on re-register
- Peer cards created/removed dynamically in `app.js:541-598`
- Auto-reconnect on WS close (`app.js:206-209`)
- AudioContext created lazily, resumed on interaction
- No persistent storage — all state in-memory on server
