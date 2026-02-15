const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os'); 
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- UTILS ---
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const getLocalUrl = () => `http://${getLocalIpAddress()}:3000`;

// --- GAME STATE ---
const INITIAL_STATE = {
    phase: 'LOBBY', 
    players: [], 
    teams: { A: [], B: [] },
    scores: { A: 0, B: 0 },
    config: {
        wordsPerPlayer: 3,
        timerDuration: 60
    },
    // --- NEW: Track turn order for each team ---
    teamIndices: { A: 0, B: 0 }, 
    
    masterDeck: [], 
    currentBowl: [], 
    round: 1, 
    activeTeam: 'A', 
    activePlayerId: null, 
    currentWord: null,
    timer: 60,
    timerRunning: false
};

let gameState = JSON.parse(JSON.stringify(INITIAL_STATE));
let timerInterval = null;

const shuffle = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

// --- SOCKET LOGIC ---
// This is the "io.on" section you were looking for!
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.emit('stateUpdate', gameState);

    // 1. HOST: Get QR Code
    socket.on('getHostInfo', async () => {
        const url = getLocalUrl();
        try {
            const qrData = await QRCode.toDataURL(url);
            socket.emit('hostInfo', { url, qr: qrData });
        } catch (err) {
            console.error(err);
        }
    });

    // 2. PLAYER: Join or Rejoin (Fixed for "Unknown" Bug)
    socket.on('joinGame', (name) => {
        if (!name || name.trim() === "") return;

        const cleanName = name.trim();
        // Check for existing player (Case Insensitive)
        const existingPlayer = gameState.players.find(p => 
            p.name.toLowerCase() === cleanName.toLowerCase()
        );

        if (existingPlayer) {
            // --- REJOIN LOGIC ---
            console.log(`🔄 REJOIN: ${cleanName}`);
            
            // 1. Capture the old ID before we overwrite it
            const oldId = existingPlayer.id;
            
            // 2. Update to the new Socket ID
            existingPlayer.id = socket.id; 
            existingPlayer.name = cleanName; 

            // 3. THE FIX: If this player was currently the Actor, update the pointer!
            if (gameState.activePlayerId === oldId) {
                gameState.activePlayerId = socket.id;
            }

        } else {
            // --- NEW JOIN LOGIC ---
            if (gameState.phase !== 'LOBBY') {
                socket.emit('error', 'Game in progress. Cannot join now.');
                return;
            }
            console.log(`✅ NEW PLAYER: ${cleanName}`);
            const player = { 
                id: socket.id, 
                name: cleanName, 
                team: null, 
                hasSubmitted: false 
            };
            gameState.players.push(player);
        }
        
        io.emit('stateUpdate', gameState);
    });
    
    // 3. HOST: Reset Logic (New!)
    socket.on('resetLobby', () => {
        gameState = JSON.parse(JSON.stringify(INITIAL_STATE));
        clearInterval(timerInterval);
        io.emit('stateUpdate', gameState);
        console.log('💥 Lobby Reset by Host');
    });

    // HOST: Play Again (Hard Reset for a new game)
    socket.on('playAgain', () => {
        console.log('🔄 Play Again triggered');
        
        gameState.phase = 'LOBBY';
        gameState.teams = { A: [], B: [] };
        gameState.scores = { A: 0, B: 0 };
        gameState.masterDeck = [];
        gameState.currentBowl = [];
        gameState.round = 1;
        gameState.activeTeam = 'A';
        gameState.timer = gameState.config.timerDuration;
        
        // --- NEW: Reset Turn Order ---
        gameState.teamIndices = { A: 0, B: 0 }; 
        
        gameState.players.forEach(p => {
            p.team = null;
            p.hasSubmitted = false;
        });

        io.emit('stateUpdate', gameState);
    });

    // 4. HOST: Start Submission (With Settings)
    socket.on('startSubmission', (settings) => {
        if (gameState.players.length < 2) return; 
        
        // Update Config if settings were sent
        if (settings) {
            gameState.config.timerDuration = settings.timer;
            gameState.config.wordsPerPlayer = settings.words;
            
            // Ensure the initial timer value matches the new setting
            gameState.timer = settings.timer; 
        }

        gameState.phase = 'SUBMISSION';
        io.emit('stateUpdate', gameState);
    });

    // 5. PLAYER: Submit Words
    socket.on('submitWords', (words) => {
        gameState.masterDeck.push(...words);
        const player = gameState.players.find(p => p.id === socket.id);
        if(player) player.hasSubmitted = true;

        const allSubmitted = gameState.players.every(p => p.hasSubmitted);
        io.emit('stateUpdate', gameState);
        
        if (allSubmitted) assignTeams();
    });

    // 6. GAME LOOP
    socket.on('startGame', () => {
        // SAFETY CHECK: If the game is over, ignore this command!
        // This prevents the "Infinite Round 3" loop.
        if (gameState.phase === 'GAME_OVER') return;

        // Normal logic
        startRound(gameState.round < 4 ? gameState.round : 1);
    });

    socket.on('nextTurn', () => {
        nextTurn();
    });

    socket.on('startTimer', () => {
        if (gameState.timerRunning) return;
        gameState.timerRunning = true;
        
        if (!gameState.currentWord) {
             gameState.currentWord = gameState.currentBowl.pop();
        }
        io.emit('stateUpdate', gameState);

        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            if (gameState.timer > 0) {
                gameState.timer--;
                io.emit('timerUpdate', gameState.timer);
            } else {
                endTurn();
            }
        }, 1000);
    });

    socket.on('gotWord', () => {
        gameState.scores[gameState.activeTeam]++;
        if (gameState.currentBowl.length > 0) {
            gameState.currentWord = gameState.currentBowl.pop();
        } else {
            endRound();
            return;
        }
        io.emit('stateUpdate', gameState);
    });

    socket.on('skipWord', () => {
        if (gameState.currentWord) {
            gameState.currentBowl.unshift(gameState.currentWord);
        }
        gameState.currentWord = gameState.currentBowl.pop();
        io.emit('stateUpdate', gameState);
    });
    
    socket.on('resetGame', () => {
        gameState = JSON.parse(JSON.stringify(INITIAL_STATE));
        clearInterval(timerInterval);
        io.emit('stateUpdate', gameState);
    });
});

// --- HELPERS ---

function assignTeams() {
    // 1. Shuffle
    const shuffled = shuffle([...gameState.players]);
    const mid = Math.ceil(shuffled.length / 2);
    
    // 2. Split into arrays
    gameState.teams.A = shuffled.slice(0, mid);
    gameState.teams.B = shuffled.slice(mid);
    
    // 3. THE FIX: Explicitly set the 'team' property on the player objects
    // Since these objects are references, this updates the main player list too.
    gameState.teams.A.forEach(p => p.team = 'A');
    gameState.teams.B.forEach(p => p.team = 'B');

    // 4. Update Phase
    gameState.phase = 'READY_TO_START';
    io.emit('stateUpdate', gameState);
}

function startRound(roundNum) {
    gameState.round = roundNum;
    gameState.currentBowl = shuffle([...gameState.masterDeck]);
    gameState.currentWord = null;
    gameState.phase = 'GAMELOOP';
    
    // LOGIC CHANGE:
    // If it is Round 1, pass 'true' to keep Team A as the starter.
    // If it is Round 2+, pass 'false' to TOGGLE the team, 
    // ensuring the team that finished the last round doesn't start this one.
    nextTurn(roundNum === 1); 
}

function nextTurn(newRound = false) {
    clearInterval(timerInterval);
    gameState.timerRunning = false;
    gameState.timer = gameState.config.timerDuration;
    gameState.currentWord = null;
    
    if (!newRound) {
        gameState.activeTeam = gameState.activeTeam === 'A' ? 'B' : 'A';
    }
    
    const currentTeam = gameState.activeTeam;
    const teamArr = gameState.teams[currentTeam];
    
    // SAFETY: If team is empty (shouldn't happen), stop
    if (!teamArr || teamArr.length === 0) return;

    // 1. Get the next index for this team
    let idx = gameState.teamIndices[currentTeam];

    // 2. Safety Check: If players left/moved and index is out of bounds, reset to 0
    if (idx >= teamArr.length) {
        idx = 0;
    }

    // 3. Pick the actor
    const actor = teamArr[idx];
    gameState.activePlayerId = actor ? actor.id : null;

    // 4. Increment the index for NEXT time (Loop back to 0 if at end)
    gameState.teamIndices[currentTeam] = (idx + 1) % teamArr.length;

    io.emit('stateUpdate', gameState);
}

function endTurn() {
    clearInterval(timerInterval);
    gameState.timerRunning = false;
    if (gameState.currentWord) {
        gameState.currentBowl.push(gameState.currentWord);
        shuffle(gameState.currentBowl);
    }
    gameState.currentWord = null;
    io.emit('turnEnded'); 
}

function endRound() {
    clearInterval(timerInterval);
    gameState.timerRunning = false;
    gameState.currentWord = null;
    if (gameState.round < 3) {
        gameState.phase = 'ROUND_OVER';
        gameState.round++;
    } else {
        gameState.phase = 'GAME_OVER';
    }
    io.emit('stateUpdate', gameState);
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Fishbowl running on port ${PORT}`);
    console.log(`Local Access: ${getLocalUrl()}`);
});