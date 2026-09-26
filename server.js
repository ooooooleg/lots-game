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

// Генерация случайного лота (от 10 до 50 очков, кратно 5 для красоты)
function getRandomLot() {
    return (Math.floor(Math.random() * 9) + 2) * 5; // [10, 15, 20, 25, 30, 35, 40, 45, 50]
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

    // 2. Присоединение к комнате
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const code = roomCode.toUpperCase().trim();
        const room = rooms[code];

        if (!room) {
            socket.emit('errorMsg', 'Комната с таким кодом не найдена!');
            return;
        }

        if (room.players.length >= 6) {
            socket.emit('errorMsg', 'В комнате уже 6 игроков!');
            return;
        }

        if (room.gameState !== 'lobby') {
            socket.emit('errorMsg', 'Игра уже началась!');
            return;
        }

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

    // 3. Старт игры (нажимает Хост)
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
            socket.emit('errorMsg', 'Для игры нужно минимум 2 игрока!');
            return;
        }

        room.gameState = 'playing';
        room.currentRound = 1;
        startNewRound(roomCode);
    });

    // 4. Прием ставки от игрока
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

        const bidAmount = parseInt(bid, 10);
        if (isNaN(bidAmount) || bidAmount < 0 || bidAmount > player.coins) {
            socket.emit('errorMsg', 'Некорректная ставка!');
            return;
        }

        player.currentBid = bidAmount;
        player.hasBid = true;

        // Сообщаем всем в комнате, кто уже сделал ставку (без раскрытия суммы!)
        io.to(roomCode).emit('bidReceived', {
            playersStatus: room.players.map(p => ({ id: p.id, hasBid: p.hasBid }))
        });

        // Проверяем, сделано ли все ставки
        const allBidded = room.players.every(p => p.hasBid);
        if (allBidded) {
            evaluateRound(roomCode);
        }
    });

    // 5. Отключение
    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const index = room.players.findIndex(p => p.id === socket.id);

            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
                    delete rooms[code];
                } else {
                    if (room.hostId === socket.id) {
                        room.hostId = room.players[0].id;
                    }
                    io.to(code).emit('updatePlayers', room.players);
                }
                break;
            }
        }
    });
});

// Запуск нового раунда
function startNewRound(roomCode) {
    const room = rooms[roomCode];
    room.currentLot = getRandomLot();

    // Сбрасываем ставки
    room.players.forEach(p => {
        p.currentBid = null;
        p.hasBid = false;
    });

    io.to(roomCode).emit('newRoundStarted', {
        round: room.currentRound,
        maxRounds: room.maxRounds,
        lot: room.currentLot,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            coins: p.coins,
            points: p.points,
            hasBid: false
        }))
    });
}

// Подведение итогов раунда
function evaluateRound(roomCode) {
    const room = rooms[roomCode];

    // Находим максимальную ставку
    let maxBid = -1;
    room.players.forEach(p => {
        if (p.currentBid > maxBid) {
            maxBid = p.currentBid;
        }
    });

    // Находим всех, кто поставил максимальную ставку (учитываем ничью)
    const winners = room.players.filter(p => p.currentBid === maxBid);
    const pointsPerWinner = Math.floor(room.currentLot / winners.length);

    // Списываем монеты и начисляем очки
    room.players.forEach(p => {
        p.coins -= p.currentBid; // Вычитаем ставку
        if (p.currentBid === maxBid) {
            p.points += pointsPerWinner;
        }
    });

    // Формируем сводку раунда
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

    // Через 5 секунд переходим к следующему раунду или финалу
    setTimeout(() => {
        if (room.currentRound < room.maxRounds) {
            room.currentRound++;
            startNewRound(roomCode);
        } else {
            room.gameState = 'finished';
            // Определение победителя игры
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