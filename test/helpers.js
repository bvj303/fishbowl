// Shared bits for the end-to-end tests: start a real server and talk to it over ws.
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(t, options = {}) {
    const srv = createServer({ heartbeatMs: 60_000, ...options });
    await new Promise((resolve) => srv.server.listen(0, resolve));
    srv.url = `ws://localhost:${srv.server.address().port}/ws`;
    srv.httpUrl = `http://localhost:${srv.server.address().port}`;
    srv.clients = [];
    srv.connect = async (opts) => {
        const client = await Client.open(srv.url, opts);
        srv.clients.push(client);
        return client;
    };
    t.after(async () => {
        srv.clients.forEach((c) => c.ws.terminate());
        await srv.close();
    });
    return srv;
}

class Client {
    static open(url, opts = {}) {
        return new Promise((resolve, reject) => {
            const client = new Client(new WebSocket(url, opts));
            client.ws.once('error', reject);
            client.waitFor('welcome').then(() => resolve(client), reject);
        });
    }

    constructor(ws) {
        this.ws = ws;
        this.log = []; // every message received, in order
        this.state = null;
        this.waiters = [];
        this.nextId = 1;
        this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            this.log.push(msg);
            if (msg.type === 'state') this.state = msg.state;
            this.waiters = this.waiters.filter((w) => !w.check(msg));
        });
    }

    sendRaw(data) {
        this.ws.send(data);
    }

    send(type, payload = {}) {
        this.ws.send(JSON.stringify({ v: 1, type, ...payload }));
    }

    // Sends a request and resolves with its reply.
    request(type, payload = {}) {
        const id = `r${this.nextId++}`;
        const reply = this.waitFor('reply', (m) => m.id === id);
        this.ws.send(JSON.stringify({ v: 1, type, id, ...payload }));
        return reply;
    }

    // Resolves with the next message (from now, or already in the log if `fromLog`) matching.
    waitFor(type, match = () => true, { timeout = 2000 } = {}) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${type}"`)), timeout);
            this.waiters.push({
                check: (msg) => {
                    if (msg.type !== type || !match(msg)) return false;
                    clearTimeout(timer);
                    resolve(msg);
                    return true;
                },
            });
        });
    }

    // Waits until the latest state satisfies `predicate`.
    async until(predicate, timeout = 2000) {
        if (this.state && predicate(this.state)) return this.state;
        const msg = await this.waitFor('state', (m) => predicate(m.state), { timeout });
        return msg.state;
    }

    of(type) {
        return this.log.filter((m) => m.type === type);
    }
}

// A host plus `n` joined phones in a fresh room.
async function setupRoom(srv, { players = 4, prefix = 'p' } = {}) {
    const host = await srv.connect();
    const created = await host.request('createRoom');
    assert.ok(created.ok, created.error);
    const { code, hostToken } = created.room;
    await host.until((s) => s.room.code === code);
    const phones = [];
    for (let i = 0; i < players; i++) {
        const phone = await srv.connect();
        phone.playerId = `${prefix}-player-${i}`;
        const res = await phone.request('joinRoom', { code, playerId: phone.playerId, name: `${prefix.toUpperCase()} ${i}` });
        assert.ok(res.ok, res.error);
        await phone.until((s) => s.you === phone.playerId);
        phones.push(phone);
    }
    return { host, phones, code, hostToken };
}

const phoneFor = (phones, playerId) => phones.find((p) => p.playerId === playerId);

// Plays a whole 3-round game with one word per player, guessing every word on the first turn.
async function playFullGame(srv, { players = 4, prefix = 'p', words = 1 } = {}) {
    const room = await setupRoom(srv, { players, prefix });
    const { host, phones } = room;
    assert.ok((await host.request('startSubmission', { timer: 30, words })).ok);
    for (const [i, phone] of phones.entries()) {
        await phone.until((s) => s.phase === 'SUBMISSION');
        const list = Array.from({ length: words }, (_, k) => `${prefix} secret ${i}-${k}`);
        assert.ok((await phone.request('submitWords', { words: list })).ok);
    }
    await host.until((s) => s.phase === 'READY_TO_START');
    for (let round = 1; round <= 3; round++) {
        assert.ok((await host.request('startRound')).ok);
        const s = await host.until((st) => st.phase === 'GAMELOOP' && st.round === round);
        const actor = phoneFor(phones, s.activePlayerId);
        assert.ok((await actor.request('startTurn')).ok);
        // Skip once, so wordSkipped shows up in the logs too.
        let st = await actor.until((x) => x.currentWord);
        if (!st.lastWord) {
            assert.ok((await actor.request('skipWord', { wordId: st.currentWord.id })).ok);
        }
        while (true) {
            st = await actor.until((x) => x.currentWord || x.phase !== 'GAMELOOP');
            if (st.phase !== 'GAMELOOP') break;
            const res = await actor.request('gotWord', { wordId: st.currentWord.id });
            assert.ok(res.ok, res.error);
            await actor.until((x) => x.currentWord?.id !== st.currentWord.id);
        }
        await host.until((x) => x.phase === (round < 3 ? 'ROUND_OVER' : 'GAME_OVER'));
    }
    return room;
}

module.exports = { startServer, Client, setupRoom, playFullGame, phoneFor, wait };
