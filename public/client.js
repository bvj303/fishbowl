const PROTOCOL_VERSION = 1;
const $ = (id) => document.getElementById(id);

let role = null; // 'host' | 'player'
let state = null;
let audioUnlocked = false;
let pendingWordId = null; // word we've already answered, to block double taps
let wordInputsKey = null;
let lastBuzzSecond = null;
let ended = null; // { title, sub } once this game is over for good (room gone, server restarted…)

// ---------- STORAGE (can throw in private mode) ----------
const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
    getJson(key) { try { return JSON.parse(this.get(key)) || null; } catch { return null; } },
    setJson(key, value) { this.set(key, JSON.stringify(value)); },
};

// A stable id for this phone, so refreshing or a dropped connection puts you back in your seat.
// crypto.randomUUID only exists on https, and on a home network the game is served over plain http.
function getPlayerId() {
    let id = store.get('fishbowl_pid');
    if (!id) {
        id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        store.set('fishbowl_pid', id);
    }
    return id;
}

// Host tokens, per room code, so a refresh (or another tab) gets the same room back.
const hostRooms = {
    get(code) { return (store.getJson('fishbowl_hosts') || {})[code] || null; },
    set(code, value) {
        const all = store.getJson('fishbowl_hosts') || {};
        // Keep only a handful; old rooms are long gone on the server anyway.
        const kept = Object.entries(all).filter(([c]) => c !== code).slice(-4);
        store.setJson('fishbowl_hosts', Object.fromEntries([...kept, [code, value]]));
    },
    remove(code) {
        const all = store.getJson('fishbowl_hosts') || {};
        delete all[code];
        store.setJson('fishbowl_hosts', all);
    },
};

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

// Restarts a CSS animation class on an element.
function replayAnimation(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
}

const player = (id) => state.players.find((p) => p.id === id);
const nameOf = (id) => (player(id) ? player(id).name : '—');
const teamClass = (t) => (t === 'A' ? 'team-a' : 'team-b');
const teamLabel = (t) => `Team ${t}`;
const roundInfo = (n) => state.rounds[n - 1];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
const isCode = (s) => /^[A-HJ-NP-Z]{4}$/.test(s);

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

// ---------- CONNECTION ----------
// One WebSocket speaking the JSON protocol in PROTOCOL.md. Reconnects with backoff and
// re-identifies (host token or player id) every time it comes back.
const conn = {
    ws: null,
    ready: false, // got "welcome" on the current socket
    attempt: 0,
    retryTimer: null,
    pingTimer: null,
    nextId: 1,
    pending: new Map(), // id -> { resolve, timer }
    serverId: null,
    clockOffset: 0, // server clock minus ours, in ms
    bestRtt: Infinity,
    bestRttAt: 0,
    bannerTimer: null,
};

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const serverNow = () => Date.now() + conn.clockOffset;

function connect() {
    clearTimeout(conn.retryTimer);
    if (conn.ws || ended || !role) return; // no socket until the landing page picks a role
    const ws = new WebSocket(wsUrl());
    conn.ws = ws;
    conn.ready = false;
    ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        onServerMessage(msg);
    };
    ws.onclose = (e) => {
        if (conn.ws !== ws) return;
        dropSocket();
        if (e.code === 4000) return endGame('This page is out of date', 'Refresh the page to get the latest version.');
        scheduleReconnect();
    };
}

// Forget the current socket (dead or closed) and fail anything waiting on it.
function dropSocket() {
    const ws = conn.ws;
    conn.ws = null;
    conn.ready = false;
    clearInterval(conn.pingTimer);
    if (ws) {
        ws.onmessage = ws.onclose = null;
        try { ws.close(); } catch { /* already closed */ }
    }
    for (const [id, p] of conn.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, code: 'OFFLINE', error: 'Lost connection to the game. Reconnecting…' });
        conn.pending.delete(id);
    }
    // Only show the banner if we stay offline for a moment, so quick blips don't flash.
    clearTimeout(conn.bannerTimer);
    conn.bannerTimer = setTimeout(() => { if (!conn.ready && !ended) show('conn-banner', true); }, 1200);
}

function scheduleReconnect() {
    if (ended) return;
    const delay = Math.min(10000, 500 * 2 ** conn.attempt) * (0.75 + Math.random() * 0.5);
    conn.attempt++;
    clearTimeout(conn.retryTimer);
    conn.retryTimer = setTimeout(connect, delay);
}

// Sends a request and resolves with the server's reply ({ ok, error?, code?, ... }).
function send(type, payload = {}, { timeout = 8000 } = {}) {
    return new Promise((resolve) => {
        if (!conn.ready) {
            return resolve({ ok: false, code: 'OFFLINE', error: 'Not connected to the game. Reconnecting…' });
        }
        const id = String(conn.nextId++);
        const timer = setTimeout(() => {
            conn.pending.delete(id);
            resolve({ ok: false, code: 'TIMEOUT', error: 'No response from the game. Check your connection.' });
        }, timeout);
        conn.pending.set(id, { resolve, timer });
        conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, id, ...payload }));
    });
}

// Measures round-trip time and the server's clock offset. A dead socket (a phone that was
// locked, Wi-Fi that dropped) never answers, so we drop it and reconnect.
async function checkConnection(timeout = 5000) {
    if (!conn.ready) return;
    const ws = conn.ws;
    const sent = Date.now();
    const res = await send('ping', {}, { timeout });
    if (conn.ws !== ws) return;
    if (!res.ok) {
        if (res.code === 'TIMEOUT') {
            dropSocket();
            connect();
        }
        return;
    }
    const now = Date.now();
    const rtt = now - sent;
    // Trust the fastest recent sample: its midpoint is closest to the server's real time.
    if (rtt <= conn.bestRtt || now - conn.bestRttAt > 60000) {
        conn.bestRtt = rtt;
        conn.bestRttAt = now;
        conn.clockOffset = res.serverNow + rtt / 2 - now;
    }
}

function wakeUp() {
    if (ended || !role) return;
    if (!conn.ws) {
        conn.attempt = 0;
        connect();
    } else if (conn.ready) {
        checkConnection(3000);
    }
}
document.addEventListener('visibilitychange', () => {
    keepAwake();
    if (document.visibilityState === 'visible') wakeUp();
});
window.addEventListener('pageshow', wakeUp);
window.addEventListener('online', wakeUp);

function onServerMessage(msg) {
    switch (msg.type) {
        case 'welcome': return onWelcome(msg);
        case 'reply': {
            const p = conn.pending.get(msg.id);
            if (p) {
                clearTimeout(p.timer);
                conn.pending.delete(msg.id);
                p.resolve(msg);
            }
            return;
        }
        case 'state':
            if (conn.bestRtt === Infinity) conn.clockOffset = msg.serverNow - Date.now();
            state = msg.state;
            return render();
        case 'roomClosed': return onRoomClosed(msg);
        case 'error': return console.warn('Server error:', msg.code, msg.error);
        case 'turnStarted': return onTurnStarted();
        case 'wordGuessed': return onWordGuessed(msg);
        case 'wordSkipped': return onWordSkipped();
        case 'turnEnded': return onTurnEnded(msg);
        default: return undefined; // roundStarted, roundEnded, gameEnded: the state covers them
    }
}

function onWelcome(msg) {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
        return endGame('This page is out of date', 'Refresh the page to get the latest version.');
    }
    const previous = conn.serverId;
    conn.serverId = msg.serverId;
    conn.ready = true;
    conn.attempt = 0;
    conn.bestRtt = Infinity;
    conn.clockOffset = msg.serverNow - Date.now();
    clearTimeout(conn.bannerTimer);
    show('conn-banner', false);
    clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => checkConnection(), 20000);
    checkConnection();
    identify(previous);
}

// Who we are on this socket: resume the host room, or take our seat back as a player.
function identify(previousServerId) {
    if (role === 'host') identifyHost(previousServerId);
    if (role === 'player') identifyPlayer(previousServerId);
}

// The room is gone. If the server's id changed, it restarted and lost every game.
function roomGoneMessage(storedServerId) {
    const restarted = storedServerId && storedServerId !== conn.serverId;
    return restarted
        ? ['This game ended because the server restarted', 'Sorry about that! Start a new game to keep playing.']
        : ['This game has ended', 'The game was closed or its code expired.'];
}

function endGame(title, sub) {
    ended = { title, sub };
    clearTimeout(conn.retryTimer);
    clearTimeout(conn.bannerTimer);
    show('conn-banner', false);
    show('host-banner', false);
    render();
}

function onRoomClosed(msg) {
    const reasons = {
        idle: 'It was closed after a long break.',
        gameOver: 'Thanks for playing!',
        closedByHost: 'The host closed this game.',
        serverShutdown: 'The server is restarting. Start a new game in a moment.',
    };
    if (role === 'host') hostRooms.remove(msg.code);
    else store.remove('fishbowl_room');
    endGame('This game has ended', reasons[msg.reason] || '');
}

function backToStart() {
    location.href = '/';
}

// ---------- ROUTING ----------
// /ABCD and /?join=ABCD open the join screen for a room; /?host=ABCD is a host screen.
function route() {
    const params = new URLSearchParams(location.search);
    const pathCode = normalizeCode(location.pathname.slice(1));
    if (params.has('host')) return startHost(normalizeCode(params.get('host')));
    if (isCode(pathCode) && location.pathname.length === 5) return startPlayer(pathCode);
    if (params.has('join') || params.has('play')) return startPlayer(normalizeCode(params.get('join')));
    show('landing', true);
}

function showView(newRole) {
    role = newRole;
    show('landing', false);
    show('host', newRole === 'host');
    show('player', newRole === 'player');
    keepAwake();
    if (conn.ready) identify(null);
    else connect();
}

// ---------- HOST ----------
let hostCode = null;
let hostInfo = null; // { code, joinUrl, qrDataUrl }

function startHost(code) {
    hostCode = isCode(code) && hostRooms.get(code) ? code : null;
    history.replaceState(null, '', hostCode ? `/?host=${hostCode}` : '/?host');
    showView('host');
    unlockAudio(false);
    render();
}

async function identifyHost(previousServerId) {
    if (ended) return;
    if (!hostCode) return createRoom();
    const saved = hostRooms.get(hostCode);
    const res = await send('resumeHost', { code: hostCode, hostToken: saved.token });
    if (res.ok) return onHostRoom(res.room);
    if (res.code === 'ROOM_NOT_FOUND' || res.code === 'HOST_TOKEN_INVALID') {
        hostRooms.remove(hostCode);
        return endGame(...roomGoneMessage(saved.serverId || previousServerId));
    }
    if (res.code !== 'OFFLINE') hostLoadingError(res.error);
}

async function createRoom() {
    show('h-loading-error', false);
    show('h-loading-retry', false);
    if (!conn.ready) return connect();
    const res = await send('createRoom');
    if (!res.ok) return hostLoadingError(res.error);
    hostCode = res.room.code;
    hostRooms.set(hostCode, { token: res.room.hostToken, serverId: conn.serverId });
    history.replaceState(null, '', `/?host=${hostCode}`);
    onHostRoom(res.room);
}

function hostLoadingError(msg) {
    if (state) return toast(msg);
    $('h-loading-error').textContent = msg;
    show('h-loading-error', true);
    show('h-loading-retry', true);
}

function onHostRoom(room) {
    hostInfo = room;
    if (room.qrDataUrl) $('qr-code').src = room.qrDataUrl;
    const short = room.joinUrl.replace(/^https?:\/\//, '');
    $('join-url').textContent = short;
    $('h-room-code').textContent = room.code;
    const onLan = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(short);
    $('join-hint').textContent = onLan
        ? 'Phones must be on the same Wi-Fi as this computer.'
        : `Or go to ${short.split('/')[0]} and type the room code.`;
}

async function hostAction(type, payload) {
    const res = await send(type, payload);
    if (!res.ok) toast(res.error);
}

function readSettings() {
    return { timer: Number($('set-timer').value), words: Number($('set-words').value) };
}

function resetLobby() {
    if (confirm('Start over with a brand-new lobby? Everyone will need to join again.')) hostAction('resetLobby');
}

function skipTurn() {
    if (confirm(`Skip ${nameOf(state.activePlayerId)}'s turn?`)) hostAction('skipTurn');
}

function removePlayer(id) {
    if (confirm(`Remove ${nameOf(id)} from the game?`)) hostAction('removePlayer', { playerId: id });
}

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

// ---------- EVENTS (animations and sounds; the state is always the source of truth) ----------
function onTurnStarted() {
    if (role === 'host') replayAnimation($('h-clock'), 'go');
}

function onWordGuessed(e) {
    if (role !== 'host' || state?.phase !== 'GAMELOOP') return;
    const tile = $(e.team === 'A' ? 'h-score-a' : 'h-score-b');
    replayAnimation(tile.querySelector('.score'), 'bump');
    const plus = document.createElement('span');
    plus.className = 'plus-one';
    plus.textContent = '+1';
    plus.addEventListener('animationend', () => plus.remove());
    tile.appendChild(plus);
}

function onWordSkipped() {
    if (role === 'host') replayAnimation(document.querySelector('#h-stage .bowl-fact'), 'wobble');
}

function onTurnEnded(info) {
    if (info.reason === 'bowl') return; // the round-over screen says it all
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
}

// ---------- CLOCK ----------
// The server sends a deadline (turnEndsAt) while the clock runs and remainingMs otherwise.
// We count down locally against the server's clock, so it's smooth and needs no ticks.
function timeLeftMs() {
    if (!state) return 0;
    if (state.turnEndsAt === null) return state.remainingMs;
    return Math.max(0, state.turnEndsAt - serverNow());
}

let clockFrame = null;
function renderClock() {
    cancelAnimationFrame(clockFrame);
    clockFrame = null;
    if (!state || state.phase !== 'GAMELOOP') return;
    const ms = timeLeftMs();
    const secs = Math.ceil(ms / 1000);
    const running = state.timerRunning && !state.paused;
    const urgent = running && secs <= 10;

    if (role === 'host') {
        const clock = $('h-clock');
        clock.textContent = secs;
        clock.classList.toggle('paused', state.paused);
        clock.classList.toggle('urgent', urgent);
        clock.classList.toggle('idle', !state.timerRunning);
    } else {
        const fraction = ms / (state.config.timerDuration * 1000);
        $('p-timer').textContent = `${secs}s`;
        $('p-timer').classList.toggle('urgent', urgent);
        const bar = $('p-timer-bar');
        bar.style.width = `${Math.min(1, fraction) * 100}%`;
        bar.classList.toggle('urgent', urgent);
        const watch = $('p-watch-timer');
        if (watch) {
            watch.textContent = secs;
            watch.classList.toggle('urgent', urgent);
        }
        const acting = state.activePlayerId === state.you;
        if (acting && running && secs <= 5 && secs > 0 && secs !== lastBuzzSecond && navigator.vibrate) navigator.vibrate(80);
        lastBuzzSecond = secs;
    }
    if (running && ms > 0) clockFrame = requestAnimationFrame(renderClock);
}

// ---------- HOST SCREENS ----------
function renderHost() {
    const screens = ['h-loading', 'h-ended', 'h-lobby', 'h-submission', 'h-ready', 'h-game', 'h-roundover', 'h-gameover'];
    const pill = $('h-round-pill');
    const roomPill = $('h-room-pill');
    if (ended) {
        $('h-ended-title').textContent = ended.title;
        $('h-ended-sub').textContent = ended.sub;
        pill.classList.add('hidden');
        roomPill.classList.add('hidden');
        return showOnly(screens, 'h-ended');
    }
    if (!state || !hostInfo) return showOnly(screens, 'h-loading');

    const s = state;
    const screen = {
        LOBBY: 'h-lobby', SUBMISSION: 'h-submission', READY_TO_START: 'h-ready',
        GAMELOOP: 'h-game', ROUND_OVER: 'h-roundover', GAME_OVER: 'h-gameover',
    }[s.phase];
    showOnly(screens, screen);

    const inRounds = s.phase === 'GAMELOOP' || s.phase === 'ROUND_OVER';
    pill.classList.toggle('hidden', !inRounds);
    if (inRounds) pill.textContent = `Round ${s.round} of ${s.rounds.length} · ${roundInfo(s.round).name}`;
    // The lobby already shows the code in big type.
    roomPill.classList.toggle('hidden', s.phase === 'LOBBY');
    roomPill.textContent = `Room ${s.room.code}`;

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
    $('h-player-count').textContent = `(${s.players.length} of ${s.limits.maxPlayers})`;
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

    for (const t of ['A', 'B']) {
        const el = $(t === 'A' ? 'h-score-a' : 'h-score-b');
        el.classList.toggle('active', s.activeTeam === t);
        // Only touch the number, so a running "bump" animation isn't cut short.
        el.querySelector('.score').textContent = s.scores[t];
    }
    renderClock();

    let status;
    if (s.paused) status = '⏸ Paused';
    else if (s.timerRunning) status = `<span class="${teamClass(s.activeTeam)}-text">${teamLabel(s.activeTeam)}</span>, start guessing!`;
    else status = `Waiting for ${escapeHtml(actor ? actor.name : 'the player')} to press start on their phone…`;

    const facts = [`<span class="fact bowl-fact">🐟 ${plural(s.bowlCount, 'word')} left in the bowl</span>`];
    if (s.timerRunning) facts.push(`<span class="fact">✓ ${s.turnScore} this turn</span>`);
    if (s.upNextId) facts.push(`<span class="fact">Up next: ${escapeHtml(nameOf(s.upNextId))}</span>`);
    if (!s.timerRunning && s.lastTurn) {
        facts.push(`<span class="fact">Last turn: ${escapeHtml(s.lastTurn.name)} got ${s.lastTurn.got}</span>`);
    }

    $('h-stage').innerHTML = `
        <div class="now">${actor && !actor.connected ? '⚠️ Disconnected — ' : ''}Now giving clues</div>
        <div class="actor ${teamClass(s.activeTeam)}">${escapeHtml(actor ? actor.name : '—')}</div>
        <div class="status">${status}</div>
        <div class="facts">${facts.join('')}</div>`;

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
// `joined` means this phone has a seat in `playerCode` and should take it back on reconnect.
let playerCode = null;
let joined = false;
let joining = false;

function startPlayer(code) {
    const saved = store.getJson('fishbowl_room');
    playerCode = isCode(code) ? code : null;
    // Coming back to the room we were in (refresh, or the phone woke up): rejoin automatically.
    joined = !!(saved && playerCode && saved.code === playerCode && store.get('fishbowl_name'));
    history.replaceState(null, '', playerCode ? `/${playerCode}` : '/?join');
    const name = store.get('fishbowl_name');
    if (name) $('p-name').value = name;
    if (playerCode) $('p-code').value = playerCode;
    showView('player');
    render();
    if (playerCode && !joined) lookupCode();
}

async function identifyPlayer(previousServerId) {
    if (ended) return;
    if (!joined) {
        if (playerCode) lookupCode();
        return render();
    }
    joining = true;
    render();
    const saved = store.getJson('fishbowl_room') || {};
    const res = await send('joinRoom', { code: playerCode, playerId: getPlayerId(), name: store.get('fishbowl_name') || '' });
    joining = false;
    if (res.ok) return render();
    if (res.code === 'ROOM_NOT_FOUND') {
        store.remove('fishbowl_room');
        return endGame(...roomGoneMessage(saved.serverId || previousServerId));
    }
    if (res.code === 'OFFLINE') return render();
    // Name clash or full room: fall back to the join form.
    joined = false;
    render();
    showError('p-join-error', res.error);
}

// Checks the typed code as soon as it's complete, so a typo shows up before the name.
let lookupSeq = 0;
async function lookupCode() {
    const code = normalizeCode($('p-code').value || playerCode);
    const status = $('p-code-status');
    status.classList.remove('error');
    if (!isCode(code)) return show('p-code-status', false);
    const seq = ++lookupSeq;
    const res = await send('lookupRoom', { code });
    if (seq !== lookupSeq) return;
    if (res.code === 'OFFLINE') return show('p-code-status', false);
    show('p-code-status', true);
    if (!res.ok) {
        status.classList.add('error');
        status.textContent = res.error;
        return;
    }
    const r = res.room;
    if (r.playerCount >= r.maxPlayers) {
        status.classList.add('error');
        status.textContent = `This game is full (${r.maxPlayers} players). You can rejoin if you were already in it.`;
    } else if (r.phase !== 'LOBBY') {
        status.textContent = "Game in progress — you can still jump in and we'll put you on a team.";
    } else {
        status.textContent = `${plural(r.playerCount, 'player')} waiting${r.hostConnected ? '' : ' (the host is reconnecting)'}.`;
    }
}

async function joinGame() {
    const code = normalizeCode(playerCode || $('p-code').value);
    const name = $('p-name').value.trim();
    if (!isCode(code)) return showError('p-join-error', 'Enter the 4-letter room code shown on the TV.');
    if (!name) return showError('p-join-error', 'Please enter your name.');
    unlockVibration();
    const res = await send('joinRoom', { code, playerId: getPlayerId(), name });
    if (!res.ok) {
        show('p-code-status', false); // the join error says it, no need to say it twice
        return showError('p-join-error', res.error);
    }
    show('p-join-error', false);
    playerCode = res.room.code;
    joined = true;
    state = null; // a fresh state for this seat follows the reply
    store.set('fishbowl_name', name);
    store.setJson('fishbowl_room', { code: playerCode, serverId: conn.serverId });
    history.replaceState(null, '', `/${playerCode}`);
    render();
}

async function leaveGame() {
    joined = false;
    store.remove('fishbowl_room');
    await send('leaveRoom');
    state = null;
    $('p-name').value = '';
    render();
    $('p-name').focus();
}

// Typing a different code means a different room.
function editCode() {
    playerCode = null;
    state = null;
    history.replaceState(null, '', '/?join');
    render();
    $('p-code').focus();
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
    const res = await send('submitWords', { words });
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
    const res = await send('startTurn');
    if (!res.ok) toast(res.error);
}

async function answerWord(type) {
    const word = state.currentWord;
    if (!word || pendingWordId === word.id) return;
    pendingWordId = word.id;
    setTurnButtonsDisabled(true);
    const res = await send(type, { wordId: word.id });
    if (!res.ok) {
        pendingWordId = null;
        setTurnButtonsDisabled(false);
        if (res.code !== 'STALE') toast(res.error);
    }
}

function setTurnButtonsDisabled(disabled) {
    $('p-got').disabled = disabled;
    $('p-skip').disabled = disabled || state.lastWord;
}

function renderPlayer() {
    const screens = ['p-join', 'p-loading', 'p-ended', 'p-lobby', 'p-submit', 'p-info', 'p-turn-ready', 'p-turn'];
    const chip = $('p-me');
    const roomChip = $('p-room');
    const inRoom = joined && state && !ended;
    show('host-banner', !!(inRoom && !state.room.hostConnected));

    if (ended) {
        chip.classList.add('hidden');
        roomChip.classList.add('hidden');
        $('player').classList.remove('in-room');
        $('p-ended-title').textContent = ended.title;
        $('p-ended-sub').textContent = ended.sub;
        return showOnly(screens, 'p-ended');
    }


    // We had a seat but the server says we're not in the game (the host removed us or
    // reset the lobby). Show the join form again, with our name filled in.
    if (inRoom && !state.you) {
        joined = false;
        store.remove('fishbowl_room');
    }
    const s = state;
    const me = joined && s && s.you ? player(s.you) : null;

    chip.classList.toggle('hidden', !me);
    roomChip.classList.toggle('hidden', !me);
    roomChip.textContent = `Room ${playerCode}`;
    $('player').classList.toggle('in-room', !!me);
    if (me) {
        chip.textContent = me.team ? `${me.name} · ${teamLabel(me.team)}` : me.name;
        chip.className = `me-chip ${me.team ? teamClass(me.team) : ''}`;
    }

    if (!me) {
        if (joined || joining) return showOnly(screens, 'p-loading');
        show('p-code-row', !playerCode);
        show('p-code-fixed', !!playerCode);
        if (playerCode) $('p-code-fixed').innerHTML = `Room <b>${escapeHtml(playerCode)}</b> · <button type="button" class="btn-link inline" data-action="editCode">change</button>`;
        $('p-join-title').textContent = 'Join the game';
        $('p-join-sub').textContent = playerCode
            ? 'Enter the name everyone knows you by.'
            : 'Enter the code on the TV and the name everyone knows you by.';
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
    renderClock();
}

function renderTurn() {
    const s = state;
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
    renderClock();
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
            <div id="p-watch-timer" class="watch-timer"></div>
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
    if (!role) return;
    if (role === 'host') renderHost();
    else renderPlayer();
}

// ---------- UI WIRING (no inline handlers, so the page can run under a strict CSP) ----------
const actions = {
    createGame: () => {
        if (role === 'host') return createRoom();
        return startHost(null);
    },
    joinGame: () => startPlayer(null),
    unlockAudio: () => unlockAudio(true),
    startSubmission: () => hostAction('startSubmission', readSettings()),
    resetLobby,
    skipTurn,
    backToStart,
    leaveGame,
    editCode,
    startTurn,
    gotWord: () => answerWord('gotWord'),
    skipWord: () => answerWord('skipWord'),
};

document.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) return removePlayer(remove.dataset.remove);
    const host = e.target.closest('[data-host]');
    if (host) return hostAction(host.dataset.host);
    const action = e.target.closest('[data-action]');
    if (action && actions[action.dataset.action]) actions[action.dataset.action]();
});

$('p-join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinGame();
});
$('p-submit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitWords();
});
$('p-code').addEventListener('input', (e) => {
    const code = normalizeCode(e.target.value);
    e.target.value = code;
    show('p-join-error', false);
    lookupCode();
    if (code.length === 4) $('p-name').focus();
});

route();
