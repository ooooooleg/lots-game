const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// ---------------------------------------------------------------------------
// Режимы игры
// ---------------------------------------------------------------------------
const MODE_NORMAL = 'normal';
const MODE_ABILITIES = 'abilities';

const MODES = {
    [MODE_NORMAL]: { key: MODE_NORMAL, label: 'Обычный', maxRounds: 5 },
    [MODE_ABILITIES]: { key: MODE_ABILITIES, label: 'Со способностями', maxRounds: 7 }
};

const ROUND_TIME = 30;          // длительность раунда (сек)
const ABILITY_SELECT_TIME = 20; // длительность выбора способностей (сек)
const ROUND_DELAY = parseInt(process.env.ROUND_DELAY || '5000', 10); // пауза между раундами (мс)
const ABILITY_ROUNDS = [1, 3, 5]; // раунды, в которых выбираются способности

// ---------------------------------------------------------------------------
// Способности
// ---------------------------------------------------------------------------
const ACTIVE_ABILITIES = [
    { id: 'shield', name: 'Щит', desc: 'Проиграешь раунд — вернёшь 50% своей ставки.', target: false },
    { id: 'steal', name: 'Кража', desc: 'Победишь раунд — заберёшь 10 монет у случайного соперника.', target: false },
    { id: 'freeze', name: 'Заморозка', desc: 'Выбранный игрок не сможет использовать свои способности (активные и пассивные) в этом раунде.', target: true },
    { id: 'sabotage', name: 'Саботаж', desc: 'Выбранный игрок потеряет 10 монет в любом случае.', target: true },
    { id: 'double_reward', name: 'Двойная награда', desc: 'Победа в раунде принесёт вдвое больше очков.', target: false },
    { id: 'parimatch', name: 'Пари', desc: 'Выбери игрока: если он поставит меньше тебя — получишь +15 монет.', target: true },
    { id: 'rematch', name: 'Реванш', desc: 'Проиграл прошлый раунд — вернёшь 25% потерянных монет.', target: false },
    { id: 'trap', name: 'Ловушка', desc: 'Выбери игрока: если он поставит больше тебя — он потеряет 10 монет.', target: true },
    { id: 'blind', name: 'Слепота', desc: 'Выбранный игрок не увидит, сколько очков разыгрывается, в следующем раунде.', target: true },
    { id: 'diamond', name: 'Глаз-алмаз', desc: 'Ты увидишь ставку выбранного игрока в этом раунде.', target: true },
    { id: 'reduction', name: 'Сокращение', desc: 'Кто бы ни победил в этом раунде, получит вдвое меньше очков.', target: false },
    { id: 'tax', name: 'Налог', desc: 'Все, кто поставил больше тебя, отдадут тебе по 5 монет.', target: false },
    { id: 'small_win', name: 'Маленькая победа', desc: 'Лот на 10 или 15 очков: победа приносит двойные очки.', target: false }
];

const PASSIVE_ABILITIES = [
    { id: 'cashback', name: 'Кешбэк', desc: 'В конце каждого раунда возвращает 10% твоей ставки.', target: false },
    { id: 'bonus', name: 'Бонус', desc: 'За каждый выигранный лот начисляется +5 монет.', target: false },
    { id: 'passive_income', name: 'Пассив', desc: 'Каждый раунд: −5 монет и +3 очка (если есть 5 монет).', target: false },
    { id: 'fifty_fifty', name: '50/50', desc: 'В начале раунда: 50% шанс +5 монет, 50% шанс −5 монет.', target: false },
    { id: 'economist', name: 'Экономист', desc: 'Поставил 10 или меньше и выиграл — получаешь +5 монет.', target: false },
    { id: 'win_streak', name: 'Серия побед', desc: 'Забрал два лота подряд — получаешь +10 монет.', target: false },
    { id: 'final_sprint', name: 'Финальный рывок', desc: 'В последних двух раундах твои ставки сильнее на 5.', target: false },
    { id: 'lucky_number', name: 'Счастливое число', desc: 'Ставка кратна 10 и ты забрал лот — +5 монет.', target: false },
    { id: 'patience', name: 'Терпение', desc: 'Два раунда подряд без победы — получаешь +15 монет.', target: false },
    { id: 'point_hunter', name: 'Охотник за очками', desc: 'Победа в лоте на 40+ очков — +5 очков.', target: false },
    { id: 'insurance', name: 'Страховка', desc: 'Проиграл раунд — возвращается 20% твоей ставки.', target: false },
    { id: 'small_bet', name: 'Маленькая ставка', desc: 'Поставил 10 или меньше и выиграл — +5 очков.', target: false },
    { id: 'big_bet', name: 'Большая ставка', desc: 'Поставил 70+ и выиграл — возвращается 10 монет.', target: false },
    { id: 'greed', name: 'Жадность', desc: 'Победа с разницей 20+ монет — +5 очков.', target: false },
    { id: 'double_profit', name: 'Двойная прибыль', desc: 'Ставка совпала со ставкой другого и ты выиграл — +10 монет.', target: false },
    { id: 'last_chance', name: 'Последний шанс', desc: 'Если у тебя 20 монет или меньше, ставка сильнее на 5.', target: false },
    { id: 'risk', name: 'Риск', desc: 'Поставил 50% и больше своих монет и выиграл — +5 очков.', target: false },
    { id: 'minimalist', name: 'Минималист', desc: 'Победа со ставкой 5 монет и меньше — +10 монет.', target: false },
    { id: 'investor', name: 'Инвестор', desc: 'Два проигрыша подряд — следующая победа приносит +10 монет.', target: false }
];

const ABILITY_BY_ID = {};
ACTIVE_ABILITIES.forEach(a => ABILITY_BY_ID[a.id] = Object.assign({ type: 'active' }, a));
PASSIVE_ABILITIES.forEach(a => ABILITY_BY_ID[a.id] = Object.assign({ type: 'passive' }, a));

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
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

function findPlayerRoom(socketId) {
    for (const code in rooms) {
        const room = rooms[code];
        if (!room) continue;
        const index = room.players.findIndex(p => p.id === socketId);
        if (index !== -1) return { code, room, player: room.players[index], index };
    }
    return null;
}

function findHostRoom(socketId) {
    for (const code in rooms) {
        const room = rooms[code];
        if (room && room.hostId === socketId) return { code, room };
    }
    return null;
}

function getByPlayerId(room, playerId) {
    if (!playerId) return null;
    return room.players.find(p => p.playerId === playerId) || null;
}

function clearRoomTimers(room) {
    if (room.timer) { clearInterval(room.timer); room.timer = null; }
    if (room.selTimer) { clearInterval(room.selTimer); room.selTimer = null; }
}

function createPlayer(socketId, playerId, name) {
    return {
        id: socketId,
        playerId,
        name,
        coins: 100,
        points: 0,
        currentBid: null,
        hasBid: false,
        activeAbilities: [],
        armedAbility: null,
        usedActiveAbilities: [],
        passiveAbilities: [],
        pendingChoice: null,
        abilityOptions: [],
        blind: false,
        blindNext: false,
        eyeTarget: null,
        frozen: false,
        roundNote: '',
        roundResults: [],
        lastBid: null,
        winStreak: 0,
        lossStreak: 0,
        prevWinStreak: 0,
        prevLossStreak: 0,
        abilityFlags: {}
    };
}

function resetPlayers(room) {
    room.players.forEach(p => {
        p.coins = 100;
        p.points = 0;
        p.currentBid = null;
        p.hasBid = false;
        p.activeAbilities = [];
        p.armedAbility = null;
        p.usedActiveAbilities = [];
        p.passiveAbilities = [];
        p.pendingChoice = null;
        p.abilityOptions = [];
        p.blind = false;
        p.blindNext = false;
        p.eyeTarget = null;
        p.frozen = false;
        p.roundNote = '';
        p.roundResults = [];
        p.lastBid = null;
        p.winStreak = 0;
        p.lossStreak = 0;
        p.prevWinStreak = 0;
        p.prevLossStreak = 0;
        p.abilityFlags = {};
    });
}

function getCleanRoom(room) {
    return {
        roomId: room.roomId,
        hostId: room.hostId,
        hostPlayerId: room.hostPlayerId,
        gameState: room.gameState,
        mode: room.mode,
        modeLabel: (MODES[room.mode] || MODES[MODE_NORMAL]).label,
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

function abilitiesPayload(room, player) {
    if (!player || room.mode !== MODE_ABILITIES) return { active: [], passive: [], armed: null, canActivate: false };
    const armedDef = player.armedAbility ? ABILITY_BY_ID[player.armedAbility.id] : null;
    const armedTarget = player.armedAbility ? getByPlayerId(room, player.armedAbility.targetPlayerId) : null;
    return {
        active: player.activeAbilities.map(a => {
            const def = ABILITY_BY_ID[a.id];
            return { id: a.id, name: def.name, desc: def.desc, target: !!def.target };
        }),
        passive: player.passiveAbilities.map(a => {
            const def = ABILITY_BY_ID[a.id];
            return { id: a.id, name: def.name, desc: def.desc };
        }),
        armed: player.armedAbility && armedDef ? {
            id: player.armedAbility.id,
            name: armedDef.name,
            desc: armedDef.desc,
            target: !!armedDef.target,
            targetName: armedTarget ? armedTarget.name : null
        } : null,
        canActivate: room.gameState === 'playing' && !player.frozen && !player.armedAbility,
        frozen: !!player.frozen
    };
}

// Персональная отправка: каждый игрок получает только свои данные
function emitPersonalized(room, event, build) {
    room.players.forEach(p => {
        const sock = io.sockets.sockets.get(p.id);
        if (sock) sock.emit(event, build(p));
    });
}

// Обновить приватный список способностей конкретного игрока
function notifyAbilities(room, player) {
    const sock = io.sockets.sockets.get(player.id);
    if (sock) sock.emit('abilitiesUpdated', { myAbilities: abilitiesPayload(room, player) });
}

function addCoins(p, amount) {
    if (amount <= 0) return 0;
    p.coins += amount;
    return amount;
}

function takeCoins(p, amount) {
    if (amount <= 0) return 0;
    const actual = Math.min(amount, p.coins);
    p.coins -= actual;
    return actual;
}

function percent(value, part) {
    return Math.floor(value * part);
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {

    socket.on('createRoom', ({ playerName, playerId }) => {
        try {
            if (!playerId) return;

            let roomCode = generateRoomCode();
            while (rooms[roomCode]) {
                roomCode = generateRoomCode();
            }

            const newPlayer = createPlayer(socket.id, playerId, playerName || 'Игрок 1');

            rooms[roomCode] = {
                roomId: roomCode,
                hostId: socket.id,
                hostPlayerId: playerId,
                gameState: 'lobby',
                mode: MODE_NORMAL,
                currentRound: 0,
                maxRounds: MODES[MODE_NORMAL].maxRounds,
                currentLot: 0,
                timer: null,
                selTimer: null,
                timeLeft: ROUND_TIME,
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

            let existingPlayer = getByPlayerId(room, playerId);

            if (!existingPlayer) {
                if (room.players.length >= 6) return socket.emit('errorMsg', 'В комнате уже 6 игроков!');
                if (room.gameState !== 'lobby') return socket.emit('errorMsg', 'Игра уже идет!');

                existingPlayer = createPlayer(socket.id, playerId, playerName || `Игрок ${room.players.length + 1}`);
                room.players.push(existingPlayer);
            } else {
                existingPlayer.id = socket.id;
            }

            socket.join(code);
            socket.emit('joinedSuccess', { roomCode: code, room: getCleanRoom(room) });
            io.to(code).emit('updatePlayers', getCleanRoom(room));
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

            const player = getByPlayerId(room, playerId);
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
                currentLot: room.gameState === 'abilitySelect' ? 0 : room.currentLot,
                currentRound: room.currentRound,
                maxRounds: room.maxRounds,
                mode: room.mode,
                timeLeft: room.timeLeft,
                blind: !!player.blind,
                abilityOptions: room.gameState === 'abilitySelect' ? player.abilityOptions : null,
                myAbilities: abilitiesPayload(room, player)
            });

            io.to(code).emit('updatePlayers', getCleanRoom(room));
        } catch (err) {
            console.error('Error in rejoinRoom:', err);
            socket.emit('rejoinFailed');
        }
    });

    // Смена режима игры (только создатель комнаты)
    socket.on('setGameMode', ({ mode }) => {
        try {
            const found = findHostRoom(socket.id);
            if (!found) return;
            const { room } = found;
            if (!MODES[mode]) return;
            if (room.gameState !== 'lobby') return;

            room.mode = mode;
            room.maxRounds = MODES[mode].maxRounds;

            io.to(room.roomId).emit('updatePlayers', getCleanRoom(room));
        } catch (err) {
            console.error('Error in setGameMode:', err);
        }
    });

    // Кик игрока (только создатель комнаты)
    socket.on('kickPlayer', ({ playerId }) => {
        try {
            const found = findHostRoom(socket.id);
            if (!found) return;
            const { room } = found;
            if (!playerId || playerId === room.hostPlayerId) return;

            const idx = room.players.findIndex(p => p.playerId === playerId);
            if (idx === -1) return;

            const kicked = room.players[idx];
            room.players.splice(idx, 1);

            const kickedSocket = io.sockets.sockets.get(kicked.id);
            if (kickedSocket) {
                kickedSocket.leave(room.roomId);
                kickedSocket.emit('playerKicked', { reason: 'Создатель комнаты исключил тебя' });
            }

            if (room.players.length === 0) {
                clearRoomTimers(room);
                delete rooms[room.roomId];
                return;
            }

            io.to(room.roomId).emit('updatePlayers', getCleanRoom(room));

            // Если игра уже идёт и все оставшиеся поставили — продолжаем
            if (room.gameState === 'playing' && room.players.every(p => p.hasBid)) {
                clearRoomTimers(room);
                evaluateRound(room.roomId);
            }

            // Если идёт выбор способностей и все оставшиеся выбрали — начинаем раунд
            if (room.gameState === 'abilitySelect' && room.players.length
                && room.players.every(p => p.pendingChoice)) {
                clearRoomTimers(room);
                finishAbilitySelection(room.roomId);
            }
        } catch (err) {
            console.error('Error in kickPlayer:', err);
        }
    });

    socket.on('startGame', () => {
        try {
            const found = findHostRoom(socket.id);
            if (!found) return;
            const { code, room } = found;

            if (room.players.length < 2) {
                return socket.emit('errorMsg', 'Нужно минимум 2 игрока!');
            }
            if (room.gameState !== 'lobby') return;

            clearRoomTimers(room);
            resetPlayers(room);
            room.gameState = 'playing';
            room.currentRound = 1;
            room.maxRounds = MODES[room.mode].maxRounds;

            startRoundOrSelection(code);
        } catch (err) {
            console.error('Error in startGame:', err);
        }
    });

    // Перезапуск игры создателем комнаты
    socket.on('restartGame', () => {
        try {
            const found = findHostRoom(socket.id);
            if (!found) return;
            const { code, room } = found;

            clearRoomTimers(room);

            room.gameState = 'lobby';
            room.currentRound = 0;
            room.currentLot = 0;
            room.timeLeft = ROUND_TIME;
            room.maxRounds = MODES[room.mode].maxRounds;
            resetPlayers(room);

            io.to(code).emit('returnedToLobby', {
                roomCode: code,
                room: getCleanRoom(room)
            });
        } catch (err) {
            console.error('Error in restartGame:', err);
        }
    });

    // Обработка выхода из комнаты / игры
    socket.on('leaveRoom', () => {
        try {
            const found = findPlayerRoom(socket.id);
            if (!found) return;

            const { code, room, index } = found;
            room.players.splice(index, 1);
            socket.leave(code);

            if (room.players.length === 0) {
                clearRoomTimers(room);
                delete rooms[code];
            } else {
                if (room.hostId === socket.id) {
                    room.hostId = room.players[0].id;
                    room.hostPlayerId = room.players[0].playerId;
                }
                io.to(code).emit('updatePlayers', getCleanRoom(room));

                // Если идёт выбор способностей и все оставшиеся выбрали — начинаем раунд
                if (room.gameState === 'abilitySelect' && room.players.length
                    && room.players.every(p => p.pendingChoice)) {
                    clearRoomTimers(room);
                    finishAbilitySelection(code);
                }
            }

            socket.emit('leftRoomSuccess');
        } catch (err) {
            console.error('Error in leaveRoom:', err);
        }
    });

    socket.on('submitBid', ({ bid }) => {
        try {
            const found = findPlayerRoom(socket.id);
            if (!found) return;

            const { code, room, player } = found;
            if (room.gameState !== 'playing') return;
            if (player.hasBid) return;

            // Пустое поле ставки = 0 монет
            let bidAmount = parseInt(bid, 10);
            if (bid === '' || bid === null || bid === undefined || isNaN(bidAmount)) bidAmount = 0;

            if (bidAmount < 0 || bidAmount > player.coins) {
                return socket.emit('errorMsg', 'Некорректная ставка!');
            }

            player.currentBid = bidAmount;
            player.hasBid = true;

            io.to(code).emit('bidReceived', {
                playersStatus: room.players.map(p => ({ playerId: p.playerId, hasBid: p.hasBid }))
            });

            // Глаз-алмаз: показываем ставку выбранного игрока владельцу способности
            room.players.forEach(watcher => {
                if (!watcher.eyeTarget || watcher.eyeTarget !== player.playerId) return;
                const watcherSocket = io.sockets.sockets.get(watcher.id);
                if (watcherSocket) {
                    watcherSocket.emit('bidRevealed', {
                        playerId: player.playerId,
                        bid: bidAmount
                    });
                }
            });

            const allBidded = room.players.every(p => p.hasBid);
            if (allBidded) {
                clearRoomTimers(room);
                evaluateRound(code);
            }
        } catch (err) {
            console.error('Error in submitBid:', err);
        }
    });

    // Выбор способности (режим "Со способностями")
    socket.on('chooseAbility', ({ abilityId }) => {
        try {
            const found = findPlayerRoom(socket.id);
            if (!found) return;

            const { code, room, player } = found;
            if (room.gameState !== 'abilitySelect' || room.mode !== MODE_ABILITIES) return;
            if (player.pendingChoice) return;

            const option = player.abilityOptions.find(o => o.id === abilityId);
            if (!option) return;

            // Цель активной способности выбирается позже — при активации в раунде
            player.pendingChoice = { abilityId, targetPlayerId: null };

            if (room.players.every(p => p.pendingChoice)) {
                clearRoomTimers(room);
                finishAbilitySelection(code);
            }
        } catch (err) {
            console.error('Error in chooseAbility:', err);
        }
    });

    // Активация активной способности во время раунда
    socket.on('activateAbility', ({ abilityId, targetPlayerId }) => {
        try {
            const found = findPlayerRoom(socket.id);
            if (!found) return;

            const { code, room, player } = found;
            if (room.mode !== MODE_ABILITIES) return;
            if (room.gameState !== 'playing') {
                return socket.emit('errorMsg', 'Способность можно активировать только во время раунда!');
            }
            if (player.frozen) {
                return socket.emit('errorMsg', 'Твои способности заморожены в этом раунде!');
            }
            if (player.armedAbility) {
                return socket.emit('errorMsg', 'Способность уже активирована в этом раунде!');
            }

            const idx = player.activeAbilities.findIndex(a => a.id === abilityId);
            if (idx === -1) return;
            const def = ABILITY_BY_ID[abilityId];
            if (!def) return;

            let target = null;
            if (def.target) {
                const targetPlayer = getByPlayerId(room, targetPlayerId);
                if (!targetPlayer || targetPlayer.playerId === player.playerId) {
                    return socket.emit('errorMsg', 'Выбери соперника!');
                }
                target = targetPlayer.playerId;
            }

            // Забираем способность из инвентаря и активируем
            player.activeAbilities.splice(idx, 1);
            player.usedActiveAbilities = player.usedActiveAbilities || [];
            if (!player.usedActiveAbilities.includes(abilityId)) player.usedActiveAbilities.push(abilityId);
            player.armedAbility = { id: abilityId, targetPlayerId: target };

            // Способности с немедленным эффектом
            if (abilityId === 'freeze' && target) {
                const targetPlayer = getByPlayerId(room, target);
                if (targetPlayer) {
                    targetPlayer.frozen = true;
                    // Снимаем уже активированную способность цели и возвращаем её в инвентарь
                    if (targetPlayer.armedAbility) {
                        targetPlayer.activeAbilities.push({ id: targetPlayer.armedAbility.id, round: room.currentRound });
                        targetPlayer.armedAbility = null;
                        const ts = io.sockets.sockets.get(targetPlayer.id);
                        if (ts) ts.emit('abilityBlocked', { reason: 'Тебя заморозили — способность возвращена' });
                    }
                    notifyAbilities(room, targetPlayer);
                }
            }
            if (abilityId === 'blind' && target) {
                const targetPlayer = getByPlayerId(room, target);
                if (targetPlayer) {
                    // Слепота действует в следующем раунде — тогда игрок не увидит лот
                    targetPlayer.blindNext = true;
                }
            }
            if (abilityId === 'diamond' && target) {
                const targetPlayer = getByPlayerId(room, target);
                player.eyeTarget = target;
                if (targetPlayer && targetPlayer.hasBid) {
                    socket.emit('bidRevealed', { playerId: targetPlayer.playerId, bid: targetPlayer.currentBid || 0 });
                }
            }

            notifyAbilities(room, player);
            socket.emit('abilityActivated', { id: abilityId, name: def.name, targetName: target ? (getByPlayerId(room, target) || {}).name : null });
        } catch (err) {
            console.error('Error in activateAbility:', err);
        }
    });

    socket.on('disconnect', () => {});
});

// ---------------------------------------------------------------------------
// Раунды
// ---------------------------------------------------------------------------
function startRoundOrSelection(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.mode === MODE_ABILITIES && ABILITY_ROUNDS.includes(room.currentRound)) {
        startAbilitySelection(roomCode);
    } else {
        startNewRound(roomCode);
    }
}

function rollAbilityOptions(room, player) {
    let pool;
    if (room.currentRound <= 1) {
        pool = PASSIVE_ABILITIES.slice();
    } else if (room.currentRound >= 5) {
        pool = ACTIVE_ABILITIES.slice();
    } else {
        pool = PASSIVE_ABILITIES.concat(ACTIVE_ABILITIES);
    }

    const owned = new Set(
        player.passiveAbilities.map(a => a.id)
            .concat(player.activeAbilities.map(a => a.id))
            .concat(player.usedActiveAbilities || [])
    );
    const available = pool.filter(a => !owned.has(a.id));
    const source = available.length >= 3 ? available : pool;

    const shuffled = source.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
    }

    return shuffled.slice(0, 3).map(a => ({
        id: a.id,
        name: a.name,
        desc: a.desc,
        target: !!a.target
    }));
}

function startAbilitySelection(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    clearRoomTimers(room);

    room.gameState = 'abilitySelect';
    room.timeLeft = ABILITY_SELECT_TIME;
    room.currentLot = 0;

    room.players.forEach(p => {
        p.currentBid = null;
        p.hasBid = false;
        p.blind = false;
        p.eyeTarget = null;
        p.frozen = false;
        p.roundNote = '';
        p.pendingChoice = null;
        p.abilityOptions = rollAbilityOptions(room, p);
    });

    emitPersonalized(room, 'abilitySelectionStarted', p => ({
        round: room.currentRound,
        maxRounds: room.maxRounds,
        timeLeft: room.timeLeft,
        options: p.abilityOptions,
        myAbilities: abilitiesPayload(room, p),
        players: room.players.map(x => ({
            playerId: x.playerId,
            name: x.name,
            coins: x.coins,
            points: x.points
        }))
    }));

    room.selTimer = setInterval(() => {
        if (!rooms[roomCode]) return clearRoomTimers(room);
        room.timeLeft--;
        emitPersonalized(room, 'abilitySelectTick', () => ({ timeLeft: Math.max(0, room.timeLeft) }));

        if (room.timeLeft <= 0) {
            clearRoomTimers(room);
            finishAbilitySelection(roomCode);
        }
    }, 1000);
}

function finishAbilitySelection(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    clearRoomTimers(room);

    room.players.forEach(p => {
        let choice = p.pendingChoice;

        // Не успел выбрать — выбираем случайную из предложенных
        if (!choice && p.abilityOptions && p.abilityOptions.length) {
            const option = p.abilityOptions[Math.floor(Math.random() * p.abilityOptions.length)];
            choice = { abilityId: option.id, targetPlayerId: null };
        }

        p.pendingChoice = null;
        p.abilityOptions = [];
        if (!choice) return;

        const def = ABILITY_BY_ID[choice.abilityId];
        if (!def) return;

        if (def.type === 'active') {
            p.activeAbilities.push({ id: choice.abilityId, round: room.currentRound });
        } else {
            p.passiveAbilities.push({ id: choice.abilityId, round: room.currentRound });
        }
    });

    startNewRound(roomCode);
}

// Активные способности активируются игроком вручную во время раунда
// (см. обработчик socket.on('activateAbility')).

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    clearRoomTimers(room);

    room.currentLot = getRandomLot();
    room.timeLeft = ROUND_TIME;
    room.gameState = 'playing';

    room.players.forEach(p => {
        p.currentBid = null;
        p.hasBid = false;
        p.blind = false;
        p.eyeTarget = null;
        p.frozen = false;
        p.armedAbility = null;
        p.roundNote = '';
    });

    // Слепота, активированная в прошлом раунде, начинает действовать сейчас
    room.players.forEach(p => {
        if (p.blindNext) {
            p.blind = true;
            p.blindNext = false;
        }
    });

    const abilityMode = room.mode === MODE_ABILITIES;

    if (abilityMode) {
        // Пассивные способности, срабатывающие в начале раунда
        room.players.forEach(p => {
            if (p.frozen) return;
            if (!p.passiveAbilities.some(a => a.id === 'fifty_fifty')) return;

            if (Math.random() < 0.5) {
                addCoins(p, 5);
                p.roundNote = '50/50: повезло, +5 🪙';
            } else if (p.coins >= 5) {
                p.coins -= 5;
                p.roundNote = '50/50: не повезло, −5 🪙';
            } else {
                p.roundNote = '50/50: не повезло (мало монет)';
            }
        });
    }

    emitPersonalized(room, 'newRoundStarted', p => ({
        round: room.currentRound,
        maxRounds: room.maxRounds,
        lot: p.blind ? null : room.currentLot,
        lotHidden: !!p.blind,
        timeLeft: room.timeLeft,
        note: p.roundNote,
        players: room.players.map(x => ({
            playerId: x.playerId,
            name: x.name,
            coins: x.coins,
            points: x.points,
            hasBid: false
        })),
        myAbilities: abilitiesPayload(room, p),
        hostPlayerId: room.hostPlayerId
    }));

    room.timer = setInterval(() => {
        if (!rooms[roomCode]) return clearRoomTimers(room);

        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', Math.max(0, room.timeLeft));

        if (room.timeLeft <= 0) {
            clearRoomTimers(room);

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
    if (room.gameState !== 'playing') return;

    clearRoomTimers(room);
    room.gameState = 'resolving';

    const abilityMode = room.mode === MODE_ABILITIES;
    const players = room.players;
    const lot = room.currentLot;

    const isFrozen = p => abilityMode && p.frozen;
    const hasPassive = (p, id) => abilityMode && !isFrozen(p) && p.passiveAbilities.some(a => a.id === id);
    const activesOf = p => (abilityMode && !isFrozen(p) && p.armedAbility) ? [p.armedAbility] : [];

    const logs = {};
    const addLog = (p, text) => {
        if (!logs[p.playerId]) logs[p.playerId] = [];
        logs[p.playerId].push(text);
    };

    // Ставка с учётом пассивных способностей
    const effBid = {};
    players.forEach(p => {
        let bid = p.currentBid || 0;
        if (hasPassive(p, 'final_sprint') && room.currentRound >= room.maxRounds - 1) bid += 5;
        if (hasPassive(p, 'last_chance') && p.coins <= 20) bid += 5;
        effBid[p.playerId] = bid;
    });

    let maxBid = -1;
    players.forEach(p => {
        if (effBid[p.playerId] > maxBid) maxBid = effBid[p.playerId];
    });

    const winners = players.filter(p => effBid[p.playerId] === maxBid);

    // Вторая по величине ставка — для "Жадности"
    let secondBid = 0;
    players.forEach(p => {
        if (winners.includes(p)) return;
        if (effBid[p.playerId] > secondBid) secondBid = effBid[p.playerId];
    });
    const margin = Math.max(0, maxBid - secondBid);

    // Списываем ставки
    players.forEach(p => {
        p.coins = Math.max(0, p.coins - (p.currentBid || 0));
    });

    // Очки победителям
    const baseShare = winners.length > 0 ? Math.floor(lot / winners.length) : 0;
    // Сокращение уменьшает очки победителя вдвое, независимо от того, кто активировал
    const reductionActive = abilityMode
        && players.some(p => activesOf(p).some(a => a.id === 'reduction'));
    const gained = {};
    winners.forEach(w => {
        let pts = baseShare;
        const myActives = activesOf(w);
        if (reductionActive) pts = Math.floor(pts / 2);
        if (myActives.some(a => a.id === 'double_reward')) pts = pts * 2;
        if (myActives.some(a => a.id === 'small_win') && (lot === 10 || lot === 15)) pts = pts * 2;
        w.points += pts;
        gained[w.playerId] = pts;
    });

    // Серии побед/поражений
    players.forEach(p => {
        p.prevWinStreak = p.winStreak;
        p.prevLossStreak = p.lossStreak;
    });

    players.forEach(p => {
        const won = winners.includes(p);
        if (won) {
            p.winStreak++;
            p.lossStreak = 0;
        } else {
            p.lossStreak++;
            p.winStreak = 0;
        }
    });

    // Эффекты способностей
    players.forEach(p => {
        const won = winners.includes(p);
        const bid = p.currentBid || 0;
        const myActives = activesOf(p);

        // --- Пассивные способности ---
        if (hasPassive(p, 'cashback') && bid > 0) {
            const v = percent(bid, 0.10);
            if (v > 0) { addCoins(p, v); addLog(p, `Кешбэк: +${v} 🪙`); }
        }
        if (hasPassive(p, 'bonus') && won) {
            addCoins(p, 5);
            addLog(p, 'Бонус: +5 🪙');
        }
        if (hasPassive(p, 'passive_income') && p.coins >= 5) {
            takeCoins(p, 5);
            p.points += 3;
            addLog(p, 'Пассив: −5 🪙, +3 ⭐');
        }
        if (hasPassive(p, 'economist') && won && bid > 0 && bid <= 10) {
            addCoins(p, 5);
            addLog(p, 'Экономист: +5 🪙');
        }
        if (hasPassive(p, 'win_streak') && won && p.prevWinStreak >= 1) {
            addCoins(p, 10);
            addLog(p, 'Серия побед: +10 🪙');
        }
        if (hasPassive(p, 'lucky_number') && won && bid > 0 && bid % 10 === 0) {
            addCoins(p, 5);
            addLog(p, 'Счастливое число: +5 🪙');
        }
        if (hasPassive(p, 'point_hunter') && won && lot >= 40) {
            p.points += 5;
            addLog(p, 'Охотник за очками: +5 ⭐');
        }
        if (hasPassive(p, 'insurance') && !won && bid > 0) {
            const v = percent(bid, 0.20);
            if (v > 0) { addCoins(p, v); addLog(p, `Страховка: +${v} 🪙`); }
        }
        if (hasPassive(p, 'small_bet') && won && bid > 0 && bid <= 10) {
            p.points += 5;
            addLog(p, 'Маленькая ставка: +5 ⭐');
        }
        if (hasPassive(p, 'big_bet') && won && bid >= 70) {
            addCoins(p, 10);
            addLog(p, 'Большая ставка: +10 🪙');
        }
        if (hasPassive(p, 'greed') && won && margin >= 20) {
            p.points += 5;
            addLog(p, 'Жадность: +5 ⭐');
        }
        if (hasPassive(p, 'double_profit') && won && bid > 0
            && players.some(o => o !== p && (o.currentBid || 0) === bid)) {
            addCoins(p, 10);
            addLog(p, 'Двойная прибыль: +10 🪙');
        }
        if (hasPassive(p, 'risk') && won && bid > 0 && bid >= (p.coins + bid) * 0.5) {
            p.points += 5;
            addLog(p, 'Риск: +5 ⭐');
        }
        if (hasPassive(p, 'minimalist') && won && bid > 0 && bid <= 5) {
            addCoins(p, 10);
            addLog(p, 'Минималист: +10 🪙');
        }
        if (hasPassive(p, 'investor') && won && p.prevLossStreak >= 2) {
            addCoins(p, 10);
            addLog(p, 'Инвестор: +10 🪙');
        }
        if (hasPassive(p, 'patience') && !won && p.prevLossStreak >= 1
            && p.abilityFlags.patienceAt !== p.lossStreak) {
            p.abilityFlags.patienceAt = p.lossStreak;
            addCoins(p, 15);
            addLog(p, 'Терпение: +15 🪙');
        }

        // --- Активные способности (одноразовые) ---
        if (myActives.some(a => a.id === 'shield') && !won && bid > 0) {
            const v = percent(bid, 0.50);
            if (v > 0) { addCoins(p, v); addLog(p, `Щит: возврат ${v} 🪙`); }
        }
        if (myActives.some(a => a.id === 'steal') && won) {
            const candidates = players.filter(o => o !== p && o.coins > 0);
            if (candidates.length) {
                const victim = candidates[Math.floor(Math.random() * candidates.length)];
                const stolen = takeCoins(victim, 10);
                addCoins(p, stolen);
                addLog(p, `Кража: +${stolen} 🪙 у ${victim.name}`);
            }
        }
        if (myActives.some(a => a.id === 'sabotage')) {
            const target = getByPlayerId(room, myActives.find(a => a.id === 'sabotage').targetPlayerId);
            if (target && target !== p) {
                const lost = takeCoins(target, 10);
                addLog(target, `Саботаж: −${lost} 🪙`);
            }
        }
        if (myActives.some(a => a.id === 'parimatch')) {
            const act = myActives.find(a => a.id === 'parimatch');
            const target = getByPlayerId(room, act.targetPlayerId);
            if (target && (target.currentBid || 0) < bid) {
                addCoins(p, 15);
                addLog(p, 'Пари: +15 🪙');
            } else if (target) {
                addLog(p, 'Пари: не сработало');
            }
        }
        if (myActives.some(a => a.id === 'rematch') && !won && room.currentRound > 1
            && p.prevLossStreak >= 1) {
            const v = percent(p.lastBid || 0, 0.25);
            if (v > 0) { addCoins(p, v); addLog(p, `Реванш: возврат ${v} 🪙`); }
        }
        if (myActives.some(a => a.id === 'trap')) {
            const act = myActives.find(a => a.id === 'trap');
            const target = getByPlayerId(room, act.targetPlayerId);
            if (target && (target.currentBid || 0) > bid) {
                const lost = takeCoins(target, 10);
                addLog(target, `Ловушка: −${lost} 🪙`);
            } else if (target) {
                addLog(p, 'Ловушка: не сработала');
            }
        }
        if (myActives.some(a => a.id === 'tax')) {
            let total = 0;
            players.forEach(o => {
                if (o === p) return;
                if ((o.currentBid || 0) <= bid) return;
                total += takeCoins(o, 5);
            });
            addCoins(p, total);
            if (total > 0) addLog(p, `Налог: +${total} 🪙`);
        }
        if (myActives.some(a => a.id === 'blind')) {
            const act = myActives.find(a => a.id === 'blind');
            const target = getByPlayerId(room, act.targetPlayerId);
            if (target) addLog(p, `Слепота: ${target.name} не увидит лот в следующем раунде 🔒`);
        }
        if (myActives.some(a => a.id === 'reduction')) {
            addLog(p, 'Сокращение: победитель получает вдвое меньше очков ✂');
        }
        if (myActives.some(a => a.id === 'freeze')) {
            const act = myActives.find(a => a.id === 'freeze');
            const target = getByPlayerId(room, act.targetPlayerId);
            if (target) addLog(target, 'Заморозка: активные и пассивные способности отключены ❄');
        }
    });

    const snapshot = players.map(x => ({
        playerId: x.playerId,
        name: x.name,
        coins: x.coins,
        points: x.points,
        lastBid: x.currentBid || 0
    }));

    // Активированные активные способности одноразовые — сбрасываем (инвентарь сохраняется)
    players.forEach(p => {
        p.armedAbility = null;
        p.lastBid = p.currentBid || 0;
        p.currentBid = null;
        p.hasBid = false;
        p.roundResults.push(winners.includes(p));
    });

    emitPersonalized(room, 'roundResult', p => ({
        round: room.currentRound,
        maxRounds: room.maxRounds,
        lot: p.blind ? null : lot,
        lotHidden: !!p.blind,
        maxBid: maxBid,
        margin: margin,
        winnersNames: winners.map(w => w.name),
        isTie: winners.length > 1,
        didWin: winners.includes(p),
        pointsGained: gained[p.playerId] || 0,
        logs: logs[p.playerId] || [],
        players: snapshot,
        myAbilities: abilitiesPayload(room, p),
        hostPlayerId: room.hostPlayerId
    }));

    setTimeout(() => {
        const currentRoom = rooms[roomCode];
        if (!currentRoom) return;

        if (currentRoom.currentRound < currentRoom.maxRounds) {
            currentRoom.currentRound++;
            startRoundOrSelection(roomCode);
        } else {
            currentRoom.gameState = 'finished';
            let maxPoints = -1;
            currentRoom.players.forEach(p => {
                if (p.points > maxPoints) maxPoints = p.points;
            });
            const gameWinners = currentRoom.players.filter(p => p.points === maxPoints);

            io.to(roomCode).emit('gameOver', {
                winners: gameWinners.map(w => ({ playerId: w.playerId, name: w.name })),
                players: currentRoom.players.map(p => ({
                    playerId: p.playerId,
                    name: p.name,
                    points: p.points,
                    coins: p.coins
                })),
                hostPlayerId: currentRoom.hostPlayerId
            });
        }
    }, ROUND_DELAY);
}

const PORT = process.env.PORT || 3000;

if (process.env.NO_LISTEN === '1') {
    // Режим тестирования: не слушаем порт, экспортируем внутренности
    module.exports = { createPlayer, resetPlayers, evaluateRound, rooms, ABILITY_BY_ID, ACTIVE_ABILITIES, PASSIVE_ABILITIES };
} else {
    server.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));
}