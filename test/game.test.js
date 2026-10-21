const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../game');

const ids = ['player-a1', 'player-a2', 'player-b1', 'player-b2'];

// A game with four players who have all submitted, sitting at READY_TO_START.
function readyGame({ words = 2 } = {}) {
    const game = new Game();
    ids.forEach((id, i) => game.join(id, `P${i}`));
    assert.ok(game.startSubmission({ timer: 30, words }).ok);
    ids.forEach((id) => assert.ok(game.submitWords(id, Array.from({ length: words }, (_, k) => `${id}-w${k}`)).ok));
    assert.equal(game.phase, 'READY_TO_START');
    return game;
}

function actor(game) {
    return game.activePlayerId;
}

test('needs four players to start and clamps settings', () => {
    const game = new Game();
    game.join('player-1', 'Ann');
    game.join('player-2', 'Bob');
    assert.equal(game.startSubmission({}).ok, false);
    game.join('player-3', 'Cat');
    game.join('player-4', 'Dan');
    assert.ok(game.startSubmission({ timer: 9999, words: -5 }).ok);
    assert.equal(game.config.timerDuration, 180);
    assert.equal(game.config.wordsPerPlayer, 1);
    assert.equal(game.startSubmission({}).ok, false, 'cannot restart submission mid-game');
});

test('names are unique; same device can rejoin; offline seat can be reclaimed', () => {
    const game = new Game();
    assert.ok(game.join('player-1', 'Ann').ok);
    assert.equal(game.join('player-2', 'ann').ok, false, 'case-insensitive clash with an online player');
    assert.ok(game.join('player-1', 'Ann').ok, 'same id rejoins');
    assert.equal(game.players.size, 1);

    game.setConnected('player-1', false);
    assert.ok(game.join('player-9', 'Ann').ok, 'new device takes over offline seat');
    assert.equal(game.players.size, 1);
    assert.ok(game.players.has('player-9'));
    assert.equal(game.join('bad id"', 'X').ok, false);
});

test('word submission is validated and only counted once', () => {
    const game = new Game();
    ids.forEach((id, i) => game.join(id, `P${i}`));
    game.startSubmission({ words: 2 });
    assert.equal(game.submitWords(ids[0], ['one']).ok, false);
    assert.equal(game.submitWords(ids[0], ['one', '   ']).ok, false);
    assert.ok(game.submitWords(ids[0], ['one', 'two']).ok);
    assert.equal(game.submitWords(ids[0], ['three', 'four']).ok, false, 'no double submit');
    assert.equal(game.deck.length, 2);
});

test('removing a player who never submits unblocks the game', () => {
    const game = new Game();
    [...ids, 'player-ghost'].forEach((id, i) => game.join(id, `P${i}`));
    game.startSubmission({ words: 1 });
    ids.forEach((id) => game.submitWords(id, [`${id}`]));
    assert.equal(game.phase, 'SUBMISSION');
    game.removePlayer('player-ghost');
    assert.equal(game.phase, 'READY_TO_START');
    assert.equal(game.teams.A.length + game.teams.B.length, 4);
});

test('words stay secret except for the active player with a running clock', () => {
    const game = readyGame();
    game.startRound();
    const a = actor(game);
    game.startTimer(a);
    const other = ids.find((id) => id !== a);
    assert.ok(game.viewFor(a).currentWord.text);
    assert.equal(game.viewFor(other).currentWord, null);
    assert.equal(game.viewFor(null).currentWord, null);
    assert.equal(JSON.stringify(game.viewFor(other)).includes('-w0'), false, 'no word text leaks');
    game.stopTimer();
});

test('only the active player can play, and double taps do not double score', () => {
    const game = readyGame();
    game.startRound();
    const a = actor(game);
    const other = ids.find((id) => id !== a);
    assert.equal(game.startTimer(other).ok, false);
    assert.ok(game.startTimer(a).ok);
    const word = game.currentWord.id;
    assert.equal(game.gotWord(other, word).ok, false);
    assert.ok(game.gotWord(a, word).ok);
    assert.equal(game.gotWord(a, word).ok, false, 'second tap on the same word is ignored');
    assert.equal(game.scores[game.activeTeam], 1);
    game.stopTimer();
});

test('skip cycles words and refuses on the last word', () => {
    const game = readyGame({ words: 1 });
    game.startRound();
    const a = actor(game);
    game.startTimer(a);
    for (let i = 0; i < 3; i++) game.gotWord(a, game.currentWord.id);
    assert.equal(game.bowl.length, 0);
    assert.equal(game.skipWord(a, game.currentWord.id).ok, false);
    game.stopTimer();
});

test('timer runs out on the server, word goes back, and the other team is up', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
        const game = readyGame();
        const ended = [];
        game.on('turnEnded', (info) => ended.push(info));
        game.startRound();
        const first = actor(game);
        const firstTeam = game.activeTeam;
        game.startTimer(first);
        game.gotWord(first, game.currentWord.id);
        mock.timers.tick(30_000);
        assert.equal(ended.length, 1);
        assert.equal(ended[0].got, 1);
        assert.notEqual(game.activeTeam, firstTeam);
        assert.equal(game.timerRunning, false);
        assert.equal(game.timer, 30);
        assert.equal(game.bowl.length, 7, 'unguessed word returned to the bowl');
    } finally {
        mock.timers.reset();
    }
});

test('pause stops the clock', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
        const game = readyGame();
        game.startRound();
        game.startTimer(actor(game));
        mock.timers.tick(5000);
        game.togglePause();
        mock.timers.tick(10_000);
        assert.equal(game.timer, 25);
        assert.equal(game.gotWord(actor(game), game.currentWord.id).ok, false, 'no scoring while paused');
        game.togglePause();
        mock.timers.tick(1000);
        assert.equal(game.timer, 24);
        game.stopTimer();
    } finally {
        mock.timers.reset();
    }
});

test('rotation alternates teams, cycles players, and skips disconnected players', () => {
    const game = readyGame();
    game.startRound();
    const seen = [];
    for (let i = 0; i < 4; i++) {
        seen.push([game.activeTeam, actor(game)]);
        game.skipTurn();
    }
    assert.deepEqual(seen.map(([t]) => t), ['A', 'B', 'A', 'B']);
    assert.equal(new Set(seen.map(([, id]) => id)).size, 4, 'everyone gets a turn');

    // Back to the first player; team B's next would be seen[1]. Take them offline and
    // the turn should go to their teammate instead.
    assert.equal(actor(game), seen[0][1]);
    game.setConnected(seen[1][1], false);
    assert.equal(game.upNextId(), seen[3][1]);
    game.skipTurn();
    assert.equal(actor(game), seen[3][1]);
});

test('removing the active player passes the turn to a teammate', () => {
    const game = readyGame();
    game.startRound();
    const a = actor(game);
    const team = game.activeTeam;
    game.startTimer(a);
    game.removePlayer(a);
    assert.equal(game.activeTeam, team);
    assert.notEqual(actor(game), a);
    assert.equal(game.bowl.length, 8, 'their word went back');
});

test('full game: three rounds, round numbers are correct, game over, play again', () => {
    const game = readyGame();
    assert.ok(game.startRound().ok);
    assert.equal(game.startRound().ok, false, 'cannot restart a running round');
    for (let round = 1; round <= 3; round++) {
        assert.equal(game.round, round);
        const a = actor(game);
        game.startTimer(a);
        while (game.currentWord) game.gotWord(a, game.currentWord.id);
        assert.equal(game.round, round, 'round number is the one just finished');
        if (round < 3) {
            assert.equal(game.phase, 'ROUND_OVER');
            const finisher = game.activeTeam;
            game.startRound();
            assert.notEqual(game.activeTeam, finisher, 'other team starts the next round');
        }
    }
    assert.equal(game.phase, 'GAME_OVER');
    assert.equal(game.scores.A + game.scores.B, 24);
    assert.equal(game.startRound().ok, false);

    game.setConnected(ids[3], false);
    assert.ok(game.playAgain().ok);
    assert.equal(game.phase, 'LOBBY');
    assert.equal(game.players.size, 3, 'offline players are cleared out');
    assert.deepEqual(game.scores, { A: 0, B: 0 });
    assert.equal(game.deck.length, 0);
});

test('late joiners are placed on the smaller team', () => {
    const game = readyGame();
    game.startRound();
    game.join('player-late', 'Late');
    const p = game.players.get('player-late');
    assert.ok(p.team);
    assert.equal(game.teams.A.length + game.teams.B.length, 5);
    assert.ok(game.teams[p.team].includes('player-late'));
});

test('the clock is a deadline: start, pause, resume and time running out', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    try {
        const game = readyGame();
        game.startRound();
        let view = game.viewFor(null);
        assert.equal(view.turnEndsAt, null, 'no deadline before the actor starts');
        assert.equal(view.remainingMs, 30_000);

        game.startTimer(actor(game));
        view = game.viewFor(null);
        assert.equal(view.turnEndsAt, 1_030_000);
        assert.equal(view.remainingMs, 30_000);
        assert.equal('timer' in view, false, 'no per-second counter in the view any more');

        mock.timers.tick(7_250);
        assert.equal(game.viewFor(null).turnEndsAt, 1_030_000, 'the deadline does not move');
        assert.equal(game.viewFor(null).remainingMs, 22_750);
        assert.equal(game.timer, 23, 'whole seconds round up');

        game.togglePause();
        view = game.viewFor(null);
        assert.equal(view.paused, true);
        assert.equal(view.turnEndsAt, null);
        assert.equal(view.remainingMs, 22_750);
        mock.timers.tick(100_000);
        assert.equal(game.viewFor(null).remainingMs, 22_750, 'paused time is not counted');
        assert.equal(game.phase, 'GAMELOOP');

        game.togglePause();
        assert.equal(game.viewFor(null).turnEndsAt, 1_107_250 + 22_750);

        const team = game.activeTeam;
        mock.timers.tick(22_749);
        assert.equal(game.activeTeam, team, 'not over a millisecond early');
        mock.timers.tick(1);
        assert.notEqual(game.activeTeam, team, 'the server ends the turn at the deadline');
        view = game.viewFor(null);
        assert.equal(view.timerRunning, false);
        assert.equal(view.turnEndsAt, null);
        assert.equal(view.remainingMs, 30_000, 'next turn starts full');
    } finally {
        mock.timers.reset();
    }
});

test('a player reconnecting mid-turn sees the same deadline', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000 });
    try {
        const game = readyGame();
        game.startRound();
        const a = actor(game);
        game.startTimer(a);
        const word = game.viewFor(a).currentWord;
        mock.timers.tick(10_000);
        game.setConnected(a, false);
        mock.timers.tick(3_000);
        assert.ok(game.join(a, game.players.get(a).name).ok);
        const view = game.viewFor(a);
        assert.equal(view.turnEndsAt, 35_000);
        assert.equal(view.remainingMs, 17_000);
        assert.deepEqual(view.currentWord, word, 'same card');
        assert.ok(game.gotWord(a, word.id).ok);
        game.stopTimer();
    } finally {
        mock.timers.reset();
    }
});

test('events for animations and sounds, with no word text', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
        const game = readyGame({ words: 1 });
        const seen = [];
        const { GAME_EVENTS } = require('../game');
        for (const type of GAME_EVENTS) game.on(type, (data) => seen.push([type, data]));

        game.startRound();
        assert.deepEqual(seen.shift(), ['roundStarted', { round: 1, team: 'A' }]);
        const a = actor(game);
        game.startTimer(a);
        assert.deepEqual(seen.shift(), ['turnStarted', { round: 1, team: 'A', playerId: a, durationMs: 30_000, turnEndsAt: 30_000 }]);
        game.skipWord(a, game.currentWord.id);
        assert.deepEqual(seen.shift(), ['wordSkipped', { team: 'A' }]);
        game.gotWord(a, game.currentWord.id);
        assert.deepEqual(seen.shift(), ['wordGuessed', { team: 'A', turnScore: 1, teamScore: 1, bowlCount: 2 }]);
        mock.timers.tick(30_000);
        const [type, ended] = seen.shift();
        assert.equal(type, 'turnEnded');
        assert.deepEqual(ended, { playerId: a, name: game.players.get(a).name, team: 'A', got: 1, reason: 'time' });

        // Team B empties the bowl: last guess, then the turn, round and (eventually) game end.
        const b = actor(game);
        game.startTimer(b);
        while (game.currentWord) game.gotWord(b, game.currentWord.id);
        const types = seen.map(([t]) => t);
        assert.deepEqual(types, ['turnStarted', 'wordGuessed', 'wordGuessed', 'wordGuessed', 'turnEnded', 'roundEnded']);
        assert.equal(seen.at(-2)[1].reason, 'bowl');
        assert.deepEqual(seen.at(-1)[1], { round: 1, roundScores: { A: 1, B: 3 }, scores: { A: 1, B: 3 } });
        assert.equal(JSON.stringify(seen).includes('-w0'), false, 'no word text in any event');

        seen.length = 0;
        for (let round = 2; round <= 3; round++) {
            game.startRound();
            const p = actor(game);
            game.startTimer(p);
            while (game.currentWord) game.gotWord(p, game.currentWord.id);
        }
        const last = seen.at(-1);
        assert.equal(last[0], 'gameEnded');
        assert.deepEqual(last[1].scores, game.scores);
        assert.equal(last[1].winner, game.scores.A > game.scores.B ? 'A' : game.scores.B > game.scores.A ? 'B' : null);
    } finally {
        mock.timers.reset();
    }
});

test('rooms cap the number of players, but seats can always be reclaimed', () => {
    const game = new Game({ maxPlayers: 4 });
    ids.forEach((id, i) => assert.ok(game.join(id, `P${i}`).ok));
    const full = game.join('player-extra', 'Extra');
    assert.equal(full.ok, false);
    assert.equal(full.code, 'ROOM_FULL');
    assert.ok(game.join(ids[0], 'P0').ok, 'rejoining your own seat still works');
    game.setConnected(ids[1], false);
    assert.ok(game.join('new-device-1', 'P1').ok, 'and so does taking over an offline seat');
    assert.equal(game.viewFor(null).limits.maxPlayers, 4);
});

test('failures carry a stable error code', () => {
    const game = readyGame();
    assert.equal(game.startSubmission({}).code, 'WRONG_PHASE');
    assert.equal(game.join('player-zz', 'P0').code, 'NAME_TAKEN');
    assert.equal(game.join('player-zz', '   ').code, 'INVALID_NAME');
    game.startRound();
    const other = ids.find((id) => id !== actor(game));
    assert.equal(game.startTimer(other).code, 'NOT_YOUR_TURN');
    game.startTimer(actor(game));
    assert.equal(game.gotWord(actor(game), 'nope').code, 'STALE');
    game.stopTimer();
});
