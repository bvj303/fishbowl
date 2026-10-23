const { test } = require('node:test');
const assert = require('node:assert/strict');
const { THEMES, DEFAULT_THEME, isTheme, publicThemes, pickWords, lookupDef } = require('../words');
const { Game, LIMITS } = require('../game');
const { createServer } = require('../server');
const { io: connect } = require('socket.io-client');

const ids = ['player-a1', 'player-a2', 'player-b1', 'player-b2'];
function lobby() {
    const game = new Game();
    ids.forEach((id, i) => game.join(id, `P${i}`));
    return game;
}

test('word bank: every entry has text and a short definition, with no duplicates', () => {
    const seen = new Set();
    for (const theme of THEMES) {
        assert.ok(theme.words.length >= 30, `${theme.id} has enough words`);
        for (const [text, def] of theme.words) {
            assert.ok(text && text.length <= LIMITS.wordLength, `${text} fits the word limit`);
            assert.ok(def && def.length <= 80, `${text} has a short definition`);
            const key = text.toLowerCase();
            assert.ok(!seen.has(key), `${text} appears only once`);
            seen.add(key);
        }
    }
});

test('themes: adult pack is flagged and kept out of the family-friendly mix', () => {
    const themes = publicThemes();
    assert.equal(themes[0].id, DEFAULT_THEME);
    assert.ok(themes.find((t) => t.id === 'fah').adult);
    assert.ok(themes.find((t) => t.id === 'chaos').adult);
    assert.ok(themes.filter((t) => !t.adult).length >= 8);

    const adultWords = new Set(THEMES.find((t) => t.id === 'fah').words.map(([w]) => w));
    for (let i = 0; i < 20; i++) {
        assert.ok(pickWords('random', 60).every((w) => !adultWords.has(w.text)), 'random never includes the adult pack');
    }
    assert.ok(pickWords('chaos', 400).some((w) => adultWords.has(w.text)), 'anything-goes does');
    assert.ok(pickWords('fah', 10).every((w) => adultWords.has(w.text)));
});

test('pickWords: distinct, respects exclusions, and tops up when a theme runs dry', () => {
    const picked = pickWords('movies', 10);
    assert.equal(new Set(picked.map((w) => w.text)).size, 10);
    assert.ok(picked.every((w) => w.def));

    const movies = THEMES.find((t) => t.id === 'movies').words.map(([w]) => w);
    const exclude = new Set(movies.slice(1).map((w) => w.toLowerCase()));
    assert.deepEqual(pickWords('movies', 1, exclude).map((w) => w.text), [movies[0]]);

    const big = pickWords('movies', movies.length + 15);
    assert.equal(big.length, movies.length + 15, 'extra words come from the random mix');
    assert.equal(new Set(big.map((w) => w.text)).size, big.length);
    assert.ok(pickWords('fah', 500).length > THEMES.find((t) => t.id === 'fah').words.length, 'adult pack tops up too');
});

test('isTheme and lookupDef validate input', () => {
    assert.ok(isTheme('random') && isTheme('chaos') && isTheme('fah'));
    assert.equal(isTheme('nope'), false);
    assert.equal(isTheme(undefined), false);
    assert.equal(lookupDef('  jurassic PARK '), 'Dinosaurs cloned from ancient DNA escape their island theme park.');
    assert.equal(lookupDef('not a real word'), null);
});

test('generated games fill the bowl, skip word entry and carry definitions', () => {
    const game = lobby();
    assert.ok(game.startSubmission({ timer: 30, words: 3, source: 'generated', theme: 'food' }).ok);
    assert.equal(game.phase, 'READY_TO_START');
    assert.equal(game.deck.length, ids.length * 3);
    assert.ok(game.deck.every((w) => w.def && w.id));
    assert.equal(new Set(game.deck.map((w) => w.text)).size, game.deck.length);
    assert.ok([...game.players.values()].every((p) => p.hasSubmitted && p.team));
    assert.equal(game.viewFor(ids[0]).config.theme, 'food');
    assert.equal(game.startRound().ok, true);
});

test('bad source or theme falls back to safe defaults', () => {
    const game = lobby();
    assert.ok(game.startSubmission({ source: 'hacker', theme: '<script>' }).ok);
    assert.equal(game.config.wordSource, 'players');
    assert.equal(game.config.theme, DEFAULT_THEME);
    assert.equal(game.phase, 'SUBMISSION');
});

test('suggestWord: only during word entry, avoids duplicates, and typed words get definitions', () => {
    const game = lobby();
    assert.equal(game.suggestWord(ids[0]).ok, false, 'not during the lobby');
    game.startSubmission({ words: 2, theme: 'animals' });

    const first = game.suggestWord(ids[0]);
    assert.ok(first.ok && first.word.text && first.word.def);
    for (let i = 0; i < 25; i++) {
        const next = game.suggestWord(ids[0], { exclude: [first.word.text, ...Array(30).fill('x')] });
        assert.notEqual(next.word.text, first.word.text, 'never repeats what is already typed');
    }
    assert.equal(game.suggestWord('stranger-xx').ok, false);

    // A suggested word typed in by hand (any case) still gets its definition; custom words don't.
    assert.ok(game.submitWords(ids[0], [first.word.text.toUpperCase(), 'My cat Gerald']).ok);
    assert.equal(game.deck[0].def, first.word.def);
    assert.equal(game.deck[1].def, null);
    assert.equal(game.suggestWord(ids[0]).ok, false, 'closed once they have submitted');

    // The suggester never receives words already in the bowl.
    for (let i = 0; i < 25; i++) {
        assert.ok(!game.deck.some((w) => w.text.toLowerCase() === game.suggestWord(ids[1]).word.text.toLowerCase()));
    }
});

test('only the clue-giver is sent the word and its definition', async (t) => {
    const { server, io, game } = createServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const url = `http://localhost:${server.address().port}`;
    const sockets = [];
    t.after(() => { sockets.forEach((s) => s.close()); game.stopTimer(); io.close(); server.close(); });
    const open = () => new Promise((resolve) => {
        const s = connect(url, { transports: ['websocket'], forceNew: true });
        sockets.push(s);
        s.on('state', (st) => { s.latest = st; });
        s.on('connect', () => resolve(s));
    });
    const call = (s, ev, ...a) => new Promise((r) => s.emit(ev, ...a, r));

    const host = await open();
    await call(host, 'registerHost');
    const phones = await Promise.all(ids.map(open));
    for (const [i, p] of phones.entries()) await call(p, 'joinGame', { playerId: ids[i], name: `P${i}` });
    assert.ok((await call(host, 'startSubmission', { words: 1, source: 'generated', theme: 'movies' })).ok);
    assert.ok((await call(host, 'startRound')).ok);

    const actor = phones[ids.indexOf(game.activePlayerId)];
    assert.ok((await call(actor, 'startTimer')).ok);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(actor.latest.currentWord.def, 'actor sees the definition');
    assert.equal(host.latest.currentWord, null, 'the TV never sees the word');
    assert.ok(phones.filter((p) => p !== actor).every((p) => p.latest.currentWord === null));
    assert.ok(host.latest.themes.length >= 10, 'themes are sent for the host drop-down');

    const suggestion = await call(phones[0], 'suggestWord', {});
    assert.equal(suggestion.ok, false, 'suggestions are closed once the game has started');
});
