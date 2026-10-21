const socket = io();
const $ = (id) => document.getElementById(id);

let role = null; // 'host' | 'player'
let state = null;
let audioUnlocked = false;
let pendingWordId = null; // word we've already answered, to block double taps
let wordInputsKey = null;
let lastBuzzSecond = null;

// ---------- STORAGE (can throw in private mode) ----------
const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

// A stable id for this phone, so refreshing or a dropped connection puts you back in your seat.
// crypto.randomUUID only exists on https, and the game is usually served over plain http.
function getPlayerId() {
    let id = store.get('fishbowl_pid');
    if (!id) {
        id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        store.set('fishbowl_pid', id);
    }
    return id;
}

// ---------- HELPERS ----------
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function show(id, visible) { $(id).classList.toggle('hidden', !visible); }

function showOnly(ids, active) {
    ids.forEach((id) => show(id, id === active));
}

let toastTimer = null;
function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// Emit and surface any error the server sends back.
function send(event, ...args) {
    return new Promise((resolve) => {
        socket.timeout(8000).emit(event, ...args, (err, res) => {
            if (err) res = { ok: false, error: 'No response from the game. Check your Wi-Fi.' };
            resolve(res || { ok: true });
        });
    });
}

const player = (id) => state.players.find((p) => p.id === id);
const nameOf = (id) => (player(id) ? player(id).name : '—');
const teamClass = (t) => (t === 'A' ? 'team-a' : 'team-b');
const teamLabel = (t) => `Team ${t}`;
const roundInfo = (n) => state.rounds[n - 1];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function roundCard(n, label = `Round ${n} of ${state.rounds.length}`) {
    const r = roundInfo(n);
    return `<div class="round-label">${label}</div>
        <div class="round-name">${escapeHtml(r.name)}</div>
        <p class="round-rule">${escapeHtml(r.rule)}</p>`;
}

function leaderText() {
    const { A, B } = state.scores;
    if (A === B) return "It's all tied up!";
    const t = A > B ? 'A' : 'B';
    return `<span class="${teamClass(t)}-text">${teamLabel(t)}</span> leads by ${Math.abs(A - B)}`;
}

// Keep screens awake while playing (only works on https / localhost; harmless elsewhere).
let wakeLock = null;
async function keepAwake() {
    try {
        if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', keepAwake);

// ---------- ROLE SELECTION ----------
function chooseRole(newRole) {
    role = newRole;
    // Put the role in the URL so a refresh lands back on the same screen.
    history.replaceState(null, '', newRole === 'host' ? '?host' : '?join');
    show('landing', false);
    show('host', newRole === 'host');
    show('player', newRole === 'player');

    if (newRole === 'host') {
        registerHost();
        unlockAudio(false);
    } else {
        const saved = store.get('fishbowl_name');
        if (saved) $('p-name').value = saved;
        autoJoin();
    }
    keepAwake();
    if (state) render();
}

const params = new URLSearchParams(location.search);
if (params.has('host')) chooseRole('host');
else if (params.has('join') || params.has('play')) chooseRole('player');

// ---------- SOCKET ----------
socket.on('connect', () => {
    show('conn-banner', false);
    if (role === 'host') registerHost();
    if (role === 'player') autoJoin();
});
socket.on('disconnect', () => show('conn-banner', true));
socket.on('connect_error', () => show('conn-banner', true));

socket.on('state', (s) => {
    state = s;
    render();
});

socket.on('turnEnded', (info) => {
    if (role === 'host') {
        playBuzzer();
        const el = $('h-timesup');
        const what = info.reason === 'skipped' ? 'Turn skipped' : "Time's up!";
        el.innerHTML = `<div class="big">${what}</div>
            <div class="sub">${escapeHtml(info.name)} got ${plural(info.got, 'word')} for ${teamLabel(info.team)}</div>`;
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 2500);
    } else if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
    }
});

// ---------- HOST ----------
function registerHost() {
    socket.emit('registerHost', (info) => {
        if (!info) return;
        if (info.qr) $('qr-code').src = info.qr;
        $('join-url').textContent = info.url;
    });
}

async function hostAction(event, payload) {
    const res = await send(event, payload);
    if (!res.ok) toast(res.error);
}

function readSettings() {
    return { timer: $('set-timer').value, words: $('set-words').value };
}

function resetLobby() {
    if (confirm('Start over with a brand-new lobby? Everyone will need to join again.')) hostAction('resetLobby');
}

function skipTurn() {
    if (confirm(`Skip ${nameOf(state.activePlayerId)}'s turn?`)) hostAction('skipTurn');
}

function removePlayer(id) {
    if (confirm(`Remove ${nameOf(id)} from the game?`)) hostAction('removePlayer', id);
}
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) removePlayer(btn.dataset.remove);
});

function unlockAudio(fromClick) {
    const audio = $('sound-buzzer');
    audio.play().then(() => {
        audio.pause();
        audio.currentTime = 0;
        audioUnlocked = true;
        $('h-sound').classList.add('hidden');
    }).catch(() => {
        if (fromClick) toast("Your browser blocked sound. Check the tab isn't muted.");
    });
}
// Browsers only allow sound after the user interacts with the page.
document.addEventListener('pointerdown', () => {
    if (role === 'host' && !audioUnlocked) unlockAudio(false);
}, { capture: true });

function playBuzzer() {
    const audio = $('sound-buzzer');
    audio.currentTime = 0;
    audio.play().catch(() => {});
}

function renderHost() {
    const s = state;
    const screens = ['h-lobby', 'h-submission', 'h-ready', 'h-game', 'h-roundover', 'h-gameover'];
    const screen = {
        LOBBY: 'h-lobby', SUBMISSION: 'h-submission', READY_TO_START: 'h-ready',
        GAMELOOP: 'h-game', ROUND_OVER: 'h-roundover', GAME_OVER: 'h-gameover',
    }[s.phase];
    showOnly(screens, screen);

    const pill = $('h-round-pill');
    const inRounds = s.phase === 'GAMELOOP' || s.phase === 'ROUND_OVER';
    pill.classList.toggle('hidden', !inRounds);
    if (inRounds) pill.textContent = `Round ${s.round} of ${s.rounds.length} · ${roundInfo(s.round).name}`;

    if (s.phase === 'LOBBY') renderHostLobby();
    if (s.phase === 'SUBMISSION') renderHostSubmission();
    if (s.phase === 'READY_TO_START') renderHostReady();
    if (s.phase === 'GAMELOOP') renderHostGame();
    if (s.phase === 'ROUND_OVER') renderHostRoundOver();
    if (s.phase === 'GAME_OVER') renderHostGameOver();
}

function hostPlayerChip(p, { done = false } = {}) {
    const cls = [p.connected ? '' : 'offline', done ? 'done' : ''].join(' ');
    const title = p.connected ? '' : ' title="Disconnected"';
    return `<li class="${cls}"${title}><span class="dot"></span>${done ? '✓ ' : ''}${escapeHtml(p.name)}
        <button class="x-btn" aria-label="Remove ${escapeHtml(p.name)}" data-remove="${escapeHtml(p.id)}">✕</button></li>`;
}

function renderHostLobby() {
    const s = state;
    const min = s.limits.minPlayers;
    $('h-player-count').textContent = `(${s.players.length})`;
    $('h-lobby-players').innerHTML = s.players.length
        ? s.players.map((p) => hostPlayerChip(p)).join('')
        : '<li class="empty">Nobody yet — scan the code to join!</li>';
    const enough = s.players.length >= min;
    $('h-start').disabled = !enough;
    $('h-start-hint').textContent = enough
        ? 'Next, everyone adds their words on their phone.'
        : `Waiting for at least ${min} players (you have ${s.players.length}).`;
}

function renderHostSubmission() {
    const s = state;
    const done = s.players.filter((p) => p.hasSubmitted).length;
    $('h-sub-bar').style.width = `${(done / Math.max(1, s.players.length)) * 100}%`;
    const waiting = s.players.filter((p) => !p.hasSubmitted).map((p) => p.name);
    $('h-sub-count').innerHTML = `<b>${done} of ${s.players.length}</b> ready · ${plural(s.deckCount, 'word')} in the bowl` +
        (waiting.length && waiting.length <= 4 ? `<br><span class="muted">Waiting on ${escapeHtml(waiting.join(', '))}</span>` : '');
    $('h-sub-players').innerHTML = s.players.map((p) => hostPlayerChip(p, { done: p.hasSubmitted })).join('');
}

function teamCards() {
    return ['A', 'B'].map((t) => `
        <div class="team-card ${teamClass(t)}">
            <h2>${teamLabel(t)}</h2>
            <ul>${state.teams[t].map((id) => `<li>${escapeHtml(nameOf(id))}</li>`).join('')}</ul>
        </div>`).join('');
}

function renderHostReady() {
    $('h-teams').innerHTML = teamCards();
    $('h-ready-round').innerHTML = roundCard(1) +
        `<p class="muted small">${plural(state.deckCount, 'word')} in the bowl · ${state.config.timerDuration} seconds per turn</p>`;
}

function renderHostGame() {
    const s = state;
    const actor = player(s.activePlayerId);
    const urgent = s.timerRunning && !s.paused && s.timer <= 10;

    for (const t of ['A', 'B']) {
        const el = $(t === 'A' ? 'h-score-a' : 'h-score-b');
        el.classList.toggle('active', s.activeTeam === t);
        el.innerHTML = `<div class="label">${teamLabel(t)}</div><div class="score">${s.scores[t]}</div>`;
    }

    const clock = $('h-clock');
    clock.textContent = s.timer;
    clock.className = 'clock' + (s.paused ? ' paused' : urgent ? ' urgent' : !s.timerRunning ? ' idle' : '');

    let status;
    if (s.paused) status = '⏸ Paused';
    else if (s.timerRunning) status = `<span class="${teamClass(s.activeTeam)}-text">${teamLabel(s.activeTeam)}</span>, start guessing!`;
    else status = `Waiting for ${escapeHtml(actor ? actor.name : 'the player')} to press start on their phone…`;

    const facts = [`🐟 ${plural(s.bowlCount, 'word')} left in the bowl`];
    if (s.timerRunning) facts.push(`✓ ${s.turnScore} this turn`);
    if (s.upNextId) facts.push(`Up next: ${escapeHtml(nameOf(s.upNextId))}`);
    if (!s.timerRunning && s.lastTurn) {
        facts.push(`Last turn: ${escapeHtml(s.lastTurn.name)} got ${s.lastTurn.got}`);
    }

    $('h-stage').innerHTML = `
        <div class="now">${actor && !actor.connected ? '⚠️ Disconnected — ' : ''}Now giving clues</div>
        <div class="actor ${teamClass(s.activeTeam)}">${escapeHtml(actor ? actor.name : '—')}</div>
        <div class="status">${status}</div>
        <div class="facts">${facts.map((f) => `<span class="fact">${f}</span>`).join('')}</div>`;

    $('h-rosters').innerHTML = ['A', 'B'].map((t) => `
        <div class="roster ${teamClass(t)}">${s.teams[t].map((id) => {
            const p = player(id);
            const cls = [id === s.activePlayerId ? 'acting' : '', id === s.upNextId ? 'next' : '', p && !p.connected ? 'offline' : ''].join(' ');
            return `<span class="${cls}">${escapeHtml(nameOf(id))}</span>`;
        }).join('')}</div>`).join('');

    const pause = $('h-pause');
    pause.disabled = !s.timerRunning;
    pause.textContent = s.paused ? '▶ Resume' : '⏸ Pause';
}

function scoreTiles() {
    return `<div class="result-scores">${['A', 'B'].map((t) => `
        <div class="score-tile ${teamClass(t)}"><div class="label">${teamLabel(t)}</div><div class="score">${state.scores[t]}</div></div>`
    ).join('')}</div>`;
}

function breakdownTable(upTo) {
    const rows = state.roundScores.slice(0, upTo).map((r, i) =>
        `<tr><th>${i + 1}. ${escapeHtml(state.rounds[i].name)}</th><td class="team-a-text">${r.A}</td><td class="team-b-text">${r.B}</td></tr>`
    ).join('');
    return `<table class="breakdown"><tr><th></th><th class="team-a-text">A</th><th class="team-b-text">B</th></tr>${rows}</table>`;
}

function renderHostRoundOver() {
    const s = state;
    const next = s.round + 1;
    const ender = s.lastTurn ? `${escapeHtml(s.lastTurn.name)} emptied the bowl! ` : '';
    $('h-roundover-body').innerHTML = `
        <h1 class="big-title">Round ${s.round} done! 🎉</h1>
        <p class="lead">${ender}${leaderText()}</p>
        ${scoreTiles()}
        <div class="round-card">${roundCard(next, `Up next · Round ${next}`)}
            <p class="muted small">All the same words go back in the bowl. ${teamLabel(s.activeTeam === 'A' ? 'B' : 'A')} goes first.</p></div>`;
    $('h-next-round').textContent = `Start Round ${next} ▶`;
}

function winnerText() {
    const { A, B } = state.scores;
    if (A === B) return "It's a tie! 🤝";
    const t = A > B ? 'A' : 'B';
    return `<span class="${teamClass(t)}-text">${teamLabel(t)}</span> wins! 🏆`;
}

function renderHostGameOver() {
    $('h-gameover-body').innerHTML = `
        <h1 class="big-title">${winnerText()}</h1>
        ${scoreTiles()}
        ${breakdownTable(state.rounds.length)}`;
}

// ---------- PLAYER ----------
function autoJoin() {
    const name = store.get('fishbowl_name');
    if (name) send('joinGame', { playerId: getPlayerId(), name }).then(handleJoinResult);
}

async function joinGame() {
    const name = $('p-name').value.trim();
    if (!name) return showError('p-join-error', 'Please enter your name.');
    const res = await send('joinGame', { playerId: getPlayerId(), name });
    if (res.ok) store.set('fishbowl_name', name);
    handleJoinResult(res);
    unlockVibration();
}

function handleJoinResult(res) {
    if (res.ok) show('p-join-error', false);
    else showError('p-join-error', res.error);
}

async function leaveGame() {
    store.remove('fishbowl_name');
    await send('leaveGame');
    $('p-name').value = '';
    $('p-name').focus();
}

function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.classList.remove('hidden');
}

function unlockVibration() {
    // Some Android browsers only vibrate after a user gesture has called it once.
    if (navigator.vibrate) navigator.vibrate(1);
}

function renderWordInputs(count) {
    const key = `${count}`;
    if (wordInputsKey === key) return;
    wordInputsKey = key;
    const examples = ['Taylor Swift', 'The Eiffel Tower', 'Jurassic Park', 'Brushing your teeth', 'Batman', 'Pizza', 'Grandma', 'The Moon'];
    $('p-word-inputs').innerHTML = Array.from({ length: count }, (_, i) => `
        <div class="word-input-row"><span class="num">${i + 1}</span>
        <input type="text" class="word-input" maxlength="${state.limits.wordLength}" autocomplete="off" autocapitalize="sentences"
            placeholder="e.g. ${examples[i % examples.length]}" enterkeyhint="${i === count - 1 ? 'done' : 'next'}"></div>`).join('');
    $('p-submit-btn').disabled = false;
}

async function submitWords() {
    const inputs = [...document.querySelectorAll('.word-input')];
    const words = inputs.map((i) => i.value.trim());
    const empty = inputs.find((i) => !i.value.trim());
    if (empty) {
        empty.focus();
        return showError('p-submit-error', `Please fill in all ${inputs.length} words.`);
    }
    const lower = words.map((w) => w.toLowerCase());
    if (new Set(lower).size !== lower.length) return showError('p-submit-error', 'You entered the same word twice.');

    $('p-submit-btn').disabled = true;
    const res = await send('submitWords', words);
    if (res.ok) {
        show('p-submit-error', false);
        wordInputsKey = null; // fresh, empty inputs next game
    } else {
        $('p-submit-btn').disabled = false;
        showError('p-submit-error', res.error);
    }
}

async function startTurn() {
    unlockVibration();
    keepAwake();
    const res = await send('startTimer');
    if (!res.ok) toast(res.error);
}

async function answerWord(event) {
    const word = state.currentWord;
    if (!word || pendingWordId === word.id) return;
    pendingWordId = word.id;
    setTurnButtonsDisabled(true);
    const res = await send(event, word.id);
    if (!res.ok) {
        pendingWordId = null;
        setTurnButtonsDisabled(false);
        if (res.error !== 'stale') toast(res.error);
    }
}
const gotWord = () => answerWord('gotWord');
const skipWord = () => answerWord('skipWord');

function setTurnButtonsDisabled(disabled) {
    $('p-got').disabled = disabled;
    $('p-skip').disabled = disabled || state.lastWord;
}

function renderPlayer() {
    const s = state;
    const me = s.you ? player(s.you) : null;
    const screens = ['p-join', 'p-lobby', 'p-submit', 'p-info', 'p-turn-ready', 'p-turn'];

    const chip = $('p-me');
    chip.classList.toggle('hidden', !me);
    if (me) {
        chip.textContent = me.team ? `${me.name} · ${teamLabel(me.team)}` : me.name;
        chip.className = `me-chip ${me.team ? teamClass(me.team) : ''}`;
    }

    if (!me) {
        const late = s.phase !== 'LOBBY';
        $('p-join-title').textContent = late ? 'Game in progress' : 'Join the game';
        $('p-join-sub').textContent = late
            ? "You can still jump in — we'll put you on a team."
            : 'Enter the name everyone knows you by.';
        return showOnly(screens, 'p-join');
    }

    if (s.phase === 'LOBBY') {
        $('p-lobby-title').textContent = `You're in, ${me.name}!`;
        $('p-lobby-players').innerHTML = s.players.map((p) =>
            `<li class="no-x ${p.id === me.id ? 'you' : ''}">${escapeHtml(p.name)}</li>`).join('');
        return showOnly(screens, 'p-lobby');
    }

    if (s.phase === 'SUBMISSION' && !me.hasSubmitted) {
        const n = s.config.wordsPerPlayer;
        $('p-submit-sub').textContent = `Write ${n} ${n === 1 ? 'word or phrase' : 'words or phrases'} for others to guess.`;
        renderWordInputs(s.config.wordsPerPlayer);
        return showOnly(screens, 'p-submit');
    }

    if (s.phase === 'GAMELOOP' && s.activePlayerId === me.id) {
        if (!s.timerRunning) {
            $('p-turn-team').innerHTML = `Get <b class="${teamClass(s.activeTeam)}-text">your team</b> to guess as many words as you can.`;
            $('p-turn-rule').innerHTML = roundCard(s.round);
            $('p-turn-secs').textContent = s.config.timerDuration;
            return showOnly(screens, 'p-turn-ready');
        }
        renderTurn();
        return showOnly(screens, 'p-turn');
    }

    $('p-info-body').innerHTML = infoScreen(me);
    showOnly(screens, 'p-info');
}

function renderTurn() {
    const s = state;
    const urgent = s.timer <= 10;
    $('p-timer').textContent = `${s.timer}s`;
    $('p-timer').classList.toggle('urgent', urgent);
    const bar = $('p-timer-bar');
    bar.style.width = `${(s.timer / s.config.timerDuration) * 100}%`;
    bar.classList.toggle('urgent', urgent);
    $('p-turn-stats').textContent = `✓ ${s.turnScore} · ${s.bowlCount} left`;
    $('p-round-hint').textContent = roundInfo(s.round).name;
    show('p-paused', s.paused);
    show('p-last-word', s.lastWord);

    if (s.currentWord) {
        const wordEl = $('p-word');
        wordEl.textContent = s.currentWord.text;
        wordEl.classList.toggle('long', s.currentWord.text.length > 18);
        if (pendingWordId !== s.currentWord.id) {
            pendingWordId = null;
            setTurnButtonsDisabled(false);
        }
    }
    if (s.timer <= 5 && s.timer > 0 && s.timer !== lastBuzzSecond && navigator.vibrate) navigator.vibrate(80);
    lastBuzzSecond = s.timer;
}

function infoScreen(me) {
    const s = state;
    if (s.phase === 'SUBMISSION') {
        const waiting = s.players.filter((p) => !p.hasSubmitted).map((p) => p.name);
        return `<div class="big-emoji">✅</div><h1>Your words are in!</h1>
            <p class="muted">Waiting on ${escapeHtml(waiting.join(', ') || 'everyone')}…</p>`;
    }

    if (s.phase === 'READY_TO_START') {
        const mates = s.teams[me.team].filter((id) => id !== me.id).map(nameOf);
        return `<div class="team-hero ${teamClass(me.team)}"><div>You're on</div><div class="big">${teamLabel(me.team)}</div></div>
            <p class="lead">${mates.length ? `With ${escapeHtml(mates.join(', '))}` : ''}</p>
            <p class="muted">Sit near your teammates! The host will start Round 1.</p>`;
    }

    if (s.phase === 'GAMELOOP') {
        const actor = player(s.activePlayerId);
        const myTeamGuessing = s.activeTeam === me.team;
        let callout;
        if (s.paused) callout = '<div class="callout wait">⏸ Paused</div>';
        else if (myTeamGuessing) callout = `<div class="callout guess">🗣️ Your team is guessing — shout it out!</div>`;
        else callout = `<div class="callout wait">🤐 Other team's turn — no helping!</div>`;
        const upNext = s.upNextId === me.id ? '<div class="callout next">👀 You\'re up next — get ready!</div>' : '';
        return `<div class="round-card">${roundCard(s.round)}</div>
            <p class="muted">${s.timerRunning ? 'Giving clues' : 'Up now'}</p>
            <h1 class="${teamClass(s.activeTeam)}-text">${escapeHtml(actor ? actor.name : '—')}</h1>
            <div class="watch-timer ${s.timerRunning && s.timer <= 10 ? 'urgent' : ''}">${s.timer}</div>
            ${s.timerRunning ? callout : `<p class="muted">Waiting for them to start…</p>`}
            ${upNext}
            <p class="muted small">${plural(s.bowlCount, 'word')} left in the bowl</p>`;
    }

    const finalScores = `<div class="final-score">${['A', 'B'].map((t) => `
        <div class="${teamClass(t)}"><div>${teamLabel(t)}${t === me.team ? ' (you)' : ''}</div><div class="n">${s.scores[t]}</div></div>`).join('')}</div>`;

    if (s.phase === 'ROUND_OVER') {
        return `<div class="big-emoji">🎉</div><h1>Round ${s.round} done!</h1>
            <p class="lead">${leaderText()}</p>${finalScores}
            <div class="round-card">${roundCard(s.round + 1, 'Next up')}</div>`;
    }

    if (s.phase === 'GAME_OVER') {
        const { A, B } = s.scores;
        const won = A !== B && (A > B ? 'A' : 'B') === me.team;
        return `<div class="big-emoji">${A === B ? '🤝' : won ? '🏆' : '👏'}</div>
            <h1>${A === B ? "It's a tie!" : won ? 'Your team wins!' : 'Good game!'}</h1>${finalScores}
            <p class="muted">The host can start a new game from the TV.</p>`;
    }
    return '';
}

// ---------- RENDER ----------
function render() {
    if (!state || !role) return;
    if (role === 'host') renderHost();
    else renderPlayer();
}
