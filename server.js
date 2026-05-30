const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve your completed index.html file out of the public folder
app.use(express.static(path.join(__dirname, 'public')));

// THE WINNING TARGET: King George Square, Brisbane CBD
const FINISH_LINE = { lat: -27.4691, lng: 153.0235 }; 
const WINNING_RADIUS_METRES = 20; // 20-meter geofence perimeter

// Track the 6 parallel race slots independently
let raceSlots = {
    "7:00": { winnerDeclared: false, winnerUsername: null },
    "7:10": { winnerDeclared: false, winnerUsername: null },
    "7:20": { winnerDeclared: false, winnerUsername: null },
    "7:30": { winnerDeclared: false, winnerUsername: null },
    "7:40": { winnerDeclared: false, winnerUsername: null },
    "7:50": { winnerDeclared: false, winnerUsername: null }
};

let players = {}; // High-speed in-memory state tracking for active devices

// Helper: Calculate accurate distance over Earth's surface (Haversine formula)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi/2) * Math.sin(deltaPhi/2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Immutable log tracking to verify the digital text-to-claim codes
function logWinnerToFile(username, slotTime) {
    const dateStr = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' });
    const timeStr = new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' });
    const logLine = `[${dateStr} @ ${timeStr}] SLOT: ${slotTime} | WINNER: ${username} | STATUS: Awaiting SMS Claim\n`;
    
    fs.appendFile('winners.txt', logLine, (err) => {
        if (err) console.error('Error logging winner payload:', err);
        console.log(`💾 Security Logged: ${username} won the ${slotTime} slot.`);
    });
}

// ----------------------------------------------------
// REAL-TIME WEBSOCKET COMMUTER ROUTING
// ----------------------------------------------------
io.on('connection', (socket) => {
    console.log(`📱 Device stream connected: ${socket.id}`);

    socket.on('joinRace', (data) => {
        players[socket.id] = {
            username: data.username,
            avatar: data.avatar || '🏃',
            slot: data.slot || '7:00',
            lat: null,
            lng: null,
            isDisqualified: false
        };
        console.log(`🏁 Grid Slot Locked: ${data.username} in ${data.slot} Scramble`);
    });

    socket.on('updateLocation', (coords) => {
        const player = players[socket.id];
        if (!player || player.isDisqualified) return;

        player.lat = coords.lat;
        player.lng = coords.lng;

        // Broadcast positions across maps instantly
        io.emit('mapUpdate', players);

        const currentSlot = raceSlots[player.slot];
        if (currentSlot && !currentSlot.winnerDeclared) {
            const distance = getDistance(coords.lat, coords.lng, FINISH_LINE.lat, FINISH_LINE.lng);
            
            // Geofenced crossing check
            if (distance <= WINNING_RADIUS_METRES) {
                currentSlot.winnerDeclared = true;
                currentSlot.winnerUsername = player.username;

                logWinnerToFile(player.username, player.slot);

                // Broadcast victory only to matching racers
                io.emit('slotFinished', { slot: player.slot, winner: player.username });
                console.log(`🏆 WINNER: ${player.username} captured slot ${player.slot}`);
            }
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            io.emit('playerDQ', { username: players[socket.id].username, reason: "Went Dark" });
            delete players[socket.id];
            io.emit('mapUpdate', players);
        }
    });
});

// ----------------------------------------------------
// AUTOMATED 5-MINUTE BOUNDARY CHECK LOOPS
// ----------------------------------------------------
setInterval(() => {
    const now = new Date();
    const timeKey = now.toLocaleTimeString('en-AU', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Brisbane' });

    // Danger Zone Mappings (5 minutes pre-race start)
    const warningTimes = {
        "06:55": "7:00", "07:05": "7:10", "07:15": "7:20",
        "07:25": "7:30", "07:35": "7:40", "07:45": "7:50"
    };

    // Official Grid Lock Mappings (Race start gun)
    const startTimes = {
        "07:00": "7:00", "07:10": "7:10", "07:20": "7:20",
        "07:30": "7:30", "07:40": "7:40", "07:50": "7:50"
    };

    // 1. Process Pre-Race Warnings
    if (warningTimes[timeKey]) {
        const slot = warningTimes[timeKey];
        Object.keys(players).forEach(id => {
            const p = players[id];
            if (p.slot === slot && p.lat && p.lng) {
                const dist = getDistance(p.lat, p.lng, FINISH_LINE.lat, FINISH_LINE.lng);
                if (dist < 5000) {
                    io.to(id).emit('proximityDangerWarning', { distance: (dist / 1000).toFixed(1), slot: slot });
                }
            }
        });
    }

    // 2. Enforce Hard Grid Start Lockouts
    if (startTimes[timeKey]) {
        const slot = startTimes[timeKey];
        Object.keys(players).forEach(id => {
            const p = players[id];
            if (p.slot === slot && p.lat && p.lng) {
                const dist = getDistance(p.lat, p.lng, FINISH_LINE.lat, FINISH_LINE.lng);
                if (dist < 5000) {
                    p.isDisqualified = true;
                    io.to(id).emit('gridLockout', { message: `Too close! You were ${(dist / 1000).toFixed(1)}km out at launch time.` });
                    io.emit('playerDQ', { username: p.username, reason: "Jumped the starting grid" });
                }
            }
        });
    }
}, 60000); // Evaluates parameters precisely every minute

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 BriScramble Core Engine hot on port ${PORT}`));