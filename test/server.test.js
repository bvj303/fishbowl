// End-to-end: a real server, one host socket and four phone sockets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

const call = (socket, event, ...args) =>
    new Promise((resolve) => socket.emit(event, ...args, resolve));

test('a full game over sockets', async (t) => {
    const { server, io, game } = createServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const url = `http://localhost:${server.address().port}`;
    const sockets = [];
    const open = () => {
        const s = connect(url, { transports: ['websocket'], forceNew: true });
        sockets.push(s);
        s.latest = null;
        s.on('state', (st) => { s.latest = st; });
        return new Promise((resolve) => s.on('connect', () => resolve(s)));
    };
    t.after(() => {
        sockets.forEach((s) => s.close());
        game.stopTimer();
        io.close();
        server.close();
    });

    const host = await open();
    const reg = await call(host, 'registerHost');
    assert.match(reg.url, /^http:\/\//);
    assert.match(reg.qr, /^data:image\/png/);

    const phones = await Promise.all([0, 1, 2, 3].map(open));
    for (const [i, phone] of phones.entries()) {
        assert.ok((await call(phone, 'joinGame', { playerId: `phone-${i}xx`, name: `Phone ${i}` })).ok);
    }

    const denied = await call(phones[0], 'startSubmission', { timer: 30, words: 1 });
    assert.equal(denied.ok, false, 'phones cannot run host actions');
    assert.ok((await call(host, 'startSubmission', { timer: 30, words: 1 })).ok);

    for (const [i, phone] of phones.entries()) {
        assert.ok((await call(phone, 'submitWords', [`word ${i}`])).ok);
    }
    assert.equal(game.phase, 'READY_TO_START');
    assert.ok((await call(host, 'startRound')).ok);

    const actorId = game.activePlayerId;
    const actorPhone = phones[Number(actorId.match(/phone-(\d)/)[1])];
    assert.ok((await call(actorPhone, 'startTimer')).ok);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(actorPhone.latest.currentWord, 'actor sees the word');
    const watcher = phones.find((p) => p !== actorPhone);
    assert.equal(watcher.latest.currentWord, null, 'others do not');

    // A dropped connection keeps the seat, and reconnecting restores it.
    actorPhone.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(game.players.get(actorId).connected, false);
    const back = await open();
    assert.ok((await call(back, 'joinGame', { playerId: actorId, name: game.players.get(actorId).name })).ok);
    assert.equal(game.players.get(actorId).connected, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(back.latest.currentWord, 'still the actor after reconnecting');

    for (let i = 0; i < 4; i++) {
        assert.ok((await call(back, 'gotWord', back.latest.currentWord?.id ?? game.currentWord.id)).ok);
        await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(game.phase, 'ROUND_OVER');
    assert.equal(host.latest.round, 1);
});
