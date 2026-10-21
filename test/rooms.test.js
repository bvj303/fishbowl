const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, BLOCKED_CODES } = require('../rooms');

test('codes are 4 letters with no lookalikes, unique among live rooms', () => {
    const rooms = new RoomManager({ maxRooms: 2000 });
    for (let i = 0; i < 1500; i++) {
        const { ok, room } = rooms.create();
        assert.ok(ok);
        assert.match(room.code, /^[A-HJ-NP-Z]{4}$/);
        assert.equal(BLOCKED_CODES.has(room.code), false);
    }
    assert.equal(rooms.size, 1500, 'no collisions');
    rooms.closeAll('test');
});

test('host tokens are checked per room', () => {
    const rooms = new RoomManager();
    const a = rooms.create().room;
    const b = rooms.create().room;
    assert.notEqual(a.hostToken, b.hostToken);
    assert.equal(rooms.authorizeHost(a.code, a.hostToken).room, a);
    assert.equal(rooms.authorizeHost(a.code.toLowerCase(), a.hostToken).room, a);
    assert.equal(rooms.authorizeHost(a.code, b.hostToken).code, 'HOST_TOKEN_INVALID');
    assert.equal(rooms.authorizeHost(a.code, undefined).code, 'HOST_TOKEN_INVALID');
    assert.equal(rooms.authorizeHost(a.code, `${a.hostToken}x`).code, 'HOST_TOKEN_INVALID');
    assert.equal(rooms.authorizeHost('QQQQ', a.hostToken).code, a.code === 'QQQQ' || b.code === 'QQQQ' ? 'HOST_TOKEN_INVALID' : 'ROOM_NOT_FOUND');
    rooms.closeAll('test');
});

test('each room has its own game', () => {
    const rooms = new RoomManager();
    const a = rooms.create().room;
    const b = rooms.create().room;
    a.game.join('player-1', 'Ann');
    assert.equal(b.game.players.size, 0);
    assert.notEqual(a.game, b.game);
    rooms.closeAll('test');
});

test('the room cap is enforced', () => {
    const rooms = new RoomManager({ maxRooms: 2 });
    assert.ok(rooms.create().ok);
    assert.ok(rooms.create().ok);
    assert.deepEqual(rooms.create(), { ok: false, code: 'SERVER_FULL' });
    rooms.closeAll('test');
});

test('sweep removes rooms that sat empty past the idle timeout', () => {
    const rooms = new RoomManager({ idleMs: 1000 });
    const closed = [];
    rooms.on('roomClosed', (room, reason) => closed.push([room.code, reason]));
    const busy = rooms.create(0).room;
    const quiet = rooms.create(0).room;
    const client = { role: 'host' };
    busy.addClient(client);

    assert.deepEqual(rooms.sweep(999), []);
    assert.deepEqual(rooms.sweep(1000), [quiet.code]);
    assert.deepEqual(closed, [[quiet.code, 'idle']]);
    assert.ok(rooms.get(busy.code), 'rooms with someone connected stay');

    busy.removeClient(client, 5000);
    assert.deepEqual(rooms.sweep(5999), []);
    assert.deepEqual(rooms.sweep(6000), [busy.code]);
    assert.equal(rooms.size, 0);
});

test('sweep removes finished games that nobody restarted', () => {
    const rooms = new RoomManager({ gameOverMs: 1000 });
    const room = rooms.create(0).room;
    room.addClient({ role: 'host' });
    room.gameOverAt = 10_000;
    assert.deepEqual(rooms.sweep(10_999), []);
    assert.deepEqual(rooms.sweep(11_000), [room.code]);
});

test('closing a room stops its game clock', () => {
    const rooms = new RoomManager();
    const room = rooms.create().room;
    let stopped = false;
    room.game.stopTimer = () => { stopped = true; };
    rooms.delete(room.code, 'test');
    assert.ok(stopped);
    assert.equal(rooms.get(room.code), null);
});
