const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const compression = require('compression');
const proxyaddr = require('proxy-addr');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');
const { GAME_EVENTS } = require('./game');
const { RoomManager } = require('./rooms');
const {
    PROTOCOL_VERSION, ERROR_CODES, CLOSE_CODES, HOST_ONLY, parseClientMessage,
} = require('./protocol');

const MINUTE = 60 * 1000;
const envInt = (name, fallback) => {
    const n = parseInt(process.env[name], 10);
    return Number.isNaN(n) ? fallback : n;
};

// Settings come from the environment; tests override them through createServer(options).
const configFromEnv = () => ({
    port: envInt('PORT', 3000),
    publicUrl: process.env.PUBLIC_URL || null,
    trustProxy: process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
    maxRooms: envInt('MAX_ROOMS', 500),
    maxPlayers: envInt('MAX_PLAYERS_PER_ROOM', 12),
    roomIdleMs: envInt('ROOM_IDLE_MINUTES', 30) * MINUTE,
    gameOverMs: envInt('ROOM_GAME_OVER_MINUTES', 30) * MINUTE,
    sweepIntervalMs: MINUTE,
    heartbeatMs: 15 * 1000,
    maxMessageBytes: 8 * 1024,
    rateLimit: { burst: 30, perSecond: 15, maxDrops: 200 },
    createRoomLimit: { max: 20, windowMs: 10 * MINUTE },
});

// --- UTILS ---

// Pick the address phones on the same Wi-Fi can reach. Prefer real LAN ranges and
// skip virtual adapters (Docker, VPNs, VMs) that would produce an unreachable QR code.
function getLocalIpAddress() {
    const candidates = [];
    for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
        if (/^(docker|br-|veth|vmnet|vbox|utun|tun|tailscale|zt|virbr)/i.test(name)) continue;
        for (const iface of ifaces || []) {
            if (iface.family === 'IPv4' && !iface.internal) candidates.push(iface.address);
        }
    }
    const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
    candidates.sort((a, b) => score(a) - score(b));
    return candidates[0] || 'localhost';
}

// TRUST_PROXY: a hop count ("1" behind one load balancer, like Render or Fly), "true",
// "false", or a list of addresses/ranges as Express understands them.
function compileTrust(value) {
    const text = String(value).trim();
    if (/^\d+$/.test(text)) {
        const hops = Number(text);
        return (addr, i) => i < hops;
    }
    if (/^(true|yes)$/i.test(text)) return () => true;
    if (/^(false|no|)$/i.test(text)) return () => false;
    return proxyaddr.compile(text.split(',').map((s) => s.trim()).filter(Boolean));
}

const firstHeader = (value) => (typeof value === 'string' ? value.split(',')[0].trim() : '');
const isLoopbackHost = (host) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host);
const VALID_HOST = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;

const SECURITY_HEADERS = {
    'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "media-src 'self'",
        "connect-src 'self' ws: wss:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
};

function createServer(options = {}) {
    const opts = { ...configFromEnv(), ...options };
    const trust = compileTrust(opts.trustProxy);
    const serverId = crypto.randomUUID(); // changes on every restart, so clients can tell
    const app = express();
    const server = http.createServer(app);
    const rooms = new RoomManager({
        maxRooms: opts.maxRooms,
        maxPlayers: opts.maxPlayers,
        idleMs: opts.roomIdleMs,
        gameOverMs: opts.gameOverMs,
    });

    // --- HTTP ---
    app.disable('x-powered-by');
    app.set('trust proxy', trust);
    app.use((req, res, next) => {
        res.set(SECURITY_HEADERS);
        if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
        next();
    });
    app.use(compression());

    app.get('/healthz', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ ok: true, rooms: rooms.size, connections: wss.clients.size, protocolVersion: PROTOCOL_VERSION });
    });

    const publicDir = path.join(__dirname, 'public');
    app.use(express.static(publicDir, {
        setHeaders(res, filePath) {
            // Files aren't fingerprinted, so code revalidates (cheap 304s) and media is cached.
            if (/\.(mp3|png|svg|ico)$/.test(filePath)) res.set('Cache-Control', 'public, max-age=86400');
            else res.set('Cache-Control', 'no-cache');
        },
    }));
    // Short join links: fishbowl.example.com/ABCD opens the join screen for that room.
    app.get('/:code([A-Za-z]{4})', (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(publicDir, 'index.html'));
    });

    // Where phones should go. PUBLIC_URL wins; otherwise use the address the host screen
    // used, unless that's localhost, in which case phones need this machine's LAN IP.
    function baseUrlFor(req) {
        if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, '');
        const viaProxy = trust(req.socket.remoteAddress, 0);
        let proto = req.socket.encrypted ? 'https' : 'http';
        let host = req.headers.host || '';
        if (viaProxy) {
            const fwdProto = firstHeader(req.headers['x-forwarded-proto']).toLowerCase();
            if (fwdProto === 'https' || fwdProto === 'http') proto = fwdProto;
            host = firstHeader(req.headers['x-forwarded-host']) || host;
        }
        if (!VALID_HOST.test(host) || isLoopbackHost(host)) {
            return `http://${getLocalIpAddress()}:${server.address().port}`;
        }
        return `${proto}://${host}`;
    }

    // --- WEBSOCKETS ---
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: opts.maxMessageBytes, perMessageDeflate: false });

    const send = (client, type, payload = {}) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload }));
        }
    };

    // Errors for messages without an id (or that couldn't be parsed) go out as type "error".
    const sendError = (client, id, { code, error }) => (id
        ? send(client, 'reply', { id, ok: false, code, error })
        : send(client, 'error', { code, error }));

    const roomInfo = (room) => ({ code: room.code, hostConnected: room.hostConnected, joinUrl: room.joinUrl });

    const sendState = (client) => {
        const { room } = client;
        if (!room) return;
        const playerId = client.role === 'player' ? client.playerId : null;
        send(client, 'state', {
            serverNow: Date.now(),
            state: { ...room.game.viewFor(playerId), room: roomInfo(room) },
        });
    };
    const broadcastState = (room) => room.clients.forEach(sendState);

    function wireRoom(room) {
        room.game.on('change', () => broadcastState(room));
        for (const type of GAME_EVENTS) {
            room.game.on(type, (data) => {
                const payload = type === 'turnStarted' ? { ...data, serverNow: Date.now() } : data;
                room.clients.forEach((client) => send(client, type, payload));
            });
        }
    }

    rooms.on('roomClosed', (room, reason) => {
        for (const client of room.clients) {
            send(client, 'roomClosed', { code: room.code, reason });
            client.room = null;
            client.role = null;
            client.playerId = null;
        }
    });

    function attach(client, room, role, playerId = null) {
        client.room = room;
        client.role = role;
        client.playerId = playerId;
        room.addClient(client);
    }

    // Takes a connection out of its room, marking the player offline if this was their last one.
    function detach(client) {
        const { room, role, playerId } = client;
        if (!room) return;
        room.removeClient(client);
        client.room = null;
        client.role = null;
        client.playerId = null;
        if (role === 'player') room.game.setConnected(playerId, room.isPlayerOnline(playerId));
        if (role === 'host' && !room.hostConnected) broadcastState(room);
    }

    // Simple fixed-window limit on room creation per IP, so one client can't fill the server.
    const createCounts = new Map(); // ip -> { count, resetAt }
    function allowCreate(ip, now = Date.now()) {
        let entry = createCounts.get(ip);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + opts.createRoomLimit.windowMs };
            createCounts.set(ip, entry);
        }
        entry.count++;
        return entry.count <= opts.createRoomLimit.max;
    }

    const fail = (code, error = ERROR_CODES[code]) => ({ ok: false, code, error });
    // Game methods return { ok, error, code }; pass failures through and drop internals on success.
    const fromGame = (result) => (result.ok ? { ok: true } : fail(result.code, result.error));

    async function hostRoomReply(room) {
        let qrDataUrl = null;
        try {
            qrDataUrl = await QRCode.toDataURL(room.joinUrl, { margin: 1, width: 600 });
        } catch (err) {
            console.error('QR code failed:', err);
        }
        return { ok: true, room: { code: room.code, hostToken: room.hostToken, joinUrl: room.joinUrl, qrDataUrl } };
    }

    // Each handler returns the reply. `after` runs once the reply is sent, so a client
    // always gets the reply to createRoom/resumeHost/joinRoom before the first state.
    const handlers = {
        ping: () => ({ ok: true, serverNow: Date.now() }),

        createRoom: async (client, payload, after) => {
            if (!allowCreate(client.ip)) {
                return fail('RATE_LIMITED', 'Too many games were created from this network. Try again in a few minutes.');
            }
            const created = rooms.create();
            if (!created.ok) return fail(created.code);
            const { room } = created;
            room.joinUrl = `${client.baseUrl}/${room.code}`;
            wireRoom(room);
            detach(client);
            attach(client, room, 'host');
            after(() => sendState(client));
            return hostRoomReply(room);
        },

        resumeHost: async (client, { code, hostToken }, after) => {
            const auth = rooms.authorizeHost(code, hostToken);
            if (!auth.ok) return fail(auth.code);
            const { room } = auth;
            if (client.room !== room || client.role !== 'host') {
                detach(client);
                attach(client, room, 'host');
            }
            after(() => broadcastState(room));
            return hostRoomReply(room);
        },

        lookupRoom: (client, { code }) => {
            const room = rooms.get(code);
            if (!room) return fail('ROOM_NOT_FOUND');
            const { game } = room;
            return {
                ok: true,
                room: {
                    code: room.code,
                    phase: game.phase,
                    playerCount: game.players.size,
                    maxPlayers: game.limits.maxPlayers,
                    hostConnected: room.hostConnected,
                },
            };
        },

        joinRoom: (client, { code, playerId, name }, after) => {
            const room = rooms.get(code);
            if (!room) return fail('ROOM_NOT_FOUND');
            if (client.room) detach(client);
            const result = room.game.join(playerId, name);
            if (!result.ok) return fromGame(result);
            attach(client, room, 'player', result.player.id);
            after(() => sendState(client));
            return { ok: true, room: { code: room.code }, playerId: result.player.id };
        },

        leaveRoom: (client) => {
            const { room, role, playerId } = client;
            if (!room) return { ok: true };
            detach(client);
            if (role === 'player' && room.game.phase === 'LOBBY' && !room.isPlayerOnline(playerId)) {
                room.game.removePlayer(playerId);
            }
            return { ok: true };
        },

        submitWords: (client, { words }) => fromGame(client.room.game.submitWords(client.playerId, words)),
        startTurn: (client) => fromGame(client.room.game.startTimer(client.playerId)),
        gotWord: (client, { wordId }) => fromGame(client.room.game.gotWord(client.playerId, wordId)),
        skipWord: (client, { wordId }) => fromGame(client.room.game.skipWord(client.playerId, wordId)),

        startSubmission: (client, settings) => fromGame(client.room.game.startSubmission(settings)),
        shuffleTeams: (client) => fromGame(client.room.game.shuffleTeams()),
        startRound: (client) => fromGame(client.room.game.startRound()),
        togglePause: (client) => fromGame(client.room.game.togglePause()),
        skipTurn: (client) => fromGame(client.room.game.skipTurn()),
        removePlayer: (client, { playerId }) => fromGame(client.room.game.removePlayer(playerId)),
        playAgain: (client) => fromGame(client.room.game.playAgain()),
        resetLobby: (client) => {
            client.room.game.reset();
            return { ok: true };
        },
        closeRoom: (client) => {
            rooms.delete(client.room.code, 'closedByHost');
            return { ok: true };
        },
    };
    const PLAYER_ONLY = new Set(['submitWords', 'startTurn', 'gotWord', 'skipWord']);

    // Token bucket per connection. Returns false when the message should be dropped.
    function takeToken(client, now = Date.now()) {
        const { burst, perSecond } = opts.rateLimit;
        client.tokens = Math.min(burst, client.tokens + ((now - client.lastRefill) / 1000) * perSecond);
        client.lastRefill = now;
        if (client.tokens < 1) return false;
        client.tokens -= 1;
        return true;
    }

    async function onMessage(client, data, isBinary) {
        client.alive = true;
        if (!takeToken(client)) {
            client.drops++;
            if (client.drops > opts.rateLimit.maxDrops) return client.ws.close(1008, 'Rate limit exceeded');
            const parsed = isBinary ? {} : parseClientMessage(data.toString('utf8'));
            return sendError(client, parsed.ok ? parsed.msg.id : parsed.id, fail('RATE_LIMITED'));
        }
        client.drops = 0;

        const parsed = isBinary
            ? { ok: false, code: 'BAD_REQUEST', error: 'Messages must be text.' }
            : parseClientMessage(data.toString('utf8'));
        if (!parsed.ok) {
            sendError(client, parsed.id, parsed);
            if (parsed.code === 'UNSUPPORTED_VERSION') client.ws.close(CLOSE_CODES.UNSUPPORTED_VERSION, 'Unsupported protocol version');
            return;
        }

        const { type, id, payload } = parsed.msg;
        const afterReply = [];
        let result;
        try {
            if (HOST_ONLY.has(type) && client.role !== 'host') result = fail('NOT_HOST');
            else if (PLAYER_ONLY.has(type) && client.role !== 'player') result = fail('NOT_IN_ROOM');
            else result = handlers[type](client, payload, (fn) => afterReply.push(fn));
            // Only createRoom/resumeHost are async; everything else replies in arrival order.
            if (result instanceof Promise) result = await result;
        } catch (err) {
            console.error(`Error handling "${type}":`, err);
            result = fail('INTERNAL');
        }
        if (id) send(client, 'reply', { id, ...result });
        else if (!result.ok) sendError(client, null, result);
        afterReply.forEach((fn) => fn());
    }

    wss.on('connection', (ws, req) => {
        const client = {
            ws,
            ip: proxyaddr(req, trust),
            baseUrl: baseUrlFor(req),
            room: null,
            role: null, // 'host' | 'player' once in a room
            playerId: null,
            alive: true,
            tokens: opts.rateLimit.burst,
            lastRefill: Date.now(),
            drops: 0,
        };
        ws.on('pong', () => { client.alive = true; });
        ws.on('message', (data, isBinary) => {
            onMessage(client, data, isBinary).catch((err) => console.error('Message handler failed:', err));
        });
        ws.on('close', () => detach(client));
        ws.on('error', (err) => console.error('WebSocket error:', err.message));
        // Lets a client find its client object again (tests and heartbeat).
        ws.fishbowl = client;

        send(client, 'welcome', {
            protocolVersion: PROTOCOL_VERSION,
            serverId,
            serverNow: Date.now(),
            limits: { maxMessageBytes: opts.maxMessageBytes, maxPlayersPerRoom: opts.maxPlayers, heartbeatMs: opts.heartbeatMs },
        });
    });

    // A connection that misses a pong for a whole interval is dead (phone locked, Wi-Fi gone).
    // terminate() fires 'close', which marks the player offline.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            const client = ws.fishbowl;
            if (!client.alive) {
                ws.terminate();
                continue;
            }
            client.alive = false;
            ws.ping();
        }
    }, opts.heartbeatMs);

    const sweeper = setInterval(() => {
        rooms.sweep();
        const now = Date.now();
        for (const [ip, entry] of createCounts) if (now >= entry.resetAt) createCounts.delete(ip);
    }, opts.sweepIntervalMs);
    heartbeat.unref();
    sweeper.unref();

    // Closes every connection (1012 = "service restart": clients reconnect, then find their room gone).
    function close() {
        clearInterval(heartbeat);
        clearInterval(sweeper);
        for (const ws of wss.clients) ws.close(1012, 'Server restarting');
        rooms.closeAll('serverShutdown');
        wss.close();
        return new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        });
    }

    return { app, server, wss, rooms, serverId, close };
}

if (require.main === module) {
    const { port, publicUrl } = configFromEnv();
    const { server, close } = createServer();
    server.listen(port, '0.0.0.0', () => {
        console.log(`Fishbowl running on port ${port}`);
        console.log(`Host screen (TV/laptop): http://localhost:${port}`);
        console.log(`Players join at:         ${publicUrl || `http://${getLocalIpAddress()}:${port}`}`);
    });
    const shutdown = (signal) => {
        console.log(`${signal} received, closing. Running games end here.`);
        close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createServer };
