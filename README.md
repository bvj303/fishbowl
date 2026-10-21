# 🐟 Fishbowl

A multiplayer party word game. One screen (TV or laptop) is the host; everyone else plays on their phone.
Run it on your home network, or host it online, where any number of groups can play at once, each in
its own room with a 4-letter code.

## Running it at home

```bash
npm install
npm start
```

No configuration needed. Then:

1. On the computer connected to the TV, open **http://localhost:3000** and choose **Create a game**.
2. Everyone scans the QR code on screen with their phone, or opens the address shown and types the
   room code. Phones must be on the **same Wi-Fi** as the computer.
3. Once at least 4 people have joined, the host presses **start**. Everyone adds their words on their
   phone, teams are picked, and you play.

If the QR code shows the wrong address (VPNs and virtual network adapters can cause this), set it
yourself: `PUBLIC_URL=http://192.168.1.20:3000 npm start`. The port can be changed with `PORT=4000`.

## How to play

Every player secretly adds a few words or phrases to the bowl. The players are split into two teams, and the teams take turns. On your turn, your phone shows a word. Get your teammates to guess as many as you can before the timer runs out. There are three rounds, and the same words are used in each one:

| Round | Rule |
| --- | --- |
| 1. Describe It | Say anything except the word itself |
| 2. Act It Out | Charades: no talking |
| 3. One Word | Exactly one word as a clue |

The team with the most points after round 3 wins.

## Good to know

- **Refreshing or locking your phone is fine.** Each phone remembers its seat and rejoins automatically.
  The host screen can be refreshed too: it keeps a secret host token and gets the same room back.
- **Late arrivals** can join mid-game and are added to the smaller team. A room holds up to 12 players.
- **Someone left?** The host can remove them with ✕. Offline players are skipped when it's their turn.
- The host screen can **pause** or **skip** a turn if someone gets stuck.
- **Games live in the server's memory.** Restarting or redeploying the server ends every running game;
  screens then say "This game ended because the server restarted" with a button to start over. Rooms
  are also cleaned up after 30 minutes with nobody connected, and 30 minutes after a game ends.

## Hosting it online

The server is a single Node process with no database. It needs WebSockets, and it must run as
**one instance** (rooms are in memory, so a second instance wouldn't see the first one's rooms).

### Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. Hosting platforms set this for you. |
| `PUBLIC_URL` | (unset) | The address phones should open, e.g. `https://fishbowl.example.com`. Used for the QR code and join link. If unset, the server uses the address the host screen connected to (or this machine's LAN IP when that's `localhost`). |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which proxies' `X-Forwarded-*` headers to trust: a hop count (`1` behind a single load balancer), `true`, `false`, or a list of addresses/ranges. |
| `MAX_ROOMS` | `500` | Rooms per server. |
| `MAX_PLAYERS_PER_ROOM` | `12` | |
| `ROOM_IDLE_MINUTES` | `30` | Delete a room after this long with nobody connected. |
| `ROOM_GAME_OVER_MINUTES` | `30` | Delete a finished game after this long unless the host starts another. |

The server answers `GET /healthz` for health checks, sends security headers (a strict CSP, no
framing, `nosniff`, HSTS over HTTPS), gzips responses, and serves the web app with `no-cache` so a
deploy is picked up on the next load. When the site is served over HTTPS, the browser automatically
uses `wss://` for the WebSocket.

### Docker

```bash
docker build -t fishbowl .
docker run -p 3000:3000 -e PUBLIC_URL=https://fishbowl.example.com -e TRUST_PROXY=1 fishbowl
```

The image is based on `node:22-alpine`, installs production dependencies only, and runs as the
unprivileged `node` user.

### Render (recommended)

`render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec).

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint**, pick the repo, and apply. It creates a web service from the
   `Dockerfile` with a health check on `/healthz` and a single instance. It uses the `starter` plan
   because the free plan sleeps when idle, which would end running games.
3. When the service is live, open its `onrender.com` URL to check it works.
4. Add your subdomain (below), then set `PUBLIC_URL` to it (e.g. `https://fishbowl.example.com`)
   under **Environment** and redeploy.

### Fly.io (alternative)

`fly.toml` is ready to use. Edit `app` (and `primary_region` if you like), then:

```bash
fly launch --copy-config --no-deploy   # creates the app from fly.toml
fly deploy
fly scale count 1                      # rooms are in memory: exactly one machine
fly secrets set PUBLIC_URL=https://fishbowl.example.com   # after adding the domain below
```

Machines are configured not to auto-stop, so a game isn't cut off when traffic is quiet.

### Pointing a subdomain at it

Say your website is `example.com` and you want the game at `fishbowl.example.com`:

- **Render:** in the service, go to **Settings → Custom Domains → Add**, enter `fishbowl.example.com`.
  Then at your DNS provider add a **CNAME** record: name `fishbowl`, value `<your-service>.onrender.com`.
  Render issues the HTTPS certificate once DNS resolves.
- **Fly.io:** run `fly certs add fishbowl.example.com`. Then add a **CNAME** record: name `fishbowl`,
  value `<your-app>.fly.dev` (or the A/AAAA records `fly certs show` prints). Fly issues the certificate.

DNS changes can take a few minutes to an hour to spread. If your DNS is on Cloudflare, set the
record to **DNS only** (grey cloud) at first so the platform can issue its certificate; you can turn
the proxy on afterwards (WebSockets work through it). Finally set `PUBLIC_URL` to
`https://fishbowl.example.com` so QR codes use the subdomain.

## Building another client (e.g. a tvOS host app)

Clients talk to the server over a plain WebSocket at `/ws` with a small, versioned JSON protocol.
[`PROTOCOL.md`](PROTOCOL.md) documents every message, the state schema, error codes, reconnection and
the turn clock, with suggested Swift `Codable` models and a `URLSessionWebSocketTask` sample. A test
checks real server traffic against it, so it stays accurate.

## Development

```bash
npm test               # unit and end-to-end tests (node --test)
npm run test:browser   # full browser run: two rooms, 4 phones each (needs a global Playwright)
```

- `game.js`: all the game rules and state, with no networking code
- `rooms.js`: rooms, codes, host tokens and cleanup (also no networking)
- `protocol.js`: protocol version, error codes and validation of incoming messages
- `server.js`: HTTP (Express) and WebSocket (`ws`) wiring
- `public/`: the browser client (host and phone views), plain JS with no build step
- `scripts/browser-e2e.js`: the browser run, which saves screenshots to `screenshots/`
- `test/`: unit tests for the rules and rooms, end-to-end tests over real WebSockets, and the
  `PROTOCOL.md` drift check
