// Fishbowl game rules and state. Has no knowledge of sockets: the server calls
// these methods and listens for 'change', 'tick' and 'turnEnded' events.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const ROUNDS = [
    { name: 'Describe It', rule: 'Say anything except the word itself. No spelling, no "rhymes with".' },
    { name: 'Act It Out', rule: 'Charades! No talking or sounds — act it out.' },
    { name: 'One Word', rule: 'You get exactly ONE word as a clue. Choose wisely.' },
];

const LIMITS = {
    minPlayers: 4,
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

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

class Game extends EventEmitter {
    constructor() {
        super();
        this.config = { timerDuration: LIMITS.timer.default, wordsPerPlayer: LIMITS.words.default };
        this.timerInterval = null;
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
        this.timer = this.config.timerDuration;
        this.timerRunning = false;
        this.paused = false;
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
        if (!name) return fail('Please enter a name.');
        if (typeof playerId !== 'string' || !/^[\w-]{6,64}$/.test(playerId)) return fail('Invalid player id.');

        const existing = this.players.get(playerId);
        const clash = [...this.players.values()].find(
            (p) => p.id !== playerId && p.name.toLowerCase() === name.toLowerCase()
        );

        if (existing) {
            if (clash) return fail(`"${name}" is already taken.`);
            existing.name = name;
            existing.connected = true;
            this.changed();
            return ok({ player: existing });
        }

        if (clash) {
            // Same name, different device. If the original is offline this is almost
            // certainly the same person on a new browser/tab, so hand over the seat.
            if (clash.connected) return fail(`"${name}" is already taken. Try adding an initial.`);
            this.replaceId(clash.id, playerId);
            clash.connected = true;
            this.changed();
            return ok({ player: clash });
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
        if (!player) return fail('Player not found.');
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
        if (this.phase !== 'LOBBY') return fail('The game has already started.');
        if (this.players.size < LIMITS.minPlayers) {
            return fail(`You need at least ${LIMITS.minPlayers} players (two teams of two).`);
        }
        this.config.timerDuration = clampInt(settings.timer, LIMITS.timer);
        this.config.wordsPerPlayer = clampInt(settings.words, LIMITS.words);
        this.timer = this.config.timerDuration;
        this.phase = 'SUBMISSION';
        this.changed();
        return ok();
    }

    submitWords(playerId, rawWords) {
        const player = this.players.get(playerId);
        if (!player) return fail('Join the game first.');
        if (this.phase !== 'SUBMISSION') return fail('Word entry is closed.');
        if (player.hasSubmitted) return fail('You already added your words.');
        if (!Array.isArray(rawWords)) return fail('Invalid words.');

        const words = rawWords.map((w) => cleanText(w, LIMITS.wordLength)).filter(Boolean);
        if (words.length !== this.config.wordsPerPlayer) {
            return fail(`Please fill in all ${this.config.wordsPerPlayer} words.`);
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
        if (this.phase !== 'READY_TO_START') return fail('Teams can only be shuffled before round 1.');
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
            return fail('A round is already in progress.');
        }
        return ok();
    }

    beginRound({ switchTeam }) {
        this.bowl = shuffle([...this.deck]);
        this.currentWord = null;
        this.lastTurn = null;
        this.phase = 'GAMELOOP';
        this.advanceTurn({ switchTeam });
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
        this.stopTimer();
        this.timer = this.config.timerDuration;
        this.currentWord = null;
        this.turnScore = 0;
        this.paused = false;

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

    startTimer(playerId) {
        if (this.phase !== 'GAMELOOP') return fail('No round in progress.');
        if (playerId !== this.activePlayerId) return fail("It's not your turn.");
        if (this.timerRunning) return ok();
        if (!this.currentWord) this.currentWord = this.bowl.pop() || null;
        if (!this.currentWord) return fail('The bowl is empty.');
        this.timerRunning = true;
        this.paused = false;
        this.runClock();
        this.changed();
        return ok();
    }

    runClock() {
        clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            this.timer = Math.max(0, this.timer - 1);
            if (this.timer === 0) this.endTurn();
            else this.emit('tick');
        }, 1000);
    }

    stopTimer() {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
        this.timerRunning = false;
    }

    togglePause() {
        if (this.phase !== 'GAMELOOP' || !this.timerRunning) return fail('Nothing to pause.');
        this.paused = !this.paused;
        if (this.paused) clearInterval(this.timerInterval);
        else this.runClock();
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
        if (!this.checkActing(playerId, wordId)) return fail('stale');
        this.scores[this.activeTeam]++;
        this.roundScores[this.round - 1][this.activeTeam]++;
        this.turnScore++;
        this.currentWord = this.bowl.pop() || null;
        if (!this.currentWord) this.endRound();
        else this.changed();
        return ok();
    }

    skipWord(playerId, wordId) {
        if (!this.checkActing(playerId, wordId)) return fail('stale');
        if (this.bowl.length === 0) return fail("That's the last word in the bowl!");
        this.bowl.unshift(this.currentWord);
        this.currentWord = this.bowl.pop();
        this.changed();
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
        this.returnCurrentWord();
        this.emit('turnEnded', this.lastTurn);
        this.advanceTurn({ switchTeam: true });
    }

    skipTurn() {
        if (this.phase !== 'GAMELOOP') return fail('No round in progress.');
        this.endTurn('skipped');
        return ok();
    }

    endRound() {
        this.stopTimer();
        this.recordTurn('bowl');
        this.currentWord = null;
        this.paused = false;
        this.phase = this.round < ROUNDS.length ? 'ROUND_OVER' : 'GAME_OVER';
        this.changed();
    }

    playAgain() {
        if (this.phase !== 'GAME_OVER') return fail('The game is not over yet.');
        this.newGame();
        return ok();
    }

    // ---------- VIEW ----------

    // What a given client is allowed to see. Words stay secret except the actor's card.
    viewFor(playerId) {
        const isActor = playerId && playerId === this.activePlayerId;
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
            limits: LIMITS,
            rounds: ROUNDS,
            round: this.round,
            activeTeam: this.activeTeam,
            activePlayerId: this.activePlayerId,
            upNextId: this.upNextId(),
            timer: this.timer,
            timerRunning: this.timerRunning,
            paused: this.paused,
            bowlCount: this.bowl.length + (this.currentWord ? 1 : 0),
            deckCount: this.deck.length,
            turnScore: this.turnScore,
            lastTurn: this.lastTurn,
            currentWord: isActor && this.timerRunning ? this.currentWord : null,
            lastWord: isActor && this.bowl.length === 0 && !!this.currentWord,
        };
    }
}

module.exports = { Game, ROUNDS, LIMITS };
