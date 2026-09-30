const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// Глобальная защита от падения Node.js процесса
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR PREVENTED:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
});

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function getRandomLot() {
    return (Math.floor(Math.random() * 9) + 2) * 5;
}

function getCleanRoom(room) {
    return {
        roomId: room.roomId,
        hostId: room.hostId,
        hostPlayerId: room.hostPlayerId,
        gameState: room.gameState,
        currentRound: room.currentRound,
        maxRounds: room.maxRounds,
        currentLot: room.currentLot,
        timeLeft: room.timeLeft,
        players: room.players.map(p => ({
            id: p.id,
            playerId: p.playerId,
            name: p.name,
            coins: p.coins,
            points: p.points,
            hasBid: p.hasBid
        }))
    };
}

io.on('connection', (socket) => {

    socket.on('createRoom', ({ playerName, playerId }) => {
        try {
            if (!playerId) return;

            let roomCode = generateRoomCode();
            while (rooms[roomCode]) {
                roomCode = generateRoomCode();
            }

            const newPlayer = {
                id: socket.id,
                playerId: playerId,
                name: playerName || 'Игрок 1',
                coins: 100,
                points: 0,
                currentBid: null,
                hasBid: false
            };

            rooms[roomCode] = {
                roomId: roomCode,
                hostId: socket.id,
                hostPlayerId: playerId,
                gameState: 'lobby',
                currentRound: 0,
                maxRounds: 5,
                currentLot: 0,
                timer: null,
                timeLeft: 20,
                players: [newPlayer]
            };

            socket.join(roomCode);
            socket.emit('roomCreated', { roomCode, room: getCleanRoom(rooms[roomCode]) });
        } catch (err) {
            console.error('Error in createRoom:', err);
        }
    });

    socket.on('joinRoom', ({ roomCode, playerName, playerId }) => {
        try {
            if (!roomCode || !playerId) return socket.emit('errorMsg', 'Ошибка данных!');
            const code = roomCode.toUpperCase().trim();
            const room = rooms[code];

            if (!room) return socket.emit('errorMsg', 'Комната не найдена!');

            let existingPlayer = room.players.find(p => p.playerId === playerId);

            if (!existingPlayer) {
                if (room.players.length >= 6) return socket.emit('errorMsg', 'В комнате уже 6 игроков!');
                if (room.gameState !== 'lobby') return socket.emit('errorMsg', 'Игра уже идет!');

                existingPlayer = {
                    id: socket.id,
                    playerId: playerId,
                    name: playerName || `Игрок ${room.players.length + 1}`,
                    coins: 100,
                    points: 0,
                    currentBid: null,
                    hasBid: false
                };
                room.players.push(existingPlayer);
            } else {
                existingPlayer.id = socket.id;
            }

            socket.join(code);
            socket.emit('joinedSuccess', { roomCode: code, room: getCleanRoom(room) });
            io.to(code).emit('updatePlayers', room.players);
        } catch (err) {
            console.error('Error in joinRoom:', err);
        }
    });

    socket.on('rejoinRoom', ({ roomCode, playerId }) => {
        try {
            if (!roomCode || !playerId) return socket.emit('rejoinFailed');

            const code = roomCode.toUpperCase().trim();
            const room = rooms[code];

            if (!room) return socket.emit('rejoinFailed');

            const player = room.players.find(p => p.playerId === playerId);
            if (!player) return socket.emit('rejoinFailed');

            player.id = socket.id;
            if (room.hostPlayerId === playerId) {
                room.hostId = socket.id;
            }

            socket.join(code);

            socket.emit('rejoinedSuccess', {
                roomCode: code,
                room: getCleanRoom(room),
                gameState: room.gameState,
                currentLot: room.currentLot,
                currentRound: room.currentRound,
                timeLeft: room.timeLeft
            });

            io.to(code).emit('updatePlayers', room.players);
        } catch (err) {
            console.error('Error in rejoinRoom:', err);
            socket.emit('rejoinFailed');
        }
    });

    socket.on('startGame', () => {
        try {
            let roomCode = null;
            for (const code in rooms) {
                if (rooms[code] && rooms[code].hostId === socket.id) {
                    roomCode = code;
                    break;
                }
            }

            if (!roomCode) return;
            const room = rooms[roomCode];

            if (room.players.length < 2) {
                return socket.emit('errorMsg', 'Нужно минимум 2 игрока!');
            }

            room.gameState = 'playing';
            room.currentRound = 1;
            startNewRound(roomCode);
        } catch (err) {
            console.error('Error in startGame:', err);
        }
    });

    // Перезапуск игры создателем комнаты
    socket.on('restartGame', () => {
        try {
            let roomCode = null;
            for (const code in rooms) {
                if (rooms[code] && rooms[code].hostId === socket.id) {
                    roomCode = code;
                    break;
                }
            }

            if (!roomCode) return;
            const room = rooms[roomCode];

            if (room.timer) clearInterval(room.timer);

            room.gameState = 'lobby';
            room.currentRound = 0;
            room.currentLot = 0;
            room.timeLeft = 20;

            // Сбрасываем счетники всех игроков
            room.players.forEach(p => {
                p.coins = 100;
                p.points = 0;
                p.currentBid = null;
                p.hasBid = false;
            });

            // Отправляем ВСЕХ участников обратно в лобби комнаты
            io.to(roomCode).emit('returnedToLobby', {
                roomCode: roomCode,
                room: getCleanRoom(room)
            });
        } catch (err) {
            console.error('Error in restartGame:', err);
        }
    });

    // Обработка выхода из комнаты / игры
    socket.on('leaveRoom', () => {
        try {
            let roomCode = null;
            let playerIndex = -1;

            for (const code in rooms) {
                if (!rooms[code]) continue;
                const idx = rooms[code].players.findIndex(p => p.id === socket.id);
                if (idx !== -1) {
                    roomCode = code;
                    playerIndex = idx;
                    break;
                }
            }

            if (!roomCode) return;
            const room = rooms[roomCode];

            room.players.splice(playerIndex, 1);
            socket.leave(roomCode);

            if (room.players.length === 0) {
                if (room.timer) clearInterval(room.timer);
                delete rooms[roomCode];
            } else {
                if (room.hostId === socket.id) {
                    room.hostId = room.players[0].id;
                    room.hostPlayerId = room.players[0].playerId;
                }
                io.to(roomCode).emit('updatePlayers', room.players);
            }

            socket.emit('leftRoomSuccess');
        } catch (err) {
            console.error('Error in leaveRoom:', err);
        }
    });

    socket.on('submitBid', ({ bid }) => {
        try {
            let roomCode = null;
            let player = null;

            for (const code in rooms) {
                if (!rooms[code]) continue;
                const p = rooms[code].players.find(x => x.id === socket.id);
                if (p) {
                    roomCode = code;
                    player = p;
                    break;
                }
            }

            if (!roomCode || !player) return;
            const room = rooms[roomCode];

            if (player.hasBid) return;

            const bidAmount = parseInt(bid, 10);
            if (isNaN(bidAmount) || bidAmount < 0 || bidAmount > player.coins) {
                return socket.emit('errorMsg', 'Некорректная ставка!');
            }

            player.currentBid = bidAmount;
            player.hasBid = true;

            io.to(roomCode).emit('bidReceived', {
                playersStatus: room.players.map(p => ({ playerId: p.playerId, hasBid: p.hasBid }))
            });

            const allBidded = room.players.every(p => p.hasBid);
            if (allBidded) {
                if (room.timer) clearInterval(room.timer);
                evaluateRound(roomCode);
            }
        } catch (err) {
            console.error('Error in submitBid:', err);
        }
    });

    socket.on('disconnect', () => {});
});

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.currentLot = getRandomLot();
    room.timeLeft = 20;

    room.players.forEach(p => {
        p.currentBid = null;
        p.hasBid = false;
    });

    io.to(roomCode).emit('newRoundStarted', {
        round: room.currentRound,
        maxRounds: room.maxRounds,
        lot: room.currentLot,
        timeLeft: room.timeLeft,
        players: room.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            coins: p.coins,
            points: p.points,
            hasBid: false
        }))
    });

    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(() => {
        if (!rooms[roomCode]) {
            clearInterval(room.timer);
            return;
        }

        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);

            room.players.forEach(p => {
                if (!p.hasBid) {
                    p.currentBid = 0;
                    p.hasBid = true;
                }
            });

            evaluateRound(roomCode);
        }
    }, 1000);
}

function evaluateRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    let maxBid = -1;
    room.players.forEach(p => {
        if (p.currentBid > maxBid) maxBid = p.currentBid;
    });

    const winners = room.players.filter(p => p.currentBid === maxBid);
    const pointsPerWinner = winners.length > 0 ? Math.floor(room.currentLot / winners.length) : 0;

    room.players.forEach(p => {
        p.coins -= p.currentBid;
        if (p.currentBid === maxBid) {
            p.points += pointsPerWinner;
        }
    });

    const resultData = {
        maxBid: maxBid,
        winnersNames: winners.map(w => w.name),
        pointsGained: pointsPerWinner,
        isTie: winners.length > 1,
        players: room.players.map(p => ({
            playerId: p.playerId,
            name: p.name,
            coins: p.coins,
            points: p.points,
            lastBid: p.currentBid
        }))
    };

    io.to(roomCode).emit('roundResult', resultData);

    setTimeout(() => {
        const currentRoom = rooms[roomCode];
        if (!currentRoom) return;

        if (currentRoom.currentRound < currentRoom.maxRounds) {
            currentRoom.currentRound++;
            startNewRound(roomCode);
        } else {
            currentRoom.gameState = 'finished';
            let maxPoints = -1;
            currentRoom.players.forEach(p => {
                if (p.points > maxPoints) maxPoints = p.points;
            });
            const gameWinners = currentRoom.players.filter(p => p.points === maxPoints);

            io.to(roomCode).emit('gameOver', {
                winners: gameWinners,
                players: currentRoom.players,
                hostPlayerId: currentRoom.hostPlayerId
            });
        }
    }, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));