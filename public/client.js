const socket = io();
let isHost = false;
let myId = null;

// --- INITIALIZATION ---

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('host')) {
    initHost();
}

function initHost() {
    isHost = true;
    document.getElementById('landing-select').classList.add('hidden');
    document.getElementById('host-view').classList.remove('hidden');
    socket.emit('getHostInfo');

    // --- NEW: Audio Unlocker ---
    // We play the sound for 0 seconds to tell the browser 
    // "The user authorized this audio."
    const audio = document.getElementById('sound-buzzer');
    if (audio) {
        audio.volume = 1.0; // Ensure volume is up
        audio.play().then(() => {
            audio.pause();
            audio.currentTime = 0;
        }).catch(e => {
            console.log("Browser prevented audio unlock:", e);
        });
    }
}

function initPlayer() {
    document.getElementById('landing-select').classList.add('hidden');
    document.getElementById('player-view').classList.remove('hidden');
    
    // AUTO-REJOIN: Check if we have a name saved
    const savedName = localStorage.getItem('fishbowl_name');
    if (savedName) {
        document.getElementById('player-name').value = savedName;
        joinGame(savedName);
    }
}

// --- SOCKET EVENTS ---

socket.on('connect', () => {
    myId = socket.id;
    // If we temporarily lost connection (screen off/refresh), 
    // try to rejoin automatically if we have a name.
    if (!isHost) {
        const savedName = localStorage.getItem('fishbowl_name');
        if (savedName) {
            socket.emit('joinGame', savedName);
        }
    }
});

socket.on('hostInfo', (data) => {
    if (!isHost) return;
    document.getElementById('qr-code').src = data.qr;
    document.getElementById('join-url').textContent = data.url;
});

socket.on('error', (msg) => {
    alert(msg);
});

socket.on('timerUpdate', (time) => {
    if (isHost) document.getElementById('host-timer').textContent = time;
    if (!isHost) {
        document.getElementById('spectator-timer').textContent = time;
        if (time <= 5 && time > 0 && navigator.vibrate) navigator.vibrate(200); 
    }
});


socket.on('turnEnded', () => {
    // 1. Play Sound (Host Only)
    if (isHost) {
        const audio = document.getElementById('sound-buzzer');
        if (audio) {
            audio.currentTime = 0; // Reset to start
            audio.play().catch(e => console.log("Audio blocked:", e));
        }

        // 2. Trigger Animation
        document.body.classList.add('times-up-flash');
        
        // Remove class after animation finishes so it can run again next time
        setTimeout(() => {
            document.body.classList.remove('times-up-flash');
        }, 1000);

        // 3. Logic: Tell server to switch turns
        socket.emit('nextTurn');
    }
});

socket.on('stateUpdate', (state) => {
    render(state);
});

// --- RENDER LOGIC ---

function render(state) {
    if (isHost) renderHost(state);
    else renderPlayer(state);
}

function renderHost(state) {
    // 1. Lobby Phase
    toggle('host-lobby', state.phase === 'LOBBY');
    if (state.phase === 'LOBBY') {
        const list = document.getElementById('host-player-list');
        list.innerHTML = state.players.map(p => `<li>${p.name}</li>`).join('');
    }

    // 2. Submission Phase
    toggle('host-submission', state.phase === 'SUBMISSION');
    if (state.phase === 'SUBMISSION') {
        const submittedCount = state.players.filter(p => p.hasSubmitted).length;
        document.getElementById('submission-progress').textContent = `${submittedCount} / ${state.players.length} Submitted`;
    }

    // 3. Game Loop
    const isGame = state.phase === 'GAMELOOP';
    toggle('host-game', isGame);
    if (isGame) {
        document.getElementById('score-a').textContent = state.scores.A;
        document.getElementById('score-b').textContent = state.scores.B;
        document.getElementById('host-timer').textContent = state.timer;
        
        const activePlayer = state.players.find(p => p.id === state.activePlayerId);
        document.getElementById('host-actor-name').textContent = activePlayer ? activePlayer.name : '...';
        document.getElementById('host-active-team').textContent = state.activeTeam;
        
        const roundNames = { 1: 'Taboo', 2: 'Charades', 3: 'Password' };
        document.getElementById('host-round-num').textContent = state.round;
        document.getElementById('host-round-name').textContent = roundNames[state.round];

        // --- NEW: Render Rosters ---
        // Helper to generate list HTML
        const renderRoster = (teamArray) => {
            return teamArray.map(p => {
                // Check if this player is the current actor
                const isActor = (p.id === state.activePlayerId);
                // Return HTML with conditional highlighting
                return `<div class="${isActor ? 'actor-highlight' : ''}">${p.name}</div>`;
            }).join('');
        };

        document.getElementById('roster-a').innerHTML = renderRoster(state.teams.A);
        document.getElementById('roster-b').innerHTML = renderRoster(state.teams.B);
    }

    // 4. Intermission / Game Over / Ready to Start
    const isIntermission = state.phase === 'ROUND_OVER' || state.phase === 'GAME_OVER' || state.phase === 'READY_TO_START';
    toggle('host-intermission', isIntermission);
    
    const msgEl = document.getElementById('intermission-msg');
    const btnEl = document.querySelector('#host-intermission button');

    if (state.phase === 'READY_TO_START') {
        msgEl.textContent = "Teams Assigned!";
        btnEl.textContent = "Start Round 1";
        btnEl.onclick = startNextRound;

    } else if (state.phase === 'ROUND_OVER') {
        // Show who is LEADING
        let leadMsg = "It's a tie!";
        const diff = Math.abs(state.scores.A - state.scores.B);
        if (state.scores.A > state.scores.B) leadMsg = `Team A leads by ${diff}`;
        if (state.scores.B > state.scores.A) leadMsg = `Team B leads by ${diff}`;

        msgEl.innerHTML = `End of Round ${state.round}<br><span style="font-size: 0.6em; color: #aaa;">${leadMsg}</span>`;
        
        btnEl.textContent = `Start Round ${state.round + 1}`;
        btnEl.onclick = startNextRound;

    } else if (state.phase === 'GAME_OVER') {
        // Show who WON and setup "New Game"
        let winner = state.scores.A > state.scores.B ? 'Team A' : 'Team B';
        if (state.scores.A === state.scores.B) winner = "It's a Tie";
        
        msgEl.innerHTML = `Game Completed!<br><span style="font-size: 0.8em; color: #e94560;">${winner} Wins!</span>`;
        
        btnEl.textContent = "Start New Game";
        btnEl.onclick = playAgain; 
    }
}

function renderPlayer(state) {
    const me = state.players.find(p => p.id === myId);
    
    // --- NEW: Handle Team Badge ---
    const badge = document.getElementById('my-team-badge');
    if (me && me.team) {
        badge.classList.remove('hidden');
        badge.textContent = `Team ${me.team}`;
        
        // Color coding
        if (me.team === 'A') {
            badge.style.backgroundColor = '#e94560'; // Red/Pink
            badge.style.color = 'white';
        } else {
            badge.style.backgroundColor = '#4aa3df'; // Blue
            badge.style.color = 'white';
        }
    } else {
        badge.classList.add('hidden');
    }

    // 1. Join Screen
    toggle('player-join', !me && state.phase === 'LOBBY');
    
    // 2. Waiting (Lobby joined)
    toggle('player-wait', state.phase === 'LOBBY' && me);
    
    // 3. Submission
    if (state.phase === 'SUBMISSION') {
        if (me && !me.hasSubmitted) {
            showScreen('player-submit');
            document.getElementById('submit-instruction').textContent = `Enter ${state.config.wordsPerPlayer} words or phrases.`;
            renderWordInputs(state.config.wordsPerPlayer);
        } else {
            showScreen('player-wait');
            document.getElementById('wait-msg').textContent = "Waiting for others...";
        }
        return; 
    }

    // 4. Game Loop
    if (state.phase === 'GAMELOOP' && me) {
        if (state.activePlayerId === myId) {
            showScreen('player-active');
            document.getElementById('active-team-indicator').textContent = state.activeTeam;
            
            if (state.timerRunning && state.currentWord) {
                document.getElementById('pre-start-controls').classList.add('hidden');
                document.getElementById('game-controls').classList.remove('hidden');
                document.getElementById('card-word').textContent = state.currentWord;
            } else {
                document.getElementById('pre-start-controls').classList.remove('hidden');
                document.getElementById('game-controls').classList.add('hidden');
            }
        } else {
            showScreen('player-spectator');
            const actor = state.players.find(p => p.id === state.activePlayerId);
            document.getElementById('spectator-actor').textContent = actor ? actor.name : 'Unknown';
        }
        return;
    }

    // 5. Handle Intermissions
    if (['ROUND_OVER', 'GAME_OVER', 'READY_TO_START'].includes(state.phase)) {
        showScreen('player-wait');
        let msg = "Look at the TV";
        
        if (state.phase === 'ROUND_OVER') msg = "Round Over! Look at TV";
        if (state.phase === 'GAME_OVER') msg = "Game Over! Look at TV";
        
        // --- NEW: Explicit Team Notification ---
        if (state.phase === 'READY_TO_START') {
            msg = `You are on Team ${me.team}! Look at TV.`;
        }
        
        document.getElementById('wait-msg').textContent = msg;
    }
}

// --- ACTIONS ---

function joinGame(optionalName) {
    const nameInput = document.getElementById('player-name');
    const name = optionalName || nameInput.value;
    
    if (name) {
        localStorage.setItem('fishbowl_name', name);
        socket.emit('joinGame', name);
    }
}

function startSubmission() {
    const timerVal = document.getElementById('setting-timer').value;
    const wordsVal = document.getElementById('setting-words').value;
    const timer = parseInt(timerVal) || 60;
    const words = parseInt(wordsVal) || 3;
    socket.emit('startSubmission', { timer, words });
}

function renderWordInputs(count) {
    const container = document.getElementById('word-inputs');
    if (container.children.length === count) return; 
    container.innerHTML = ''; 
    for(let i=0; i<count; i++) {
        const input = document.createElement('input');
        input.placeholder = `Word/Phrase ${i+1}`;
        input.className = 'word-input';
        container.appendChild(input);
    }
}

function submitWords() {
    const inputs = document.querySelectorAll('.word-input');
    const words = Array.from(inputs).map(i => i.value).filter(v => v.trim() !== "");
    if (words.length === inputs.length) {
        socket.emit('submitWords', words);
    } else {
        alert("Please fill in all words!");
    }
}

function startTurn() {
    socket.emit('startTimer');
}

function gotWord() {
    socket.emit('gotWord');
}

function skipWord() {
    socket.emit('skipWord');
}

function startNextRound() {
    socket.emit('startGame'); 
}

function playAgain() {
    socket.emit('playAgain');
}

function resetLobby() {
    if(confirm("Are you sure? This kicks everyone out.")) {
        socket.emit('resetLobby');
    }
}

// --- UTILS ---
function toggle(id, show) {
    const el = document.getElementById(id);
    if (show) el.classList.remove('hidden');
    else el.classList.add('hidden');
}

function showScreen(id) {
    ['player-join', 'player-wait', 'player-submit', 'player-spectator', 'player-active'].forEach(s => {
        document.getElementById(s).classList.add('hidden');
    });
    document.getElementById(id).classList.remove('hidden');
}