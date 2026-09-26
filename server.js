const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

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

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    // 1. Создание комнаты
    socket.on('createRoom', ({ playerName }) => {
        let roomCode = generateRoomCode();
        while (rooms[roomCode]) {
            roomCode = generateRoomCode();
        }

        rooms[roomCode] = {
            roomId: roomCode,
            hostId: socket.id,
            gameState: 'lobby',
            currentRound: 0,
            maxRounds: 5,
            currentLot: 0,
            timer: null,
            timeLeft: 20,
            players: [
                {
                    id: socket.id,
                    name: playerName || 'Игрок 1',
                    coins: 100,
                    points: 0,
                    currentBid: null,
                    hasBid: false
                }
            ]
        };

        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, room: rooms[roomCode] });
    });

    // 2. Вход в новую комнату
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const code = roomCode.toUpperCase().trim();
        const room = rooms[code];

        if (!room) return socket.emit('errorMsg', 'Комната с таким кодом не найдена!');
        if (room.players.length >= 6) return socket.emit('errorMsg', 'В комнате уже 6 игроков!');
        if (room.gameState !== 'lobby') return socket.emit('errorMsg', 'Игра уже началась!');

        const newPlayer = {
            id: socket.id,
            name: playerName || `Игрок ${room.players.length + 1}`,
            coins: 100,
            points: 0,
            currentBid: null,
            hasBid: false
        };

        room.players.push(newPlayer);
        socket.join(code);

        socket.emit('joinedSuccess', { roomCode: code, room });
        io.to(code).emit('updatePlayers', room.players);
    });

    // 3. Переподключение после перезагрузки страницы (Rejoin)
    socket.on('rejoinRoom', ({ roomCode, playerName }) => {
        const code = roomCode ? roomCode.toUpperCase().trim() : '';
        const room = rooms[code];

        if (!room) {
            return socket.emit('rejoinFailed');
        }

        // Ищем существующего игрока по имени
        let player = room.players.find(p => p.name === playerName);

        if (player) {
            // Обновляем ID сокета у переподключившегося игрока
            if (room.hostId === player.id) room.hostId = socket.id;
            player.id = socket.id;
        } else {
            // Если игра еще в лобби, можем добавить его заново
            if (room.gameState === 'lobby' && room.players.length < 6) {
                player = {
                    id: socket.id,
                    name: playerName,
                    coins: 100,
                    points: 0,
                    currentBid: null,
                    hasBid: false
                };
                room.players.push(player);
            } else {
                return socket.emit('rejoinFailed');
            }
        }

        socket.join(code);

        // Отправляем игроку текущее состояние комнаты
        socket.emit('rejoinedSuccess', {
            roomCode: code,
            room: room,
            gameState: room.gameState,
            currentLot: room.currentLot,
            currentRound: room.currentRound,
            timeLeft: room.timeLeft
        });

        io.to(code).emit('updatePlayers', room.players);
    });

    // 4. Старт игры
    socket.on('startGame', () => {
        let roomCode = null;
        for (const code in rooms) {
            if (rooms[code].hostId === socket.id) {
                roomCode = code;
                break;
            }
        }

        if (!roomCode) return;
        const room = rooms[roomCode];

        if (room.players.length < 2) {
            return socket.emit('errorMsg', 'Для игры нужно минимум 2 игрока!');
        }

        room.gameState = 'playing';
        room.currentRound = 1;
        startNewRound(roomCode);
    });

    // 5. Прием ставки
    socket.on('submitBid', ({ bid }) => {
        let roomCode = null;
        let player = null;

        for (const code in rooms) {
            const p = rooms[code].players.find(x => x.id === socket.id);
            if (p) {
                roomCode = code;
                player = p;
                break;
            }
        }

        if (!roomCode || !player) return;
        const room = rooms[roomCode];

        if (player.hasBid) return; // Нельзя ставить дважды за раунд

        const bidAmount = parseInt(bid, 10);
        if (isNaN(bidAmount) || bidAmount < 0 || bidAmount > player.coins) {
            return socket.emit('errorMsg', 'Некорректная ставка!');
        }

        player.currentBid = bidAmount;
        player.hasBid = true;

        io.to(roomCode).emit('bidReceived', {
            playersStatus: room.players.map(p => ({ id: p.id, hasBid: p.hasBid }))
        });

        const allBidded = room.players.every(p => p.hasBid);
        if (allBidded) {
            clearInterval(room.timer); // Останавливаем таймер
            evaluateRound(roomCode);
        }
    });

    // 6. Отключение игрока
    socket.on('disconnect', () => {
        // Мы НЕ удаляем игрока мгновенно из списка во время игры,
        // чтобы дать ему возможность переподключиться при перезагрузке
        for (const code in rooms) {
            const room = rooms[code];
            const pIndex = room.players.findIndex(p => p.id === socket.id);

            if (pIndex !== -1) {
                // Если с момента отключения прошло 60 сек и он не вернулся — тогда очищаем
                setTimeout(() => {
                    const isStillDisconnected = !room.players.some(p => p.id === socket.id);
                    if (isStillDisconnected && room.gameState === 'lobby') {
                        room.players.splice(pIndex, 1);
                        if (room.players.length === 0) delete rooms[code];
                        else io.to(code).emit('updatePlayers', room.players);
                    }
                }, 60000);
                break;
            }
        }
    });
});

// Новый раунд + запуск 20-секундного таймера
function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.currentLot = getRandomLot();
    room.timeLeft = 20; // 20 секунд на раунд

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
            id: p.id,
            name: p.name,
            coins: p.coins,
            points: p.points,
            hasBid: false
        }))
    });

    if (room.timer) clearInterval(room.timer);

    // Запуск интервала обратного отсчета (каждую секунду)
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);

        // Время вышло!
        if (room.timeLeft <= 0) {
            clearInterval(room.timer);

            // Игрокам без ставки автоматически ставится 0 монет
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

// Расчет итогов раунда
function evaluateRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    let maxBid = -1;
    room.players.forEach(p => {
        if (p.currentBid > maxBid) maxBid = p.currentBid;
    });

    const winners = room.players.filter(p => p.currentBid === maxBid);
    const pointsPerWinner = Math.floor(room.currentLot / winners.length);

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
            id: p.id,
            name: p.name,
            coins: p.coins,
            points: p.points,
            lastBid: p.currentBid
        }))
    };

    io.to(roomCode).emit('roundResult', resultData);

    setTimeout(() => {
        if (room.currentRound < room.maxRounds) {
            room.currentRound++;
            startNewRound(roomCode);
        } else {
            room.gameState = 'finished';
            let maxPoints = -1;
            room.players.forEach(p => {
                if (p.points > maxPoints) maxPoints = p.points;
            });
            const gameWinners = room.players.filter(p => p.points === maxPoints);

            io.to(roomCode).emit('gameOver', {
                winners: gameWinners,
                players: room.players
            });
        }
    }, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});