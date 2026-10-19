// Keeps PROTOCOL.md honest: parses its schema tables and checks every message a real
// server sends (during full games, errors, reconnects and room closing) against them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CLIENT_MESSAGES, ERROR_CODES } = require('../protocol');
const { GAME_EVENTS } = require('../game');
const { startServer, setupRoom, playFullGame, phoneFor } = require('./helpers');

const doc = fs.readFileSync(path.join(__dirname, '..', 'PROTOCOL.md'), 'utf8');

// ---------- Parse the doc ----------
// `<!-- schema: Name -->` and `<!-- enum: Name -->` are each followed by a markdown table.
function tableAfter(index) {
    const rows = [];
    const lines = doc.slice(index).split('\n').slice(1);
    let started = false;
    for (const line of lines) {
        if (!line.startsWith('|')) {
            if (started || line.trim()) break;
            continue;
        }
        started = true;
        rows.push(line.split('|').slice(1, -1).map((c) => c.trim()));
    }
    return rows.slice(2); // drop header and separator
}

const unquote = (cell) => cell.replace(/^`|`$/g, '');
const schemas = {};
const enums = {};
for (const m of doc.matchAll(/<!-- (schema|enum): ([\w.]+) -->/g)) {
    const rows = tableAfter(m.index);
    if (m[1] === 'enum') {
        enums[m[2]] = rows.map(([value]) => JSON.parse(unquote(value)));
    } else {
        schemas[m[2]] = rows.map(([field, type]) => {
            const name = unquote(field);
            return { name: name.replace(/\?$/, ''), optional: name.endsWith('?'), type: unquote(type) };
        });
    }
}
const examples = [...doc.matchAll(/<!-- example: ([\w.]+) -->\s*```json\n([\s\S]*?)```/g)]
    .map((m) => ({ name: m[1], json: JSON.parse(m[2]) }));

// ---------- Validate values against the doc's types ----------
function checkType(value, type, where) {
    if (type.endsWith('?')) {
        if (value === null) return;
        return checkType(value, type.slice(0, -1), where);
    }
    if (type.endsWith('[]')) {
        assert.ok(Array.isArray(value), `${where}: expected an array, got ${JSON.stringify(value)}`);
        value.forEach((v, i) => checkType(v, type.slice(0, -2), `${where}[${i}]`));
        return;
    }
    switch (type) {
        case 'string': return assert.equal(typeof value, 'string', `${where}: expected string`);
        case 'bool': return assert.equal(typeof value, 'boolean', `${where}: expected bool`);
        case 'int': return assert.ok(Number.isInteger(value), `${where}: expected int, got ${JSON.stringify(value)}`);
        default:
            if (enums[type]) return assert.ok(enums[type].includes(value), `${where}: ${JSON.stringify(value)} is not a ${type}`);
            assert.ok(schemas[type], `${where}: the doc uses type "${type}" but never defines it`);
            return checkObject(value, schemas[type], where);
    }
}

function checkObject(value, fields, where) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${where}: expected an object`);
    const known = new Set(fields.map((f) => f.name));
    for (const key of Object.keys(value)) {
        assert.ok(known.has(key), `${where}.${key} is sent but not documented`);
    }
    for (const f of fields) {
        if (!(f.name in value)) {
            assert.ok(f.optional, `${where}.${f.name} is documented but missing`);
            continue;
        }
        checkType(value[f.name], f.type, `${where}.${f.name}`);
    }
}

const ENVELOPE = [{ name: 'v', type: 'int' }, { name: 'type', type: 'string' }];

// `requestType` is what a reply answers, so we know which reply.* fields to expect.
function checkServerMessage(msg, requestType) {
    const schema = schemas[`server.${msg.type}`];
    assert.ok(schema, `server message "${msg.type}" is not documented`);
    assert.equal(msg.v, 1);
    let fields = [...ENVELOPE, ...schema];
    if (msg.type === 'reply' && msg.ok) {
        assert.ok(!('code' in msg) && !('error' in msg), 'successful replies carry no error');
        fields = [...fields, ...(schemas[`reply.${requestType}`] || [])];
    }
    if (msg.type === 'reply' && !msg.ok) {
        assert.ok('code' in msg && 'error' in msg, 'failed replies carry code and error');
    }
    checkObject(msg, fields, msg.type === 'reply' ? `reply(${requestType})` : msg.type);
}

// Records what each request id was for, so replies can be checked against the right table.
function trackRequests(client) {
    const types = new Map();
    const original = client.request.bind(client);
    client.request = (type, payload) => {
        types.set(`r${client.nextId}`, type);
        return original(type, payload);
    };
    client.requestTypes = types;
    return client;
}

// ---------- Tests ----------
test('the doc parses: every schema, enum and example', () => {
    assert.ok(Object.keys(schemas).length > 30);
    assert.ok(examples.length >= 5);
    for (const { name, json } of examples) {
        if (name.startsWith('server.')) checkServerMessage(json);
        else if (name.startsWith('reply.')) checkServerMessage(json, name.slice('reply.'.length));
        else checkType(json, name, name);
    }
});

test('documented client messages match what the server accepts', () => {
    const documented = Object.keys(schemas).filter((n) => n.startsWith('client.')).map((n) => n.slice(7));
    assert.deepEqual(documented.sort(), Object.keys(CLIENT_MESSAGES).sort());
    const docType = { string: 'string', integer: 'int', array: 'string[]' };
    for (const [type, spec] of Object.entries(CLIENT_MESSAGES)) {
        const fields = schemas[`client.${type}`];
        assert.deepEqual(fields.map((f) => f.name).sort(), Object.keys(spec).sort(), `fields of ${type}`);
        for (const f of fields) {
            assert.equal(f.type, docType[spec[f.name].type], `${type}.${f.name} type`);
            assert.equal(f.optional, !!spec[f.name].optional, `${type}.${f.name} optional`);
        }
    }
});

test('documented error codes and events match the code', () => {
    assert.deepEqual(enums.ErrorCode.sort(), Object.keys(ERROR_CODES).sort());
    // Every code the game rules can return is a documented one.
    const gameCodes = [...fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8').matchAll(/fail\([^;]*?'([A-Z_]+)'\)/g)].map((m) => m[1]);
    assert.ok(gameCodes.length > 10);
    for (const code of gameCodes) assert.ok(enums.ErrorCode.includes(code), `game.js returns undocumented ${code}`);
    for (const type of GAME_EVENTS) assert.ok(schemas[`server.${type}`], `event ${type} is not documented`);
});

test('real server traffic matches the documented shapes', async (t) => {
    const srv = await startServer(t);
    const connect = srv.connect;
    srv.connect = async (opts) => trackRequests(await connect(opts));

    // A full game, plus the less common paths.
    const { host, phones, code, hostToken } = await playFullGame(srv, { words: 2 });
    const extra = await srv.connect();
    await extra.request('ping');
    await extra.request('lookupRoom', { code });
    await extra.request('lookupRoom', { code: code === 'ZZZZ' ? 'YYYY' : 'ZZZZ' });
    await extra.request('resumeHost', { code, hostToken });
    await extra.request('nope');
    extra.sendRaw('not json');
    await extra.waitFor('error');
    await phones[0].request('leaveRoom');
    await host.request('playAgain');
    await host.until((s) => s.phase === 'LOBBY');

    // Mid-turn traffic with a paused clock and a word on screen.
    const second = await setupRoom(srv, { prefix: 'two' });
    await second.host.request('startSubmission', { timer: 30, words: 1 });
    for (const p of second.phones) await p.request('submitWords', { words: ['w'] });
    await second.host.request('startRound');
    const s = await second.host.until((x) => x.phase === 'GAMELOOP');
    const actor = phoneFor(second.phones, s.activePlayerId);
    await actor.request('startTurn');
    await actor.until((x) => x.currentWord);
    await second.host.request('togglePause');
    await second.host.request('skipTurn');
    await second.host.request('closeRoom');
    await second.phones[0].waitFor('roomClosed').catch(() => {});

    const seenTypes = new Set();
    const seenReplies = new Set();
    let count = 0;
    for (const client of srv.clients) {
        for (const msg of client.log) {
            const requestType = msg.type === 'reply' ? client.requestTypes.get(msg.id) : undefined;
            checkServerMessage(msg, requestType);
            seenTypes.add(msg.type);
            if (msg.type === 'reply' && msg.ok) seenReplies.add(requestType);
            count++;
        }
    }
    assert.ok(count > 200, `checked ${count} messages`);

    // Everything the doc promises actually showed up.
    const documentedServer = Object.keys(schemas).filter((n) => n.startsWith('server.')).map((n) => n.slice(7));
    for (const type of documentedServer) assert.ok(seenTypes.has(type), `never saw a "${type}" message`);
    const documentedReplies = Object.keys(schemas).filter((n) => n.startsWith('reply.')).map((n) => n.slice(6));
    for (const type of documentedReplies) assert.ok(seenReplies.has(type), `never saw a successful "${type}" reply`);
    // The paused, mid-turn state with a word showed up too.
    assert.ok(actor.log.some((m) => m.type === 'state' && m.state.currentWord && m.state.turnEndsAt));
    assert.ok(second.host.log.some((m) => m.type === 'state' && m.state.paused && m.state.turnEndsAt === null));
});
