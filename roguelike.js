// ===========================================================================
//  LOTS — режим «Забег» (рогалик)
//  Полностью серверный движок: карта с боевым уклоном, бои на ставках,
//  собственные способности режима, реликвии/проклятия с жёсткими лимитами,
//  события, магазин, репутация (HP), золото, счёт и мета-прогрессия.
// ===========================================================================

// ---------------------------------------------------------------------------
//  Сид-генератор случайных чисел (воспроизводимость забегов)
// ---------------------------------------------------------------------------
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function rnd(run) { return run._rng(); }
function ri(run, lo, hi) { return lo + Math.floor(run._rng() * (hi - lo + 1)); }
function pick(run, arr) { return arr[Math.floor(run._rng() * arr.length)]; }
function shuffle(run, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(run._rng() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function chance(run, p) { return run._rng() < p; }

// ---------------------------------------------------------------------------
//  СПОСОБНОСТИ «ЗАБЕГА» — сделаны специально под этот режим.
//  Это не активки/пассивки обычной игры: здесь всё привязано к тактике
//  торгов (ставка/раунд/монеты), а выбор ограничен жёсткими лимитами.
// ---------------------------------------------------------------------------
const MAX_ACTIVE = 2;   // слотов активных способностей
const MAX_PASSIVE = 2;  // слотов пассивных способностей
const MAX_RELICS = 7;   // максимум реликвий (включая геройскую)
const MAX_POTIONS = 3;  // максимум зелий суммарно

// Активные: одна на раунд, раз за бой. Используются в ходу боя.
const ACTIVES = [
    { id: 'a_scout', name: 'Наводчик', type: 'active',
        desc: 'В этом раунде видна ставка врага ещё до твоего хода.' },
    { id: 'a_delay', name: 'Волокита', type: 'active',
        desc: 'В этом раунде вражеская ставка уменьшается на 30%.' },
    { id: 'a_free', name: 'Свободный ход', type: 'active',
        desc: 'Ставка в этом раунде не тратит монеты.' },
    { id: 'a_surge', name: 'Взлёт', type: 'active',
        desc: '+45% к эффективной ставке в этом раунде (без доплаты).' },
    { id: 'a_allin', name: 'Ва-банк', type: 'active',
        desc: '+70% к эффективной ставке, но сама ставка стоит в 1.5 раза дороже.' },
    { id: 'a_rollback', name: 'Откат', type: 'active',
        desc: 'Если раунд проигран — монеты ставки возвращаются полностью.' }
];

// Пассивные: работают весь бой, тоже под тактику (очки/монеты/возвраты).
const PASSIVES = [
    { id: 'p_firstfree', name: 'Даровой старт', type: 'passive',
        desc: 'Первая ставка в каждом бою не тратит монеты.' },
    { id: 'p_jeweler', name: 'Ставка мастера', type: 'passive',
        desc: '+5 очков за выигранный раунд.' },
    { id: 'p_counter', name: 'Костяшки', type: 'passive',
        desc: '+4 очка за проигранный раунд.' },
    { id: 'p_refund', name: 'Подушки', type: 'passive',
        desc: 'Возвращает 35% ставки за проигранный раунд.' },
    { id: 'p_income', name: 'Купюры', type: 'passive',
        desc: '+8% монет в конце каждого раунда.' },
    { id: 'p_pickpocket', name: 'Тонкие пальцы', type: 'passive',
        desc: 'Украл 12 монет врага за выигранный раунд.' },
    { id: 'p_biglot', name: 'Крупный лот', type: 'passive',
        desc: '+7 очков за лоты от 40.' },
    { id: 'p_tie', name: 'Последнее слово', type: 'passive',
        desc: 'При равной ставке лот достаётся тебе.' }
];

function getAbility(id) {
    return ACTIVES.find(a => a.id === id) || PASSIVES.find(a => a.id === id) || null;
}
function hasPassive(run, id) {
    return run.abilities.passive.some(a => a.id === id);
}

// ===========================================================================
//  КОНТЕНТ: ГЕРОИ
// ===========================================================================
// Герой даёт стартовую «геройскую реликвию» (fx + stat) и стартовые бонусы.
// fx — боевые хуки, stat — постоянные (применяются при создании забега).
const HEROES = [
    { id: 'sprinter', name: 'Спринтер', icon: '🏃', desc: 'Ставки сильнее на +8 в первых двух раундах боя. Слабость: стартует с 88 монет.', relic: 'hero_sprinter' },
    { id: 'marathon', name: 'Марафонец', icon: '🏁', desc: 'В последнем раунде боя ставка сильнее на +8. Крепче остальных.', relic: 'hero_marathon' },
    { id: 'merchant', name: 'Купец', icon: '💰', desc: 'Все награды золотом +25%. Начинает с +60 золота.', relic: 'hero_merchant' },
    { id: 'hunter', name: 'Охотник', icon: '🎯', desc: '+8 очков за каждый лот на 40+. Слабость: −15 репутации.', relic: 'hero_hunter' },
    { id: 'collector', name: 'Собиратель', icon: '📦', desc: '+4 очка за каждый проигранный раунд боя.', relic: 'hero_collector' },
    { id: 'mystic', name: 'Мистик', icon: '🔮', desc: 'Иммунитет к слепоте, +3 к каждой ставке.', relic: 'hero_mystic' },
    { id: 'tank', name: 'Танк', icon: '🛡️', desc: 'В проигранном раунде возвращается 30% ставки. Крепче, но беднее.', relic: 'hero_tank' },
    { id: 'hedonist', name: 'Гедонист', icon: '🍷', desc: '+7 очков за выигранный раунд, но ставки от 30 стоят на 5 монет дороже.', relic: 'hero_hedonist' },
    { id: 'intriguer', name: 'Интриган', icon: '🎭', desc: 'Раз за бой — бесплатный рывок: +12 к ставке.', relic: 'hero_intriguer' }
];

// ===========================================================================
//  КОНТЕНТ: РЕЛИКВИИ (включая геройские)
// ===========================================================================
// stat: { maxHp, gold, potion } — применяется при получении
// fx:   боевые/экономические хуки (см. mods())
const RELICS = [
    // --- геройские ---
    { id: 'hero_sprinter', name: 'Рывок', icon: '🏃', rarity: 'hero', hero: true, desc: '+8 к ставке в 1–2 раундах боя.', fx: { bidBoostEarly: 8, startCoins: -2 } },
    { id: 'hero_marathon', name: 'Выносливость', icon: '🏁', rarity: 'hero', hero: true, desc: '+8 к ставке в последнем раунде боя.', fx: { bidBoostLate: 8 }, stat: { maxHp: 20 } },
    { id: 'hero_merchant', name: 'Торговая жилка', icon: '💰', rarity: 'hero', hero: true, desc: '+25% золота с наград.', fx: { goldMult: 1.25 }, stat: { gold: 60 } },
    { id: 'hero_hunter', name: 'Чутьё', icon: '🎯', rarity: 'hero', hero: true, desc: '+8 очков за лоты 40+.', fx: { bigLotPts: 8, bigLotMin: 40 }, stat: { maxHp: -15 } },
    { id: 'hero_collector', name: ' Коллекция', icon: '📦', rarity: 'hero', hero: true, desc: '+4 очка за проигранный раунд боя.', fx: { loseRoundPoints: 4 } },
    { id: 'hero_mystic', name: 'Прозрение', icon: '🔮', rarity: 'hero', hero: true, desc: '+3 к ставке, иммунитет к слепоте.', fx: { bidBoost: 3, immuneBlind: true } },
    { id: 'hero_tank', name: 'Броня', icon: '🛡️', rarity: 'hero', hero: true, desc: 'Возврат 30% ставки в проигранном раунде.', fx: { bidRefundLosePct: 0.30 }, stat: { maxHp: 15, gold: -15 } },
    { id: 'hero_hedonist', name: 'Жажда', icon: '🍷', rarity: 'hero', hero: true, desc: '+7 очков за выигранный раунд.', fx: { winPoints: 7, expensiveBid: 30, expensiveBidCost: 5 } },
    { id: 'hero_intriguer', name: 'Интрига', icon: '🎭', rarity: 'hero', hero: true, desc: 'Раз за бой: +12 к ставке бесплатно.', fx: { freeOverbid: 12, freeOverbidUses: 1 } },

    // --- обычные ---
    { id: 'pouch', name: 'Кошель', icon: '👛', rarity: 'common', desc: '+15 монет в начале каждого боя.', fx: { startCoins: 15 } },
    { id: 'percent', name: 'Процент', icon: '📈', rarity: 'common', desc: 'В конце раунда получаешь 10% остатка монет.', fx: { endRoundIncomePct: 0.10 } },
    { id: 'firstbid', name: 'Первая ставка', icon: '🆓', rarity: 'common', desc: 'Первая ставка в каждом бою не тратит монеты.', fx: { firstBidFree: true } },
    { id: 'jeweler', name: 'Ювелир', icon: '💎', rarity: 'common', desc: '+4 очка за каждый выигранный раунд.', fx: { winPoints: 4 } },
    { id: 'veteran', name: 'Ветеран', icon: '🎖️', rarity: 'common', desc: '+3 очка за проигранный раунд.', fx: { loseRoundPoints: 3 } },
    { id: 'insurance', name: 'Страховка', icon: '🧾', rarity: 'common', desc: 'Возврат 25% ставки в проигранном раунде.', fx: { bidRefundLosePct: 0.25 } },
    { id: 'bonus', name: 'Пособие', icon: '🪙', rarity: 'common', desc: '+5 монет за каждый выигранный раунд.', fx: { winCoins: 5 } },
    { id: 'cashback', name: 'Кешбэк', icon: '🔁', rarity: 'common', desc: 'В конце раунда +8% остатка монет.', fx: { endRoundIncomePct: 0.08 } },
    { id: 'hunter2', name: 'Намётанный глаз', icon: '👁️', rarity: 'common', desc: '+5 очков за лоты 40+.', fx: { bigLotPts: 5, bigLotMin: 40 } },
    { id: 'minimalist', name: 'Минималист', icon: '🤏', rarity: 'common', desc: 'Победа со ставкой ≤8 даёт +10 очков.', fx: { smallBidPts: 10, smallBidMax: 8 } },
    { id: 'greed', name: 'Азарт', icon: '🔥', rarity: 'common', desc: '+5 очков за победу с отрывом 20+.', fx: { winPoints: 5 } },
    { id: 'leech', name: 'Пиявка', icon: '🩸', rarity: 'common', desc: 'Выиграл раунд — забираешь 8 монет врага.', fx: { stealOnWin: 8 } },
    { id: 'tie', name: 'Хитрец', icon: '🤝', rarity: 'common', desc: 'При равной ставке лот достаётся тебе.', fx: { tieWins: true } },
    { id: 'sprint', name: 'Спринт', icon: '⚡', rarity: 'common', desc: '+5 к ставке в первых двух раундах боя.', fx: { bidBoostEarly: 5 } },
    { id: 'marathon2', name: 'Второе дыхание', icon: '🌬️', rarity: 'common', desc: '+5 к ставке в последнем раунде боя.', fx: { bidBoostLate: 5 } },
    { id: 'vulture', name: 'Стервятник', icon: '🦅', rarity: 'common', desc: 'Победа с отрывом 20+ даёт +6 очков.', fx: { vulture: true } },

    // --- редкие ---
    { id: 'mech', name: 'Механизм', icon: '⚙️', rarity: 'rare', desc: '+10 очков за лоты 45+.', fx: { bigLotPts: 10, bigLotMin: 45 } },
    { id: 'bank', name: 'Банк', icon: '🏦', rarity: 'rare', desc: '+25 монет в начале каждого боя.', fx: { startCoins: 25 } },
    { id: 'gilded', name: 'Позолота', icon: '✨', rarity: 'rare', desc: '+35% золота с наград.', fx: { goldMult: 1.35 } },
    { id: 'alchemist', name: 'Алхимик', icon: '⚗️', rarity: 'rare', desc: 'После победы в бою — 35% шанс получить зелье.', fx: { potionChance: 0.35 } },
    { id: 'scholar', name: 'Эрудит', icon: '📚', rarity: 'rare', desc: 'В награде за бой на 1 вариант больше.', fx: { extraRewardOption: true } },
    { id: 'doctor', name: 'Лекарь', icon: '⚕️', rarity: 'rare', desc: '+12 репутации после победы в бою.', fx: { healOnWin: 12 } },
    { id: 'thorns', name: 'Шипы', icon: '🌵', rarity: 'rare', desc: 'Выиграл раунд — забираешь 14 монет врага.', fx: { stealOnWin: 14 } },
    { id: 'lucky', name: 'Везунчик', icon: '🍀', rarity: 'rare', desc: 'Все лоты дороже на 5 очков.', fx: { lotShift: 5 } },
    { id: 'shield', name: 'Оберег', icon: '🔰', rarity: 'rare', desc: 'Первый проигранный бой наносит вдвое меньше урона.', fx: { softFirstLoss: true } },

    // --- эпические ---
    { id: 'tycoon', name: 'Воротила', icon: '🤑', rarity: 'epic', desc: '+50% золота и +20 монет в начале боя.', fx: { goldMult: 1.5, startCoins: 20 } },
    { id: 'executioner', name: 'Палач', icon: '🪓', rarity: 'epic', desc: '+10 очков за выигранный раунд, но крупные ставки дороже.', fx: { winPoints: 10, expensiveBid: 40, expensiveBidCost: 3 } },
    { id: 'relichunter', name: 'Охотник за реликвиями', icon: '🗺️', rarity: 'epic', desc: '−25% к ценам в магазине.', fx: { shopDiscount: 0.25 } },
    { id: 'undying', name: 'Неугасимый', icon: '♻️', rarity: 'epic', desc: '+25 репутации после победы в бою.', fx: { healOnWin: 25 } },
    { id: 'master', name: 'Мастер торгов', icon: '🎩', rarity: 'epic', desc: '+8 к каждой ставке.', fx: { bidBoost: 8 } },

    // --- легендарные ---
    { id: 'crown', name: 'Корона', icon: '👑', rarity: 'legendary', desc: '+12 очков за победу, +30% золота, +20 монет.', fx: { winPoints: 12, goldMult: 1.3, startCoins: 20 } },
    { id: 'phoenix', name: 'Феникс', icon: '🦅', rarity: 'legendary', desc: 'Один раз за забег выживаешь при смертельном уроне с 1 HP.', fx: { reviveOnce: true } },
    { id: 'grandcollector', name: 'Гранд-коллекционер', icon: '🏛️', rarity: 'legendary', desc: '+4 очка за победу, +1 вариант награды, −20% цены.', fx: { winPoints: 4, extraRewardOption: true, shopDiscount: 0.2 } },

    // --- дополнительные ---
    { id: 'wallet', name: 'Бумажник', icon: '💵', rarity: 'common', desc: '+10 монет в начале каждого боя.', fx: { startCoins: 10 } },
    { id: 'speculator', name: 'Спекулянт', icon: '📊', rarity: 'common', desc: 'В конце раунда +6% остатка монет.', fx: { endRoundIncomePct: 0.06 } },
    { id: 'reseller', name: 'Перекупщик', icon: '🔖', rarity: 'rare', desc: '−15% к ценам в магазине.', fx: { shopDiscount: 0.15 } },
    { id: 'survivor', name: 'Выживший', icon: '🩹', rarity: 'rare', desc: '+8 репутации после победы в бою.', fx: { healOnWin: 8 } },
    { id: 'hustler', name: 'Делец', icon: '🤝', rarity: 'rare', desc: 'Выиграл раунд — забираешь 6 монет врага.', fx: { stealOnWin: 6 } },
    { id: 'vampire', name: 'Вампир', icon: '🧛', rarity: 'epic', desc: '+12 репутации за победу, но −5 золота за победу.', fx: { healOnWin: 12, loseGoldOnWin: 5 } },
    { id: 'oracle_relic', name: 'Ясновидение', icon: '👁️', rarity: 'epic', desc: 'Иммунитет к слепоте и +2 к ставке.', fx: { immuneBlind: true, bidBoost: 2 } }
];

// ===========================================================================
//  КОНТЕНТ: ПРОКЛЯТИЯ
// ===========================================================================
const CURSES = [
    { id: 'c_weak', name: 'Слабость', icon: '🥀', desc: '−3 к каждой ставке.', fx: { bidBoost: -3 } },
    { id: 'c_tax', name: 'Побор', icon: '🧾', desc: '−5 золота за каждый узел карты.', fx: { nodeGoldLoss: 5 } },
    { id: 'c_fragile', name: 'Хрупкость', icon: '💔', desc: '+30% урона по репутации.', fx: { dmgMult: 1.3 } },
    { id: 'c_greed', name: 'Скупость', icon: '🪙', desc: '−20% золота с наград.', fx: { goldMult: 0.8 } },
    { id: 'c_heavy', name: 'Тяжесть', icon: '⚓', desc: '−10 монет в начале боя.', fx: { startCoins: -10 } },
    { id: 'c_blind', name: 'Слепота', icon: '🌑', desc: 'В боях с элитой и боссами лот скрыт.', fx: { blindOnBoss: true } },
    { id: 'c_burden', name: 'Бремя', icon: '🎒', desc: '+20% к ценам в магазине.', fx: { shopPriceUp: 0.2 } },
    { id: 'c_debt', name: 'Долг', icon: '💸', desc: '−6 золота за каждую победу.', fx: { loseGoldOnWin: 6 } },
    { id: 'c_fear', name: 'Страх', icon: '😱', desc: 'Враги получают +10 монет.', fx: { enemyCoinsBonus: 10 } },
    { id: 'c_broken', name: 'Надлом', icon: '🩹', desc: '−4 очка за выигранный раунд.', fx: { winPoints: -4 } },
    { id: 'c_gluttony', name: 'Чревоугодие', icon: '🍖', desc: '−15 к максимуму репутации.', fx: {}, stat: { maxHp: -15 } },
    { id: 'c_slow', name: 'Медлительность', icon: '🐌', desc: 'Враги ставят агрессивнее.', fx: { enemyAggro: 0.15 } }
];

const RELIC_BY_ID = {};
RELICS.forEach(r => { RELIC_BY_ID[r.id] = r; });
CURSES.forEach(c => { RELIC_BY_ID[c.id] = c; });

// ===========================================================================
//  КОНТЕНТ: ЗЕЛЬЯ
// ===========================================================================
const POTIONS = [
    { id: 'heal', name: 'Зелье лечения', icon: '🧪', desc: '+35 репутации.', where: 'any' },
    { id: 'coin', name: 'Зелье монет', icon: '🍯', desc: '+30 монет на текущий бой (в бою).', where: 'combat' },
    { id: 'focus', name: 'Зелье сосредоточения', icon: '🎯', desc: '+8 к ставке до конца боя (в бою).', where: 'combat' },
    { id: 'gold', name: 'Зелье богатства', icon: '💎', desc: '+30 золота (на карте).', where: 'map' },
    { id: 'shield', name: 'Зелье стойкости', icon: '🔰', desc: 'Следующий проигранный бой не отнимет репутацию.', where: 'any' },
    { id: 'luck', name: 'Зелье удачи', icon: '🍀', desc: '+6 к каждой ставке до конца боя (в бою).', where: 'combat' }
];
const POTION_BY_ID = {};
POTIONS.forEach(p => { POTION_BY_ID[p.id] = p; });

// ===========================================================================
//  КОНТЕНТ: ВРАГИ
// ===========================================================================
const ENEMIES = [
    { id: 'snob', name: 'Сноб', icon: '🧐', aggr: 0.40, flags: { snob: true } },
    { id: 'spender', name: 'Транжира', icon: '💸', aggr: 0.70, flags: {} },
    { id: 'hoarder', name: 'Скряга', icon: '🐀', aggr: 0.20, flags: {} },
    { id: 'manic', name: 'Маньяк', icon: '🤪', aggr: 0.55, flags: { manic: true } },
    { id: 'spy', name: 'Шпион', icon: '🕵️', aggr: 0.50, flags: { spy: true } },
    { id: 'mirror', name: 'Зеркало', icon: '🪞', aggr: 0.45, flags: { mirror: true } },
    { id: 'philosopher', name: 'Философ', icon: '🧘', aggr: 0.30, flags: { philosopher: true } },
    { id: 'collector', name: 'Коллекционер', icon: '🗃️', aggr: 0.50, flags: { collector: true } },
    { id: 'gambler', name: 'Игрок', icon: '🎲', aggr: 0.50, flags: { gambler: true } },
    { id: 'leech', name: 'Пиявка', icon: '🐛', aggr: 0.45, flags: { leech: true } },
    { id: 'armored', name: 'Броненосец', icon: '🦔', aggr: 0.40, flags: { armored: true } },
    { id: 'venom', name: 'Отравитель', icon: '🐍', aggr: 0.50, flags: { venom: true } },
    { id: 'duelist', name: 'Дуэлянт', icon: '🤺', aggr: 0.60, flags: {} },
    { id: 'miser', name: 'Плакса', icon: '😢', aggr: 0.25, flags: {} },
    { id: 'tycoon', name: 'Воротила', icon: '🎩', aggr: 0.60, flags: {}, coinsBonus: 20 },
    { id: 'ghost', name: 'Призрак', icon: '👻', aggr: 0.50, flags: { spy: true, mirror: true } },
    { id: 'ogre', name: 'Громила', icon: '👹', aggr: 0.75, flags: {}, coinsBonus: 15 },
    { id: 'oracle', name: 'Оракул', icon: '🔮', aggr: 0.45, flags: { oracle: true } }
];

const BOSSES = [
    { id: 'curator', name: 'Куратор', icon: '👑', aggr: 0.55, coinsBonus: 20, flags: { collector: true, oracle: true } },
    { id: 'casino', name: 'Казино «Фортуна»', icon: '🎰', aggr: 0.50, coinsBonus: 25, flags: { casino: true, gambler: true } },
    { id: 'collector', name: 'Аукционист-Коллекционер', icon: '🧛', aggr: 0.60, coinsBonus: 35, flags: { collector: true, armored: true, venom: true } },
    { id: 'leviathan', name: 'Левиафан', icon: '🐋', aggr: 0.70, coinsBonus: 40, flags: { armored: true, manic: true } },
    { id: 'tyrant', name: 'Тиран', icon: '👑', aggr: 0.65, coinsBonus: 30, flags: { venom: true, collector: true } },
    { id: 'whisper', name: 'Шёпот', icon: '🌫️', aggr: 0.60, coinsBonus: 25, flags: { spy: true, mirror: true, leech: true } },
    { id: 'midas', name: 'Мидас', icon: '🪙', aggr: 0.70, coinsBonus: 45, flags: { gambler: true, oracle: true } },
    { id: 'final', name: 'Верховный Аукционист', icon: '☠️', aggr: 0.70, coinsBonus: 55, flags: { collector: true, armored: true, venom: true, spy: true } }
];

// ===========================================================================
//  КОНТЕНТ: СОБЫТИЯ
// ===========================================================================
// choices[].effects — массив вида {k, v}
const EVENTS = [
    { id: 'beggar', title: 'Нищий у входа', text: 'Оборванный старик просит монет на «счастливый лот».',
      choices: [ { label: 'Дать 20 золота', effects: [{ k: 'gold', v: -20 }, { k: 'maxHp', v: 5 }], hint: '−20💰, +5 репутации (макс.)' },
                 { label: 'Прогнать', effects: [{ k: 'gold', v: 5 }], hint: '+5💰' } ] },
    { id: 'sealed', title: 'Запечатанный зал', text: 'Дверь с тяжёлым замком. Пахнет деньгами… или ловушкой.',
      choices: [ { label: 'Вскрыть (риск)', effects: [{ k: 'roll', p: 0.5, win: [{ k: 'relic' }], lose: [{ k: 'hp', v: -20 }] }], hint: '50%: реликвия, иначе −20 репутации' },
                 { label: 'Уйти', effects: [] } ] },
    { id: 'shady', title: 'Сомнительный торговец', text: '«Реликвия в мешке! Не смотри, бери!»',
      choices: [ { label: 'Купить за 40 золота', effects: [{ k: 'gold', v: -40 }, { k: 'roll', p: 0.65, win: [{ k: 'relic' }], lose: [{ k: 'curse' }] }], hint: '−40💰: 65% реликвия, иначе проклятие' },
                 { label: 'Отказаться', effects: [] } ] },
    { id: 'dice', title: 'Азартный партнёр', text: 'Предлагает сыграть в кости: удвоить золото или потерять.',
      choices: [ { label: 'Сыграть', effects: [{ k: 'roll', p: 0.5, win: [{ k: 'gold', v: 40 }], lose: [{ k: 'gold', v: -30 }] }], hint: '50%: +40💰, иначе −30💰' },
                 { label: 'Отказаться', effects: [] } ] },
    { id: 'hammer', title: 'Старый молоток', text: 'Аукционный молоток гудит от силы. Можно обменять реликвию.',
      choices: [ { label: 'Обменять реликвию', requires: r => r.relics.filter(id => RELIC_BY_ID[id] && !RELIC_BY_ID[id].hero).length > 0,
                   effects: [{ k: 'swapRelic' }], hint: 'случайная реликвия → другая случайная' },
                 { label: 'Уйти', effects: [] } ] },
    { id: 'mirrorhall', title: 'Зеркальный зал', text: 'Из зеркала навстречу выходит твоя копия.',
      choices: [ { label: 'Сразиться', effects: [{ k: 'combat', tier: 'elite' }, { k: 'gold', v: 30 }], hint: 'элитный бой, затем +30💰' },
                 { label: 'Разбить зеркало', effects: [{ k: 'hp', v: -10 }, { k: 'relic' }], hint: '−10 репутации, +реликвия' } ] },
    { id: 'fountain', title: 'Фонтан монет', text: 'Монеты блестят на дне. Говорят, вода лечит.',
      choices: [ { label: 'Напиться', effects: [{ k: 'heal', v: 30 }], hint: '+30 репутации' },
                 { label: 'Собрать монеты', effects: [{ k: 'gold', v: 25 }], hint: '+25💰' } ] },
    { id: 'altar2', title: 'Тёмный алтарь', text: 'Алтарь требует крови за силу.',
      choices: [ { label: 'Отдать 15 HP', requires: r => r.hp > 20, effects: [{ k: 'hp', v: -15 }, { k: 'relic' }], hint: '−15 репутации, +реликвия' },
                 { label: 'Пройти мимо', effects: [] } ] },
    { id: 'scholar2', title: 'Забытая библиотека', text: 'Пыльные фолианты хранят секреты торгов.',
      choices: [ { label: 'Изучать', effects: [{ k: 'ability' }], hint: '+способность' },
                 { label: 'Продать книги', effects: [{ k: 'gold', v: 35 }], hint: '+35💰' } ] },
    { id: 'trapped', title: 'Ловушка', text: 'Пол щёлкает — ты угодил в западню!',
      choices: [ { label: 'Вырваться (−12 репутации)', effects: [{ k: 'hp', v: -12 }] },
                 { label: 'Схватить что блестит', effects: [{ k: 'hp', v: -20 }, { k: 'gold', v: 45 }], hint: '−20 репутации, +45💰' } ] },
    { id: 'merchant2', title: 'Караван', text: 'Усталый караван продаёт припасы.',
      choices: [ { label: 'Купить зелье (20💰)', effects: [{ k: 'gold', v: -20 }, { k: 'potion' }], hint: '−20💰, +зелье' },
                 { label: 'Купить лечение (25💰)', requires: r => r.hp < r.maxHp, effects: [{ k: 'gold', v: -25 }, { k: 'heal', v: 35 }], hint: '−25💰, +35 репутации' },
                 { label: 'Уйти', effects: [] } ] },
    { id: 'gambler2', title: 'Кости судьбы', text: 'Ставка на удачу: всё или ничего.',
      choices: [ { label: 'Рискнуть половиной золота', requires: r => r.gold >= 20, effects: [{ k: 'gambleHalf' }], hint: '50%: ×2 к золоту, иначе теряешь половину' },
                 { label: 'Отказаться', effects: [] } ] },
    { id: 'relicseller', title: 'Перекупщик', text: 'Готов дать проклятие в обмен на силу.',
      choices: [ { label: 'Взять проклятие + реликвию', effects: [{ k: 'curse' }, { k: 'relic' }], hint: '+проклятие и +реликвия' },
                 { label: 'Купить реликвию (60💰)', requires: r => r.gold >= 60, effects: [{ k: 'gold', v: -60 }, { k: 'relic' }], hint: '−60💰, +реликвия' } ] },
    { id: 'oracle2', title: 'Оракул', text: 'Оракул предлагает заглянуть в будущее.',
      choices: [ { label: 'Узнать судьбу (+10 золота)', effects: [{ k: 'gold', v: 10 }, { k: 'heal', v: 10 }], hint: '+10💰, +10 репутации' },
                 { label: 'Забрать амулет', effects: [{ k: 'curse' }, { k: 'maxHp', v: 20 }], hint: '+20 макс. репутации, +проклятие' } ] },
    { id: 'forge2', title: 'Брошенная кузница', text: 'Горн ещё горяч.',
      choices: [ { label: 'Перековать способность', requires: r => (r.abilities.active.length + r.abilities.passive.length) > 0, effects: [{ k: 'forge' }], hint: 'заменить одну способность' },
                 { label: 'Обыскать', effects: [{ k: 'gold', v: 20 }, { k: 'hp', v: 10 }], hint: '+20💰, +10 репутации' } ] },
    { id: 'ghostship', title: 'Корабль-призрак', text: 'Заброшенное судно полно сокровищ и опасностей.',
      choices: [ { label: 'Обыскать трюм', effects: [{ k: 'hp', v: -15 }, { k: 'roll', p: 0.6, win: [{ k: 'relic' }], lose: [{ k: 'gold', v: -20 }] }], hint: '−15 репутации: 60% реликвия' },
                 { label: 'Уйти', effects: [] } ] },
    { id: 'goodwin', title: 'Щедрый спонсор', text: 'Богач восхищён твоей игрой и делает вклад.',
      choices: [ { label: 'Принять', effects: [{ k: 'gold', v: 50 }, { k: 'hp', v: 10 }], hint: '+50💰, +10 репутации' },
                 { label: 'Попросить реликвию', effects: [{ k: 'relic' }, { k: 'hp', v: -5 }], hint: '+реликвия, −5 репутации' } ] },
    { id: 'purge', title: 'Чистилище', text: 'Священник предлагает снять проклятие.',
      choices: [ { label: 'Снять проклятие', requires: r => r.curses.length > 0, effects: [{ k: 'removeCurse' }], hint: 'убрать одно проклятие' },
                 { label: 'Пожертвовать 30💰', effects: [{ k: 'gold', v: -30 }, { k: 'maxHp', v: 10 }], hint: '−30💰, +10 макс. репутации' } ] },

    // --- дополнительные ---
    { id: 'arena', title: 'Подпольная арена', text: 'Хозяин арены предлагает бой за щедрую награду.',
      choices: [ { label: 'Выйти на арену', effects: [{ k: 'combat', tier: 'elite' }, { k: 'gold', v: 40 }], hint: 'элитный бой, затем +40💰' },
                 { label: 'Ставить на бойца (−20💰)', effects: [{ k: 'gold', v: -20 }, { k: 'roll', p: 0.55, win: [{ k: 'gold', v: 60 }], lose: [] }], hint: '−20💰: 55% шанс +60💰' } ] },
    { id: 'thief', title: 'Карманник', text: 'Кто-то толкнул тебя в толпе. Кошель полегчал?',
      choices: [ { label: 'Погнаться за вором', effects: [{ k: 'hp', v: -10 }, { k: 'gold', v: 25 }], hint: '−10 репутации, +25💰' },
                 { label: 'Смириться', effects: [{ k: 'gold', v: -15 }], hint: '−15💰' } ] },
    { id: 'wiseman', title: 'Мудрец', text: 'Старец обещает знание в обмен на услугу.',
      choices: [ { label: 'Выслушать', effects: [{ k: 'ability' }], hint: '+способность' },
                 { label: 'Заплатить 25💰', requires: r => r.gold >= 25, effects: [{ k: 'gold', v: -25 }, { k: 'relic' }], hint: '−25💰, +реликвия' } ] },
    { id: 'chestchoice', title: 'Два сундука', text: 'Один полон золота, другой — тайн.',
      choices: [ { label: 'Золотой', effects: [{ k: 'gold', v: 55 }], hint: '+55💰' },
                 { label: 'Таинственный', effects: [{ k: 'relic' }], hint: '+реликвия' } ] },
    { id: 'sacrifice2', title: 'Кровавый пакт', text: 'Голос предлагает силу в обмен на слабость.',
      choices: [ { label: 'Принять', effects: [{ k: 'maxHp', v: 20 }, { k: 'curse' }], hint: '+20 макс. репутации, +проклятие' },
                 { label: 'Отказаться', effects: [{ k: 'hp', v: -5 }], hint: '−5 репутации' } ] },
    { id: 'rainy', title: 'Дождь монет', text: 'С неба сыплются монеты! Но не все они настоящие.',
      choices: [ { label: 'Собрать всё', effects: [{ k: 'gold', v: 35 }, { k: 'roll', p: 0.3, win: [], lose: [{ k: 'hp', v: -10 }] }], hint: '+35💰, 30% шанс −10 репутации' },
                 { label: 'Собрать осторожно', effects: [{ k: 'gold', v: 15 }], hint: '+15💰' } ] }
];

// ===========================================================================
//  УЗЛЫ КАРТЫ
// ===========================================================================
const NODE_META = {
    battle: { icon: '⚔️', label: 'Лот' },
    elite: { icon: '💀', label: 'Элита' },
    boss: { icon: '👑', label: 'Босс' },
    treasure: { icon: '🎁', label: 'Сокровищница' },
    event: { icon: '📜', label: 'Событие' },
    rest: { icon: '🔥', label: 'Костёр' },
    shop: { icon: '🛒', label: 'Магазин' },
    forge: { icon: '🔨', label: 'Кузница' },
    library: { icon: '📚', label: 'Библиотека' },
    altar: { icon: '⚗️', label: 'Алтарь' },
    casino: { icon: '🎰', label: 'Казино' }
};

const ACTS = [
    { n: 1, name: 'Провинциальный аукцион' },
    { n: 2, name: 'Городской дом торговли' },
    { n: 3, name: 'Чёрный рынок теней' }
];
const ACT_FLOORS = 10;            // этажей в акте (последний — босс)
const STAGE_ROUNDS = 3;           // раундов в бою
const ACT_COINS = [60, 80, 100];  // монет в бою по актам
const BASE_HP = 100;

// ===========================================================================
//  ДВИЖОК ЗАБЕГА
// ===========================================================================
function listContent() {
    return {
        heroes: HEROES,
        relics: RELICS.map(r => ({ id: r.id, name: r.name, icon: r.icon, rarity: r.rarity, desc: r.desc })),
        curses: CURSES.map(c => ({ id: c.id, name: c.name, icon: c.icon, desc: c.desc })),
        potions: POTIONS,
        actives: ACTIVES.map(a => ({ id: a.id, name: a.name, desc: a.desc })),
        passives: PASSIVES.map(a => ({ id: a.id, name: a.name, desc: a.desc })),
        acts: ACTS,
        nodeMeta: NODE_META
    };
}

function createRun(opts) {
    opts = opts || {};
    const hero = HEROES.find(h => h.id === opts.heroId) || HEROES[0];
    const seed = (opts.seed === undefined || opts.seed === null || opts.seed === '')
        ? Math.floor(Math.random() * 2 ** 31)
        : (typeof opts.seed === 'number' ? opts.seed : hashString(String(opts.seed)));
    const ascension = clamp(parseInt(opts.ascension, 10) || 0, 0, 15);

    const run = {
        seed, ascension,
        name: opts.name || 'Игрок',
        heroId: hero.id,
        _rng: mulberry32(seed),
        screen: 'map',
        act: 1,
        floorIndex: 0,
        hp: BASE_HP,
        maxHp: BASE_HP,
        gold: 0,
        potions: {},
        relics: [],
        curses: [],
        abilities: { active: [], passive: [] },
        battle: null,
        reward: null,
        event: null,
        shop: null,
        treasure: null,
        forge: null,
        library: null,
        casino: null,
        altar: null,
        rest: null,
        log: [],
        lastEnemy: null,
        pendingPotions: {},
        flags: {},
        stats: { battlesWon: 0, battlesLost: 0, nodes: 0, goldEarned: 0, elites: 0, bosses: 0 },
        finished: false,
        result: null
    };

    // Стартовая геройская реликвия
    acquireRelic(run, hero.relic, true);

    generateMap(run);
    pushLog(run, `Забег начат: герой «${hero.name}», семя ${seed}${ascension ? ', закон ' + ascension : ''}.`);
    return run;
}

function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function pushLog(run, text) {
    run.log.push(text);
    if (run.log.length > 60) run.log.shift();
}

// --- Генерация карты ---
// Бой на этаже обязателен: без него не пройти. Пул — только боевые узлы.
function rollCombatType(run, floor) {
    const pool = [];
    const add = (t, w) => { for (let i = 0; i < w; i++) pool.push(t); };
    add('battle', 10);
    if (floor >= 2) add('elite', run.act >= 2 ? 4 : 3);
    return pick(run, pool);
}

// Служебные узлы — дают редкие/случайные выгоды, но боя не заменяют.
function rollUtilityType(run) {
    const act = run.act;
    const pool = [];
    const add = (t, w) => { for (let i = 0; i < w; i++) pool.push(t); };
    add('event', 5);
    add('rest', 3);
    add('shop', act >= 2 ? 3 : 2);
    add('treasure', 2);
    add('forge', 2);
    add('library', 2);
    if (act >= 2) add('casino', 2);
    add('altar', 2);
    return pick(run, pool);
}

function generateMap(run) {
    const floors = [];
    for (let f = 0; f < ACT_FLOORS; f++) {
        if (f === ACT_FLOORS - 1) { floors.push([{ type: 'boss' }]); continue; }
        const count = chance(run, 0.5) ? 3 : 2;
        const types = [];
        // Первый узел этажа — всегда бой (обязательный путь)
        types.push(rollCombatType(run, f));
        let guard = 0;
        while (types.length < count && guard++ < 25) {
            // ~70% путей — снова бой, остальное — служебное
            const t = chance(run, 0.7) ? rollCombatType(run, f) : rollUtilityType(run);
            if (!types.includes(t)) types.push(t);
            else if (guard > 12) { const u = rollUtilityType(run); if (!types.includes(u)) types.push(u); }
        }
        floors.push(types.map(t => ({ type: t, locked: t === 'treasure' && chance(run, 0.25) })));
    }
    run.map = { floors };
}

// --- Модификаторы (собираются из реликвий, проклятий и героя) ---
function mods(run) {
    const m = {
        startCoins: 0, bidBoost: 0, bidBoostEarly: 0, bidBoostLate: 0,
        winPoints: 0, bigLotPts: 0, bigLotMin: 40, smallBidPts: 0, smallBidMax: 8,
        loseRoundPoints: 0, endRoundIncomePct: 0, bidRefundLosePct: 0, stealOnWin: 0,
        winCoins: 0, tieWins: false, healOnWin: 0, firstBidFree: false, vulture: false,
        potionChance: 0, extraRewardOption: false, lotShift: 0,
        expensiveBid: 0, expensiveBidCost: 0, freeOverbid: 0, freeOverbidUses: 0,
        reviveOnce: false, softFirstLoss: false, immuneBlind: false,
        goldMult: 1, dmgMult: 1
    };
    const apply = (fx) => {
        if (!fx) return;
        for (const k in fx) {
            const v = fx[k];
            if (k === 'goldMult' || k === 'dmgMult') { m[k] *= v; continue; }
            if (typeof v === 'number') m[k] = (m[k] || 0) + v;
            else if (typeof v === 'boolean') m[k] = m[k] || v;
            else m[k] = v;
        }
    };
    run.relics.forEach(id => apply((RELIC_BY_ID[id] || {}).fx));
    run.curses.forEach(id => apply((RELIC_BY_ID[id] || {}).fx));
    return m;
}

function shopDiscount(run) {
    let d = 0;
    run.relics.forEach(id => { const r = RELIC_BY_ID[id]; if (r && r.fx && r.fx.shopDiscount) d += r.fx.shopDiscount; });
    let up = 0;
    run.curses.forEach(id => { const c = RELIC_BY_ID[id]; if (c && c.fx && c.fx.shopPriceUp) up += c.fx.shopPriceUp; });
    return clamp(1 - d + up, 0.4, 2.0);
}

function applyStat(run, stat, sign) {
    if (!stat) return;
    if (stat.maxHp) { run.maxHp = Math.max(20, run.maxHp + stat.maxHp); run.hp = clamp(run.hp + stat.maxHp, 1, run.maxHp); }
    if (stat.gold) { addGold(run, stat.gold); }
    if (stat.potion) addPotion(run, stat.potion);
}

function acquireRelic(run, id, silent) {
    const def = RELIC_BY_ID[id];
    if (!def) return false;
    if (run.relics.includes(id) || run.curses.includes(id)) return false;
    if (run.relics.length >= MAX_RELICS) return false; // предел коллекции
    run.relics.push(id);
    applyStat(run, def.stat, 1);
    if (!silent) pushLog(run, `Получена реликвия: ${def.icon || ''} ${def.name}.`);
    return true;
}

function addCurse(run, id) {
    let def;
    if (id) { def = RELIC_BY_ID[id]; }
    if (!def) {
        const pool = CURSES.filter(c => !run.curses.includes(c.id));
        if (!pool.length) return;
        def = pick(run, pool);
    }
    if (run.curses.includes(def.id)) return;
    run.curses.push(def.id);
    applyStat(run, def.stat, -1);
    pushLog(run, `Проклятие: ${def.icon || ''} ${def.name}.`);
}

function removeCurse(run) {
    if (!run.curses.length) return false;
    const id = run.curses.pop();
    const def = RELIC_BY_ID[id];
    // откатываем стат-эффекты
    if (def && def.stat) {
        if (def.stat.maxHp) { run.maxHp = Math.max(20, run.maxHp - def.stat.maxHp); run.hp = clamp(run.hp, 1, run.maxHp); }
        if (def.stat.gold) addGold(run, -def.stat.gold);
    }
    pushLog(run, `Снято проклятие: ${def ? def.name : id}.`);
    return true;
}

function addPotion(run, id) {
    const total = Object.values(run.potions).reduce((s, c) => s + c, 0);
    if (total >= MAX_POTIONS) return false; // лимит зелий
    run.potions[id] = (run.potions[id] || 0) + 1;
    return true;
}
function usePotion(run, id) {
    if (!run.potions[id]) return { error: 'Нет такого зелья' };
    const def = POTION_BY_ID[id];
    if (!def) return { error: 'Неизвестное зелье' };
    const inCombat = run.screen === 'combat';
    if (def.where === 'combat' && !inCombat) return { error: 'Это зелье только в бою' };
    if (def.where === 'map' && inCombat) return { error: 'Это зелье только на карте' };
    run.potions[id]--;
    if (run.potions[id] <= 0) delete run.potions[id];

    if (id === 'heal') { run.hp = clamp(run.hp + 35, 0, run.maxHp); pushLog(run, 'Зелье лечения: +35 репутации.'); }
    else if (id === 'gold') { addGold(run, 30); pushLog(run, 'Зелье богатства: +30 золота.'); }
    else if (id === 'shield') { run.flags.shieldPotion = true; pushLog(run, 'Зелье стойкости: следующий проигранный бой без урона.'); }
    else if (id === 'coin') { if (inCombat) { run.battle.playerCoins += 30; pushLog(run, 'Зелье монет: +30 монет.'); } }
    else if (id === 'focus') { if (inCombat) { run.battle.bonusBid = (run.battle.bonusBid || 0) + 8; pushLog(run, 'Зелье сосредоточения: +8 к ставкам.'); } }
    else if (id === 'luck') { if (inCombat) { run.battle.bonusBid = (run.battle.bonusBid || 0) + 6; pushLog(run, 'Зелье удачи: +6 к ставкам.'); } }
    return { ok: true };
}

function addGold(run, amount) {
    if (!amount) return;
    run.gold = Math.max(0, run.gold + amount);
    if (amount > 0) run.stats.goldEarned += amount;
}

// --- Вход в узел ---
function enterNode(run, floorIndex, nodeIndex) {
    if (run.screen !== 'map') return { error: 'Сейчас нельзя выбирать узел' };
    if (run.finished) return { error: 'Забег окончен' };
    if (floorIndex !== run.floorIndex) return { error: 'Недоступный этаж' };
    const floor = run.map.floors[floorIndex];
    if (!floor || !floor[nodeIndex]) return { error: 'Нет такого узла' };
    const node = floor[nodeIndex];
    run.currentNode = node;
    run.stats.nodes++;

    const m = mods(run);
    if (m.nodeGoldLoss) addGold(run, -m.nodeGoldLoss);

    switch (node.type) {
        case 'battle': startCombat(run, 'battle'); break;
        case 'elite': startCombat(run, 'elite'); break;
        case 'boss': startCombat(run, 'boss'); break;
        case 'treasure': startTreasure(run, node); break;
        case 'event': startEvent(run); break;
        case 'rest': run.screen = 'rest'; run.rest = { done: false }; break;
        case 'shop': openShop(run); break;
        case 'forge':
            if (run.abilities.active.length + run.abilities.passive.length === 0) {
                addGold(run, 20);
                pushLog(run, 'Кузница пуста: нечего перековывать, +20 золота.');
                run.screen = 'map'; advanceFloor(run); break;
            }
            run.screen = 'forge'; run.forge = { done: false }; break;
        case 'library': {
            const opts = rollAbilityOptions(run, 3);
            if (!opts.length) { addGold(run, 25); pushLog(run, 'Библиотека исчерпана, +25 золота.'); run.screen = 'map'; advanceFloor(run); break; }
            run.screen = 'library'; run.library = { options: opts, done: false }; break;
        }
        case 'altar': run.screen = 'altar'; run.altar = { done: false }; break;
        case 'casino': run.screen = 'casino'; run.casino = { done: false, lastResult: null }; break;
        default: return { error: 'Неизвестный узел' };
    }
    return { ok: true };
}

// --- Бой ---
function pickEnemy(run, tier) {
    if (tier === 'boss') {
        const pool = BOSSES.filter(b => !run.stats.bosses || b.id !== run.lastBoss);
        const b = pick(run, pool);
        run.lastBoss = b.id;
        return b;
    }
    const pool = tier === 'elite' ? ENEMIES.concat(ENEMIES.filter(e => (e.coinsBonus || 0) > 0)) : ENEMIES;
    return pick(run, pool);
}

function startCombat(run, tier) {
    const base = ACT_COINS[run.act - 1] || 60;
    const enemy = pickEnemy(run, tier);
    const m = mods(run);
    const isBoss = tier === 'boss';
    const isElite = tier === 'elite';

    const playerCoins = Math.max(5, base + m.startCoins);
    const eliteBonus = isElite ? 15 : isBoss ? (20 + run.act * 10) : 0;
    const enemyCoins = Math.max(5, base + (enemy.coinsBonus || 0) + eliteBonus + (m.enemyCoinsBonus || 0) + Math.round(run.ascension * 2) + (run.act - 1) * 10);

    run.battle = {
        tier,
        enemy,
        round: 1,
        playerCoins,
        enemyCoins,
        playerPoints: 0,
        enemyPoints: 0,
        lot: 0,
        enemyBid: null,
        playerBid: null,
        armedActive: null,
        usedThisBattle: [],
        firstBidUsed: false,
        freeOverbidUsed: false,
        bonusBid: 0,
        logs: [],
        roundHistory: [],
        blind: isBoss && (run.curses.some(id => (RELIC_BY_ID[id] || {}).fx && RELIC_BY_ID[id].fx.blindOnBoss))
    };
    run.screen = 'combat';
    run.lastEnemy = { name: enemy.name, icon: enemy.icon, tier };
    pushLog(run, `Бой (${nodeLabel(tier)}): ${enemy.icon} ${enemy.name}.`);
    beginRound(run);
}

function nodeLabel(tier) {
    return tier === 'boss' ? 'босс' : tier === 'elite' ? 'элита' : 'обычный';
}

function beginRound(run) {
    const b = run.battle;
    b.lot = getLot(run, b);
    if (b.enemy.flags.casino) b.lot *= 2;
    b.playerBid = null;
    b.armedActive = null;
    b.blind = false;
    if (b.tier === 'boss' && run.curses.some(id => (RELIC_BY_ID[id] || {}).fx && RELIC_BY_ID[id].fx.blindOnBoss)
        && !mods(run).immuneBlind) b.blind = true;
    b.enemyBid = enemyCommit(run);
}

function getLot(run, b) {
    const base = (Math.floor(rnd(run) * 9) + 2) * 5; // 10..50
    return clamp(base + mods(run).lotShift, 5, 65);
}

function enemyCommit(run) {
    const b = run.battle;
    const e = b.enemy;
    const roundsLeft = Math.max(1, STAGE_ROUNDS - b.round + 1);
    const budget = b.enemyCoins / roundsLeft;
    const m = mods(run);
    const aggr = clamp(e.aggr + (m.enemyAggro || 0), 0.05, 0.95);
    const roll = rnd(run);
    let target;
    if (e.flags.philosopher && b.lot < 25) target = 0;
    else if (roll < aggr) target = budget * (1.5 + rnd(run) * 1.6) * (0.6 + b.lot / 60);
    else if (roll < aggr + 0.5) target = budget * (0.6 + rnd(run) * 0.7) * (0.6 + b.lot / 60);
    else target = budget * rnd(run) * 0.4;

    if (e.flags.manic) target *= (0.5 + rnd(run) * 2);
    if (e.flags.snob) target = Math.round(target / 5) * 5;
    if (e.flags.mirror && b.roundHistory.length) target = (b.roundHistory[b.roundHistory.length - 1].playerEffective || 0) + 1;
    if (e.flags.spy && b.roundHistory.length) {
        const last = b.roundHistory[b.roundHistory.length - 1].playerEffective || 0;
        target = Math.max(target, last + (rnd(run) < 0.5 ? 1 : -1));
    }
    if (b.round === STAGE_ROUNDS && b.enemyPoints < b.playerPoints) target *= 1.25;
    target = Math.round((target + (rnd(run) * 5 - 2)) * 1.2);
    return clamp(target, 0, b.enemyCoins);
}

function combatMods(run) {
    const m = mods(run);
    m.bonusBid = run.battle.bonusBid || 0;
    return m;
}

// Активация активной способности в бою (перезаряжается каждый бой)
function activateAbility(run, abilityId) {
    const b = run.battle;
    if (!b) return { error: 'Нет активного боя' };
    if (b.armedActive) return { error: 'Способность уже активирована в этом раунде' };
    const owned = run.abilities.active.find(a => a.id === abilityId);
    if (!owned) return { error: 'У тебя нет такой способности' };
    if (b.usedThisBattle.includes(abilityId)) return { error: 'Способность уже использована в этом бою' };
    b.armedActive = abilityId;
    b.usedThisBattle.push(abilityId);
    const def = getAbility(abilityId);
    b.logs.push(`Активирована: ${def ? def.name : abilityId}`);
    return { ok: true, def };
}

// Игрок делает ставку -> раунд разрешается
function submitBid(run, bid) {
    const b = run.battle;
    if (!b) return { error: 'Нет активного боя' };
    if (b.playerBid !== null) return { error: 'Ставка уже сделана' };
    let amount = parseInt(bid, 10);
    if (isNaN(amount) || amount < 0) amount = 0;
    if (amount > b.playerCoins) return { error: 'Недостаточно монет' };
    b.playerBid = amount;
    return resolveRound(run);
}

function resolveRound(run) {
    const b = run.battle;
    const m = combatMods(run);
    const e = b.enemy;
    const armed = b.armedActive;
    const logs = [];
    const pBid = b.playerBid;

    // --- Эффективная ставка игрока: плоские бонусы реликвий/событий, потом множители навыков
    let flat = 0;
    if (b.round <= 2) flat += m.bidBoostEarly;
    if (b.round >= STAGE_ROUNDS) flat += m.bidBoostLate;
    flat += m.bidBoost + (b.bonusBid || 0);

    if (m.freeOverbid > 0 && !b.freeOverbidUsed) {
        flat += m.freeOverbid;
        b.freeOverbidUsed = true;
        logs.push(`Бесплатный рывок: +${m.freeOverbid} к ставке.`);
    }

    let mult = 1;
    if (armed === 'a_surge') mult = 1.45;
    if (armed === 'a_allin') mult = 1.7;
    const effP = Math.round((pBid + flat) * mult);
    if (armed === 'a_surge') logs.push('Взлёт: ставка действует на 45% сильнее.');
    if (armed === 'a_allin') logs.push('Ва-банк: ставка сильнее на 70%, но и стоит дороже.');

    // --- Эффективная ставка врага (навык «Волокита» режет её)
    let effE = b.enemyBid;
    if (armed === 'a_delay') { effE = Math.round(effE * 0.7); logs.push('Волокита: ставка врага ослаблена на 30%.'); }

    // --- Стоимость ставки (переплата у «Гедониста/Палача», наценка «Ва-банка»)
    let cost = pBid;
    if (armed === 'a_allin') cost = Math.ceil(cost * 1.5);
    if (m.expensiveBid && pBid >= m.expensiveBid) cost += m.expensiveBidCost;

    let costFree = armed === 'a_free';
    let refundFirst = false;
    if (!costFree && (m.firstBidFree || hasPassive(run, 'p_firstfree')) && !b.firstBidUsed) {
        refundFirst = true;
        b.firstBidUsed = true;
    }

    // --- Кто победил
    let playerWins;
    if (effP > effE) playerWins = true;
    else if (effP < effE) playerWins = false;
    else playerWins = !!(m.tieWins || hasPassive(run, 'p_tie')); // ничья в пользу игрока

    // --- Списание монет
    const spend = costFree || refundFirst ? 0 : cost;
    b.playerCoins = Math.max(0, b.playerCoins - spend);
    b.enemyCoins = Math.max(0, b.enemyCoins - b.enemyBid);
    if (costFree) logs.push('Свободный ход: ставка не стоила монет 🆓');
    else if (refundFirst) logs.push('Первая ставка бесплатна 🆓');

    // --- Очки
    let pPts = 0, ePts = 0;
    if (playerWins) {
        pPts = b.lot;
        pPts += m.winPoints;
        if (hasPassive(run, 'p_jeweler')) pPts += 5;
        let bigBonus = 0;
        if (m.bigLotPts && b.lot >= m.bigLotMin) bigBonus = m.bigLotPts;
        if (hasPassive(run, 'p_biglot') && b.lot >= 40) bigBonus = Math.max(bigBonus, 7);
        if (bigBonus) pPts += bigBonus;
        if (m.smallBidPts && pBid <= m.smallBidMax && pBid > 0) pPts += m.smallBidPts;
        if (m.vulture && (effP - effE) >= 20) pPts += 6;
        pPts = Math.max(0, pPts);
        b.playerPoints += pPts;
    } else {
        pPts = Math.max(0, m.loseRoundPoints + (hasPassive(run, 'p_counter') ? 4 : 0));
        b.playerPoints += pPts;
        // возврат проигранной ставки: навык «Откат» возвращает всё, иначе процент
        if (armed === 'a_rollback' && spend > 0) {
            b.playerCoins += spend;
            logs.push(`Откат: возвращено ${spend} монет.`);
        } else if (spend > 0) {
            const pct = Math.max(m.bidRefundLosePct, hasPassive(run, 'p_refund') ? 0.35 : 0);
            const back = Math.floor(spend * pct);
            if (back > 0) { b.playerCoins += back; logs.push(`Возврат ${back} монет за проигрыш.`); }
        }
    }

    if (!playerWins) {
        ePts = b.lot;
        if (e.flags.collector) ePts += 5;
        if (e.flags.oracle) ePts += 4;
        if (e.flags.gambler && chance(run, 0.2)) { ePts *= 2; logs.push('Игрок удваивает очки!'); }
        b.enemyPoints += ePts;
        if (e.flags.leech) {
            const steal = Math.min(6, b.playerCoins);
            b.playerCoins -= steal; b.enemyCoins += steal;
            if (steal) logs.push(`${e.name} крадёт ${steal} монет.`);
        }
    } else {
        // игрок захватил лот
        const steal = Math.max(m.stealOnWin || 0, hasPassive(run, 'p_pickpocket') ? 12 : 0);
        if (steal) {
            const got = Math.min(steal, b.enemyCoins);
            b.enemyCoins -= got; b.playerCoins += got;
            if (got) logs.push(`Кража: +${got} монет.`);
        }
        if (m.winCoins) { b.playerCoins += m.winCoins; logs.push(`Бонус: +${m.winCoins} монет.`); }
    }

    // Доход в конце раунда (проценты от остатка)
    const incomePct = Math.max(m.endRoundIncomePct, hasPassive(run, 'p_income') ? 0.08 : 0);
    if (incomePct > 0) {
        const inc = Math.floor(b.playerCoins * incomePct);
        if (inc > 0) { b.playerCoins += inc; logs.push(`Доход: +${inc} монет.`); }
    }

    b.roundHistory.push({ round: b.round, lot: b.lot, playerEffective: effP, enemyEffective: effE, playerWins });
    b.logs.push(`Раунд ${b.round}: ${playerWins ? 'ты победил' : 'враг победил'} (${effP} vs ${effE}).`);
    if (logs.length) logs.forEach(l => b.logs.push(l));

    const result = {
        round: b.round,
        lot: b.lot,
        lotHidden: b.blind,
        playerBid: pBid,
        playerEffective: effP,
        enemyBid: b.enemyBid,
        enemyEffective: effE,
        playerWins,
        isTie: effP === effE,
        pointsGained: pPts,
        enemyPointsGained: ePts,
        playerPoints: b.playerPoints,
        enemyPoints: b.enemyPoints,
        playerCoins: b.playerCoins,
        enemyCoins: b.enemyCoins,
        logs: logs.slice()
    };

    if (b.round < STAGE_ROUNDS) {
        b.round++;
        b.playerBid = null;
        beginRound(run);
        return { ok: true, roundResult: result, continueCombat: true };
    }
    return { ok: true, roundResult: result, continueCombat: false, combatEnd: endCombat(run) };
}

function endCombat(run) {
    const b = run.battle;
    const m = mods(run);
    const win = b.playerPoints > b.enemyPoints;
    const margin = Math.max(0, b.enemyPoints - b.playerPoints);

    let damage = 0;
    let revived = false;
    let shielded = false;

    if (!win) {
        damage = Math.max(12, Math.round(margin * 1.2));
        if (b.enemy.flags.armored) damage = Math.floor(damage * 0.7);
        if (m.softFirstLoss && !run.flags.softFirstLossUsed) { damage = Math.floor(damage / 2); run.flags.softFirstLossUsed = true; }
        if (run.flags.shieldPotion) { shielded = true; damage = 0; run.flags.shieldPotion = false; }
        damage = Math.floor(damage * m.dmgMult);
        run.hp -= damage;
        if (run.hp <= 0) {
            if (m.reviveOnce && !run.flags.revived) { run.flags.revived = true; run.hp = 1; revived = true; }
            else { run.hp = 0; }
        }
    }

    const summary = {
        tier: b.tier,
        enemy: { name: b.enemy.name, icon: b.enemy.icon },
        playerPoints: b.playerPoints,
        enemyPoints: b.enemyPoints,
        win,
        damage,
        revived,
        shielded,
        hp: run.hp
    };

    if (win) {
        run.stats.battlesWon++;
        if (b.tier === 'elite') run.stats.elites++;
        if (b.tier === 'boss') run.stats.bosses++;
        buildBattleReward(run, b.tier);
    } else {
        run.stats.battlesLost++;
        run.screen = 'map';
        run.battle = null;
        advanceFloor(run);
        if (run.hp <= 0) finishRun(run, false);
    }
    return summary;
}

// Награда за бой зависит от типа противника — так прогрессия не растекается:
// обычные бои дают золото/починку, элиты — реликвии, боссы — реликвии и навыки.
function buildBattleReward(run, tier) {
    const m = mods(run);
    const baseGold = tier === 'boss' ? 60 + run.act * 20 : tier === 'elite' ? 40 : 22;
    let gold = Math.floor(baseGold * m.goldMult);
    if (m.loseGoldOnWin) gold = Math.max(0, gold - m.loseGoldOnWin);
    addGold(run, gold);
    run.hp = clamp(run.hp + m.healOnWin, 0, run.maxHp);
    if (m.potionChance && chance(run, m.potionChance)) addPotion(run, pick(run, POTIONS).id);

    let pool;
    if (tier === 'boss') pool = ['relic', 'ability', 'gold', 'heal', 'maxhp'];
    else if (tier === 'elite') pool = ['relic', 'gold', 'heal', 'potion', 'maxhp'];
    else pool = ['gold', 'heal', 'potion', 'maxhp'];

    const count = 3 + (m.extraRewardOption ? 1 : 0);
    const guaranteed = tier === 'boss' ? ['relic', 'ability'] : tier === 'elite' ? ['relic'] : [];
    const options = buildRewardOptions(run, pool, count, guaranteed);
    run.reward = { gold, options, kind: 'battle', tier };
    run.battle = null;
    run.screen = 'reward';
}

function buildRewardOptions(run, pool, count, guaranteed) {
    const options = [];
    const hasFreeAbility = () => run.abilities.active.length < MAX_ACTIVE || run.abilities.passive.length < MAX_PASSIVE;
    const make = (type) => {
        if (type === 'relic') {
            if (run.relics.length >= MAX_RELICS) return null;
            const relicPool = RELICS.filter(r => !r.hero && !run.relics.includes(r.id));
            if (!relicPool.length) return null;
            const r = weightedRelic(run, relicPool);
            return { kind: 'relic', id: r.id, name: r.name, icon: r.icon, desc: r.desc, rarity: r.rarity };
        }
        if (type === 'ability') {
            if (!hasFreeAbility()) return null;
            const opts = rollAbilityOptions(run, 1);
            if (!opts.length) return null;
            const a = opts[0];
            return { kind: 'ability', id: a.id, name: a.name, desc: a.desc };
        }
        if (type === 'potion') {
            const total = Object.values(run.potions).reduce((s, c) => s + c, 0);
            if (total >= MAX_POTIONS) return null;
            const p = pick(run, POTIONS);
            return { kind: 'potion', id: p.id, name: p.name, icon: p.icon, desc: p.desc };
        }
        if (type === 'heal') {
            if (run.hp >= run.maxHp) return null;
            return { kind: 'heal', amount: 30, name: 'Отдых', icon: '❤️', desc: '+30 репутации.' };
        }
        if (type === 'gold') return { kind: 'gold', amount: 35, name: 'Золото', icon: '💰', desc: '+35 золота.' };
        if (type === 'maxhp') return { kind: 'maxhp', amount: 8, name: 'Стойкость', icon: '💪', desc: '+8 к макс. репутации.' };
        return null;
    };
    // Приоритетные варианты (элита/босс) идут первыми, если позволяют лимиты
    (guaranteed || []).forEach(kind => {
        if (options.length >= count) return;
        if (!pool.includes(kind)) return;
        const o = make(kind);
        if (o) options.push(o);
    });

    const used = new Set(options.map(o => o.kind));
    const bag = shuffle(run, pool.filter(k => !used.has(k)));
    for (let i = 0; i < bag.length && options.length < count; i++) {
        const o = make(bag[i]);
        if (o) options.push(o);
    }
    let guard = 0;
    while (options.length < count && guard++ < 30) {
        const o = make(bag[guard % bag.length]);
        if (o && !options.some(x => x.kind === o.kind && x.id === o.id)) options.push(o);
    }
    return options;
}

function weightedRelic(run, pool) {
    const weights = { common: 6, rare: 3, epic: 1.5, legendary: 0.5 };
    const bag = [];
    pool.forEach(r => { const w = Math.max(1, Math.round(weights[r.rarity] || 1)); for (let i = 0; i < w; i++) bag.push(r); });
    return pick(run, bag);
}

function chooseReward(run, index) {
    if (run.screen !== 'reward' || !run.reward) return { error: 'Сейчас нет награды' };
    const opt = run.reward.options[index];
    if (!opt) return { error: 'Нет такого варианта' };
    grantOption(run, opt);
    run.reward = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

function grantOption(run, opt) {
    if (opt.kind === 'relic') { if (!acquireRelic(run, opt.id)) addGold(run, 40); }
    else if (opt.kind === 'ability') { if (!addAbility(run, opt.id)) addGold(run, 35); }
    else if (opt.kind === 'potion') { if (!addPotion(run, opt.id)) addGold(run, 15); }
    else if (opt.kind === 'heal') run.hp = clamp(run.hp + opt.amount, 0, run.maxHp);
    else if (opt.kind === 'gold') addGold(run, opt.amount);
    else if (opt.kind === 'maxhp') { run.maxHp += opt.amount; run.hp += opt.amount; }
}

function addAbility(run, id) {
    const def = getAbility(id);
    if (!def) return false;
    if (def.type === 'active') {
        if (run.abilities.active.length >= MAX_ACTIVE) return false; // слоты заняты
        run.abilities.active.push({ id });
    } else {
        if (run.abilities.passive.length >= MAX_PASSIVE) return false;
        run.abilities.passive.push({ id });
    }
    return true;
}

// --- Логика продвижения по карте ---
function advanceFloor(run) {
    if (run.finished) return;
    if (run.currentNode && run.currentNode.type === 'boss') {
        // Босс побеждён — переход к следующему акту или победа
        if (run.act >= 3) { finishRun(run, true); return; }
        run.act++;
        run.floorIndex = 0;
        generateMap(run);
        run.currentNode = null;
        pushLog(run, `Начало акта ${run.act}: ${ACTS[run.act - 1].name}.`);
        run.screen = 'map';
        return;
    }
    run.floorIndex++;
    run.currentNode = null;
    if (run.floorIndex >= ACT_FLOORS) {
        // на всякий случай
        if (run.act >= 3) finishRun(run, true);
        else { run.act++; run.floorIndex = 0; generateMap(run); }
    }
    run.screen = 'map';
}

function finishRun(run, victory) {
    run.finished = true;
    const depth = (run.act - 1) * ACT_FLOORS + run.floorIndex;
    let score = Math.floor(run.gold)
        + run.stats.battlesWon * 50
        + run.relics.length * 25
        + run.abilities.active.length * 20 + run.abilities.passive.length * 10
        + depth * 15
        + (victory ? 1000 : 0)
        + run.ascension * 100;
    score = Math.max(0, score);
    const crystals = Math.floor(score / 200) + (victory ? 10 : 0) + run.ascension * 2;
    run.result = {
        victory,
        score,
        crystals,
        act: run.act,
        depth,
        hp: run.hp,
        gold: Math.floor(run.gold),
        relics: run.relics.slice(),
        curses: run.curses.slice(),
        abilities: run.abilities,
        stats: run.stats,
        heroId: run.heroId,
        seed: run.seed,
        ascension: run.ascension
    };
    run.screen = victory ? 'victory' : 'gameover';
    pushLog(run, victory ? 'ПОБЕДА! Забег пройден.' : 'Забег окончен — репутация на нуле.');
}

// --- Библиотека (выбор способности) ---
function rollAbilityOptions(run, count) {
    const owned = new Set(run.abilities.active.map(a => a.id).concat(run.abilities.passive.map(a => a.id)));
    const pool = ACTIVES.concat(PASSIVES).filter(a => !owned.has(a.id));
    const activeFull = run.abilities.active.length >= MAX_ACTIVE;
    const passiveFull = run.abilities.passive.length >= MAX_PASSIVE;
    const fits = a => (a.type === 'active' && !activeFull) || (a.type === 'passive' && !passiveFull);
    const shuffled = shuffle(run, pool);
    // сначала те, что влезут без замены, потом остальные
    const order = shuffled.filter(fits).concat(shuffled.filter(a => !fits(a)));
    return order.slice(0, count || 3).map(a => ({
        id: a.id, name: a.name, desc: a.desc, type: a.type, target: !!a.target
    }));
}

function libraryChoose(run, abilityId) {
    if (run.screen !== 'library' || !run.library) return { error: 'Сейчас не библиотека' };
    const ok = run.library.options.find(o => o.id === abilityId);
    if (!ok) return { error: 'Нет такой способности' };
    const def = getAbility(abilityId);
    const type = def ? def.type : 'passive';
    const list = type === 'active' ? run.abilities.active : run.abilities.passive;
    const cap = type === 'active' ? MAX_ACTIVE : MAX_PASSIVE;
    if (list.length >= cap) {
        // слоты заняты — игрок сам выбирает, что заменить
        run.swap = { type, newId: abilityId, newName: ok.name, newDesc: ok.desc, source: 'library' };
        return { ok: true, needSwap: true };
    }
    list.push({ id: abilityId });
    pushLog(run, `Изучена способность: ${ok.name}.`);
    run.library = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

function swapAbility(run, oldId) {
    if (!run.swap) return { error: 'Нечего заменять' };
    const sw = run.swap;
    const list = sw.type === 'active' ? run.abilities.active : run.abilities.passive;
    const idx = list.findIndex(a => a.id === oldId);
    if (idx < 0) return { error: 'Нет такой способности' };
    const oldDef = getAbility(oldId);
    list[idx] = { id: sw.newId };
    pushLog(run, `Замена: ${(oldDef || {}).name} → ${sw.newName}.`);
    run.swap = null;
    run.library = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

function swapCancel(run) {
    if (!run.swap) return { error: 'Нечего отменять' };
    run.swap = null;
    return { ok: true };
}

function libraryLeave(run) {
    if (run.screen !== 'library') return { error: 'Сейчас не библиотека' };
    addGold(run, 25);
    pushLog(run, 'Библиотека пройдена мимо, +25 золота.');
    run.library = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

// --- Кузница (перековка) ---
function forgeChoose(run, abilityId) {
    if (run.screen !== 'forge' || !run.forge) return { error: 'Сейчас не кузница' };
    let type = null, list = null;
    const aIdx = run.abilities.active.findIndex(a => a.id === abilityId);
    const pIdx = run.abilities.passive.findIndex(a => a.id === abilityId);
    if (aIdx >= 0) { type = 'active'; list = run.abilities.active; }
    else if (pIdx >= 0) { type = 'passive'; list = run.abilities.passive; }
    else return { error: 'Нет такой способности' };

    const owned = new Set(run.abilities.active.map(a => a.id).concat(run.abilities.passive.map(a => a.id)));
    const pool = (type === 'active' ? ACTIVES : PASSIVES).filter(a => !owned.has(a.id));
    if (!pool.length) {
        addGold(run, 25);
        run.forge = null; run.screen = 'map'; advanceFloor(run);
        return { ok: true, replaced: null };
    }
    const ne = pick(run, pool);
    const idx = type === 'active' ? aIdx : pIdx;
    list[idx] = { id: ne.id };
    pushLog(run, `Перековано: ${(getAbility(abilityId) || {}).name} → ${ne.name}.`);
    run.forge = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true, replaced: ne };
}

function forgeLeave(run) {
    if (run.screen !== 'forge') return { error: 'Сейчас не кузница' };
    addGold(run, 10);
    pushLog(run, 'Кузница покинута, +10 золота.');
    run.forge = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

// --- Костёр ---
function restAction(run, action) {
    if (run.screen !== 'rest' || !run.rest) return { error: 'Сейчас не костёр' };
    const m = mods(run);
    if (action === 'heal') {
        let amt = Math.floor(run.maxHp * 0.35);
        run.hp = clamp(run.hp + amt, 0, run.maxHp);
        pushLog(run, `Отдых: +${amt} репутации.`);
    } else if (action === 'maxhp') {
        const add = Math.max(3, Math.floor(run.maxHp * 0.08));
        run.maxHp += add; run.hp += add;
        pushLog(run, `Отдых: +${add} к макс. репутации.`);
    } else if (action === 'removeCurse') {
        if (!run.curses.length) return { error: 'Нет проклятий' };
        removeCurse(run);
    } else return { error: 'Неизвестное действие' };
    run.rest = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

// --- Сокровищница ---
function startTreasure(run, node) {
    run.treasure = { locked: !!node.locked, opened: false };
    run.screen = 'treasure';
    // если не заперт — сразу выдаём
    if (!node.locked) {
        const r = run.relics.length >= MAX_RELICS ? null
            : weightedRelic(run, RELICS.filter(x => !x.hero && !run.relics.includes(x.id)));
        if (r) acquireRelic(run, r.id);
        else addGold(run, 50);
        const trapped = chance(run, 0.2) && run.curses.length < 6;
        if (trapped) addCurse(run);
        run.treasure.opened = true;
        run.treasure.got = r ? { name: r.name, icon: r.icon } : { name: 'Золотая пыль', icon: '💰' };
        run.treasure.trapped = trapped;
    }
}

function treasureTake(run) {
    if (run.screen !== 'treasure' || !run.treasure) return { error: 'Сейчас не сокровищница' };
    if (run.treasure.locked) {
        // запертый сундук: вскрываем ценой 15 репутации; при нехватке — просто уходим
        if (run.hp > 20) {
            run.hp -= 15;
            const r = run.relics.length >= MAX_RELICS ? null
                : weightedRelic(run, RELICS.filter(x => !x.hero && !run.relics.includes(x.id)));
            if (r) acquireRelic(run, r.id);
            else addGold(run, 50);
            run.treasure.opened = true;
            run.treasure.got = r ? { name: r.name, icon: r.icon } : { name: 'Золотая пыль', icon: '💰' };
            pushLog(run, 'Запертый сундук вскрыт ценой 15 репутации.');
        } else {
            pushLog(run, 'Слишком мало репутации — запертый сундук оставлен.');
        }
    }
    run.treasure = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

// --- Событие ---
function startEvent(run) {
    const pool = EVENTS.filter(e => true);
    const ev = pick(run, pool);
    run.event = { id: ev.id, title: ev.title, text: ev.text, choices: ev.choices.map((c, i) => ({ i, label: c.label, hint: c.hint || '', available: c.requires ? !!c.requires(run) : true })), resolved: false };
    run.screen = 'event';
}

function eventChoice(run, index) {
    if (run.screen !== 'event' || !run.event) return { error: 'Сейчас нет события' };
    if (run.event.resolved) return { error: 'Событие уже решено' };
    const ev = EVENTS.find(e => e.id === run.event.id);
    const choice = ev.choices[index];
    if (!choice) return { error: 'Нет такого варианта' };
    if (choice.requires && !choice.requires(run)) return { error: 'Недоступный вариант' };
    applyEffects(run, choice.effects || []);
    run.event.resolved = true;
    run.pendingEventEnd = true;
    return { ok: true };
}

function eventContinue(run) {
    if (run.screen !== 'event') return { error: 'Сейчас нет события' };
    run.event = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

function applyEffects(run, effects) {
    effects.forEach(e => {
        switch (e.k) {
            case 'gold': addGold(run, e.v); break;
            case 'hp': run.hp = clamp(run.hp + e.v, 0, run.maxHp); if (run.hp <= 0 && !run.finished) finishRun(run, false); break;
            case 'maxHp': run.maxHp = Math.max(10, run.maxHp + e.v); if (e.v > 0) run.hp += e.v; break;
            case 'heal': run.hp = clamp(run.hp + e.v, 0, run.maxHp); break;
            case 'relic': {
                const pool = RELICS.filter(r => !r.hero && !run.relics.includes(r.id));
                if (run.relics.length >= MAX_RELICS) { addGold(run, 40); break; } // коллекция полна
                if (pool.length) acquireRelic(run, weightedRelic(run, pool).id);
                else addGold(run, 40);
                break;
            }
            case 'curse': addCurse(run); break;
            case 'potion': if (!addPotion(run, pick(run, POTIONS).id)) addGold(run, 15); break;
            case 'ability': {
                const opts = rollAbilityOptions(run, 1);
                if (opts.length && !addAbility(run, opts[0].id)) addGold(run, 35);
                else if (!opts.length) addGold(run, 35);
                break;
            }
            case 'removeCurse': removeCurse(run); break;
            case 'combat': startCombat(run, e.tier || 'battle'); break;
            case 'roll': applyEffects(run, chance(run, e.p) ? e.win : e.lose); break;
            case 'gambleHalf': {
                const g = run.gold;
                if (chance(run, 0.5)) addGold(run, g); else addGold(run, -Math.floor(g / 2));
                break;
            }
            case 'swapRelic': {
                const pool = run.relics.filter(id => RELIC_BY_ID[id] && !RELIC_BY_ID[id].hero);
                if (pool.length) {
                    const oldId = pick(run, pool);
                    const oldIdx = run.relics.indexOf(oldId);
                    run.relics.splice(oldIdx, 1);
                    const candidates = RELICS.filter(r => !r.hero && !run.relics.includes(r.id));
                    if (candidates.length) run.relics.push(weightedRelic(run, candidates).id);
                }
                break;
            }
            case 'forge': break; // обрабатывается отдельным экраном
        }
    });
}

// --- Магазин ---
function openShop(run) {
    const pool = [];
    const usedRelic = new Set();
    const relicsFree = run.relics.length < MAX_RELICS;
    const potTotal = () => Object.values(run.potions).reduce((s, c) => s + c, 0);
    if (relicsFree) {
        for (let i = 0; i < 3; i++) {
            const available = RELICS.filter(r => !r.hero && !run.relics.includes(r.id) && !usedRelic.has(r.id));
            if (!available.length) break;
            const r = weightedRelic(run, available);
            usedRelic.add(r.id);
            const price = Math.round((r.rarity === 'legendary' ? 90 : r.rarity === 'epic' ? 70 : r.rarity === 'rare' ? 50 : 30) * shopDiscount(run));
            pool.push({ kind: 'relic', id: r.id, name: r.name, icon: r.icon, desc: r.desc, rarity: r.rarity, price });
        }
    }
    if (potTotal() < MAX_POTIONS) {
        const pot = pick(run, POTIONS);
        pool.push({ kind: 'potion', id: pot.id, name: pot.name, icon: pot.icon, desc: pot.desc, price: Math.round(25 * shopDiscount(run)) });
    }
    pool.push({ kind: 'heal', amount: 35, name: 'Отдых', icon: '❤️', desc: '+35 репутации.', price: Math.round(30 * shopDiscount(run)) });
    pool.push({ kind: 'gold', amount: 55, name: 'Подачка', icon: '💰', desc: '+55 золота (но дорого).', price: Math.round(50 * shopDiscount(run)) });
    if (run.curses.length) pool.push({ kind: 'removeCurse', name: 'Снятие проклятия', icon: '🕊️', desc: 'Убрать одно проклятие.', price: Math.round(45 * shopDiscount(run)) });
    run.shop = { stock: pool, done: false };
    run.screen = 'shop';
}

function shopBuy(run, index) {
    if (run.screen !== 'shop' || !run.shop) return { error: 'Сейчас не магазин' };
    const item = run.shop.stock[index];
    if (!item || item.sold) return { error: 'Товар недоступен' };
    if (run.gold < item.price) return { error: 'Недостаточно золота' };
    if (item.kind === 'relic') {
        if (run.relics.includes(item.id)) return { error: 'Уже есть' };
        if (run.relics.length >= MAX_RELICS) return { error: 'Слишком много реликвий' };
    }
    if (item.kind === 'potion') {
        const total = Object.values(run.potions).reduce((s, c) => s + c, 0);
        if (total >= MAX_POTIONS) return { error: 'Слишком много зелий' };
    }
    addGold(run, -item.price);
    item.sold = true;
    if (item.kind === 'relic') acquireRelic(run, item.id);
    else if (item.kind === 'potion') addPotion(run, item.id);
    else if (item.kind === 'heal') run.hp = clamp(run.hp + item.amount, 0, run.maxHp);
    else if (item.kind === 'gold') addGold(run, item.amount);
    else if (item.kind === 'removeCurse') removeCurse(run);
    return { ok: true };
}

function shopLeave(run) {
    if (run.screen !== 'shop') return { error: 'Сейчас не магазин' };
    run.shop = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

// --- Алтарь ---
function altarAction(run, action) {
    if (run.screen !== 'altar' || !run.altar) return { error: 'Сейчас не алтарь' };
    const full = () => run.relics.length >= MAX_RELICS;
    const rollAltarRelic = () => {
        const pool = RELICS.filter(r => !r.hero && !run.relics.includes(r.id));
        if (full() || !pool.length) { addGold(run, 50); return false; }
        acquireRelic(run, weightedRelic(run, pool).id);
        return true;
    };
    if (action === 'blood') {
        if (run.hp <= 20) return { error: 'Слишком мало репутации' };
        run.hp -= 15;
        if (!rollAltarRelic()) pushLog(run, 'Коллекция полна — жертва принята в золоте.');
    } else if (action === 'gold') {
        if (run.gold < 40) return { error: 'Недостаточно золота' };
        addGold(run, -40);
        if (!rollAltarRelic()) pushLog(run, 'Коллекция полна — алтарь вернул золото.');
    } else if (action === 'sacrifice') {
        const pool = run.relics.filter(id => RELIC_BY_ID[id] && !RELIC_BY_ID[id].hero);
        if (!pool.length) return { error: 'Нет реликвий для жертвы' };
        const id = pick(run, pool);
        run.relics.splice(run.relics.indexOf(id), 1);
        addGold(run, 60);
    } else if (action === 'curse') {
        addCurse(run);
        rollAltarRelic();
    } else if (action === 'leave') {
        // просто уйти
    } else return { error: 'Неизвестное действие' };
    run.altar = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

// --- Казино ---
function casinoBet(run, amount) {
    if (run.screen !== 'casino' || !run.casino) return { error: 'Сейчас не казино' };
    amount = parseInt(amount, 10);
    if (isNaN(amount) || amount <= 0) return { error: 'Ставка должна быть больше 0' };
    if (run.gold < amount) return { error: 'Недостаточно золота' };
    addGold(run, -amount);
    if (chance(run, 0.45)) {
        addGold(run, amount * 2);
        run.casino.lastResult = { win: true, amount };
    } else {
        run.casino.lastResult = { win: false, amount };
    }
    return { ok: true };
}

function casinoLeave(run) {
    if (run.screen !== 'casino') return { error: 'Сейчас не казино' };
    run.casino = null;
    run.screen = 'map';
    advanceFloor(run);
    return { ok: true };
}

function enemyTell(e) {
    if (e.flags.mirror) return '🪞 Повторяет твою прошлую ставку';
    if (e.flags.spy) return '👁 Держит твой прошлый уровень (+1)';
    if (e.flags.manic) return '🎲 Непредсказуем: ставки скачут';
    if (e.flags.philosopher) return '🤔 Пропускает дешёвые лоты (до 25)';
    if (e.flags.snob) return '🎩 Округляет ставки до 5';
    if (e.aggr >= 0.62) return '🔥 Агрессивен — попробует перебить';
    if (e.aggr <= 0.34) return '🪙 Скуп — редко рискует';
    return '⚖ Играет ровно';
}

// ===========================================================================
//  ИНТЕРФЕЙС ПРЕДСТАВЛЕНИЯ (что видит клиент)
// ===========================================================================
function view(run) {
    const m = mods(run);
    const base = {
        seed: run.seed,
        name: run.name,
        hero: HEROES.find(h => h.id === run.heroId),
        ascension: run.ascension,
        screen: run.screen,
        act: run.act,
        actName: (ACTS[run.act - 1] || ACTS[0]).name,
        floorIndex: run.floorIndex,
        maxFloors: ACT_FLOORS,
        hp: run.hp,
        maxHp: run.maxHp,
        gold: Math.floor(run.gold),
        limits: { relics: MAX_RELICS, active: MAX_ACTIVE, passive: MAX_PASSIVE, potions: MAX_POTIONS },
        potionCount: Object.values(run.potions).reduce((s, c) => s + c, 0),
        potions: Object.keys(run.potions).map(id => ({ id, count: run.potions[id], ...POTION_BY_ID[id] })),
        relics: run.relics.map(id => {
            const r = RELIC_BY_ID[id];
            return r ? { id, name: r.name, icon: r.icon, rarity: r.rarity, desc: r.desc } : null;
        }).filter(Boolean),
        curses: run.curses.map(id => {
            const c = RELIC_BY_ID[id];
            return c ? { id, name: c.name, icon: c.icon, desc: c.desc } : null;
        }).filter(Boolean),
        abilities: {
            active: run.abilities.active.map(a => { const d = getAbility(a.id); return d ? { id: a.id, name: d.name, desc: d.desc, target: !!d.target } : null; }).filter(Boolean),
            passive: run.abilities.passive.map(a => { const d = getAbility(a.id); return d ? { id: a.id, name: d.name, desc: d.desc } : null; }).filter(Boolean)
        },
        log: run.log.slice(-12),
        stats: run.stats,
        goldMult: m.goldMult
    };

    if (run.screen === 'map' || !run.finished) {
        // карта: показываем текущий этаж и будущие (без деталей врагов)
        base.map = {
            floors: run.map.floors.map((floor, fi) => floor.map((node, ni) => ({
                type: node.type,
                locked: !!node.locked,
                icon: (NODE_META[node.type] || {}).icon || '❔',
                label: (NODE_META[node.type] || {}).label || '???',
                // текущий этаж раскрыт, будущие — только иконки
                revealed: fi === run.floorIndex
            }))),
            current: run.floorIndex
        };
    }

    if (run.screen === 'combat' && run.battle) {
        const b = run.battle;
        const reveal = b.armedActive === 'a_scout';
        let effFlat = m.bidBoost + (b.bonusBid || 0);
        if (b.round <= 2) effFlat += m.bidBoostEarly;
        if (b.round >= STAGE_ROUNDS) effFlat += m.bidBoostLate;
        if (m.freeOverbid > 0 && !b.freeOverbidUsed) effFlat += m.freeOverbid;
        base.battle = {
            tier: b.tier,
            enemy: { name: b.enemy.name, icon: b.enemy.icon, flags: Object.keys(b.enemy.flags || {}), tell: enemyTell(b.enemy) },
            round: b.round,
            maxRounds: STAGE_ROUNDS,
            lot: b.blind ? null : b.lot,
            lotHidden: b.blind,
            playerCoins: b.playerCoins,
            enemyCoins: b.enemyCoins,
            playerPoints: b.playerPoints,
            enemyPoints: b.enemyPoints,
            bonusBid: b.bonusBid || 0,
            effFlat,
            armedActive: b.armedActive ? (getAbility(b.armedActive) || {}).name : null,
            armedActiveId: b.armedActive || null,
            scoutReveal: reveal,
            enemyBid: reveal ? b.enemyBid : null,
            activeUsable: run.abilities.active.filter(a => !b.usedThisBattle.includes(a.id))
                .map(a => { const d = getAbility(a.id); return { id: a.id, name: d.name, desc: d.desc }; }),
            hasBid: b.playerBid !== null,
            log: b.logs.slice(-8)
        };
    }

    if (run.screen === 'reward' && run.reward) base.reward = run.reward;
    if (run.screen === 'shop' && run.shop) base.shop = { stock: run.shop.stock.map(s => ({ ...s })) };
    if (run.screen === 'event' && run.event) base.event = run.event;
    if (run.screen === 'treasure' && run.treasure) base.treasure = run.treasure;
    if (run.screen === 'forge' && run.forge) base.forge = { done: run.forge.done };
    if (run.screen === 'library' && run.library) base.library = { options: run.library.options };
    if (run.swap) {
        const list = run.swap.type === 'active' ? run.abilities.active : run.abilities.passive;
        base.swap = {
            type: run.swap.type,
            newId: run.swap.newId,
            newName: run.swap.newName,
            newDesc: run.swap.newDesc,
            candidates: list.map(a => { const d = getAbility(a.id); return d ? { id: a.id, name: d.name, desc: d.desc } : null; }).filter(Boolean)
        };
    }
    if (run.screen === 'altar') base.altar = { done: false };
    if (run.screen === 'casino' && run.casino) base.casino = { lastResult: run.casino.lastResult };
    if (run.screen === 'rest') base.rest = { done: false };
    if (run.result) base.result = run.result;

    return base;
}

// ===========================================================================
//  АВТОПИЛОТ (для тестов и симулятора баланса)
// ===========================================================================
function autoPlayerBid(run) {
    const b = run.battle;
    const roundsLeft = STAGE_ROUNDS - b.round + 1;
    const budget = b.playerCoins / roundsLeft;
    let t = budget * (0.7 + rnd(run) * 0.9) * (0.6 + b.lot / 60);
    if (b.round === STAGE_ROUNDS && b.playerPoints < b.enemyPoints) t *= 1.5;
    if (run.abilities.active.length && rnd(run) < 0.4 && !b.armedActive) {
        const usable = run.abilities.active.filter(a => !b.usedThisBattle.includes(a.id));
        if (usable.length) activateAbility(run, pick(run, usable).id);
    }
    const bid = clamp(Math.round(t + (rnd(run) * 5 - 2)), 0, b.playerCoins);
    return bid;
}

function autoNodeChoice(run) {
    const floor = run.map.floors[run.floorIndex];
    let idx = ri(run, 0, floor.length - 1);
    // стараемся не идти в запертый сундук без нужды
    if (floor[idx].locked && floor.length > 1) idx = (idx + 1) % floor.length;
    return idx;
}

function simulateRun(opts) {
    const run = createRun(opts);
    let guard = 0;
    while (!run.finished && guard++ < 500) {
        const s = run.screen;
        if (s === 'map') {
            enterNode(run, run.floorIndex, autoNodeChoice(run));
        } else if (s === 'combat') {
            while (run.screen === 'combat' && !run.finished) {
                const res = submitBid(run, autoPlayerBid(run));
                if (res.error) break;
                if (res.continueCombat === false && res.combatEnd) {
                    if (run.screen === 'reward') break;
                    // бой проигран -> карта/конец
                }
            }
        } else if (s === 'reward') {
            chooseReward(run, 0);
        } else if (s === 'event') {
            if (run.event && !run.event.resolved) {
                const avail = run.event.choices.filter(c => c.available);
                eventChoice(run, (avail.length ? pick(run, avail) : run.event.choices[0]).i);
            } else eventContinue(run);
        } else if (s === 'treasure') {
            if (run.treasure && run.treasure.locked) {
                if (run.hp > 20) treasureTake(run); else { run.treasure = null; run.screen = 'map'; advanceFloor(run); }
            } else treasureTake(run);
        } else if (s === 'rest') {
            restAction(run, run.hp < run.maxHp * 0.6 ? 'heal' : 'maxhp');
        } else if (s === 'shop') {
            // купим что подешевле при наличии золота
            let bought = false;
            for (let i = 0; i < run.shop.stock.length; i++) {
                const it = run.shop.stock[i];
                if (!it.sold && run.gold >= it.price && (it.kind === 'relic' || it.kind === 'potion')) {
                    if (shopBuy(run, i).ok) { bought = true; break; }
                }
            }
            if (!bought || run.gold < 25) shopLeave(run);
        } else if (s === 'forge') {
            const any = run.abilities.active[0] || run.abilities.passive[0];
            if (any) forgeChoose(run, any.id);
            else { run.forge = null; run.screen = 'map'; advanceFloor(run); }
        } else if (s === 'library') {
            if (run.library.options.length) {
                const r = libraryChoose(run, run.library.options[0].id);
                if (run.swap) {
                    const list = run.swap.type === 'active' ? run.abilities.active : run.abilities.passive;
                    if (list.length) swapAbility(run, pick(run, list).id);
                    else { swapCancel(run); run.library = null; run.screen = 'map'; advanceFloor(run); }
                } else if (r.error) { addGold(run, 25); run.library = null; run.screen = 'map'; advanceFloor(run); }
            } else { run.library = null; run.screen = 'map'; advanceFloor(run); }
        } else if (s === 'altar') {
            altarAction(run, run.hp > 60 ? 'blood' : 'curse');
        } else if (s === 'casino') {
            casinoBet(run, Math.min(20, run.gold));
            casinoLeave(run);
        } else {
            // неизвестный экран — не застреваем
            run.screen = 'map';
            advanceFloor(run);
        }
    }
    if (!run.finished) finishRun(run, false);
    return run;
}

// ===========================================================================
//  SOCKET-СЛОЙ
// ===========================================================================
function configure(deps) {
    // Способности «Забега» теперь собственные и статичны — зависимость от
    // основной игры больше не нужна. Оставлено для совместимости вызова.
}

function attachRoguelike(io, deps) {
    configure(deps);

    const runs = Object.create(null); // socketId -> run

    function emitState(socket, run, extra) {
        socket.emit('rlState', Object.assign({ view: view(run) }, extra || {}));
    }

    io.on('connection', (socket) => {
        socket.on('rlStart', (opts) => {
            try {
                const run = createRun(opts || {});
                runs[socket.id] = run;
                emitState(socket, run, { started: true });
            } catch (e) { console.error('rlStart error', e); socket.emit('rlError', 'Ошибка старта забега'); }
        });

        socket.on('rlList', () => {
            socket.emit('rlContent', listContent());
        });

        socket.on('rlEnterNode', ({ floorIndex, nodeIndex }) => {
            const run = runs[socket.id];
            if (!run) return socket.emit('rlError', 'Забег не найден');
            const r = enterNode(run, floorIndex, nodeIndex);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlSubmitBid', ({ bid }) => {
            const run = runs[socket.id];
            if (!run) return socket.emit('rlError', 'Забег не найден');
            const r = submitBid(run, bid);
            if (r.error) return socket.emit('rlError', r.error);
            socket.emit('rlRoundResult', r.roundResult);
            if (r.combatEnd) socket.emit('rlCombatEnd', r.combatEnd);
            emitState(socket, run);
        });

        socket.on('rlActivate', ({ abilityId }) => {
            const run = runs[socket.id];
            if (!run) return socket.emit('rlError', 'Забег не найден');
            const r = activateAbility(run, abilityId);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlUsePotion', ({ potionId }) => {
            const run = runs[socket.id];
            if (!run) return socket.emit('rlError', 'Забег не найден');
            const r = usePotion(run, potionId);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlChooseReward', ({ index }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = chooseReward(run, index);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlLibraryChoose', ({ abilityId }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = libraryChoose(run, abilityId);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlSwapConfirm', ({ oldId }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = swapAbility(run, oldId);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlSwapCancel', () => {
            const run = runs[socket.id];
            if (!run) return;
            swapCancel(run);
            emitState(socket, run);
        });

        socket.on('rlLibraryLeave', () => {
            const run = runs[socket.id];
            if (!run) return;
            const r = libraryLeave(run);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlForgeChoose', ({ abilityId }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = forgeChoose(run, abilityId);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlForgeLeave', () => {
            const run = runs[socket.id];
            if (!run) return;
            const r = forgeLeave(run);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlRest', ({ action }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = restAction(run, action);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlEventChoice', ({ index }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = eventChoice(run, index);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlEventContinue', () => {
            const run = runs[socket.id];
            if (!run) return;
            const r = eventContinue(run);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlShopBuy', ({ index }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = shopBuy(run, index);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlShopLeave', () => {
            const run = runs[socket.id];
            if (!run) return;
            const r = shopLeave(run);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlTreasureTake', () => {
            const run = runs[socket.id];
            if (!run) return;
            const r = treasureTake(run);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlAltar', ({ action }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = altarAction(run, action);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlCasinoBet', ({ amount }) => {
            const run = runs[socket.id];
            if (!run) return;
            const r = casinoBet(run, amount);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlCasinoLeave', () => {
            const run = runs[socket.id];
            if (!run) return;
            const r = casinoLeave(run);
            if (r.error) return socket.emit('rlError', r.error);
            emitState(socket, run);
        });

        socket.on('rlAbandon', () => {
            delete runs[socket.id];
            socket.emit('rlAbandoned');
        });

        socket.on('disconnect', () => { delete runs[socket.id]; });
    });

    return { runs };
}

module.exports = {
    attachRoguelike,
    configure,
    listContent,
    createRun,
    generateMap,
    mods,
    enterNode,
    startCombat,
    submitBid,
    activateAbility,
    usePotion,
    chooseReward,
    libraryChoose,
    libraryLeave,
    addAbility,
    acquireRelic,
    addPotion,
    forgeChoose,
    forgeLeave,
    restAction,
    treasureTake,
    eventChoice,
    eventContinue,
    shopBuy,
    shopLeave,
    altarAction,
    casinoBet,
    casinoLeave,
    swapAbility,
    swapCancel,
    simulateRun,
    autoPlayerBid,
    view,
    HEROES, RELICS, CURSES, POTIONS, EVENTS, ENEMIES, BOSSES, NODE_META, ACTS,
    ACTIVES, PASSIVES, MAX_RELICS, MAX_ACTIVE, MAX_PASSIVE, MAX_POTIONS
};
