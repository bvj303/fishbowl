// Wire protocol: version, limits, error codes and strict validation of every client
// message. PROTOCOL.md is the human-readable source of truth; test/protocol.test.js
// checks this file and real server traffic against it.

const PROTOCOL_VERSION = 1;
const SUPPORTED_VERSIONS = [1];

const ERROR_CODES = {
    BAD_REQUEST: 'The message was not valid.',
    UNKNOWN_TYPE: 'Unknown message type.',
    UNSUPPORTED_VERSION: 'This app is out of date. Please refresh or update it.',
    RATE_LIMITED: 'Slow down a little!',
    SERVER_FULL: 'The server is busy right now. Please try again in a few minutes.',
    ROOM_NOT_FOUND: "There's no game with that code. Check the code on the TV.",
    ROOM_FULL: 'That game is full.',
    HOST_TOKEN_INVALID: 'This screen is no longer the host of that game.',
    NOT_HOST: 'Only the host screen can do that.',
    NOT_IN_ROOM: 'Join a game first.',
    INVALID_NAME: 'Please enter a name.',
    NAME_TAKEN: 'That name is already taken.',
    INVALID_WORDS: 'Please fill in all the words.',
    ALREADY_SUBMITTED: 'You already added your words.',
    WRONG_PHASE: "You can't do that right now.",
    NOT_ENOUGH_PLAYERS: 'You need at least 4 players.',
    NOT_YOUR_TURN: "It's not your turn.",
    STALE: 'That word was already answered.',
    LAST_WORD: "That's the last word in the bowl!",
    NOT_FOUND: 'Not found.',
    REJECTED: "You can't do that right now.",
    INTERNAL: 'Something went wrong. Please try again.',
};

// WebSocket close codes the server uses (besides the standard 1001/1008/1009/1012).
const CLOSE_CODES = {
    UNSUPPORTED_VERSION: 4000,
};

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O (and no digits, so no 0 or 1)
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;

// ---------- VALIDATION ----------
// Each field is { type, optional?, ...constraints }. Unknown fields are rejected.
const str = (min, max, extra = {}) => ({ type: 'string', min, max, ...extra });
const roomCode = { type: 'string', pattern: /^[A-Za-z]{4}$/, transform: (s) => s.toUpperCase() };
const playerId = str(6, 64, { pattern: /^[\w-]+$/ });

const CLIENT_MESSAGES = {
    // Anyone
    ping: {},
    createRoom: {},
    resumeHost: { code: roomCode, hostToken: str(16, 128) },
    lookupRoom: { code: roomCode },
    joinRoom: { code: roomCode, playerId, name: str(0, 64) },
    leaveRoom: {},
    // Players
    submitWords: { words: { type: 'array', max: 8, items: str(0, 200) } },
    startTurn: {},
    gotWord: { wordId: str(1, 64) },
    skipWord: { wordId: str(1, 64) },
    // Host only
    startSubmission: { timer: { type: 'integer', min: 1, max: 3600 }, words: { type: 'integer', min: 1, max: 100 } },
    shuffleTeams: {},
    startRound: {},
    togglePause: {},
    skipTurn: {},
    removePlayer: { playerId },
    playAgain: {},
    resetLobby: {},
    closeRoom: {},
};

const HOST_ONLY = new Set([
    'startSubmission', 'shuffleTeams', 'startRound', 'togglePause', 'skipTurn',
    'removePlayer', 'playAgain', 'resetLobby', 'closeRoom',
]);

const ENVELOPE_FIELDS = new Set(['v', 'type', 'id']);

function checkField(value, spec) {
    switch (spec.type) {
        case 'string':
            if (typeof value !== 'string') return 'must be a string';
            if (spec.min !== undefined && value.length < spec.min) return `must be at least ${spec.min} characters`;
            if (spec.max !== undefined && value.length > spec.max) return `must be at most ${spec.max} characters`;
            if (spec.pattern && !spec.pattern.test(value)) return 'has an invalid format';
            return null;
        case 'integer':
            if (!Number.isInteger(value)) return 'must be an integer';
            if (value < spec.min || value > spec.max) return `must be between ${spec.min} and ${spec.max}`;
            return null;
        case 'array': {
            if (!Array.isArray(value)) return 'must be an array';
            if (value.length > spec.max) return `must have at most ${spec.max} items`;
            for (const item of value) {
                const err = checkField(item, spec.items);
                if (err) return `items ${err}`;
            }
            return null;
        }
        default:
            return 'has an unknown type';
    }
}

// Parses and validates one raw text frame. Returns { ok: true, msg } where msg is
// { v, type, id, payload }, or { ok: false, code, error, id? }.
function parseClientMessage(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return { ok: false, code: 'BAD_REQUEST', error: 'Messages must be JSON.' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, code: 'BAD_REQUEST', error: 'Messages must be JSON objects.' };
    }
    // Echo a usable id back even when the rest of the message is bad.
    const id = typeof data.id === 'string' && data.id.length >= 1 && data.id.length <= 64 ? data.id : undefined;
    const bad = (error, code = 'BAD_REQUEST') => ({ ok: false, code, error, id });

    if (data.id !== undefined && id === undefined) return bad('"id" must be a string of 1-64 characters.');
    if (!SUPPORTED_VERSIONS.includes(data.v)) {
        return bad(`Unsupported protocol version. This server speaks v${PROTOCOL_VERSION}.`, 'UNSUPPORTED_VERSION');
    }
    if (typeof data.type !== 'string') return bad('"type" must be a string.');
    const spec = Object.prototype.hasOwnProperty.call(CLIENT_MESSAGES, data.type) ? CLIENT_MESSAGES[data.type] : null;
    if (!spec) return bad(`Unknown message type "${data.type.slice(0, 32)}".`, 'UNKNOWN_TYPE');

    const payload = {};
    for (const key of Object.keys(data)) {
        if (!ENVELOPE_FIELDS.has(key) && !Object.prototype.hasOwnProperty.call(spec, key)) {
            return bad(`Unexpected field "${key.slice(0, 32)}" in "${data.type}".`);
        }
    }
    for (const [key, fieldSpec] of Object.entries(spec)) {
        const value = data[key];
        if (value === undefined) {
            if (fieldSpec.optional) continue;
            return bad(`"${data.type}" needs "${key}".`);
        }
        const err = checkField(value, fieldSpec);
        if (err) return bad(`"${key}" ${err}.`);
        payload[key] = fieldSpec.transform ? fieldSpec.transform(value) : value;
    }
    return { ok: true, msg: { v: data.v, type: data.type, id, payload } };
}

module.exports = {
    PROTOCOL_VERSION,
    SUPPORTED_VERSIONS,
    ERROR_CODES,
    CLOSE_CODES,
    CLIENT_MESSAGES,
    HOST_ONLY,
    ROOM_CODE_ALPHABET,
    ROOM_CODE_PATTERN,
    parseClientMessage,
};
