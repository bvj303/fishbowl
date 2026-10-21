// Rooms: each one owns a separate Game, a short join code and a secret host token.
// No networking here either; the server attaches its connections to `room.clients`.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { Game } = require('./game');
const { ROOM_CODE_ALPHABET } = require('./protocol');

const MINUTE = 60 * 1000;

const DEFAULTS = {
    maxRooms: 500,
    maxPlayers: 12,
    idleMs: 30 * MINUTE, // no one connected for this long -> room is deleted
    gameOverMs: 30 * MINUTE, // finished game nobody restarted for this long -> room is deleted
};

// Codes that are best not shown on a family TV.
const BLOCKED_CODES = new Set([
    'ANAL', 'ANUS', 'ARSE', 'CLIT', 'COCK', 'COON', 'CRAP', 'CUNT', 'DAMN', 'DICK', 'DYKE', 'FAGS',
    'FUCK', 'GOOK', 'HELL', 'JERK', 'JIZZ', 'KIKE', 'KUNT', 'NAZI', 'NIGG', 'PAKI', 'PISS',
    'POOP', 'PORN', 'PUSY', 'RAPE', 'SCUM', 'SEXY', 'SHAG', 'SHAT', 'SHIT', 'SLAG', 'SLUT', 'SPIC',
    'SUCK', 'TITS', 'TURD', 'TWAT', 'WANK', 'WHOR',
]);

function randomCode() {
    let code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
    return code;
}

function tokensMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class Room {
    constructor(code, { maxPlayers, now }) {
        this.code = code;
        this.hostToken = crypto.randomBytes(24).toString('base64url');
        this.game = new Game({ maxPlayers });
        this.joinUrl = null;
        this.createdAt = now;
        this.clients = new Set(); // set by the server: { role: 'host' | 'player', playerId }
        this.emptySince = now;
        this.gameOverAt = null;
        this.game.on('change', () => {
            if (this.game.phase !== 'GAME_OVER') this.gameOverAt = null;
        });
        this.game.on('gameEnded', () => {
            this.gameOverAt = Date.now();
        });
    }

    get hostConnected() {
        return [...this.clients].some((c) => c.role === 'host');
    }

    isPlayerOnline(playerId) {
        return [...this.clients].some((c) => c.role === 'player' && c.playerId === playerId);
    }

    addClient(client) {
        this.clients.add(client);
        this.emptySince = null;
    }

    removeClient(client, now = Date.now()) {
        this.clients.delete(client);
        if (this.clients.size === 0 && this.emptySince === null) this.emptySince = now;
    }

    dispose() {
        this.game.stopTimer();
        this.game.removeAllListeners();
        this.clients.clear();
    }
}

class RoomManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = { ...DEFAULTS, ...options };
        this.rooms = new Map(); // code -> Room
    }

    get size() {
        return this.rooms.size;
    }

    create(now = Date.now()) {
        if (this.rooms.size >= this.options.maxRooms) return { ok: false, code: 'SERVER_FULL' };
        let code;
        do code = randomCode(); while (this.rooms.has(code) || BLOCKED_CODES.has(code));
        const room = new Room(code, { maxPlayers: this.options.maxPlayers, now });
        this.rooms.set(code, room);
        return { ok: true, room };
    }

    get(code) {
        return typeof code === 'string' ? this.rooms.get(code.toUpperCase()) || null : null;
    }

    // Returns the room only if `token` is its host token.
    authorizeHost(code, token) {
        const room = this.get(code);
        if (!room) return { ok: false, code: 'ROOM_NOT_FOUND' };
        if (!tokensMatch(room.hostToken, token)) return { ok: false, code: 'HOST_TOKEN_INVALID' };
        return { ok: true, room };
    }

    delete(code, reason) {
        const room = this.rooms.get(code);
        if (!room) return;
        this.rooms.delete(code);
        // Listeners get the room before it is torn down so they can tell its clients.
        this.emit('roomClosed', room, reason);
        room.dispose();
    }

    // Deletes rooms nobody has used for a while. Returns the codes it removed.
    sweep(now = Date.now()) {
        const removed = [];
        for (const room of [...this.rooms.values()]) {
            if (room.emptySince !== null && now - room.emptySince >= this.options.idleMs) {
                this.delete(room.code, 'idle');
                removed.push(room.code);
            } else if (room.gameOverAt !== null && now - room.gameOverAt >= this.options.gameOverMs) {
                this.delete(room.code, 'gameOver');
                removed.push(room.code);
            }
        }
        return removed;
    }

    closeAll(reason) {
        for (const code of [...this.rooms.keys()]) this.delete(code, reason);
    }
}

module.exports = { RoomManager, Room, DEFAULTS, randomCode, BLOCKED_CODES };
