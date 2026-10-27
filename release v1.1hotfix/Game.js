// Gridline War - v1.0.0
// v3.6 规则对齐 + 主干修复 + P0 修复 + 原生 WebRTC 联机
const canvas = document.getElementById('gameCanvas'), ctx = canvas.getContext('2d');
const miniMap = document.getElementById('miniMapCanvas'), miniCtx = miniMap.getContext('2d');
const Type = {EMPTY: 0, BASE: 1, TRUNK: 2, SOLDIER: 3, CORPSE: 4, TUMOR: 5};
const Variant = {NORMAL: 0, DEVOURER: 1, VIRUS: 2, CRYSTAL: 3, GENE: 4, BOMB: 5, BAN: 6};
const Player = {NONE: 0, P1: 1, P2: 2};

let COLS = 40, ROWS = 30, CELL_SIZE = 28, grid = [], currentPlayer = 1,
    isGameOver = false, isPlacingPhase = false, selectedCell = null, currentAction = null,
    trunkPath = [], ruleMode = 'CLASSIC', aiLevel = 'PVP',
    p1Cooldown = false, p2Cooldown = false, hoverCell = {r: -1, c: -1},
    turnCount = 0, turnLimit = 0;

const LIMITED_VARIANTS = new Set([Variant.DEVOURER, Variant.VIRUS, Variant.GENE, Variant.CRYSTAL, Variant.BOMB]);
let createdVariantBranches = {1: new Set(), 2: new Set()};
let crystalExtraSource = null;

let isNetMode = false;
let myRole = null;

// 原生 WebRTC 网络对象
let ws = null;
let pc = null;
let dc = null;
let currentRoomId = null;
let pendingCandidates = []; // ★ 修复：缓存过早到达的 ICE Candidate

let isSyncing = false;
let netSeq = 0;

// 记录结算信息，用于联机同步
let gameOverTitle = "";
let gameOverReason = "";

// ★ 强化的 ICE 配置，应对严苛网络
function getRtcConfig() {
    return {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.miwifi.com' },
            { urls: 'stun:stun.qq.com' },
            {
                urls: [
                    'turn:openrelay.metered.ca:80',
                    'turn:openrelay.metered.ca:443',
                    'turn:openrelay.metered.ca:443?transport=tcp'
                ],
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ],
        iceTransportPolicy: 'all'
    };
}

function isVariantBranchCreation(src, variant) {
    return (src.type === Type.TRUNK || src.type === Type.BASE) && LIMITED_VARIANTS.has(variant);
}
function variantName(v) {
    return ({
        [Variant.DEVOURER]: '噬体',
        [Variant.VIRUS]: '病毒',
        [Variant.GENE]: '基因',
        [Variant.CRYSTAL]: '晶体',
        [Variant.BOMB]: '炸弹',
        [Variant.BAN]: '禁'
    })[v] || '变异体';
}

const $ = id => document.getElementById(id), btnTrunk = $('btn-grow-trunk'), btnSoldier = $('btn-grow-soldier'),
    btnAttack = $('btn-attack'), btnDisable = $('btn-disable'), btnGrowTumor = $('btn-grow-tumor'),
    btnPass = $('btn-pass'), variantPanel = $('variant-panel'), variantSelect = $('variant-select');

function setButtonEnabled(b, on) { if (!b) return; b.disabled = !on; b.classList.toggle('disabled', !on) }

function writeLog(m, t = 'sys') {
    const b = $('log-box'); if (!b) return;
    const d = document.createElement('div');
    d.className = `log-${t}`;
    const time = new Date().toLocaleTimeString('en-US', {hour12: false});
    d.textContent = `[${time}] ${m}`;
    b.appendChild(d); b.scrollTop = b.scrollHeight;
}

function showMsg(m, e = false) {
    const x = $('hint-msg'); if (!x) return;
    x.textContent = m; x.style.color = e ? '#e74c3c' : '#f1c40f';
    clearTimeout(x._t); x._t = setTimeout(() => x.textContent = '', 1800)
}

function cell(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS ? grid[r][c] : null }

function initGrid() {
    grid = Array.from({length: ROWS}, (_, r) => Array.from({length: COLS}, (_, c) => ({
        row: r, col: c, owner: 0, type: 0, variant: 0, parent: null, children: [], crystalUsed: 0, disabledRounds: 0
    })))
}

function adjacent(a, b) { return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col)) === 1 }
function orth(a, b) { return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1 }
function isHead(x) { return x.type === Type.BASE || x.type === Type.TRUNK || (x.type === Type.SOLDIER && x.children.filter(y => y.type === Type.SOLDIER).length === 0) }

function banAt(r, c, p, targetGrid = grid) {
    let hasMyBan = false, hasEnemyBan = false;
    for (const row of targetGrid) for (const x of row) {
        if (x.type === Type.SOLDIER && x.variant === Variant.BAN && Math.abs(r - x.row) + Math.abs(c - x.col) <= 2) {
            if (x.owner === p) hasMyBan = true; else hasEnemyBan = true;
        }
    }
    if (hasEnemyBan) return true;
    return false;
}

function hasBan(p, targetGrid = grid) {
    return targetGrid.some(row => row.some(x => x.owner === p && x.type === Type.SOLDIER && x.variant === Variant.BAN));
}

function hasVariantInGrid(g, p, v) {
    for (const row of g) for (const x of row) {
        if (x.owner === p && x.type === Type.SOLDIER && x.variant === v) return true;
    }
    return false;
}
function hasVariantOnField(p, v) { return hasVariantInGrid(grid, p, v); }

function detach(x) { if (x.parent) x.parent.children = x.parent.children.filter(y => y !== x) }

function subtree(root) {
    const out = [], s = [root], seen = new Set();
    while (s.length) {
        const x = s.pop(); if (seen.has(x)) continue;
        seen.add(x); out.push(x);
        for (const y of x.children || []) s.push(y)
    }
    return out
}

// ★ P0-3：连锁死亡统一清理 parent/children
function corpseSubtree(root) {
    const nodes = subtree(root);
    writeLog(`[连锁死亡] 起点 (${root.row},${root.col}) 开始塌陷，波及 ${nodes.length} 个单位！`, 'combat');
    detach(root);
    for (const x of nodes) {
        x.parent = null;
        x.children = [];
        if (x.type === Type.TUMOR) {
            // 肿瘤不转尸体，但已断开连接
        } else {
            x.type = Type.CORPSE;
        }
    }
    checkGameOver()
}

// ★ P0-3：吞噬也统一清理 parent/children
function eraseSubtree(root) {
    const nodes = subtree(root);
    writeLog(`[吞噬] 起点 (${root.row},${root.col}) 被彻底抹除，清除 ${nodes.length} 个单位！`, 'combat');
    detach(root);
    for (const x of nodes) {
        x.parent = null;
        x.children = [];
        if (x.type === Type.TUMOR) {
            continue;
        }
        x.type = 0; x.owner = 0; x.variant = 0;
        x.crystalUsed = 0; x.disabledRounds = 0;
    }
}

// ★ P0-3：爆炸时先断开子节点父引用，并清理范围内肿瘤的悬空父引用
function explode(b) {
    writeLog(`[爆炸] 炸弹在 (${b.row},${b.col}) 引爆！引发 5x5 范围毁灭！`, 'combat');
    for (let r = Math.max(0, b.row - 2); r <= Math.min(ROWS - 1, b.row + 2); r++) for (let c = Math.max(0, b.col - 2); c <= Math.min(COLS - 1, b.col + 2); c++) {
        if (Math.abs(r - b.row) + Math.abs(c - b.col) > 2) continue;
        const x = grid[r][c];
        if (x.type !== Type.EMPTY && x.type !== Type.TUMOR) {
            for (const ch of x.children) { if (ch !== x) ch.parent = null; }
            detach(x);
            x.type = 0; x.owner = 0; x.parent = null; x.children = [];
        }
    }
    for (let r = Math.max(0, b.row - 2); r <= Math.min(ROWS - 1, b.row + 2); r++) for (let c = Math.max(0, b.col - 2); c <= Math.min(COLS - 1, b.col + 2); c++) {
        if (Math.abs(r - b.row) + Math.abs(c - b.col) > 2) continue;
        const x = grid[r][c];
        if (x.type === Type.TUMOR && x.parent && x.parent.type === Type.EMPTY) x.parent = null;
    }
    checkGameOver()
}

function checkSqueeze() {
    const dead = [];
    for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) {
        const x = grid[r][c];
        if ([Type.EMPTY, Type.CORPSE, Type.TUMOR].includes(x.type)) continue;
        if (x.type === Type.SOLDIER && x.variant === Variant.DEVOURER) continue;
        if ([[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].every(([a, b]) => grid[a][b].type !== Type.EMPTY)) dead.push(x)
    }
    if (dead.length > 0) writeLog(`[挤压判定] 发现 ${dead.length} 个被围死的单位！`, 'rule');

    const roots = dead.filter(x => !dead.some(y => y !== x && subtree(y).includes(x)));
    for (const x of roots) {
        const nodes = subtree(x),
            head = [...nodes].reverse().find(y => y.type === Type.SOLDIER && y.variant === Variant.BOMB);
        corpseSubtree(x);
        if (head) explode(head)
    }
}

function findBase(p, targetGrid = grid) {
    for (const row of targetGrid) for (const x of row) if (x.owner === p && x.type === Type.BASE) return x;
    return null
}

function getMinDistToBase(owner, enemyBase, targetGrid) {
    let minDist = Infinity;
    for (const row of targetGrid) for (const x of row) {
        if (x.owner === owner && x.type !== Type.EMPTY && x.type !== Type.CORPSE) {
            const d = Math.hypot(x.row - enemyBase.row, x.col - enemyBase.col);
            if (d < minDist) minDist = d;
        }
    }
    return minDist;
}

function moveLogToModal() {
    const logBox = $('log-box');
    const modal = document.querySelector('#game-over-screen .modal');
    if (logBox && modal && !modal.contains(logBox)) {
        const title = document.createElement('h3');
        title.textContent = '系统控制台日志';
        title.style.marginTop = '15px';
        title.style.fontSize = '14px';
        title.style.color = '#aaa';
        title.style.textAlign = 'center';
        modal.appendChild(title);

        logBox.style.marginTop = '5px';
        logBox.style.height = '200px';
        logBox.style.width = '100%';
        logBox.style.textAlign = 'left';
        modal.appendChild(logBox);
    }
}

function triggerGameOverScreen(title, reason) {
    gameOverTitle = title;
    gameOverReason = reason;
    const wTitle = $('winner-title'), wReason = $('winner-reason');
    if (wTitle && wReason) {
        setTimeout(() => {
            $('game-over-screen').style.display = 'flex';
            wTitle.textContent = title;
            wReason.textContent = reason;
            moveLogToModal();
        }, 1000);
    }
}

function checkGameOver() {
    if (isGameOver) return true;
    const a = findBase(1), b = findBase(2);
    if (a && b) return false;

    isGameOver = true;
    const title = !a && !b ? '平局！' : !a ? '橘色 P2 获胜！' : '蓝色 P1 获胜！';
    writeLog(`[游戏结束] ${title} - 母体被消灭`, 'success');
    triggerGameOverScreen(title, '母体被消灭');
    return true;
}

function netSync() {
    if (isNetMode && dc && dc.readyState === 'open' && !isSyncing) {
        netSeq++;
        dc.send(JSON.stringify({ type: 'action', data: serializeState() }));
    }
}

function finish(action) {
    if (isGameOver) {
        netSync();
        crystalExtraSource = null;
        selectedCell = null; currentAction = null; trunkPath = [];
        return drawBoard();
    }

    crystalExtraSource = null;
    turnCount++;

    checkSqueeze();
    if (checkGameOver()) { netSync(); return drawBoard(); }

    if (turnLimit > 0 && turnCount >= turnLimit * 2 && currentPlayer === 2) {
        const base1 = findBase(1);
        const base2 = findBase(2);
        if (base1 && base2) {
            const dist1 = getMinDistToBase(1, base2, grid);
            const dist2 = getMinDistToBase(2, base1, grid);
            let winner = 0;
            let reason = "";

            if (dist1 < dist2) { winner = 1; reason = `回合数已满，P1 距离敌方母体更近 (${dist1.toFixed(1)} vs ${dist2.toFixed(1)})`; }
            else if (dist2 < dist1) { winner = 2; reason = `回合数已满，P2 距离敌方母体更近 (${dist2.toFixed(1)} vs ${dist1.toFixed(1)})`; }
            else { winner = 0; reason = `回合数已满，双方最近距离相同 (${dist1.toFixed(1)})，平局`; }

            isGameOver = true;
            const title = winner === 1 ? '蓝色 P1 获胜！' : winner === 2 ? '橘色 P2 获胜！' : '平局！';
            writeLog(`[游戏结束] ${title} - ${reason}`, 'success');
            triggerGameOverScreen(title, reason);
            netSync();
            return drawBoard();
        }
    }

    if (action === 'GROW_TRUNK') {
        if (currentPlayer === 1) p1Cooldown = true; else p2Cooldown = true;
        writeLog(`[P${currentPlayer}] 结束回合 (生长主干，进入冷却期)`, currentPlayer === 1 ? 'p1' : 'p2');
    } else {
        if (currentPlayer === 1) p1Cooldown = false; else p2Cooldown = false;
        if (action === 'PASS') {
            writeLog(`[P${currentPlayer}] 主动跳过回合`, currentPlayer === 1 ? 'p1' : 'p2');
        } else {
            writeLog(`[P${currentPlayer}] 结束回合 (执行了 ${action})`, currentPlayer === 1 ? 'p1' : 'p2');
        }
    }

    selectedCell = null; currentAction = null; trunkPath = [];
    currentPlayer = currentPlayer === 1 ? 2 : 1;

    for (const row of grid) for (const x of row) {
        if (x.owner === currentPlayer) {
            if (x.type === Type.SOLDIER && x.variant === Variant.CRYSTAL) x.crystalUsed = 0;
            if (x.disabledRounds > 0) x.disabledRounds--;
        }
    }

    updateUI();
    drawBoard();
    netSync();

    if (!isNetMode && aiLevel !== 'PVP' && currentPlayer === 2) {
        if (aiLevel === 'EASY') setTimeout(botTurnEasy, 250);
        else if (aiLevel === 'HARD') setTimeout(botTurnHard, 250);
        else if (aiLevel === 'MASTER') setTimeout(botTurnMaster, 250);
    }
}

function consumeCrystal(src) {
    if (isGameOver) return false;
    if (crystalExtraSource) return false;

    if (src && src.variant === Variant.CRYSTAL) {
        src.crystalUsed++;
        if (src.crystalUsed < 2) {
            let nextSource = src;
            if (!isHead(src)) {
                const child = src.children.find(y => y.type === Type.SOLDIER && isHead(y));
                if (child) nextSource = child;
            }
            selectedCell = nextSource;
            currentAction = null;
            crystalExtraSource = nextSource;
            writeLog(`[P${currentPlayer}] 晶体触发额外行动 (已用 ${src.crystalUsed}/2)`, currentPlayer === 1 ? 'p1' : 'p2');
            updateUI('晶体可再行动一次 (移动或攻击)');
            drawBoard();
            return true;
        }
    }
    return false;
}

function grow(target, parent, type, variant = 0) {
    if (target.type === Type.CORPSE) { detach(target); target.children = [] }

    target.type = type; target.owner = currentPlayer; target.variant = variant;
    target.parent = parent; target.children = []; parent.children.push(target);

    const varStr = type === Type.SOLDIER ? ` / ${['普通', '噬体', '病毒', '晶体', '基因', '炸弹', '禁'][variant]}` : '';
    const actionType = type === Type.TRUNK ? '生长主干' : (type === Type.SOLDIER ? '长出分支' : '分化肿瘤');
    writeLog(`[P${currentPlayer}] ${actionType} 位于 (${target.row},${target.col})，连接自 (${parent.row},${parent.col}) ${varStr}`, currentPlayer === 1 ? 'p1' : 'p2');
}

function actAt(t) {
    if (currentAction === 'GROW_TRUNK') {
        if (t.type !== Type.EMPTY || banAt(t.row, t.col, currentPlayer)) return showMsg('主干只能进入未封锁空格', true);
        const parents = [];
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const p = cell(t.row + dr, t.col + dc);
            if (p && p.owner === currentPlayer && (p.type === Type.BASE || p.type === Type.TRUNK)) parents.push(p);
        }
        if (!parents.length) return showMsg('目标格必须邻接任意己方母体或主干', true);

        if (!selectedCell || !parents.includes(selectedCell)) {
            return showMsg('请先选择与该目标格相邻的己方母体/主干作为生长起点', true);
        }
        const parent = selectedCell;

        grow(t, parent, Type.TRUNK); trunkPath.push(t);
        selectedCell = t;

        if (trunkPath.length === 3) finish('GROW_TRUNK'); else {
            updateUI(`主干 ${trunkPath.length}/3；继续点击选中格的相邻空格，或点击其他己方母体/主干切换起点`);
            drawBoard();
        }
        return
    }

    if (!selectedCell || !currentAction) return;
    const src = selectedCell;
    if (src.disabledRounds > 0) return showMsg('该分支仍被病毒禁用', true);

    if (currentAction === 'ATTACK') {
        if (src.type !== Type.SOLDIER || !isHead(src) || !orth(src, t) || t.type === Type.EMPTY || t === src) {
            return showMsg('攻击仅限头部上下左右一格', true);
        }
        // ★ P0-2：不能攻击己方活体单位（己方尸体仍可清理）
        if (t.owner === currentPlayer && t.type !== Type.CORPSE) {
            return showMsg('不能攻击己方活体单位', true);
        }
        if (t.type === Type.TUMOR) return showMsg('肿瘤无法被杀死', true);

        if (t.type === Type.CORPSE) {
            writeLog(`[P${currentPlayer}] 清理了 (${t.row},${t.col}) 的尸体`, currentPlayer === 1 ? 'p1' : 'p2');
            t.type = 0; t.owner = 0; t.parent = null; t.children = [];
        } else {
            writeLog(`[P${currentPlayer}] 发起攻击！目标 (${t.row},${t.col})`, currentPlayer === 1 ? 'p1' : 'p2');
            corpseSubtree(t);
        }
        if (!consumeCrystal(src)) finish('ATTACK'); else netSync();
        return
    }

    if (currentAction === 'GROW_SOLDIER') {
        // ★ P0-1：分支只能从主干生长或从已有分支头部延伸
        if (src.type !== Type.TRUNK && src.type !== Type.SOLDIER) {
            return showMsg('分支只能从主干生长或从已有分支头部延伸', true);
        }
        if (src.type === Type.SOLDIER && !isHead(src)) return showMsg('该分支已延伸，不能再分叉', true);

        const rawV = src.type === Type.SOLDIER ? src.variant : Number(variantSelect.value || 0);
        const v = ruleMode === 'ADVANCED' ? rawV : Variant.NORMAL;

        const creatingLimited = isVariantBranchCreation(src, v);
        if (creatingLimited && hasVariantOnField(currentPlayer, v)) {
            return showMsg(`${variantName(v)}同时只能存在一条`, true);
        }
        if (v === Variant.BAN && hasBan(currentPlayer)) return showMsg('己方场上只能存在一个“禁”', true);

        let jump = false;
        if (v === Variant.GENE) {
            const dr = t.row - src.row, dc = t.col - src.col;
            if ((Math.abs(dr) === 2 && dc === 0) || (Math.abs(dc) === 2 && dr === 0) || (Math.abs(dr) === 2 && Math.abs(dc) === 2)) {
                const m = cell(src.row + dr / 2, src.col + dc / 2);
                jump = !!m && m.type !== Type.EMPTY
            }
        }
        if (!jump && !adjacent(src, t)) return showMsg('必须移动一步；基因可越过一格障碍', true);
        if (banAt(t.row, t.col, currentPlayer)) return showMsg('目标处于“禁”领域，无法进入', true);

        // v3.6：基因跳跃落点必须是合法空格，不能落在尸体上
        if (jump && t.type !== Type.EMPTY) return showMsg('基因跳跃落点必须是空格', true);

        if (v === Variant.VIRUS && t.owner && t.owner !== currentPlayer && t.type !== Type.CORPSE) {
            if (t.type === Type.TUMOR) return showMsg('肿瘤无法被杀死', true);
            writeLog(`[P${currentPlayer}] 病毒覆盖了 (${t.row},${t.col}) 的敌人！`, currentPlayer === 1 ? 'p1' : 'p2');
            eraseSubtree(t);
            if (checkGameOver()) { netSync(); return; }
            grow(t, src, Type.SOLDIER, v)
        } else {
            if (t.type !== Type.EMPTY && !(t.type === Type.CORPSE && v === Variant.DEVOURER)) {
                return showMsg('目标不可进入', true);
            }
            grow(t, src, Type.SOLDIER, v)
        }

        if (creatingLimited) {
            createdVariantBranches[currentPlayer].add(v);
            writeLog(`[P${currentPlayer}] 创造了本局唯一的【${variantName(v)}】分支！`, 'rule');
        }

        let extraAction = false;
        if (src.type === Type.SOLDIER && src.variant === Variant.CRYSTAL) {
            extraAction = consumeCrystal(src);
        } else if (v === Variant.CRYSTAL) {
            extraAction = consumeCrystal(t);
        }

        if (!extraAction) finish('GROW_SOLDIER'); else netSync();
        return
    }

    if (currentAction === 'DISABLE') {
        if (src.variant !== Variant.VIRUS || !isHead(src) || t.owner === currentPlayer || t.type !== Type.SOLDIER ||
            Math.max(Math.abs(src.row - t.row), Math.abs(src.col - t.col)) > 1) {
            return showMsg('只能禁用病毒头部3×3内的敌方分支', true);
        }
        t.disabledRounds = 3;
        writeLog(`[P${currentPlayer}] 病毒释放禁用，目标 (${t.row},${t.col}) 将冻结2回合！`, currentPlayer === 1 ? 'p1' : 'p2');
        finish('DISABLE');
        return
    }

    if (currentAction === 'TUMOR') {
        if (src.variant !== Variant.GENE || !isHead(src)) return showMsg('基因只能在相邻空格分化肿瘤', true);

        // v3.6：在已有基因上变化成肿瘤（初步实现：基因头部自身变肿瘤）
        if (t === src) {
            src.type = Type.TUMOR;
            writeLog(`[P${currentPlayer}] 基因 (${src.row},${src.col}) 变异为肿瘤！`, currentPlayer === 1 ? 'p1' : 'p2');
            finish('TUMOR');
            return;
        }

        if (t.type !== Type.EMPTY || !adjacent(src, t) || banAt(t.row, t.col, currentPlayer)) {
            return showMsg('基因只能在相邻空格分化肿瘤', true);
        }
        grow(t, src, Type.TUMOR, Variant.GENE);
        writeLog(`[P${currentPlayer}] 基因分化了不可摧毁的肿瘤！`, currentPlayer === 1 ? 'p1' : 'p2');
        finish('TUMOR')
    }
}

canvas.addEventListener('pointerdown', e => {
    if (isGameOver) return;
    if (isNetMode) {
        if (!myRole) return;
        if (myRole === 'host' && currentPlayer !== 1) return;
        if (myRole === 'guest' && currentPlayer !== 2) return;
    } else if (aiLevel !== 'PVP' && currentPlayer === 2) return;

    const rct = canvas.getBoundingClientRect(),
        c = Math.floor((e.clientX - rct.left) * canvas.width / rct.width / CELL_SIZE),
        r = Math.floor((e.clientY - rct.top) * canvas.height / rct.height / CELL_SIZE), t = cell(r, c);
    if (!t) return;

    if (isPlacingPhase) {
        if (t.type !== 0 || (currentPlayer === 1 ? c >= COLS / 2 : c < COLS / 2)) return showMsg('请在己方半场空格放置母体', true);
        t.type = Type.BASE; t.owner = currentPlayer;
        writeLog(`[P${currentPlayer}] 在 (${r},${c}) 放置了母体！`, currentPlayer === 1 ? 'p1' : 'p2');

        if (currentPlayer === 1) {
            currentPlayer = 2;
            if (!isNetMode && aiLevel !== 'PVP') {
                placeBotBase(); isPlacingPhase = false; currentPlayer = 1;
                writeLog(`[系统] 机器人已部署完毕，游戏开始！`, 'sys');
            }
        } else {
            isPlacingPhase = false; currentPlayer = 1;
            writeLog(`[系统] 双方部署完毕，游戏开始！`, 'sys');
        }
        updateUI(); drawBoard(); netSync(); return
    }

    if (crystalExtraSource) {
        if ((t === crystalExtraSource || t.parent === crystalExtraSource) && isHead(t) && t.type !== Type.CORPSE) {
            selectedCell = t; updateUI(); drawBoard(); return;
        }
        if (t.type === Type.EMPTY) {
            currentAction = 'GROW_SOLDIER';
        } else {
            currentAction = 'ATTACK';
        }
        actAt(t);
        return;
    }

    if (currentAction) {
        // v3.6：分化肿瘤动作下，点击基因头部自身可触发“基因变肿瘤”
        if (currentAction === 'TUMOR' && t === selectedCell) {
            actAt(t);
            return;
        }
        // 主干生长中，点击己方母体/主干 = 切换生长起点
        if (currentAction === 'GROW_TRUNK' && t.owner === currentPlayer && (t.type === Type.BASE || t.type === Type.TRUNK)) {
            if (t !== selectedCell) {
                selectedCell = t;
                writeLog(`[P${currentPlayer}] 切换主干生长起点至 (${t.row},${t.col}) (已长 ${trunkPath.length}/3)`, currentPlayer === 1 ? 'p1' : 'p2');
                updateUI(`已切换生长起点至 (${t.row},${t.col})；点击相邻空格继续生长 (${trunkPath.length}/3)`);
                drawBoard();
            } else {
                showMsg(`已选中 (${t.row},${t.col})，点击相邻空格生长；点击其他己方主干/母体可切换起点`);
            }
            return;
        }
        if (t.owner === currentPlayer && isHead(t) && t.type !== Type.CORPSE && trunkPath.length === 0) {
            if (t === selectedCell) {
                currentAction = null;
                writeLog(`[P${currentPlayer}] 取消当前动作模式`, currentPlayer === 1 ? 'p1' : 'p2');
            } else {
                selectedCell = t;
                currentAction = null;
                writeLog(`[P${currentPlayer}] 重新选中了 (${t.row},${t.col})`, currentPlayer === 1 ? 'p1' : 'p2');
            }
            updateUI(); drawBoard();
            return;
        }
        actAt(t);
        return;
    }

    if (t.owner === currentPlayer && isHead(t) && t.type !== Type.CORPSE) {
        selectedCell = selectedCell === t ? null : t;
        if (selectedCell) {
            writeLog(`[P${currentPlayer}] 选中了 (${t.row},${t.col}) 的 ${['', '母体', '主干', '分支', '尸体', '肿瘤'][t.type]}`, currentPlayer === 1 ? 'p1' : 'p2');
        } else {
            writeLog(`[P${currentPlayer}] 取消选中`, currentPlayer === 1 ? 'p1' : 'p2');
        }
        updateUI(); drawBoard();
    }
});

canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (crystalExtraSource) return showMsg('晶体额外行动中，不能取消', true);

    // 主干生长中右键 = 结束本回合生长，避免绕过“生长互斥”
    if (currentAction === 'GROW_TRUNK' && trunkPath.length > 0) {
        return finish('GROW_TRUNK');
    }

    currentAction = null; selectedCell = null; trunkPath = [];
    updateUI(); drawBoard();
});

window.selectAction = a => {
    if (isGameOver) return;
    if (isNetMode) {
        if (myRole === 'host' && currentPlayer !== 1) return;
        if (myRole === 'guest' && currentPlayer !== 2) return;
    } else if (aiLevel !== 'PVP' && currentPlayer === 2) return;

    // 主干生长中，禁止切换动作或重置生长进度
    if (currentAction === 'GROW_TRUNK' && trunkPath.length > 0) {
        return showMsg(`主干生长中 (${trunkPath.length}/3)，可切换生长起点或点击"结束行动"`, true);
    }

    if (a === 'GROW_TRUNK') {
        const cool = currentPlayer === 1 ? p1Cooldown : p2Cooldown;
        if (cool) return showMsg('主干冷却中', true);
        if (!selectedCell || ![Type.BASE, Type.TRUNK].includes(selectedCell.type)) return showMsg('先选择母体或主干作为起点', true)
    }
    if (!selectedCell) return showMsg('请先选择棋子', true);
    if (a === 'GROW_SOLDIER' && selectedCell.type === Type.SOLDIER && !isHead(selectedCell)) return showMsg('该分支已延伸，不能再分叉', true);
    currentAction = a; trunkPath = [];
    writeLog(`[P${currentPlayer}] 切换至动作模式: ${a}`, currentPlayer === 1 ? 'p1' : 'p2');
    updateUI(); drawBoard();
};
btnTrunk.onclick = () => selectAction('GROW_TRUNK');
btnSoldier.onclick = () => selectAction('GROW_SOLDIER');
btnAttack.onclick = () => selectAction('ATTACK');
btnDisable.onclick = () => selectAction('DISABLE');
btnGrowTumor.onclick = () => selectAction('TUMOR');
btnPass.onclick = () => {
    if (isPlacingPhase || isGameOver) return;
    if (isNetMode) {
        if (myRole === 'host' && currentPlayer !== 1) return;
        if (myRole === 'guest' && currentPlayer !== 2) return;
    } else if (aiLevel !== 'PVP' && currentPlayer === 2) return;

    finish(trunkPath.length ? 'GROW_TRUNK' : 'PASS')
};

function updateUI(msg) {
    const playerEl = $('player-display');
    const turnEl = $('turn-display');
    if (playerEl) {
        let text = currentPlayer === 1 ? '蓝色 (P1)' : aiLevel === 'PVP' ? '橘色 (P2)' : '机器人';
        if (isNetMode) {
            text = currentPlayer === 1 ? '蓝色 (P1)' : '橘色 (P2)';
            if (myRole === 'host' && currentPlayer === 2) text += ' - 等待对方...';
            if (myRole === 'guest' && currentPlayer === 1) text += ' - 等待对方...';
        }
        playerEl.textContent = text;
        playerEl.className = currentPlayer === 1 ? 'p1-color' : 'p2-color';
    }
    if (turnEl) {
        if (turnLimit > 0) {
            let round = Math.floor(turnCount / 2) + 1;
            turnEl.textContent = `当前回合: ${round} / ${turnLimit} (已行动 ${turnCount} 步)`;
        } else {
            turnEl.textContent = `当前回合: 无限制`;
        }
    }

    [btnTrunk, btnSoldier, btnAttack, btnDisable, btnGrowTumor, btnPass].forEach(b => setButtonEnabled(b, false));
    if (isPlacingPhase) {
        const hintEl = $('hint-text'); if (hintEl) hintEl.textContent = `布阵：P${currentPlayer} 放置母体`;
        return
    }
    if (isGameOver) return;

    let isMyTurn = true;
    if (isNetMode) {
        if (myRole === 'host' && currentPlayer !== 1) isMyTurn = false;
        if (myRole === 'guest' && currentPlayer !== 2) isMyTurn = false;
    } else if (aiLevel !== 'PVP' && currentPlayer === 2) {
        isMyTurn = false;
    }

    if (isMyTurn) setButtonEnabled(btnPass, true);
    if (selectedCell) {
        const cool = currentPlayer === 1 ? p1Cooldown : p2Cooldown;
        // 主干生长中，两种生长按钮都禁用，只保留“结束行动”
        const growingTrunk = currentAction === 'GROW_TRUNK' && trunkPath.length > 0;

        setButtonEnabled(btnTrunk, !growingTrunk && [Type.BASE, Type.TRUNK].includes(selectedCell.type) && !cool && isMyTurn);
        setButtonEnabled(btnSoldier, !growingTrunk && (selectedCell.type === Type.TRUNK || selectedCell.type === Type.SOLDIER) && isHead(selectedCell) && isMyTurn);
        setButtonEnabled(btnAttack, selectedCell.type === Type.SOLDIER && isMyTurn);
        setButtonEnabled(btnDisable, ruleMode === 'ADVANCED' && selectedCell.variant === Variant.VIRUS && isMyTurn);
        setButtonEnabled(btnGrowTumor, ruleMode === 'ADVANCED' && selectedCell.variant === Variant.GENE && isMyTurn)
    }
    const hintEl = $('hint-text');
    if (hintEl) {
        if (msg) hintEl.textContent = msg;
        else if (currentAction === 'GROW_TRUNK' && trunkPath.length > 0) {
            hintEl.textContent = `主干生长中 (${trunkPath.length}/3)：点击选中格相邻空格继续，或点击其他己方主干/母体切换起点`;
        } else if (selectedCell) {
            hintEl.textContent = '选择动作';
        } else {
            hintEl.textContent = '请选择己方有效节点';
        }
    }
}

function drawShape(x, y, s, color, type, v) {
    ctx.fillStyle = color; ctx.strokeStyle = color;
    if (type === Type.BASE) {
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
            const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
            i ? ctx.lineTo(x + Math.cos(a) * s * .4, y + Math.sin(a) * s * .4) : ctx.moveTo(x + Math.cos(a) * s * .4, y + Math.sin(a) * s * .4)
        }
        ctx.closePath(); ctx.fill()
    } else if (type === Type.TRUNK) ctx.fillRect(x - s * .3, y - s * .3, s * .6, s * .6);
    else if (type === Type.CORPSE) {
        ctx.lineWidth = 3; ctx.beginPath();
        ctx.moveTo(x - s * .3, y - s * .3); ctx.lineTo(x + s * .3, y + s * .3);
        ctx.moveTo(x + s * .3, y - s * .3); ctx.lineTo(x - s * .3, y + s * .3); ctx.stroke()
    } else if (type === Type.TUMOR) {
        ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, s * .35, 0, 7); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - s * .22, y - s * .22); ctx.lineTo(x + s * .22, y + s * .22);
        ctx.moveTo(x + s * .22, y - s * .22); ctx.lineTo(x - s * .22, y + s * .22); ctx.stroke()
    } else {
        ctx.beginPath(); ctx.arc(x, y, s * .3, 0, 7);
        ctx.fill();
        if (v > 0) {
            ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(9, s * .35)}px sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(['', '噬', '毒', '晶', '基', '弹', '禁'][v], x, y)
        }
    }
}

function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1;
    for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CELL_SIZE, 0); ctx.lineTo(c * CELL_SIZE, canvas.height); ctx.stroke() }
    for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL_SIZE); ctx.lineTo(canvas.width, r * CELL_SIZE); ctx.stroke() }

    ctx.save();
    for (const row of grid) for (const x of row) {
        if (x.type === Type.SOLDIER && x.variant === Variant.BAN) {
            const banColor = x.owner === 1 ? 'rgba(231, 76, 60, 0.1)' : 'rgba(230, 126, 34, 0.1)';
            const borderColor = x.owner === 1 ? 'rgba(231, 76, 60, 0.4)' : 'rgba(230, 126, 34, 0.4)';

            ctx.fillStyle = banColor;
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);

            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    if (Math.abs(dr) + Math.abs(dc) > 2) continue;
                    const tr = x.row + dr;
                    const tc = x.col + dc;
                    if (tr >= 0 && tr < ROWS && tc >= 0 && tc < COLS) {
                        ctx.fillRect(tc * CELL_SIZE, tr * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                        ctx.strokeRect(tc * CELL_SIZE, tr * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                    }
                }
            }
        }
    }
    ctx.restore();

    for (const row of grid) for (const x of row) {
        if (x.type === 0) continue;
        const X = (x.col + .5) * CELL_SIZE, Y = (x.row + .5) * CELL_SIZE, color = x.owner === 1 ? '#3498db' : '#e67e22';
        // ★ P0-3：parent 指向空格时不画线
        if (x.parent && x.type !== Type.CORPSE && x.parent.type !== Type.CORPSE && x.parent.type !== Type.EMPTY) {
            ctx.strokeStyle = color; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo((x.parent.col + .5) * CELL_SIZE, (x.parent.row + .5) * CELL_SIZE);
            ctx.lineTo(X, Y); ctx.stroke()
        }
        drawShape(X, Y, CELL_SIZE, color, x.type, x.variant);
        if (x.disabledRounds) {
            ctx.strokeStyle = '#9b59b6';
            ctx.strokeRect(x.col * CELL_SIZE + 2, x.row * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4)
        }
    }
    if (selectedCell) {
        ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 3;
        ctx.strokeRect(selectedCell.col * CELL_SIZE + 2, selectedCell.row * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4)
    }
    drawMiniMap()
}

function drawMiniMap() {
    miniCtx.fillStyle = '#111'; miniCtx.fillRect(0, 0, miniMap.width, miniMap.height);
    for (const row of grid) for (const x of row) if (x.type !== 0) {
        miniCtx.fillStyle = x.owner === 1 ? '#3498db' : '#e67e22';
        miniCtx.fillRect(x.col * miniMap.width / COLS, x.row * miniMap.height / ROWS, Math.max(1, miniMap.width / COLS), Math.max(1, miniMap.height / ROWS))
    }
}

function placeBotBase() {
    while (1) {
        const r = Math.floor(Math.random() * ROWS), c = Math.floor(COLS / 2 + Math.random() * COLS / 2);
        if (grid[r][c].type === 0) {
            grid[r][c].type = Type.BASE; grid[r][c].owner = 2;
            writeLog(`[机器人] 在 (${r},${c}) 放置了母体`, 'bot'); break
        }
    }
}

/* ===================== 原生 WebRTC 联机模块 ===================== */

window.togglePeerPanel = () => {
    const isPeer = $('ai-select').value === 'PEER';
    $('peer-panel').style.display = isPeer ? 'block' : 'none';
    $('game-start-buttons').style.display = isPeer ? 'none' : 'block';
};

function serializeState() {
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const x = grid[r][c];
            if (x.type !== Type.EMPTY) {
                cells.push({
                    r, c, o: x.owner, t: x.type, v: x.variant, cu: x.crystalUsed, dr: x.disabledRounds,
                    pr: x.parent ? x.parent.row : -1, pc: x.parent ? x.parent.col : -1
                });
            }
        }
    }
    return {
        g: cells, cp: currentPlayer, c1: p1Cooldown, c2: p2Cooldown,
        ip: isPlacingPhase, ig: isGameOver, tc: turnCount, tl: turnLimit,
        sc: selectedCell ? {r: selectedCell.row, c: selectedCell.col} : null,
        ca: currentAction, tp: trunkPath.map(t => ({r: t.row, c: t.col})),
        seq: netSeq, rm: ruleMode,
        cv: { 1: [...createdVariantBranches[1]], 2: [...createdVariantBranches[2]] },
        ces: crystalExtraSource ? {r: crystalExtraSource.row, c: crystalExtraSource.col} : null,
        gt: gameOverTitle, gr: gameOverReason
    };
}

function deserializeState(state) {
    initGrid();
    currentPlayer = state.cp; p1Cooldown = state.c1; p2Cooldown = state.c2;
    isPlacingPhase = state.ip; isGameOver = state.ig; turnCount = state.tc || 0; turnLimit = state.tl || 0;
    currentAction = state.ca;

    netSeq = state.seq || 0;
    ruleMode = state.rm || ruleMode;
    createdVariantBranches = {
        1: new Set(state.cv ? state.cv[1] : []),
        2: new Set(state.cv ? state.cv[2] : [])
    };
    gameOverTitle = state.gt || "";
    gameOverReason = state.gr || "";

    for (const s of state.g) {
        const x = grid[s.r][s.c];
        x.owner = s.o; x.type = s.t; x.variant = s.v; x.crystalUsed = s.cu; x.disabledRounds = s.dr;
    }
    for (const s of state.g) {
        if (s.pr !== -1) {
            const x = grid[s.r][s.c];
            const p = grid[s.pr][s.pc];
            x.parent = p;
            p.children.push(x);
        }
    }
    selectedCell = state.sc ? grid[state.sc.r][state.sc.c] : null;
    trunkPath = state.tp.map(t => grid[t.r][t.c]);
    crystalExtraSource = state.ces ? grid[state.ces.r][state.ces.c] : null;
}

// 1. 初始化并连接信令服务器
function initSignaling(roomId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let host = window.location.host;

    // 智能判断：如果是本地 file:// 协议，或者 Live Server 测试环境，默认去连本地的 8000 端口
    if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        host = 'localhost:8000';
    }

    const wsUrl = `${protocol}//${host}/?room=${roomId}`;

    $('net-status').innerText = `正在连接信令服务器 (${wsUrl})...`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        $('net-status').innerText = `已进入房间 ${roomId}，等待对方加入...`;
        // 心跳保活
        ws._pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 15000);
    };

    ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        handleSignalMessage(msg);
    };

    ws.onclose = () => {
        clearInterval(ws._pingInterval);
        if (!dc || dc.readyState !== 'open') {
            $('net-status').innerText = `信令服务器连接断开，请检查 Deno 是否启动`;
        }
    };

    ws.onerror = () => {
        $('net-status').innerText = `信令服务器连接失败，请检查网络`;
    };
}

// 2. 创建 WebRTC 连接
function createPeerConnection() {
    const peerConn = new RTCPeerConnection(getRtcConfig());

    peerConn.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal({ type: 'candidate', candidate: event.candidate });
        }
    };

    peerConn.onconnectionstatechange = () => {
        if (peerConn.connectionState === 'failed' || peerConn.connectionState === 'disconnected') {
            alert('P2P 连接已断开');
            location.reload();
        }
    };

    return peerConn;
}

// 3. 处理信令消息
async function handleSignalMessage(msg) {
    if (msg.type === 'error') {
        alert(msg.msg);
        location.reload();
        return;
    }

    if (msg.type === 'peer-disconnected') {
        alert('对方已断开连接');
        location.reload();
        return;
    }

    if (msg.type === 'ready') {
        if (myRole === 'host') {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({ type: 'offer', sdp: offer });
            $('net-status').innerText = `对方已加入，正在建立 P2P 连接...`;
        }
        return;
    }

    if (msg.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        // ★ 修复：设置 RemoteDescription 后，立刻添加之前缓存的 Candidate
        while (pendingCandidates.length > 0) {
            try { await pc.addIceCandidate(pendingCandidates.shift()); } catch (e) {}
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ type: 'answer', sdp: answer });
        return;
    }

    if (msg.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        while (pendingCandidates.length > 0) {
            try { await pc.addIceCandidate(pendingCandidates.shift()); } catch (e) {}
        }
        return;
    }

    if (msg.type === 'candidate') {
        const cand = new RTCIceCandidate(msg.candidate);
        // ★ 修复：如果还没有设置 RemoteDescription，先缓存起来
        if (pc.remoteDescription && pc.remoteDescription.type) {
            try { await pc.addIceCandidate(cand); } catch (e) {}
        } else {
            pendingCandidates.push(cand);
        }
        return;
    }

    // -------- 游戏内的数据同步 ----------------
    if (msg.type === 'config') {
        if (myRole === 'guest') {
            $('map-size').value = msg.data.mapSize;
            $('turn-limit').value = msg.data.turnLimit;
            startGameInternal(msg.data.mode);
        }
    } else if (msg.type === 'action') {
        if (msg.data.seq <= netSeq) return;

        isSyncing = true;
        netSeq = msg.data.seq;
        deserializeState(msg.data);
        drawBoard();
        updateUI();

        if (msg.data.ig && msg.data.gt) {
            triggerGameOverScreen(msg.data.gt, msg.data.gr);
        }

        isSyncing = false;
    }
}

function sendSignal(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// 4. UI 按钮绑定
window.createOnlineRoom = () => {
    isNetMode = true;
    myRole = 'host';
    currentRoomId = Math.random().toString(36).substring(2, 6).toUpperCase();

    $('net-status').innerText = `房间号: ${currentRoomId}，等待对方加入...`;

    pc = createPeerConnection();
    dc = pc.createDataChannel('game', { ordered: true });
    setupDataChannel();
    initSignaling(currentRoomId);
};

window.joinOnlineRoom = () => {
    const roomId = $('input-room-id').value.trim().toUpperCase();
    if (!roomId) return alert('请输入房间号');

    isNetMode = true;
    myRole = 'guest';
    currentRoomId = roomId;

    $('net-status').innerText = `正在加入房间 ${roomId}...`;

    pc = createPeerConnection();
    pc.ondatachannel = (event) => {
        dc = event.channel;
        setupDataChannel();
    };
    initSignaling(currentRoomId);
};

// 5. 配置 DataChannel
function setupDataChannel() {
    dc.onopen = () => {
        $('net-status').innerText = `P2P 连接成功！你是 ${myRole === 'host' ? '蓝色 P1' : '橘色 P2'}`;
        if (myRole === 'host') {
            $('game-start-buttons').style.display = 'block';
        }
    };

    dc.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            handleSignalMessage(msg);
        } catch (err) {}
    };

    dc.onclose = () => {
        alert('P2P 数据通道已断开');
        location.reload();
    };
}

window.startGame = mode => {
    if (isNetMode) {
        if (myRole === 'host') {
            const mapSize = $('map-size').value;
            const tLimit = $('turn-limit').value;
            dc.send(JSON.stringify({ type: 'config', data: { mode, mapSize, turnLimit: tLimit } }));
            startGameInternal(mode);
        }
    } else {
        startGameInternal(mode);
    }
};

/* ===================== 启动逻辑 ===================== */

function startGameInternal(mode) {
    ruleMode = mode;
    aiLevel = isNetMode ? 'PVP' : $('ai-select').value;
    turnLimit = parseInt($('turn-limit').value) || 0;
    if (ruleMode === 'CLASSIC') {
        variantSelect.value = '0';
    }

    COLS = Number($('map-size').value); ROWS = COLS === 40 ? 30 : COLS;
    CELL_SIZE = Math.floor(1120 / COLS); canvas.width = COLS * CELL_SIZE; canvas.height = ROWS * CELL_SIZE;
    miniMap.width = 200; miniMap.height = Math.floor(200 * ROWS / COLS);
    $('start-screen').style.display = 'none';
    variantPanel.style.display = mode === 'ADVANCED' ? 'block' : 'none';
    initGrid(); currentPlayer = 1; isGameOver = false; isPlacingPhase = true;
    selectedCell = null; currentAction = null; trunkPath = [];
    p1Cooldown = p2Cooldown = false; createdVariantBranches = {1: new Set(), 2: new Set()};
    crystalExtraSource = null; turnCount = 0;
    netSeq = 0; gameOverTitle = ""; gameOverReason = "";
    writeLog(`[系统] 游戏初始化完成。模式: ${mode}，地图: ${COLS}x${ROWS}${turnLimit > 0 ? '，限制回合: ' + turnLimit : ''}`, 'sys');
    updateUI(); drawBoard()
}

/* ===================== 高级 AI 推演引擎 ===================== */

function cloneGrid(srcGrid) {
    const newGrid = Array.from({length: ROWS}, (_, r) => Array.from({length: COLS}, (_, c) => ({
        row: r, col: c, owner: 0, type: 0, variant: 0, parent: null, children: [], crystalUsed: 0, disabledRounds: 0
    })));
    const nodeMap = new Map();
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const src = srcGrid[r][c];
        const dest = newGrid[r][c];
        dest.owner = src.owner; dest.type = src.type; dest.variant = src.variant;
        dest.crystalUsed = src.crystalUsed; dest.disabledRounds = src.disabledRounds;
        nodeMap.set(src, dest);
    }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const src = srcGrid[r][c];
        const dest = newGrid[r][c];
        if (src.parent) dest.parent = nodeMap.get(src.parent);
        dest.children = src.children.map(ch => nodeMap.get(ch));
    }
    return newGrid;
}

// ★ P0-3：与真实结算保持一致（统一清理父子引用）
function simulateSqueeze(sGrid) {
    const dead = [];
    for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) {
        const x = sGrid[r][c];
        if ([Type.EMPTY, Type.CORPSE, Type.TUMOR].includes(x.type)) continue;
        if (x.type === Type.SOLDIER && x.variant === Variant.DEVOURER) continue;
        if ([[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].every(([a, b]) => sGrid[a][b].type !== Type.EMPTY)) dead.push(x)
    }
    if (!dead.length) return;

    const roots = dead.filter(x => !dead.some(y => y !== x && subtree(y).includes(x)));
    for (const x of roots) {
        const nodes = subtree(x);
        const head = [...nodes].reverse().find(y => y.type === Type.SOLDIER && y.variant === Variant.BOMB);
        detach(x);
        for (const node of nodes) {
            node.parent = null;
            node.children = [];
            if (node.type === Type.TUMOR) {
                // 肿瘤不转尸体
            } else {
                node.type = Type.CORPSE;
            }
        }

        // 模拟炸弹被挤死后的爆炸
        if (head) {
            for (let r = Math.max(0, head.row - 2); r <= Math.min(ROWS - 1, head.row + 2); r++) {
                for (let c = Math.max(0, head.col - 2); c <= Math.min(COLS - 1, head.col + 2); c++) {
                    if (Math.abs(r - head.row) + Math.abs(c - head.col) > 2) continue;
                    const t = sGrid[r][c];
                    if (t.type !== Type.EMPTY && t.type !== Type.TUMOR) {
                        for (const ch of t.children) { if (ch !== t) ch.parent = null; }
                        if (t.parent) t.parent.children = t.parent.children.filter(y => y !== t);
                        t.type = 0; t.owner = 0; t.parent = null; t.children = [];
                    }
                }
            }
            for (let r = Math.max(0, head.row - 2); r <= Math.min(ROWS - 1, head.row + 2); r++) {
                for (let c = Math.max(0, head.col - 2); c <= Math.min(COLS - 1, head.col + 2); c++) {
                    if (Math.abs(r - head.row) + Math.abs(c - head.col) > 2) continue;
                    const t = sGrid[r][c];
                    if (t.type === Type.TUMOR && t.parent && t.parent.type === Type.EMPTY) t.parent = null;
                }
            }
        }
    }
}

function getSimulatedMoves(sGrid, p, isCooldown = false) {
    const moves = [];
    for (const row of sGrid) for (const x of row) {
        if (x.owner !== p || x.disabledRounds > 0) continue;

        if (x.type === Type.SOLDIER && isHead(x)) {
            for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const t = sGrid[x.row + dr]?.[x.col + dc];
                if (t && t.type !== Type.EMPTY && t.type !== Type.TUMOR) {
                    // ★ P0-2：不能攻击己方活体单位（尸体仍可清理）
                    if (t.owner === p && t.type !== Type.CORPSE) continue;
                    moves.push({ action: 'ATTACK', src: x, target: t, score: 0 });
                }
            }
        }

        if (x.type === Type.SOLDIER && isHead(x)) {
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                const t = sGrid[x.row + dr]?.[x.col + dc];
                // ★ 修复：加上 !banAt 限制，防止 AI 走入禁地
                if (t && t.type === Type.EMPTY && !banAt(t.row, t.col, p, sGrid)) {
                    moves.push({ action: 'MOVE', src: x, target: t, variant: x.variant, score: 0 });
                }
            }
            if (x.variant === Variant.GENE) {
                const jumps = [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [-2, 2], [2, -2], [2, 2]];
                for (const [dr, dc] of jumps) {
                    const t = sGrid[x.row + dr]?.[x.col + dc];
                    const mid = sGrid[x.row + dr / 2]?.[x.col + dc / 2];
                    // ★ 修复：加上 !banAt 限制，防止 AI 跳入禁地
                    if (t && t.type === Type.EMPTY && mid && mid.type !== Type.EMPTY && !banAt(t.row, t.col, p, sGrid)) {
                        moves.push({ action: 'MOVE', src: x, target: t, variant: x.variant, isJump: true, score: 0 });
                    }
                }
            }
        }

        if (x.type === Type.BASE || x.type === Type.TRUNK) {
            // ★ P0-1：分支只能从主干生长，母体不可直接长分支/变异体
            if (x.type === Type.TRUNK) {
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    if (!dr && !dc) continue;
                    const t = sGrid[x.row + dr]?.[x.col + dc];
                    if (t && t.type === Type.EMPTY && !banAt(t.row, t.col, p, sGrid)) {
                        if (ruleMode === 'CLASSIC') {
                            moves.push({ action: 'GROW_SOLDIER', src: x, target: t, variant: Variant.NORMAL, score: 0 });
                        } else {
                            moves.push({ action: 'GROW_SOLDIER', src: x, target: t, variant: Variant.NORMAL, score: 0 });
                            if (!hasVariantInGrid(sGrid, p, Variant.VIRUS)) moves.push({ action: 'GROW_SOLDIER', src: x, target: t, variant: Variant.VIRUS, score: 0 });
                            if (!hasVariantInGrid(sGrid, p, Variant.CRYSTAL)) moves.push({ action: 'GROW_SOLDIER', src: x, target: t, variant: Variant.CRYSTAL, score: 0 });
                            if (!hasVariantInGrid(sGrid, p, Variant.BOMB)) moves.push({ action: 'GROW_SOLDIER', src: x, target: t, variant: Variant.BOMB, score: 0 });
                            if (!hasVariantInGrid(sGrid, p, Variant.GENE)) moves.push({ action: 'GROW_SOLDIER', src: x, target: t, variant: Variant.GENE, score: 0 });
                            if (!hasBan(p, sGrid)) moves.push({ action: 'GROW_SOLDIER', src: x, target: t, variant: Variant.BAN, score: 0 });
                        }
                    }
                }
            }

            if (isCooldown) {
                // 冷却期
            } else {
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    if (!dr && !dc) continue;
                    const t = sGrid[x.row + dr]?.[x.col + dc];
                    if (t && t.type === Type.EMPTY && !banAt(t.row, t.col, p, sGrid)) {
                        moves.push({ action: 'GROW_TRUNK', src: x, target: t, step: 3, score: 0 });
                    }
                }
            }
        }
    }
    return moves;
}

function executeSimulatedMove(sGrid, move, p) {
    const { action, src, target } = move;
    if (action === 'ATTACK') {
        if (target.type === Type.CORPSE) {
            target.type = 0; target.owner = 0; target.parent = null; target.children = [];
        } else {
            if (src.variant === Variant.VIRUS && target.owner !== p) {
                const nodes = subtree(target);
                if (target.parent) target.parent.children = target.parent.children.filter(y => y !== target);
                for (const node of nodes) {
                    if (node.type === Type.TUMOR) { node.parent = null; continue; }
                    node.type = 0; node.owner = 0; node.parent = null; node.children = [];
                }
                target.type = Type.SOLDIER; target.owner = p; target.variant = Variant.VIRUS;
                target.parent = src; target.children = [];
                src.children.push(target);
            } else {
                const nodes = subtree(target);
                if (target.parent) target.parent.children = target.parent.children.filter(y => y !== target);
                for (const node of nodes) {
                    if (node.type === Type.TUMOR) { node.parent = null; continue; }
                    node.type = Type.CORPSE;
                }
                target.parent = null;
            }
        }
    } else if (action === 'MOVE' || action === 'GROW_SOLDIER') {
        const v = move.variant !== undefined ? move.variant : src.variant;

        if (v === Variant.VIRUS && target.owner && target.owner !== p) {
            const nodes = subtree(target);
            if (target.parent) target.parent.children = target.parent.children.filter(y => y !== target);
            for (const node of nodes) {
                if (node.type === Type.TUMOR) { node.parent = null; continue; }
                node.type = 0; node.owner = 0; node.parent = null; node.children = [];
            }
        }

        target.type = Type.SOLDIER; target.owner = p; target.variant = v;
        target.parent = src; target.children = [];
        src.children.push(target);
    } else if (action === 'GROW_TRUNK') {
        let curr = target;
        let prev = src;
        let count = 0;
        const enemy = p === Player.P1 ? Player.P2 : Player.P1;
        const enBase = findBase(enemy, sGrid);

        let maxStep = move.step || 3;

        while (count < maxStep) {
            curr.type = Type.TRUNK; curr.owner = p;
            curr.parent = prev; curr.children = [];
            prev.children.push(curr);
            count++;
            prev = curr;

            let bestDist = Infinity;
            let nextT = null;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                const t = sGrid[curr.row + dr]?.[curr.col + dc];
                if (t && t.type === Type.EMPTY && !banAt(t.row, t.col, p, sGrid)) {
                    const dist = enBase ? Math.hypot(t.row - enBase.row, t.col - enBase.col) : 0;
                    if (dist < bestDist) {
                        let parentBlocked = 0;
                        for (let ddr = -1; ddr <= 1; ddr++) for (let ddc = -1; ddc <= 1; ddc++) {
                            if (Math.abs(ddr) + Math.abs(ddc) !== 1) continue;
                            const nt = sGrid[curr.row + ddr]?.[curr.col + ddc];
                            if (nt && nt.type !== Type.EMPTY && nt !== t) parentBlocked++;
                        }
                        if (parentBlocked >= 3) continue;

                        bestDist = dist;
                        nextT = t;
                    }
                }
            }
            if (!nextT) break;
            curr = nextT;
        }
    }
    simulateSqueeze(sGrid);
}

function evaluateState(sGrid, p, p2CooldownState) {
    let score = 0;
    const enemy = p === Player.P1 ? Player.P2 : Player.P1;
    const myBase = findBase(p, sGrid), enBase = findBase(enemy, sGrid);

    if (!enBase && myBase) return 1000000;
    if (!myBase && enBase) return -1000000;

    let aggression = 1.5 + Math.min(3.0, turnCount / 10);
    if (turnLimit > 0 && turnCount >= (turnLimit * 2 - 4)) aggression += 5.0;

    let baseThreatened = false;
    if (myBase) {
        for (let r = myBase.row - 1; r <= myBase.row + 1; r++) {
            for (let c = myBase.col - 1; c <= myBase.col + 1; c++) {
                const t = sGrid[r]?.[c];
                if (t && t.owner === enemy && t.type !== Type.EMPTY && t.type !== Type.CORPSE) {
                    baseThreatened = true;
                }
            }
        }
    }

    let mustRush = false;
    if (turnLimit > 0 && myBase && enBase && !baseThreatened) {
        const remainingRounds = turnLimit - Math.floor(turnCount / 2);
        const myMinDist = getMinDistToBase(p, enBase, sGrid);
        const enemyMinDist = getMinDistToBase(enemy, myBase, sGrid);
        if (enemyMinDist < myMinDist || remainingRounds < 15) {
            mustRush = true;
        }
    }

    for (const row of sGrid) for (const x of row) {
        if (x.type === Type.EMPTY) continue;

        let val = 1;
        if (x.type === Type.TRUNK) val = 1.5;
        if (x.type === Type.SOLDIER && x.variant !== Variant.NORMAL) val = 4;
        if (x.type === Type.TUMOR) val = 2;
        if (x.type === Type.CORPSE) val = 0.1;

        let blockedSides = 0;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const t = sGrid[x.row + dr]?.[x.col + dc];
            if (!t || t.type !== Type.EMPTY) blockedSides++;
        }

        const isDevourer = (x.type === Type.SOLDIER && x.variant === Variant.DEVOURER);
        if (blockedSides === 4 && !isDevourer && x.type !== Type.CORPSE && x.type !== Type.TUMOR) {
            val = -10;
        } else if (blockedSides === 3 && x.type !== Type.TUMOR) {
            val -= 2;
        }

        if (x.owner === p) {
            score += val;

            if (x.type === Type.BASE) {
                if (blockedSides === 3) score -= 50000;
                if (blockedSides === 4) score -= 500000;

                let enemyNear = false;
                for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                    const t = sGrid[x.row + dr]?.[x.col + dc];
                    if (t && t.owner === enemy && (t.type === Type.SOLDIER || t.type === Type.TRUNK)) {
                        enemyNear = true;
                    }
                }
                if (enemyNear) score -= 500000;
            }

            if (enBase && x.type !== Type.CORPSE) {
                const distToEnemy = Math.hypot(x.row - enBase.row, x.col - enBase.col);
                if (mustRush) {
                    score += Math.max(0, (40 - distToEnemy)) * 20 * aggression;
                } else if (!baseThreatened) {
                    score += Math.max(0, (40 - distToEnemy)) * 0.5 * aggression;
                }
            }
        } else {
            score -= val * 15;

            if (blockedSides === 3) score += 2000;
            if (blockedSides === 4) score += 5000;

            if (x.type === Type.BASE) {
                if (blockedSides === 3) score += 50000;
                if (blockedSides === 4) score += 500000;
            }

            if (myBase) {
                const dist = Math.hypot(x.row - myBase.row, x.col - myBase.col);
                if (dist <= 3) {
                    score -= Math.pow(10, 4 - dist) * 200;
                }
            }
        }
    }

    for (const row of sGrid) for (const x of row) {
        if (x.owner === p && (x.type === Type.TRUNK || x.type === Type.BASE)) {
            let enemyNear = false;
            for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
                if (Math.abs(dr) + Math.abs(dc) > 2) continue;
                const t = sGrid[x.row + dr]?.[x.col + dc];
                if (t && t.owner === enemy && (t.type === Type.SOLDIER || t.type === Type.TRUNK)) enemyNear = true;
            }
            if (enemyNear) score -= 10;
        }
    }

    if (p === Player.P2 && p2CooldownState) score -= 5;

    return score;
}

function presortMoves(sGrid, moves, p) {
    const myBase = findBase(p, sGrid);
    const enemy = p === Player.P1 ? Player.P2 : Player.P1;

    let isEmergency = false;
    let dangerTile = null;

    if (myBase) {
        let emptyCount = 0;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const t = sGrid[myBase.row + dr]?.[myBase.col + dc];
            if (t && t.type === Type.EMPTY) {
                emptyCount++;
                dangerTile = t;
            }
        }
        if (emptyCount === 1) isEmergency = true;
    }

    let baseThreatened = false;
    if (myBase) {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const t = sGrid[myBase.row + dr]?.[myBase.col + dc];
            if (t && t.owner === enemy && t.type !== Type.EMPTY && t.type !== Type.CORPSE) {
                baseThreatened = true;
            }
        }
    }

    let mustRush = false;
    if (turnLimit > 0 && myBase && enemy && !baseThreatened) {
        const enBase = findBase(enemy, sGrid);
        if (enBase) {
            const remainingRounds = turnLimit - Math.floor(turnCount / 2);
            const myMinDist = getMinDistToBase(p, enBase, sGrid);
            const enemyMinDist = getMinDistToBase(enemy, myBase, sGrid);
            if (enemyMinDist < myMinDist || remainingRounds < 15) {
                mustRush = true;
            }
        }
    }

    for (const m of moves) {
        m.score = 1;

        if (m.action === 'ATTACK') {
            m.score = subtree(m.target).length * 5;
            if (m.target.type === Type.CORPSE) m.score = 25;
            else if (m.target.owner !== p) m.score = 200;

            if (m.target.type === Type.BASE) m.score = 999999;

            if (myBase && m.target.owner !== p) {
                const dist = Math.hypot(m.target.row - myBase.row, m.target.col - myBase.col);
                if (dist <= 3) m.score += 10000;
            }
        }

        if (m.action === 'MOVE' || m.action === 'GROW_SOLDIER') {
            m.score = 15;
            if (m.variant === Variant.VIRUS) m.score += 10;
            if (mustRush) m.score += 500;
        }

        if (m.action === 'GROW_TRUNK') {
            m.score = 5;
            if (mustRush) m.score += 2000;
        }

        if (isEmergency && dangerTile && m.target.row === dangerTile.row && m.target.col === dangerTile.col) {
            m.score += 1000000;
        }

        if (isEmergency && myBase) {
            const distToBase = Math.hypot(m.target.row - myBase.row, m.target.col - myBase.col);
            if (distToBase <= 2 && (m.action === 'GROW_TRUNK' || m.action === 'GROW_SOLDIER' || m.action === 'MOVE')) {
                m.score += 5000;
            }
        }

        if (baseThreatened && myBase) {
            const distToBase = Math.hypot(m.target.row - myBase.row, m.target.col - myBase.col);
            if (m.action === 'ATTACK' && distToBase <= 1 && m.target.owner === enemy) {
                m.score += 500000;
            }
            if (distToBase <= 1) {
                m.score += 50000;
            }
            if (distToBase > 3) {
                m.score -= 100000;
            }
        }
    }
    moves.sort((a, b) => b.score - a.score);
    return moves;
}

function botTurnHard() {
    writeLog(`[困难机器人] 正在深度推演...`, 'bot');

    let myMoves = getSimulatedMoves(grid, Player.P2, p2Cooldown);
    if (myMoves.length === 0) return finish('PASS');

    myMoves = presortMoves(grid, myMoves, Player.P2).slice(0, 15);

    let bestMove = null;
    let bestScore = -Infinity;

    for (const move of myMoves) {
        const sGrid = cloneGrid(grid);
        const simTarget = sGrid[move.target.row][move.target.col];
        const simSrc = sGrid[move.src.row][move.src.col];
        executeSimulatedMove(sGrid, {
            action: move.action,
            src: simSrc,
            target: simTarget,
            variant: move.variant,
            isJump: move.isJump,
            step: move.step
        }, Player.P2);

        let enemyMoves = getSimulatedMoves(sGrid, Player.P1, p1Cooldown);
        enemyMoves = presortMoves(sGrid, enemyMoves, Player.P1).slice(0, 5);

        let worstCounterScore = Infinity;

        if (enemyMoves.length === 0) {
            worstCounterScore = evaluateState(sGrid, Player.P2, false);
        } else {
            for (const enemyMove of enemyMoves) {
                const sGrid2 = cloneGrid(sGrid);
                const simEnemyTarget = sGrid2[enemyMove.target.row][enemyMove.target.col];
                const simEnemySrc = sGrid2[enemyMove.src.row][enemyMove.src.col];
                executeSimulatedMove(sGrid2, {
                    action: enemyMove.action,
                    src: simEnemySrc,
                    target: simEnemyTarget,
                    variant: enemyMove.variant,
                    isJump: enemyMove.isJump,
                    step: enemyMove.step
                }, Player.P1);

                const score = evaluateState(sGrid2, Player.P2, move.action === 'GROW_TRUNK');
                if (score < worstCounterScore) worstCounterScore = score;
            }
        }

        const finalScore = worstCounterScore + Math.random() * 0.5;
        if (finalScore > bestScore) {
            bestScore = finalScore;
            bestMove = move;
        }
    }

    if (bestMove) {
        selectedCell = bestMove.src;
        currentAction = bestMove.action;

        if (bestMove.action === 'ATTACK') {
            writeLog(`[困难机器人] 执行攻击 (${bestMove.src.row},${bestMove.src.col}) -> (${bestMove.target.row},${bestMove.target.col})`, 'bot');
            if (bestMove.target.type === Type.CORPSE) {
                bestMove.target.type = 0; bestMove.target.owner = 0; bestMove.target.parent = null; bestMove.target.children = [];
            } else {
                corpseSubtree(bestMove.target);
            }
            finish('ATTACK');
        } else if (bestMove.action === 'MOVE' || bestMove.action === 'GROW_SOLDIER') {
            writeLog(`[困难机器人] 执行长出分支/移动 (${bestMove.src.row},${bestMove.src.col}) -> (${bestMove.target.row},${bestMove.target.col})`, 'bot');
            let v = bestMove.variant !== undefined ? bestMove.variant : bestMove.src.variant;
            if (bestMove.action === 'GROW_SOLDIER' && ruleMode === 'ADVANCED' && v > 0) {
                createdVariantBranches[Player.P2].add(v);
                writeLog(`[P2] 创造了本局唯一的【${variantName(v)}】分支！`, 'rule');
            }
            grow(bestMove.target, bestMove.src, Type.SOLDIER, v);
            finish('GROW_SOLDIER');
        } else if (bestMove.action === 'GROW_TRUNK') {
            writeLog(`[困难机器人] 执行长主干`, 'bot');

            let count = 0;
            let currentParent = bestMove.src;
            let currentTarget = bestMove.target;
            const enemyBase = findBase(Player.P1);

            while (count < 3) {
                grow(currentTarget, currentParent, Type.TRUNK);
                count++;
                currentParent = currentTarget;

                let bestDist = Infinity;
                let nextT = null;
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    if (!dr && !dc) continue;
                    const t = cell(currentParent.row + dr, currentParent.col + dc);
                    if (t && t.type === Type.EMPTY && !banAt(t.row, t.col, Player.P2)) {
                        const dist = enemyBase ? Math.hypot(t.row - enemyBase.row, t.col - enemyBase.col) : 0;
                        if (dist < bestDist) {
                            let parentBlocked = 0;
                            for (let ddr = -1; ddr <= 1; ddr++) for (let ddc = -1; ddc <= 1; ddc++) {
                                if (Math.abs(ddr) + Math.abs(ddc) !== 1) continue;
                                const nt = cell(currentParent.row + ddr, currentParent.col + ddc);
                                if (nt && nt.type !== Type.EMPTY && nt !== t) parentBlocked++;
                            }
                            if (parentBlocked >= 3) continue;

                            bestDist = dist;
                            nextT = t;
                        }
                    }
                }
                if (!nextT) break;
                currentTarget = nextT;
            }
            finish('GROW_TRUNK');
        }
    } else {
        writeLog(`[困难机器人] 未找到合适动作，跳过回合`, 'bot');
        finish('PASS');
    }
}

function botTurnEasy() {
    if (isGameOver) return;
    writeLog(`[机器人] 开始思考...`, 'bot');

    const heads = [];
    for (const row of grid) for (const x of row) {
        if (x.owner === Player.P2 && isHead(x) && x.disabledRounds <= 0) heads.push(x);
    }

    const soldiers = heads.filter(x => x.type === Type.SOLDIER);
    for (const soldier of soldiers) {
        const enemy = [[-1, 0], [1, 0], [0, -1], [0, 1]]
            .map(([a, b]) => cell(soldier.row + a, soldier.col + b))
            .find(x => x && x.type !== Type.EMPTY && x.type !== Type.TUMOR && x.type !== Type.CORPSE && x.owner === Player.P1);
        if (enemy) {
            selectedCell = soldier;
            writeLog(`[机器人] 发起攻击！目标 (${enemy.row},${enemy.col})`, 'bot');
            corpseSubtree(enemy);
            return finish('ATTACK');
        }
    }

    if (!p2Cooldown) {
        let count = 0;
        const moves = [];
        for (const row of grid) for (const parent of row) {
            if (parent.owner !== Player.P2 || ![Type.BASE, Type.TRUNK].includes(parent.type)) continue;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                const target = cell(parent.row + dr, parent.col + dc);
                if (target && target.type === Type.EMPTY && !banAt(target.row, target.col, Player.P2)) moves.push({target, parent});
            }
        }
        moves.sort((a, b) => Math.random() - 0.5);
        for (const move of moves) {
            if (count >= 3) break;
            if (move.target.type !== Type.EMPTY) continue;
            grow(move.target, move.parent, Type.TRUNK);
            count++;
        }
        if (count > 0) {
            writeLog(`[机器人] 生长了 ${count} 格主干`, 'bot');
            return finish('GROW_TRUNK');
        }
    }

    for (const head of heads) {
        if (head.type === Type.TRUNK || head.type === Type.SOLDIER) {
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                const t = cell(head.row + dr, head.col + dc);
                if (t && t.type === Type.EMPTY && !banAt(t.row, t.col, Player.P2)) {
                    grow(t, head, Type.SOLDIER, Variant.NORMAL);
                    return finish('GROW_SOLDIER');
                }
            }
        }
    }
    finish('PASS');
}

function botTurnMaster() {
    writeLog(`[大师机器人] 启动深度算杀引擎...`, 'bot');

    let myMoves = getSimulatedMoves(grid, Player.P2, p2Cooldown);
    if (myMoves.length === 0) return finish('PASS');

    myMoves = presortMoves(grid, myMoves, Player.P2).slice(0, 12);

    let bestMove = null;
    let bestScore = -Infinity;

    for (const move of myMoves) {
        const sGrid1 = cloneGrid(grid);
        const simTarget = sGrid1[move.target.row][move.target.col];
        const simSrc = sGrid1[move.src.row][move.src.col];
        executeSimulatedMove(sGrid1, {
            action: move.action,
            src: simSrc,
            target: simTarget,
            variant: move.variant,
            isJump: move.isJump,
            step: move.step
        }, Player.P2);

        let enemyMoves = getSimulatedMoves(sGrid1, Player.P1, p1Cooldown);
        enemyMoves = presortMoves(sGrid1, enemyMoves, Player.P1).slice(0, 6);

        let worstCounterScore = Infinity;

        if (enemyMoves.length === 0) {
            worstCounterScore = evaluateState(sGrid1, Player.P2, move.action === 'GROW_TRUNK');
        } else {
            for (const enemyMove of enemyMoves) {
                const sGrid2 = cloneGrid(sGrid1);
                const simETarget = sGrid2[enemyMove.target.row][enemyMove.target.col];
                const simESrc = sGrid2[enemyMove.src.row][enemyMove.src.col];
                executeSimulatedMove(sGrid2, {
                    action: enemyMove.action,
                    src: simESrc,
                    target: simETarget,
                    variant: enemyMove.variant,
                    isJump: enemyMove.isJump,
                    step: enemyMove.step
                }, Player.P1);

                const currentEval = evaluateState(sGrid2, Player.P2, move.action === 'GROW_TRUNK');
                if (currentEval < -500000) {
                    worstCounterScore = currentEval;
                    break;
                }

                if (currentEval < worstCounterScore) {
                    worstCounterScore = currentEval;
                }
            }
        }

        if (worstCounterScore > bestScore) {
            bestScore = worstCounterScore;
            bestMove = move;
        }
    }

    if (bestMove) {
        selectedCell = bestMove.src;
        currentAction = bestMove.action;

        if (bestMove.action === 'ATTACK') {
            writeLog(`[大师机器人] 执行算杀攻击 (${bestMove.src.row},${bestMove.src.col}) -> (${bestMove.target.row},${bestMove.target.col})`, 'bot');
            if (bestMove.target.type === Type.CORPSE) {
                bestMove.target.type = 0; bestMove.target.owner = 0; bestMove.target.parent = null; bestMove.target.children = [];
            } else {
                corpseSubtree(bestMove.target);
            }
            finish('ATTACK');
        } else if (bestMove.action === 'MOVE' || bestMove.action === 'GROW_SOLDIER') {
            writeLog(`[大师机器人] 长出分支/移动 (${bestMove.src.row},${bestMove.src.col}) -> (${bestMove.target.row},${bestMove.target.col})`, 'bot');
            let v = bestMove.variant !== undefined ? bestMove.variant : bestMove.src.variant;
            if (bestMove.action === 'GROW_SOLDIER' && ruleMode === 'ADVANCED' && v > 0) {
                createdVariantBranches[Player.P2].add(v);
                writeLog(`[P2] 创造了本局唯一的【${variantName(v)}】分支！`, 'rule');
            }
            grow(bestMove.target, bestMove.src, Type.SOLDIER, v);
            finish('GROW_SOLDIER');
        } else if (bestMove.action === 'GROW_TRUNK') {
            writeLog(`[大师机器人] 执行战略主干生长`, 'bot');

            let count = 0;
            let maxStep = bestMove.step || 3;
            let currentParent = bestMove.src;
            let currentTarget = bestMove.target;
            const enemyBase = findBase(Player.P1);

            while (count < maxStep) {
                grow(currentTarget, currentParent, Type.TRUNK);
                count++;
                currentParent = currentTarget;

                let bestDist = Infinity;
                let nextT = null;
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    if (!dr && !dc) continue;
                    const t = cell(currentParent.row + dr, currentParent.col + dc);
                    if (t && t.type === Type.EMPTY && !banAt(t.row, t.col, Player.P2)) {
                        const dist = enemyBase ? Math.hypot(t.row - enemyBase.row, t.col - enemyBase.col) : 0;
                        if (dist < bestDist) {
                            let parentBlocked = 0;
                            for (let ddr = -1; ddr <= 1; ddr++) for (let ddc = -1; ddc <= 1; ddc++) {
                                if (Math.abs(ddr) + Math.abs(ddc) !== 1) continue;
                                const nt = cell(currentParent.row + ddr, currentParent.col + ddc);
                                if (nt && nt.type !== Type.EMPTY && nt !== t) parentBlocked++;
                            }
                            if (parentBlocked >= 3) continue;

                            bestDist = dist;
                            nextT = t;
                        }
                    }
                }
                if (!nextT) break;
                currentTarget = nextT;
            }
            writeLog(`[大师机器人] 连续生长了 ${count} 格主干`, 'bot');
            finish('GROW_TRUNK');
        }
    } else {
        writeLog(`[大师机器人] 未找到合适动作，跳过回合`, 'bot');
        finish('PASS');
    }
}

/* ===================== 启动 ===================== */

initGrid(); drawBoard(); updateUI();