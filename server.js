const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// COOP header for Firebase Auth redirect
app.use(function(req, res, next){
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
});

// Favicon
app.get('/favicon.ico', function(req, res){
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%23E8001A"/><circle cx="50" cy="50" r="30" fill="none" stroke="white" stroke-width="4" stroke-dasharray="8,6"/><circle cx="50" cy="50" r="8" fill="white"/></svg>');
});

// Inject config to frontend without exposing in source
app.get('/api/config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send('window.claimPhone = "' + (process.env.CLAIM_PHONE || '+61400000000') + '";');
});


app.use(express.static(path.join(__dirname, 'public')));

const FINISH_LINE = { lat: -27.4691, lng: 153.0235 };
const WINNING_RADIUS_METRES = 20;

let raceSlots = {
    "7:00": { winnerDeclared: false, winnerUsername: null },
    "7:10": { winnerDeclared: false, winnerUsername: null },
    "7:20": { winnerDeclared: false, winnerUsername: null },
    "7:30": { winnerDeclared: false, winnerUsername: null },
    "7:40": { winnerDeclared: false, winnerUsername: null },
    "7:50": { winnerDeclared: false, winnerUsername: null }
};

// username => { uid, username, lockedAt }
const registeredUsers = {};

let players = {};

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180;
    const dLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dPhi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dLambda/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function logWinner(username, slot) {
    const dateStr = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' });
    const timeStr = new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' });
    const line = `[${dateStr} @ ${timeStr}] SLOT: ${slot} | WINNER: ${username} | STATUS: Awaiting SMS Claim\n`;
    fs.appendFile('winners.txt', line, err => { if (err) console.error(err); });
    console.log(`WINNER: ${username} slot ${slot}`);
}

// Username registration endpoint
app.post('/api/register-username', (req, res) => {
    const { uid, username } = req.body;
    if (!uid || !username) return res.status(400).json({ error: 'Missing uid or username' });

    const clean = username.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 18);
    if (clean.length < 2) return res.status(400).json({ error: 'Username too short' });

    // Check if this uid already has a locked username
    const existing = Object.values(registeredUsers).find(u => u.uid === uid);
    if (existing) {
        const hoursOld = (Date.now() - existing.lockedAt) / 3600000;
        if (hoursOld > 24) {
            return res.json({ username: existing.username, locked: true });
        }
    }

    // Check if username taken
    if (registeredUsers[clean.toLowerCase()] && registeredUsers[clean.toLowerCase()].uid !== uid) {
        return res.status(409).json({ error: 'Username taken' });
    }

    registeredUsers[clean.toLowerCase()] = { uid, username: clean, lockedAt: Date.now() };
    res.json({ username: clean, locked: false });
});

io.on('connection', (socket) => {
    console.log(`Device connected: ${socket.id}`);

    socket.on('joinRace', (data) => {
        players[socket.id] = {
            username: data.username,
            avatar: data.avatar || '🏁',
            slot: data.slot || '7:00',
            lat: null,
            lng: null,
            isDisqualified: false,
            isDark: false
        };
        console.log(`${data.username} joined slot ${data.slot}`);
    });

    socket.on('updateLocation', (coords) => {
        const player = players[socket.id];
        if (!player || player.isDisqualified) return;

        player.lat = coords.lat;
        player.lng = coords.lng;
        player.isDark = false;

        io.emit('mapUpdate', players);

        const slot = raceSlots[player.slot];
        if (slot && !slot.winnerDeclared) {
            const dist = getDistance(coords.lat, coords.lng, FINISH_LINE.lat, FINISH_LINE.lng);
            if (dist <= WINNING_RADIUS_METRES) {
                slot.winnerDeclared = true;
                slot.winnerUsername = player.username;
                logWinner(player.username, player.slot);
                io.emit('slotFinished', { slot: player.slot, winner: player.username });
            }
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            io.emit('playerDQ', { username: players[socket.id].username, reason: 'Went Dark' });
            delete players[socket.id];
            io.emit('mapUpdate', players);
        }
    });
});

// Pre-race checks every minute
setInterval(() => {
    const now = new Date();
    const timeKey = now.toLocaleTimeString('en-AU', { hour12:false, hour:'2-digit', minute:'2-digit', timeZone:'Australia/Brisbane' });

    const warnings = { "06:55":"7:00","07:05":"7:10","07:15":"7:20","07:25":"7:30","07:35":"7:40","07:45":"7:50" };
    const starts   = { "07:00":"7:00","07:10":"7:10","07:20":"7:20","07:30":"7:30","07:40":"7:40","07:50":"7:50" };

    if (warnings[timeKey]) {
        const slot = warnings[timeKey];
        Object.keys(players).forEach(id => {
            const p = players[id];
            if (p.slot === slot && p.lat && p.lng) {
                const dist = getDistance(p.lat, p.lng, FINISH_LINE.lat, FINISH_LINE.lng);
                if (dist < 5000) io.to(id).emit('proximityDangerWarning', { distance: (dist/1000).toFixed(1), slot });
            }
        });
    }

    if (starts[timeKey]) {
        const slot = starts[timeKey];
        Object.keys(players).forEach(id => {
            const p = players[id];
            if (p.slot === slot && p.lat && p.lng) {
                const dist = getDistance(p.lat, p.lng, FINISH_LINE.lat, FINISH_LINE.lng);
                if (dist < 5000) {
                    p.isDisqualified = true;
                    io.to(id).emit('gridLockout', { message: `Too close — ${(dist/1000).toFixed(1)}km at launch.` });
                    io.emit('playerDQ', { username: p.username, reason: 'Jumped the grid' });
                }
            }
        });
    }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BriScramble running on port ${PORT}`));