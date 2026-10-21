// Fishbowl game rules and state. Has no knowledge of sockets: the server calls
// these methods, listens for 'change', and forwards the events in GAME_EVENTS.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const ROUNDS = [
    { name: 'Describe It', rule: 'Say anything except the word itself. No spelling, no "rhymes with".' },
    { name: 'Act It Out', rule: 'Charades! No talking or sounds — act it out.' },
    { name: 'One Word', rule: 'You get exactly ONE word as a clue. Choose wisely.' },
];

const LIMITS = {
    minPlayers: 4,
    maxPlayers: 12,
    nameLength: 16,
    wordLength: 60,
    timer: { min: 15, max: 180, default: 60 },
    words: { min: 1, max: 8, default: 3 },
};

const shuffle = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

const clampInt = (value, { min, max, default: fallback }) => {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

const cleanText = (value, maxLength) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';

// Small events a client can animate or play sounds for. None of them carry word text.
const GAME_EVENTS = ['turnStarted', 'wordGuessed', 'wordSkipped', 'turnEnded', 'roundStarted', 'roundEnded', 'gameEnded'];

const ok = (extra = {}) => ({ ok: true, ...extra });
// `code` is a stable, machine-readable reason (see PROTOCOL.md); `error` is for people.
const fail = (error, code = 'REJECTED') => ({ ok: false, error, code });

class Game extends EventEmitter {
    constructor({ maxPlayers = LIMITS.maxPlayers } = {}) {
        super();
        this.limits = { ...LIMITS, maxPlayers };
        this.config = { timerDuration: LIMITS.timer.default, wordsPerPlayer: LIMITS.words.default };
        this.turnTimeout = null;
        this.reset();
    }

    // Wipes everything, including players.
    reset() {
        this.stopTimer();
        this.players = new Map(); // id -> { id, name, team, connected, hasSubmitted }
        this.newGame();
    }

    // Keeps the players (and settings) but clears words, teams and scores.
    newGame() {
        this.stopTimer();
        this.phase = 'LOBBY';
        this.teams = { A: [], B: [] };
        this.teamIndices = { A: 0, B: 0 };
        this.scores = { A: 0, B: 0 };
        this.roundScores = ROUNDS.map(() => ({ A: 0, B: 0 }));
        this.deck = [];
        this.bowl = [];
        this.round = 1;
        this.activeTeam = 'A';
        this.activePlayerId = null;
        this.currentWord = null;
        this.resetClock();
        this.turnScore = 0;
        this.lastTurn = null;
        for (const [id, p] of this.players) {
            if (!p.connected) this.players.delete(id);
            p.team = null;
            p.hasSubmitted = false;
        }
        this.changed();
    }

    changed() {
        this.emit('change');
    }

    // ---------- PLAYERS ----------

    join(playerId, rawName) {
        const name = cleanText(rawName, LIMITS.nameLength);
        if (!name) return fail('Please enter a name.', 'INVALID_NAME');
        if (typeof playerId !== 'string' || !/^[\w-]{6,64}$/.test(playerId)) return fail('Invalid player id.', 'BAD_REQUEST');

        const existing = this.players.get(playerId);
        const clash = [...this.players.values()].find(
            (p) => p.id !== playerId && p.name.toLowerCase() === name.toLowerCase()
        );

        if (existing) {
            if (clash) return fail(`"${name}" is already taken.`, 'NAME_TAKEN');
            existing.name = name;
            existing.connected = true;
            this.changed();
            return ok({ player: existing });
        }

        if (clash) {
            // Same name, different device. If the original is offline this is almost
            // certainly the same person on a new browser/tab, so hand over the seat.
            if (clash.connected) return fail(`"${name}" is already taken. Try adding an initial.`, 'NAME_TAKEN');
            this.replaceId(clash.id, playerId);
            clash.connected = true;
            this.changed();
            return ok({ player: clash });
        }

        if (this.players.size >= this.limits.maxPlayers) {
            return fail(`This game is full (${this.limits.maxPlayers} players max).`, 'ROOM_FULL');
        }
        const player = { id: playerId, name, team: null, connected: true, hasSubmitted: false };
        if (this.phase !== 'LOBBY' && this.phase !== 'SUBMISSION') {
            // Late arrival: drop them onto the smaller team. They skip word entry.
            player.hasSubmitted = true;
            const team = this.teams.A.length <= this.teams.B.length ? 'A' : 'B';
            player.team = team;
            this.teams[team].push(playerId);
        }
        this.players.set(playerId, player);
        this.changed();
        return ok({ player });
    }

    replaceId(oldId, newId) {
        const player = this.players.get(oldId);
        this.players.delete(oldId);
        player.id = newId;
        this.players.set(newId, player);
        for (const team of ['A', 'B']) {
            this.teams[team] = this.teams[team].map((id) => (id === oldId ? newId : id));
        }
        if (this.activePlayerId === oldId) this.activePlayerId = newId;
    }

    setConnected(playerId, connected) {
        const player = this.players.get(playerId);
        if (!player || player.connected === connected) return;
        player.connected = connected;
        this.changed();
    }

    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (!player) return fail('Player not found.', 'NOT_FOUND');
        this.players.delete(playerId);

        if (player.team) {
            const list = this.teams[player.team];
            const idx = list.indexOf(playerId);
            list.splice(idx, 1);
            // Keep the rotation pointing at the same "next" person.
            if (idx < this.teamIndices[player.team]) this.teamIndices[player.team]--;
            if (this.teamIndices[player.team] >= list.length) this.teamIndices[player.team] = 0;
        }

        if (this.phase === 'SUBMISSION') {
            this.checkAllSubmitted();
        } else if (this.phase === 'GAMELOOP' && this.activePlayerId === playerId) {
            this.returnCurrentWord();
            this.advanceTurn({ switchTeam: false });
        }
        this.changed();
        return ok();
    }

    // ---------- SETUP ----------

    startSubmission(settings = {}) {
        if (this.phase !== 'LOBBY') return fail('The game has already started.', 'WRONG_PHASE');
        if (this.players.size < LIMITS.minPlayers) {
            return fail(`You need at least ${LIMITS.minPlayers} players (two teams of two).`, 'NOT_ENOUGH_PLAYERS');
        }
        this.config.timerDuration = clampInt(settings.timer, LIMITS.timer);
        this.config.wordsPerPlayer = clampInt(settings.words, LIMITS.words);
        this.resetClock();
        this.phase = 'SUBMISSION';
        this.changed();
        return ok();
    }

    submitWords(playerId, rawWords) {
        const player = this.players.get(playerId);
        if (!player) return fail('Join the game first.', 'NOT_IN_ROOM');
        if (this.phase !== 'SUBMISSION') return fail('Word entry is closed.', 'WRONG_PHASE');
        if (player.hasSubmitted) return fail('You already added your words.', 'ALREADY_SUBMITTED');
        if (!Array.isArray(rawWords)) return fail('Invalid words.', 'BAD_REQUEST');

        const words = rawWords.map((w) => cleanText(w, LIMITS.wordLength)).filter(Boolean);
        if (words.length !== this.config.wordsPerPlayer) {
            return fail(`Please fill in all ${this.config.wordsPerPlayer} words.`, 'INVALID_WORDS');
        }
        for (const text of words) {
            this.deck.push({ id: crypto.randomUUID(), text, by: playerId });
        }
        player.hasSubmitted = true;
        if (!this.checkAllSubmitted()) this.changed();
        return ok();
    }

    checkAllSubmitted() {
        const players = [...this.players.values()];
        if (players.length >= 2 && players.every((p) => p.hasSubmitted)) {
            this.assignTeams();
            return true;
        }
        return false;
    }

    assignTeams() {
        const ids = shuffle([...this.players.keys()]);
        const mid = Math.ceil(ids.length / 2);
        this.teams = { A: ids.slice(0, mid), B: ids.slice(mid) };
        this.teamIndices = { A: 0, B: 0 };
        for (const team of ['A', 'B']) {
            for (const id of this.teams[team]) this.players.get(id).team = team;
        }
        this.phase = 'READY_TO_START';
        this.changed();
    }

    shuffleTeams() {
        if (this.phase !== 'READY_TO_START') return fail('Teams can only be shuffled before round 1.', 'WRONG_PHASE');
        this.assignTeams();
        return ok();
    }

    // ---------- ROUNDS & TURNS ----------

    startRound() {
        if (this.phase === 'READY_TO_START') {
            this.round = 1;
            this.activeTeam = 'A';
            this.beginRound({ switchTeam: false });
        } else if (this.phase === 'ROUND_OVER') {
            this.round++;
            // The team that emptied the bowl already had their go; the other team starts.
            this.beginRound({ switchTeam: true });
        } else {
            return fail('A round is already in progress.', 'WRONG_PHASE');
        }
        return ok();
    }

    beginRound({ switchTeam }) {
        this.bowl = shuffle([...this.deck]);
        this.currentWord = null;
        this.lastTurn = null;
        this.phase = 'GAMELOOP';
        this.advanceTurn({ switchTeam });
        this.emit('roundStarted', { round: this.round, team: this.activeTeam });
    }

    // Picks the next player from `team` (skipping anyone offline) and moves the pointer.
    pickActor(team, { peek = false } = {}) {
        const ids = this.teams[team];
        if (ids.length === 0) return null;
        const start = this.teamIndices[team] % ids.length;
        let chosen = start;
        for (let k = 0; k < ids.length; k++) {
            const idx = (start + k) % ids.length;
            if (this.players.get(ids[idx])?.connected) {
                chosen = idx;
                break;
            }
        }
        if (!peek) this.teamIndices[team] = (chosen + 1) % ids.length;
        return ids[chosen];
    }

    otherTeam(team) {
        return team === 'A' ? 'B' : 'A';
    }

    advanceTurn({ switchTeam }) {
        this.resetClock();
        this.currentWord = null;
        this.turnScore = 0;

        let team = switchTeam ? this.otherTeam(this.activeTeam) : this.activeTeam;
        if (this.teams[team].length === 0) team = this.otherTeam(team);
        this.activeTeam = team;
        this.activePlayerId = this.pickActor(team);
        this.changed();
    }

    // Who will be acting after the current turn (for the "up next" hint).
    upNextId() {
        if (this.phase !== 'GAMELOOP') return null;
        let team = this.otherTeam(this.activeTeam);
        if (this.teams[team].length === 0) team = this.activeTeam;
        return this.pickActor(team, { peek: true });
    }

    // ---------- CLOCK ----------
    // The server owns the deadline. Clients get `turnEndsAt` (epoch ms) while the clock
    // runs, or `remainingMs` while it is paused or not started, and count down locally.

    resetClock() {
        this.stopTimer();
        this.remainingMs = this.config.timerDuration * 1000;
        this.turnEndsAt = null;
        this.paused = false;
    }

    // Whole seconds left, rounded up the way a countdown shows them.
    get timer() {
        return Math.ceil(this.timeLeftMs() / 1000);
    }

    timeLeftMs() {
        if (this.turnEndsAt === null) return this.remainingMs;
        return Math.max(0, this.turnEndsAt - Date.now());
    }

    startTimer(playerId) {
        if (this.phase !== 'GAMELOOP') return fail('No round in progress.', 'WRONG_PHASE');
        if (playerId !== this.activePlayerId) return fail("It's not your turn.", 'NOT_YOUR_TURN');
        if (this.timerRunning) return ok();
        if (!this.currentWord) this.currentWord = this.bowl.pop() || null;
        if (!this.currentWord) return fail('The bowl is empty.', 'WRONG_PHASE');
        this.timerRunning = true;
        this.paused = false;
        this.runClock();
        this.changed();
        this.emit('turnStarted', {
            round: this.round,
            team: this.activeTeam,
            playerId: this.activePlayerId,
            durationMs: this.config.timerDuration * 1000,
            turnEndsAt: this.turnEndsAt,
        });
        return ok();
    }

    runClock() {
        clearTimeout(this.turnTimeout);
        this.turnEndsAt = Date.now() + this.remainingMs;
        this.turnTimeout = setTimeout(() => this.endTurn(), this.remainingMs);
    }

    stopTimer() {
        clearTimeout(this.turnTimeout);
        this.turnTimeout = null;
        this.timerRunning = false;
    }

    togglePause() {
        if (this.phase !== 'GAMELOOP' || !this.timerRunning) return fail('Nothing to pause.', 'WRONG_PHASE');
        this.paused = !this.paused;
        if (this.paused) {
            clearTimeout(this.turnTimeout);
            this.remainingMs = this.timeLeftMs();
            this.turnEndsAt = null;
        } else {
            this.runClock();
        }
        this.changed();
        return ok();
    }

    // Validates that `playerId` is acting right now and is looking at `wordId`.
    // The word id check stops a double-tap from scoring a word nobody has seen.
    checkActing(playerId, wordId) {
        if (this.phase !== 'GAMELOOP' || !this.timerRunning || this.paused) return false;
        if (playerId !== this.activePlayerId || !this.currentWord) return false;
        return this.currentWord.id === wordId;
    }

    gotWord(playerId, wordId) {
        if (!this.checkActing(playerId, wordId)) return fail('That word was already answered.', 'STALE');
        const team = this.activeTeam;
        this.scores[team]++;
        this.roundScores[this.round - 1][team]++;
        this.turnScore++;
        this.currentWord = this.bowl.pop() || null;
        const guessed = { team, turnScore: this.turnScore, teamScore: this.scores[team], bowlCount: this.bowl.length };
        if (!this.currentWord) {
            this.endRound(guessed);
        } else {
            this.changed();
            this.emit('wordGuessed', guessed);
        }
        return ok();
    }

    skipWord(playerId, wordId) {
        if (!this.checkActing(playerId, wordId)) return fail('That word was already answered.', 'STALE');
        if (this.bowl.length === 0) return fail("That's the last word in the bowl!", 'LAST_WORD');
        this.bowl.unshift(this.currentWord);
        this.currentWord = this.bowl.pop();
        this.changed();
        this.emit('wordSkipped', { team: this.activeTeam });
        return ok();
    }

    returnCurrentWord() {
        if (this.currentWord) {
            this.bowl.push(this.currentWord);
            shuffle(this.bowl);
        }
        this.currentWord = null;
    }

    recordTurn(reason) {
        const actor = this.players.get(this.activePlayerId);
        this.lastTurn = {
            playerId: this.activePlayerId,
            name: actor ? actor.name : 'Someone',
            team: this.activeTeam,
            got: this.turnScore,
            reason,
        };
    }

    // Time ran out (or the host skipped the turn).
    endTurn(reason = 'time') {
        this.stopTimer();
        this.recordTurn(reason);
        const info = this.lastTurn;
        this.returnCurrentWord();
        this.advanceTurn({ switchTeam: true });
        this.emit('turnEnded', info);
    }

    skipTurn() {
        if (this.phase !== 'GAMELOOP') return fail('No round in progress.', 'WRONG_PHASE');
        this.endTurn('skipped');
        return ok();
    }

    // The bowl is empty. `guessed` is the wordGuessed event for the final word.
    endRound(guessed) {
        this.stopTimer();
        this.recordTurn('bowl');
        this.currentWord = null;
        this.paused = false;
        this.phase = this.round < ROUNDS.length ? 'ROUND_OVER' : 'GAME_OVER';
        this.changed();

        const scores = { ...this.scores };
        this.emit('wordGuessed', guessed);
        this.emit('turnEnded', this.lastTurn);
        this.emit('roundEnded', { round: this.round, roundScores: { ...this.roundScores[this.round - 1] }, scores });
        if (this.phase === 'GAME_OVER') {
            const winner = scores.A === scores.B ? null : scores.A > scores.B ? 'A' : 'B';
            this.emit('gameEnded', { scores, winner });
        }
    }

    playAgain() {
        if (this.phase !== 'GAME_OVER') return fail('The game is not over yet.', 'WRONG_PHASE');
        this.newGame();
        return ok();
    }

    // ---------- VIEW ----------

    // What a given client is allowed to see. Words stay secret except the actor's card.
    viewFor(playerId) {
        const isActor = !!playerId && playerId === this.activePlayerId;
        return {
            phase: this.phase,
            you: this.players.has(playerId) ? playerId : null,
            players: [...this.players.values()].map(({ id, name, team, connected, hasSubmitted }) => ({
                id, name, team, connected, hasSubmitted,
            })),
            teams: this.teams,
            scores: this.scores,
            roundScores: this.roundScores,
            config: this.config,
            limits: this.limits,
            rounds: ROUNDS,
            round: this.round,
            activeTeam: this.activeTeam,
            activePlayerId: this.activePlayerId,
            upNextId: this.upNextId(),
            timerRunning: this.timerRunning,
            paused: this.paused,
            turnEndsAt: this.timerRunning && !this.paused ? this.turnEndsAt : null,
            remainingMs: this.timeLeftMs(),
            bowlCount: this.bowl.length + (this.currentWord ? 1 : 0),
            deckCount: this.deck.length,
            turnScore: this.turnScore,
            lastTurn: this.lastTurn,
            currentWord: isActor && this.timerRunning && this.currentWord
                ? { id: this.currentWord.id, text: this.currentWord.text }
                : null,
            lastWord: isActor && this.bowl.length === 0 && !!this.currentWord,
        };
    }
}

module.exports = { Game, ROUNDS, LIMITS, GAME_EVENTS };
