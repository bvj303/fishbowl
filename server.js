const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const QRCode = require('qrcode');
const path = require('path');
const { Game } = require('./game');

const PORT = parseInt(process.env.PORT, 10) || 3000;

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

const getJoinUrl = () => process.env.PUBLIC_URL || `http://${getLocalIpAddress()}:${PORT}`;

function createServer() {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    const game = new Game();

    app.use(express.static(path.join(__dirname, 'public')));

    const broadcast = () => {
        for (const socket of io.sockets.sockets.values()) {
            socket.emit('state', game.viewFor(socket.data.playerId));
        }
    };
    game.on('change', broadcast);
    game.on('tick', broadcast);
    game.on('turnEnded', (info) => io.emit('turnEnded', info));

    const isPlayerOnline = (playerId) =>
        [...io.sockets.sockets.values()].some((s) => s.data.playerId === playerId);

    io.on('connection', (socket) => {
        socket.emit('state', game.viewFor(null));

        // Every handler replies through an optional ack callback so the client can show errors.
        const on = (event, handler, { hostOnly = false } = {}) => {
            socket.on(event, (...args) => {
                const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
                if (hostOnly && !socket.data.isHost) return ack({ ok: false, error: 'Only the host screen can do that.' });
                try {
                    ack(handler(...args) || { ok: true });
                } catch (err) {
                    console.error(`Error handling "${event}":`, err);
                    ack({ ok: false, error: 'Something went wrong. Please try again.' });
                }
            });
        };

        // --- HOST ---
        socket.on('registerHost', async (ack) => {
            socket.data.isHost = true;
            const url = getJoinUrl();
            try {
                const qr = await QRCode.toDataURL(`${url}/?join`, { margin: 1, width: 600 });
                if (typeof ack === 'function') ack({ url, qr });
            } catch (err) {
                console.error(err);
                if (typeof ack === 'function') ack({ url, qr: null });
            }
        });
        on('startSubmission', (settings) => game.startSubmission(settings), { hostOnly: true });
        on('shuffleTeams', () => game.shuffleTeams(), { hostOnly: true });
        on('startRound', () => game.startRound(), { hostOnly: true });
        on('togglePause', () => game.togglePause(), { hostOnly: true });
        on('skipTurn', () => game.skipTurn(), { hostOnly: true });
        on('removePlayer', (id) => game.removePlayer(id), { hostOnly: true });
        on('playAgain', () => game.playAgain(), { hostOnly: true });
        on('resetLobby', () => game.reset(), { hostOnly: true });

        // --- PLAYERS ---
        on('joinGame', ({ playerId, name } = {}) => {
            const result = game.join(playerId, name);
            if (result.ok) {
                socket.data.playerId = result.player.id;
                broadcast();
                return { ok: true };
            }
            return result;
        });
        on('leaveGame', () => {
            const id = socket.data.playerId;
            socket.data.playerId = null;
            if (id && game.phase === 'LOBBY') return game.removePlayer(id);
            if (id) game.setConnected(id, isPlayerOnline(id));
            broadcast();
            return { ok: true };
        });
        on('submitWords', (words) => game.submitWords(socket.data.playerId, words));
        on('suggestWord', (opts) => game.suggestWord(socket.data.playerId, opts));
        on('startTimer', () => game.startTimer(socket.data.playerId));
        on('gotWord', (wordId) => game.gotWord(socket.data.playerId, wordId));
        on('skipWord', (wordId) => game.skipWord(socket.data.playerId, wordId));

        socket.on('disconnect', () => {
            const id = socket.data.playerId;
            if (id) game.setConnected(id, isPlayerOnline(id));
        });
    });

    return { app, server, io, game };
}

if (require.main === module) {
    const { server } = createServer();
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Fishbowl running on port ${PORT}`);
        console.log(`Host screen (TV/laptop): http://localhost:${PORT}/?host`);
        console.log(`Players join at:         ${getJoinUrl()}`);
    });
}

module.exports = { createServer };
