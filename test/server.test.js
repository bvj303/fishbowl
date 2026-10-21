// End-to-end: a real server, real WebSockets, the JSON protocol from PROTOCOL.md.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, setupRoom, playFullGame, phoneFor, wait } = require('./helpers');

test('a full game over WebSockets', async (t) => {
    const srv = await startServer(t);
    const { host, phones, code } = await setupRoom(srv);
    const created = host.of('reply')[0];
    assert.match(created.room.joinUrl, new RegExp(`^http://.+/${code}$`));
    assert.match(created.room.qrDataUrl, /^data:image\/png/);

    const denied = await phones[0].request('startSubmission', { timer: 30, words: 1 });
    assert.equal(denied.ok, false, 'phones cannot run host actions');
    assert.equal(denied.code, 'NOT_HOST');
    assert.ok((await host.request('startSubmission', { timer: 30, words: 1 })).ok);

    for (const [i, phone] of phones.entries()) {
        assert.ok((await phone.request('submitWords', { words: [`word ${i}`] })).ok);
    }
    await host.until((s) => s.phase === 'READY_TO_START');
    assert.ok((await host.request('startRound')).ok);
    const { activePlayerId } = await host.until((s) => s.phase === 'GAMELOOP');

    const actor = phoneFor(phones, activePlayerId);
    assert.ok((await actor.request('startTurn')).ok);
    assert.ok((await actor.until((s) => s.currentWord)).currentWord.text, 'actor sees the word');
    const watcher = phones.find((p) => p !== actor);
    assert.equal(watcher.state.currentWord, null, 'others do not');

    // A dropped connection keeps the seat, and reconnecting restores it.
    actor.ws.close();
    await host.until((s) => !s.players.find((p) => p.id === activePlayerId).connected);
    const back = await srv.connect();
    const name = host.state.players.find((p) => p.id === activePlayerId).name;
    assert.ok((await back.request('joinRoom', { code, playerId: activePlayerId, name })).ok);
    const st = await back.until((s) => s.you === activePlayerId);
    assert.ok(st.currentWord, 'still the actor after reconnecting');
    await host.until((s) => s.players.find((p) => p.id === activePlayerId).connected);

    for (let i = 0; i < 4; i++) {
        const word = back.state.currentWord;
        assert.ok((await back.request('gotWord', { wordId: word.id })).ok);
    }
    await host.until((s) => s.phase === 'ROUND_OVER');
    assert.equal(host.state.round, 1);
    assert.equal(host.state.scores.A + host.state.scores.B, 4);
});

test('rooms get short unambiguous codes and a secret host token', async (t) => {
    const srv = await startServer(t);
    const host = await srv.connect();
    const codes = new Set();
    for (let i = 0; i < 20; i++) {
        const res = await host.request('createRoom');
        assert.ok(res.ok);
        assert.match(res.room.code, /^[A-HJ-NP-Z]{4}$/, 'no I, O, 0 or 1');
        assert.ok(res.room.hostToken.length >= 24);
        codes.add(res.room.code);
    }
    assert.equal(codes.size, 20, 'no collisions with live rooms');
    assert.equal(srv.rooms.size, 20);

    // Only the most recent room is attached to this connection; state carries no token.
    await host.until((s) => s.room.code === [...codes].pop());
    assert.equal(JSON.stringify(host.of('state')).includes('hostToken'), false);
});

test('phones join by code (any case) and get clear errors for unknown codes', async (t) => {
    const srv = await startServer(t);
    const { code } = await setupRoom(srv, { players: 1 });
    const phone = await srv.connect();

    const look = await phone.request('lookupRoom', { code: code.toLowerCase() });
    assert.ok(look.ok);
    assert.deepEqual(look.room, { code, phase: 'LOBBY', playerCount: 1, maxPlayers: 12, hostConnected: true });

    const missing = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    const unknown = await phone.request('joinRoom', { code: missing, playerId: 'phone-xyz', name: 'Zed' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'ROOM_NOT_FOUND');
    assert.match(unknown.error, /no game with that code/i);
    assert.equal((await phone.request('lookupRoom', { code: missing })).code, 'ROOM_NOT_FOUND');

    const joined = await phone.request('joinRoom', { code: code.toLowerCase(), playerId: 'phone-xyz', name: 'Zed' });
    assert.ok(joined.ok);
    assert.equal(joined.room.code, code);
    assert.equal(joined.playerId, 'phone-xyz');
    const state = await phone.until((s) => s.you === 'phone-xyz');
    assert.equal(state.room.code, code);
    assert.ok(state.room.hostConnected);
    // The reply always comes before the first state for the new seat.
    const firstReply = phone.log.findIndex((m) => m.type === 'reply' && m.id === phone.log.at(-2)?.id);
    assert.ok(firstReply !== -1 && phone.log[firstReply + 1].type === 'state');
});

test('host actions need the host token; phones and wrong tokens are rejected', async (t) => {
    const srv = await startServer(t);
    const { phones, code, hostToken } = await setupRoom(srv);

    const stranger = await srv.connect();
    assert.equal((await stranger.request('startRound')).code, 'NOT_HOST', 'a fresh connection is not a host');
    assert.equal((await stranger.request('closeRoom')).code, 'NOT_HOST');

    for (const type of ['startSubmission', 'shuffleTeams', 'startRound', 'togglePause', 'skipTurn', 'playAgain', 'resetLobby', 'closeRoom']) {
        const payload = type === 'startSubmission' ? { timer: 30, words: 1 } : {};
        const res = await phones[0].request(type, payload);
        assert.equal(res.code, 'NOT_HOST', `${type} is host-only`);
    }
    assert.equal((await phones[0].request('removePlayer', { playerId: phones[1].playerId })).code, 'NOT_HOST');

    const wrong = await stranger.request('resumeHost', { code, hostToken: hostToken.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) });
    assert.equal(wrong.code, 'HOST_TOKEN_INVALID');
    assert.equal((await stranger.request('startRound')).code, 'NOT_HOST', 'still not a host');
    const otherRoom = await stranger.request('resumeHost', { code: code === 'ZZZZ' ? 'YYYY' : 'ZZZZ', hostToken });
    assert.equal(otherRoom.code, 'ROOM_NOT_FOUND');

    // A host token for one room does nothing in another.
    const other = await setupRoom(srv, { players: 0 });
    assert.equal((await stranger.request('resumeHost', { code: other.code, hostToken })).code, 'HOST_TOKEN_INVALID');

    // The right token makes this connection a host too.
    const res = await stranger.request('resumeHost', { code, hostToken });
    assert.ok(res.ok);
    assert.equal(res.room.code, code);
    assert.ok((await stranger.request('startSubmission', { timer: 30, words: 1 })).ok);
});

test('two rooms play at the same time without touching each other', async (t) => {
    const srv = await startServer(t);
    // Run both games concurrently.
    const [red, blue] = await Promise.all([
        playFullGame(srv, { prefix: 'red', words: 2 }),
        playFullGame(srv, { prefix: 'blue', words: 2 }),
    ]);
    assert.notEqual(red.code, blue.code);
    for (const [room, mine, theirs] of [[red, 'red', 'blue'], [blue, 'blue', 'red']]) {
        assert.equal(room.host.state.phase, 'GAME_OVER');
        assert.equal(room.host.state.scores.A + room.host.state.scores.B, 3 * 8);
        assert.ok(room.host.state.players.every((p) => p.id.startsWith(`${mine}-`)));
        for (const client of [room.host, ...room.phones]) {
            const traffic = JSON.stringify(client.log);
            assert.equal(traffic.includes(theirs), false, `${mine} room saw ${theirs} traffic`);
            assert.ok(client.log.filter((m) => m.state).every((m) => m.state.room.code === room.code));
        }
    }
    // Words never appear in events, and only the actor ever saw word text.
    for (const room of [red, blue]) {
        const events = room.host.log.filter((m) => !['state', 'reply', 'welcome'].includes(m.type));
        assert.equal(JSON.stringify(events).includes('secret'), false);
        assert.equal(JSON.stringify(room.host.log).includes('secret'), false, 'host never sees words');
    }
});

test('phones in another room cannot reach this room', async (t) => {
    const srv = await startServer(t);
    const a = await setupRoom(srv, { prefix: 'a' });
    const b = await setupRoom(srv, { prefix: 'b' });
    assert.ok((await a.host.request('startSubmission', { timer: 30, words: 1 })).ok);
    await b.phones[0].until((s) => s.phase === 'LOBBY');
    assert.equal(srv.rooms.get(b.code).game.phase, 'LOBBY');
    // A player id from room A means nothing in room B's game.
    const res = await b.phones[0].request('submitWords', { words: ['x'] });
    assert.equal(res.code, 'WRONG_PHASE');
    assert.equal(srv.rooms.get(a.code).game.deck.length, 0);
});

test('host reconnects with the token and gets the same room back', async (t) => {
    const srv = await startServer(t);
    const { host, phones, code, hostToken } = await setupRoom(srv);
    assert.ok((await host.request('startSubmission', { timer: 30, words: 1 })).ok);

    host.ws.close();
    const waiting = await phones[0].until((s) => !s.room.hostConnected);
    assert.equal(waiting.phase, 'SUBMISSION', 'the game carries on without the host');

    const again = await srv.connect();
    const res = await again.request('resumeHost', { code, hostToken });
    assert.ok(res.ok);
    assert.equal(res.room.code, code);
    assert.equal(res.room.hostToken, hostToken);
    const st = await again.until((s) => s.room.code === code);
    assert.equal(st.phase, 'SUBMISSION');
    assert.equal(st.players.length, 4);
    await phones[0].until((s) => s.room.hostConnected);
    assert.ok((await again.request('togglePause')).code === 'WRONG_PHASE', 'host actions work again (rules apply)');
});

test('rooms are capped, and so are players per room', async (t) => {
    const srv = await startServer(t, { maxRooms: 2, maxPlayers: 5 });
    const { code } = await setupRoom(srv, { players: 5 });
    const sixth = await srv.connect();
    const full = await sixth.request('joinRoom', { code, playerId: 'late-player', name: 'Late' });
    assert.equal(full.code, 'ROOM_FULL');
    assert.match(full.error, /full/);

    // A player who already has a seat can still come back when the room is full.
    const rejoin = await sixth.request('joinRoom', { code, playerId: 'p-player-0', name: 'P 0' });
    assert.ok(rejoin.ok);

    const host = await srv.connect();
    assert.ok((await host.request('createRoom')).ok);
    const tooMany = await host.request('createRoom');
    assert.equal(tooMany.code, 'SERVER_FULL');
    assert.match(tooMany.error, /busy/);
});

test('room creation is rate limited per IP', async (t) => {
    const srv = await startServer(t, { createRoomLimit: { max: 3, windowMs: 60_000 } });
    const host = await srv.connect();
    for (let i = 0; i < 3; i++) assert.ok((await host.request('createRoom')).ok);
    const other = await srv.connect();
    assert.equal((await other.request('createRoom')).code, 'RATE_LIMITED', 'per IP, not per connection');
});

test('empty rooms are cleaned up after the idle timeout', async (t) => {
    const srv = await startServer(t, { roomIdleMs: 150, sweepIntervalMs: 30 });
    const { host, phones, code } = await setupRoom(srv, { players: 1 });
    await wait(250);
    assert.ok(srv.rooms.get(code), 'not while clients are connected');

    host.ws.close();
    phones[0].ws.close();
    await wait(80);
    assert.ok(srv.rooms.get(code), 'not straight away');
    await wait(250);
    assert.equal(srv.rooms.get(code), null);

    const late = await srv.connect();
    assert.equal((await late.request('lookupRoom', { code })).code, 'ROOM_NOT_FOUND');
});

test('finished games are cleaned up, and connected clients are told why', async (t) => {
    const srv = await startServer(t, { gameOverMs: 200, sweepIntervalMs: 30 });
    const { host, phones, code } = await playFullGame(srv);
    assert.ok(srv.rooms.get(code));
    const closed = await phones[0].waitFor('roomClosed', () => true, { timeout: 2000 });
    assert.deepEqual({ code: closed.code, reason: closed.reason }, { code, reason: 'gameOver' });
    await host.waitFor('roomClosed', () => true, { timeout: 500 }).catch(() => {});
    assert.equal(srv.rooms.get(code), null);
    assert.equal((await phones[0].request('startTurn')).code, 'NOT_IN_ROOM');
});

test('play again keeps a finished room alive', async (t) => {
    const srv = await startServer(t, { gameOverMs: 200, sweepIntervalMs: 30 });
    const { host, code } = await playFullGame(srv);
    assert.ok((await host.request('playAgain')).ok);
    await wait(350);
    assert.ok(srv.rooms.get(code));
});

test('the host can close the room', async (t) => {
    const srv = await startServer(t);
    const { host, phones, code } = await setupRoom(srv, { players: 1 });
    assert.ok((await host.request('closeRoom')).ok);
    const msg = await phones[0].waitFor('roomClosed', () => true).catch(() => phones[0].of('roomClosed')[0]);
    assert.equal((msg || phones[0].of('roomClosed')[0]).reason, 'closedByHost');
    assert.equal(srv.rooms.get(code), null);
});

test('malformed messages get error replies and never crash the server', async (t) => {
    const srv = await startServer(t);
    const c = await srv.connect();
    const errorFor = async (raw) => {
        const next = c.waitFor('error');
        c.sendRaw(raw);
        return next;
    };
    assert.equal((await errorFor('not json')).code, 'BAD_REQUEST');
    assert.equal((await errorFor('[1,2,3]')).code, 'BAD_REQUEST');
    assert.equal((await errorFor('null')).code, 'BAD_REQUEST');
    assert.equal((await errorFor('"hello"')).code, 'BAD_REQUEST');
    assert.equal((await errorFor(JSON.stringify({ v: 1 }))).code, 'BAD_REQUEST');
    assert.equal((await errorFor(JSON.stringify({ v: 1, type: 'gotWord' }))).code, 'BAD_REQUEST', 'missing field');
    assert.equal((await errorFor(JSON.stringify({ v: 1, type: 'ping', id: 42 }))).code, 'BAD_REQUEST', 'numeric id');
    const binary = c.waitFor('error');
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal((await binary).code, 'BAD_REQUEST');

    const bad = (type, payload) => c.request(type, payload);
    assert.equal((await bad('fly')).code, 'UNKNOWN_TYPE');
    assert.equal((await bad('__proto__')).code, 'UNKNOWN_TYPE');
    assert.equal((await bad('toString')).code, 'UNKNOWN_TYPE');
    assert.equal((await bad('ping', { extra: 1 })).code, 'BAD_REQUEST', 'unknown fields are rejected');
    assert.equal((await bad('joinRoom', { code: 'AB', playerId: 'abcdefg', name: 'x' })).code, 'BAD_REQUEST');
    assert.equal((await bad('joinRoom', { code: 'ABCD', playerId: '../../etc', name: 'x' })).code, 'BAD_REQUEST');
    assert.equal((await bad('joinRoom', { code: 'ABCD', playerId: 'abcdefg', name: { $gt: '' } })).code, 'BAD_REQUEST');
    assert.equal((await bad('submitWords', { words: 'one' })).code, 'BAD_REQUEST');
    assert.equal((await bad('submitWords', { words: [1, 2] })).code, 'BAD_REQUEST');
    assert.equal((await bad('startSubmission', { timer: '60', words: 3 })).code, 'BAD_REQUEST');
    assert.equal((await bad('startSubmission', { timer: 60.5, words: 3 })).code, 'BAD_REQUEST');
    assert.equal((await bad('gotWord', { wordId: 'x' })).code, 'NOT_IN_ROOM', 'valid but not in a room');

    const pong = await c.request('ping');
    assert.ok(pong.ok, 'connection still works');
    assert.equal(typeof pong.serverNow, 'number');
    const res = await fetch(`${srv.httpUrl}/healthz`);
    assert.equal(res.status, 200, 'server still up');
});

test('incompatible protocol versions are rejected', async (t) => {
    const srv = await startServer(t);
    const c = await srv.connect();
    assert.equal(c.of('welcome')[0].protocolVersion, 1);
    const reply = c.waitFor('reply');
    c.sendRaw(JSON.stringify({ v: 2, type: 'ping', id: 'a' }));
    assert.equal((await reply).code, 'UNSUPPORTED_VERSION');
    assert.equal(await c.closed, 4000);
});

test('oversized messages close the connection', async (t) => {
    const srv = await startServer(t, { maxMessageBytes: 1024 });
    const c = await srv.connect();
    c.send('submitWords', { words: ['x'.repeat(2000)] });
    assert.equal(await c.closed, 1009);
    const d = await srv.connect();
    assert.ok((await d.request('ping')).ok, 'others are unaffected');
});

test('each connection is rate limited', async (t) => {
    const srv = await startServer(t, { rateLimit: { burst: 10, perSecond: 5, maxDrops: 30 } });
    const c = await srv.connect();
    const replies = await Promise.all(Array.from({ length: 20 }, () => c.request('ping')));
    const limited = replies.filter((r) => r.code === 'RATE_LIMITED');
    assert.equal(replies.filter((r) => r.ok).length, 10);
    assert.equal(limited.length, 10);
    assert.match(limited[0].error, /slow down/i);

    await wait(450); // ~2 tokens back
    assert.ok((await c.request('ping')).ok);

    // Flooding way past the limit gets the connection closed.
    for (let i = 0; i < 100; i++) c.send('ping');
    assert.equal(await c.closed, 1008);
});

test('heartbeat drops dead connections and marks the player offline', async (t) => {
    const srv = await startServer(t, { heartbeatMs: 80 });
    const { host, code } = await setupRoom(srv, { players: 0 });
    // A phone whose network silently died: it never answers pings.
    const dead = await srv.connect({ autoPong: false });
    assert.ok((await dead.request('joinRoom', { code, playerId: 'sleepy-phone', name: 'Sleepy' })).ok);
    await host.until((s) => s.players.some((p) => p.id === 'sleepy-phone' && p.connected));
    await host.until((s) => s.players.some((p) => p.id === 'sleepy-phone' && !p.connected), 1000);
    await dead.closed;
    // The live host kept answering pings and is still connected.
    await wait(200);
    assert.equal(host.ws.readyState, WebSocket.OPEN);
});

test('turn clock: deadline, pause/resume and reconnecting mid-turn', async (t) => {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    t.after(() => mock.timers.reset());
    const srv = await startServer(t);
    const { host, phones, code } = await setupRoom(srv);
    assert.ok((await host.request('startSubmission', { timer: 30, words: 1 })).ok);
    for (const phone of phones) assert.ok((await phone.request('submitWords', { words: ['w'] })).ok);
    await host.until((s) => s.phase === 'READY_TO_START');
    assert.ok((await host.request('startRound')).ok);
    let s = await host.until((x) => x.phase === 'GAMELOOP');
    assert.equal(s.turnEndsAt, null);
    assert.equal(s.remainingMs, 30_000);

    const actor = phoneFor(phones, s.activePlayerId);
    const started = host.waitFor('turnStarted');
    assert.ok((await actor.request('startTurn')).ok);
    const ev = await started;
    assert.equal(ev.turnEndsAt, 1_700_000_030_000);
    assert.equal(ev.serverNow, 1_700_000_000_000);
    assert.equal(ev.durationMs, 30_000);
    s = await host.until((x) => x.timerRunning);
    assert.equal(s.turnEndsAt, 1_700_000_030_000);
    assert.equal(s.remainingMs, 30_000);

    mock.timers.tick(12_000);
    assert.ok((await host.request('togglePause')).ok);
    s = await host.until((x) => x.paused);
    assert.equal(s.turnEndsAt, null, 'no deadline while paused');
    assert.equal(s.remainingMs, 18_000);
    mock.timers.tick(60_000); // paused time doesn't count
    assert.ok((await host.request('togglePause')).ok);
    s = await host.until((x) => !x.paused);
    assert.equal(s.turnEndsAt, 1_700_000_072_000 + 18_000);

    // A phone that reconnects mid-turn gets the same deadline, not a fresh countdown.
    mock.timers.tick(5_000);
    const watcher = phones.find((p) => p !== actor);
    watcher.ws.close();
    const back = await srv.connect();
    const name = host.state.players.find((p) => p.id === watcher.playerId).name;
    assert.ok((await back.request('joinRoom', { code, playerId: watcher.playerId, name })).ok);
    const msg = await back.waitFor('state').catch(() => back.of('state').at(-1));
    const st = msg.state || back.state;
    assert.equal(st.turnEndsAt, 1_700_000_090_000);
    assert.equal(st.remainingMs, 13_000);
    assert.equal(back.of('state').at(-1).serverNow, 1_700_000_077_000);

    // No more once-a-second ticks: nothing arrives while the clock just runs.
    const before = host.log.length;
    await wait(1200);
    assert.equal(host.log.length, before);
});

test('HTTP: health check, short join links, security headers and gzip', async (t) => {
    const srv = await startServer(t);
    const health = await fetch(`${srv.httpUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const page = await fetch(`${srv.httpUrl}/ABCD`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Fishbowl<\/title>/);
    assert.equal(page.headers.get('content-encoding'), 'gzip');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-cache');

    const audio = await fetch(`${srv.httpUrl}/buzzer.mp3`);
    assert.match(audio.headers.get('cache-control'), /max-age=86400/);
    assert.equal((await fetch(`${srv.httpUrl}/nope/nope`)).status, 404);
});

test('join URL comes from PUBLIC_URL, the proxy headers, or the LAN address', async (t) => {
    const joinUrlWith = async (srv, headers) => {
        const c = await srv.connect({ headers });
        return (await c.request('createRoom')).room.joinUrl;
    };

    const plain = await startServer(t);
    // The test connects to localhost, so phones would need the LAN address instead.
    assert.doesNotMatch(await joinUrlWith(plain, {}), /localhost/);
    assert.match(await joinUrlWith(plain, { Host: 'fishbowl.example.com' }), /^http:\/\/fishbowl\.example\.com\/[A-Z]{4}$/);
    // Behind a proxy (loopback is trusted by default): https and the public host.
    assert.match(
        await joinUrlWith(plain, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'play.example.com' }),
        /^https:\/\/play\.example\.com\/[A-Z]{4}$/,
    );

    const untrusted = await startServer(t, { trustProxy: '10.9.9.9' });
    assert.doesNotMatch(await joinUrlWith(untrusted, { 'X-Forwarded-Host': 'evil.example.com' }), /evil/);

    const hop = await startServer(t, { trustProxy: '1' });
    assert.match(await joinUrlWith(hop, { 'X-Forwarded-Proto': 'https', Host: 'fb.example.com' }), /^https:\/\/fb\.example\.com\//);
    const none = await startServer(t, { trustProxy: 'false' });
    assert.match(await joinUrlWith(none, { 'X-Forwarded-Proto': 'https', Host: 'fb.example.com' }), /^http:\/\/fb\.example\.com\//);

    const fixed = await startServer(t, { publicUrl: 'https://fishbowl.example.com/' });
    assert.match(await joinUrlWith(fixed, {}), /^https:\/\/fishbowl\.example\.com\/[A-Z]{4}$/);
});
