/*
 * Gridline War (格线战争) - browser UI, rendering, AI turn driver and WebRTC networking.
 *
 * Game rules live exclusively in engine.js (global GridEngine). This file holds one engine state
 * object; every game-state change is a move that is checked with GridEngine.validateMove and
 * applied with GridEngine.applyMove. Log lines are generated from the events of each applied move.
 * Computer opponents live in ai.js (global GridAI) and are driven through an async turn loop.
 * Network play exchanges moves (with sequence numbers, sync epochs and state hashes) instead of full
 * states; the host is authoritative and sends a full snapshot when either side detects a desync.
 *
 * Script order in start.html: engine.js, ai.js, Game.js (classic scripts, works under file://).
 */
(function () {
    'use strict';

    const Engine = window.GridEngine;
    if (!Engine) throw new Error('Game.js: engine.js must be loaded before Game.js');

    const canvas = document.getElementById('gameCanvas'), ctx = canvas.getContext('2d');
    const miniMap = document.getElementById('miniMapCanvas'), miniCtx = miniMap.getContext('2d');
    const Type = Engine.Type;
    const Variant = Engine.Variant;
    const AI_PLAYER = 2;
    const AI_TURN_DELAY_MS = 250;

    // AI move presentation: minimum interval between two board-changing AI micro-moves, and the
    // durations of the transient canvas effects drawn for them.
    const AI_STEP_MS = 450;
    const FX_GROW_MS = 360;     // new unit pops in, link grows from its parent
    const FX_STRIKE_MS = 420;   // attack / disable streak and impact ring
    const FX_FADE_MS = 520;     // unit turned into a corpse, or removed from the board
    const FX_BLAST_MS = 700;    // bomb explosion
    const FX_WAVE_MS = 30;      // per-cell delay of fades, by Manhattan distance from the move target
    const FX_WAVE_MAX_MS = 300;
    const MARK_COLORS = Object.freeze({grow: '#e67e22', attack: '#e74c3c', disable: '#9b59b6'});

    const TYPE_LABELS = ['', '母体', '主干', '分支', '尸体', '肿瘤'];
    const VARIANT_LABELS = ['普通', '噬体', '病毒', '晶体', '基因', '炸弹', '禁'];
    const VARIANT_GLYPHS = ['', '噬', '毒', '晶', '基', '弹', '禁'];
    const AI_TURN_BANNERS = Object.freeze({
        EASY: '[机器人] 开始思考...',
        HARD: '[困难机器人] 正在深度推演...',
        MASTER: '[大师机器人] 启动深度算杀引擎...'
    });
    const AI_THINKING_HINT = '机器人思考中…';

    // Board geometry used for rendering and pointer mapping (set from the map size at game start).
    let COLS = 40, ROWS = 30, CELL_SIZE = 28;

    // Authoritative game state (immutable GridEngine state), null before a game starts.
    let state = null;

    // UI-only state.
    let selectedCell = null;   // selected cell index, or null
    let currentAction = null;  // 'GROW_TRUNK' | 'GROW_SOLDIER' | 'ATTACK' | 'DISABLE' | 'TUMOR' | null
    let aiLevel = 'PVP';
    let gameToken = 0;         // incremented per game; stale async AI loops compare against it
    let aiRunning = false;     // an AI turn is scheduled or in progress
    let gameOverShown = false;

    let isNetMode = false;
    let myRole = null;

    // Native WebRTC objects.
    let ws = null;
    let pc = null;
    let dc = null;              // RTCDataChannel; never reuse this name for loop variables
    let currentRoomId = null;
    let pendingCandidates = []; // ICE candidates that arrived before the remote description

    // Move protocol state.
    let netSeq = 0;             // number of moves applied in the current network game
    let netEpoch = 0;           // sync epoch: the host increments it per snapshot, the guest adopts it
                                // from the snapshot; every move carries the sender's epoch
    let awaitingSync = false;   // guest only: a desync was reported, waiting for the host snapshot

    let gameOverTitle = '';
    let gameOverReason = '';
    let gameOverTimer = null;   // pending timer that displays the game-over screen
    let logBoxHome = null;      // {parent, next, heading} while the log box is inside the game-over modal

    // AI move presentation (UI only, never part of the game state).
    let fxList = [];            // transient effects {kind, at, t0, dur, ...}; t0 may lie in the future
    let fxFrame = 0;            // requestAnimationFrame handle of the effect loop, 0 when idle
    let aiMarks = new Map();    // cell -> {steps, kind}: cells acted on during the latest AI turn
    let aiStep = 0;             // number of marked micro-moves in the latest AI turn

    // ICE configuration with public STUN servers and a TURN relay for restrictive networks.
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

    const $ = id => document.getElementById(id), btnTrunk = $('btn-grow-trunk'), btnSoldier = $('btn-grow-soldier'),
        btnAttack = $('btn-attack'), btnDisable = $('btn-disable'), btnGrowTumor = $('btn-grow-tumor'),
        btnPass = $('btn-pass'), variantPanel = $('variant-panel'), variantSelect = $('variant-select');

    function setButtonEnabled(b, on) {
        if (!b) return;
        b.disabled = !on;
        b.classList.toggle('disabled', !on);
    }

    function writeLog(m, t = 'sys') {
        const b = $('log-box');
        if (!b) return;
        const d = document.createElement('div');
        d.className = `log-${t}`;
        const time = new Date().toLocaleTimeString('en-US', {hour12: false});
        d.textContent = `[${time}] ${m}`;
        b.appendChild(d);
        b.scrollTop = b.scrollHeight;
    }

    function showMsg(m, e = false) {
        const x = $('hint-msg');
        if (!x) return;
        x.textContent = m;
        x.style.color = e ? '#e74c3c' : '#f1c40f';
        clearTimeout(x._t);
        x._t = setTimeout(() => x.textContent = '', 1800);
    }

    /* ===================== State helpers ===================== */

    function rowOf(i) { return Math.floor(i / state.cols); }
    function colOf(i) { return i % state.cols; }
    function cellLabel(i) { return `(${rowOf(i)},${colOf(i)})`; }
    function playerClass(p) { return p === 1 ? 'p1' : 'p2'; }

    function trunkCount() {
        const pend = state ? state.pending : null;
        return pend && pend.kind === 'TRUNK' ? pend.count : 0;
    }

    function crystalSource() {
        const pend = state ? state.pending : null;
        return pend && pend.kind === 'CRYSTAL' ? pend.at : null;
    }

    function winnerTitle(winner) {
        return winner === 0 ? '平局！' : winner === 2 ? '橘色 P2 获胜！' : '蓝色 P1 获胜！';
    }

    // True when the player operating this page may act for state.current.
    function isLocalTurn() {
        if (!state) return false;
        if (isNetMode) {
            if (!myRole || awaitingSync) return false;
            if (myRole === 'host' && state.current !== 1) return false;
            if (myRole === 'guest' && state.current !== 2) return false;
            return true;
        }
        return !(aiLevel !== 'PVP' && state.current === AI_PLAYER);
    }

    function isAiTurn() {
        return state !== null && !isNetMode && aiLevel !== 'PVP' &&
            state.phase === 'PLAY' && state.current === AI_PLAYER;
    }

    function hasAi() {
        const ai = window.GridAI;
        return typeof ai === 'object' && ai !== null && typeof ai.chooseMove === 'function';
    }

    // Derives the selection and action mode from the pending sequence of the current state:
    // a trunk sequence keeps the last grown trunk selected in GROW_TRUNK mode, a crystal extra
    // action keeps the crystal head selected; otherwise the selection is cleared (turn change).
    function syncSelectionToState() {
        const pend = state.pending;
        if (state.phase !== 'PLAY' || pend === null) {
            selectedCell = null;
            currentAction = null;
        } else if (pend.kind === 'TRUNK') {
            selectedCell = typeof pend.last === 'number' && pend.last >= 0 ? pend.last : null;
            currentAction = 'GROW_TRUNK';
        } else {
            selectedCell = pend.at;
            currentAction = null;
        }
    }

    /* ===================== Event log ===================== */

    function logEvents(events) {
        for (const ev of events) {
            const p = ev.p, cls = playerClass(p);
            switch (ev.k) {
                case 'PLACE':
                    writeLog(`[P${p}] 在 ${cellLabel(ev.at)} 放置了母体！`, cls);
                    if (p === 2) writeLog('[系统] 双方部署完毕，游戏开始！', 'sys');
                    break;
                case 'GROW': {
                    const varStr = ev.kind === 'SOLDIER' ? ` / ${VARIANT_LABELS[ev.variant]}` : '';
                    const actionType = ev.kind === 'TRUNK' ? '生长主干' : (ev.kind === 'SOLDIER' ? '长出分支' : '分化肿瘤');
                    writeLog(`[P${p}] ${actionType} 位于 ${cellLabel(ev.at)}，连接自 ${cellLabel(ev.from)} ${varStr}`, cls);
                    if (ev.kind === 'TUMOR') writeLog(`[P${p}] 基因分化了不可摧毁的肿瘤！`, cls);
                    break;
                }
                case 'VARIANT_CREATED':
                    writeLog(`[P${p}] 创造了本局唯一的【${Engine.variantName(ev.variant)}】分支！`, 'rule');
                    break;
                case 'TRAMPLE':
                    writeLog(`[P${p}] 病毒覆盖了 ${cellLabel(ev.at)} 的敌人！`, cls);
                    break;
                case 'ERASE':
                    writeLog(`[吞噬] 起点 ${cellLabel(ev.root)} 被彻底抹除，清除 ${ev.count} 个单位！`, 'combat');
                    break;
                case 'ATTACK':
                    writeLog(`[P${p}] 发起攻击！目标 ${cellLabel(ev.at)}`, cls);
                    break;
                case 'CLEAR_CORPSE':
                    writeLog(`[P${p}] 清理了 ${cellLabel(ev.at)} 的尸体`, cls);
                    break;
                case 'CHAIN_DEATH':
                    writeLog(`[连锁死亡] 起点 ${cellLabel(ev.root)} 开始塌陷，波及 ${ev.count} 个单位！`, 'combat');
                    break;
                case 'DISABLE':
                    writeLog(`[P${p}] 病毒释放禁用，目标 ${cellLabel(ev.at)} 将冻结2回合！`, cls);
                    break;
                case 'TUMOR_SELF':
                    writeLog(`[P${p}] 基因 ${cellLabel(ev.at)} 变异为肿瘤！`, cls);
                    break;
                case 'CRYSTAL_EXTRA':
                    writeLog(`[P${p}] 晶体触发额外行动 (已用 1/2)`, cls);
                    break;
                case 'SQUEEZE':
                    writeLog(`[挤压判定] 发现 ${ev.count} 个被围死的单位！`, 'rule');
                    break;
                case 'EXPLODE':
                    writeLog(`[爆炸] 炸弹在 ${cellLabel(ev.at)} 引爆！引发 5x5 范围毁灭！`, 'combat');
                    break;
                case 'TURN_END':
                    if (ev.action === 'GROW_TRUNK') {
                        writeLog(`[P${p}] 结束回合 (生长主干，进入冷却期)`, cls);
                    } else if (ev.action === 'PASS') {
                        writeLog(`[P${p}] 主动跳过回合`, cls);
                    } else {
                        writeLog(`[P${p}] 结束回合 (执行了 ${ev.action})`, cls);
                    }
                    break;
                case 'GAME_OVER': {
                    const title = winnerTitle(ev.winner);
                    writeLog(`[游戏结束] ${title} - ${ev.reason}`, 'success');
                    triggerGameOverScreen(title, ev.reason);
                    break;
                }
                default:
                    break;
            }
        }
    }

    /* ===================== Game over ===================== */

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
            logBoxHome = {parent: logBox.parentNode, next: logBox.nextSibling, heading: title};
            modal.appendChild(title);

            logBox.style.marginTop = '5px';
            logBox.style.height = '200px';
            logBox.style.width = '100%';
            logBox.style.textAlign = 'left';
            modal.appendChild(logBox);
        }
    }

    function triggerGameOverScreen(title, reason) {
        if (gameOverShown) return;
        gameOverShown = true;
        gameOverTitle = title;
        gameOverReason = reason;
        const wTitle = $('winner-title'), wReason = $('winner-reason');
        if (wTitle && wReason) {
            gameOverTimer = setTimeout(() => {
                gameOverTimer = null;
                $('game-over-screen').style.display = 'flex';
                wTitle.textContent = gameOverTitle;
                wReason.textContent = gameOverReason;
                moveLogToModal();
            }, 1000);
        }
    }

    // Cancels a scheduled or visible game-over screen and returns the log box to the side panel
    // with its original inline styles.
    function resetGameOverScreen() {
        if (gameOverTimer !== null) {
            clearTimeout(gameOverTimer);
            gameOverTimer = null;
        }
        gameOverShown = false;
        gameOverTitle = '';
        gameOverReason = '';
        const screen = $('game-over-screen');
        if (screen) screen.style.display = 'none';
        const home = logBoxHome, logBox = $('log-box');
        logBoxHome = null;
        if (!home || !logBox) return;
        if (home.heading.parentNode) home.heading.parentNode.removeChild(home.heading);
        logBox.style.marginTop = '';
        logBox.style.height = '';
        logBox.style.width = '';
        logBox.style.textAlign = '';
        if (home.parent) home.parent.insertBefore(logBox, home.next);
    }

    // Aligns the game-over screen with the state after a host snapshot replaced it: a running game
    // cancels a game-over screen produced from the replaced state; a finished game shows the
    // snapshot's result, also when a screen with another result is already scheduled or visible.
    function syncGameOverScreen() {
        if (state.phase !== 'OVER') {
            if (gameOverShown) resetGameOverScreen();
            return;
        }
        const title = winnerTitle(state.winner), reason = state.overReason;
        if (!gameOverShown) {
            triggerGameOverScreen(title, reason);
            return;
        }
        gameOverTitle = title;
        gameOverReason = reason;
        if (gameOverTimer === null) {
            const wTitle = $('winner-title'), wReason = $('winner-reason');
            if (wTitle) wTitle.textContent = title;
            if (wReason) wReason.textContent = reason;
        }
    }

    /* ===================== Move application ===================== */

    // Applies an already validated move to the authoritative state.
    //   opts.log  (default true)  write log lines generated from the move's events
    //   opts.send (default false) forward the move to the network peer
    function commitMove(move, opts) {
        const o = opts || {};
        state = Engine.applyMove(state, move);
        if (o.log !== false) logEvents(state.events);
        syncSelectionToState();
        if (o.send) netSendMove(move);
        return state;
    }

    // Validates and applies a move made by the player operating this page.
    function playLocalMove(move) {
        const err = Engine.validateMove(state, move);
        if (err !== null) {
            showMsg(err, true);
            return false;
        }
        commitMove(move, {send: true});
        const pend = state.phase === 'PLAY' ? state.pending : null;
        if (pend !== null && pend.kind === 'TRUNK') {
            updateUI(`主干 ${pend.count}/3；继续点击选中格的相邻空格，或点击其他己方母体/主干切换起点`);
        } else if (pend !== null && pend.kind === 'CRYSTAL') {
            updateUI('晶体可再行动一次 (移动或攻击)');
        } else {
            updateUI();
        }
        drawBoard();
        scheduleAiTurn();
        return true;
    }

    // Executes the current action mode against the clicked cell t.
    function actAt(t) {
        if (currentAction === 'GROW_TRUNK') {
            playLocalMove({type: 'TRUNK', from: selectedCell === null ? -1 : selectedCell, to: t});
            return;
        }
        if (selectedCell === null || !currentAction) return;
        const src = selectedCell;
        switch (currentAction) {
            case 'ATTACK':
                playLocalMove({type: 'ATTACK', from: src, to: t});
                break;
            case 'GROW_SOLDIER':
                playLocalMove({type: 'BRANCH', from: src, to: t, variant: Number(variantSelect.value || 0)});
                break;
            case 'DISABLE':
                playLocalMove({type: 'DISABLE', from: src, to: t});
                break;
            case 'TUMOR':
                playLocalMove({type: 'TUMOR', from: src, to: t});
                break;
            default:
                break;
        }
    }

    function handlePlacementClick(t) {
        const move = {type: 'PLACE', to: t};
        const err = Engine.validateMove(state, move);
        if (err !== null) return showMsg(err, true);
        commitMove(move, {send: true});
        if (state.phase === 'PLACE' && !isNetMode && aiLevel !== 'PVP') placeAiBase();
        updateUI();
        drawBoard();
    }

    /* ===================== Input ===================== */

    canvas.addEventListener('pointerdown', e => {
        if (!state || state.phase === 'OVER') return;
        if (!isLocalTurn()) return;

        const rct = canvas.getBoundingClientRect(),
            c = Math.floor((e.clientX - rct.left) * canvas.width / rct.width / CELL_SIZE),
            r = Math.floor((e.clientY - rct.top) * canvas.height / rct.height / CELL_SIZE);
        if (!Engine.inBounds(state, r, c)) return;
        const t = Engine.idx(state, r, c);
        const p = state.current;

        if (state.phase === 'PLACE') {
            handlePlacementClick(t);
            return;
        }

        const crystal = crystalSource();
        if (crystal !== null) {
            if ((t === crystal || state.parent[t] === crystal) && Engine.isHead(state, t) &&
                state.type[t] !== Type.CORPSE) {
                selectedCell = t;
                updateUI();
                drawBoard();
                return;
            }
            currentAction = state.type[t] === Type.EMPTY ? 'GROW_SOLDIER' : 'ATTACK';
            actAt(t);
            return;
        }

        if (currentAction) {
            // Tumour mode: clicking the selected gene head converts the head itself.
            if (currentAction === 'TUMOR' && t === selectedCell) {
                actAt(t);
                return;
            }
            // Trunk mode: clicking an own base/trunk switches the growth origin.
            if (currentAction === 'GROW_TRUNK' && state.owner[t] === p &&
                (state.type[t] === Type.BASE || state.type[t] === Type.TRUNK)) {
                if (t !== selectedCell) {
                    selectedCell = t;
                    writeLog(`[P${p}] 切换主干生长起点至 (${r},${c}) (已长 ${trunkCount()}/3)`, playerClass(p));
                    updateUI(`已切换生长起点至 (${r},${c})；点击相邻空格继续生长 (${trunkCount()}/3)`);
                    drawBoard();
                } else {
                    showMsg(`已选中 (${r},${c})，点击相邻空格生长；点击其他己方主干/母体可切换起点`);
                }
                return;
            }
            if (state.owner[t] === p && Engine.isHead(state, t) && state.type[t] !== Type.CORPSE &&
                trunkCount() === 0) {
                if (t === selectedCell) {
                    currentAction = null;
                    writeLog(`[P${p}] 取消当前动作模式`, playerClass(p));
                } else {
                    selectedCell = t;
                    currentAction = null;
                    writeLog(`[P${p}] 重新选中了 (${r},${c})`, playerClass(p));
                }
                updateUI();
                drawBoard();
                return;
            }
            actAt(t);
            return;
        }

        if (state.owner[t] === p && Engine.isHead(state, t) && state.type[t] !== Type.CORPSE) {
            selectedCell = selectedCell === t ? null : t;
            if (selectedCell !== null) {
                writeLog(`[P${p}] 选中了 (${r},${c}) 的 ${TYPE_LABELS[state.type[t]]}`, playerClass(p));
            } else {
                writeLog(`[P${p}] 取消选中`, playerClass(p));
            }
            updateUI();
            drawBoard();
        }
    });

    canvas.addEventListener('contextmenu', e => {
        e.preventDefault();
        // Right-click acts only for the player whose turn it is on this page.
        if (state && state.phase === 'PLAY' && !isLocalTurn()) return;
        if (crystalSource() !== null) return showMsg('晶体额外行动中，不能取消', true);

        // Right-click during a trunk sequence ends the turn (keeps growth exclusive per turn).
        if (currentAction === 'GROW_TRUNK' && trunkCount() > 0) {
            playLocalMove({type: 'END'});
            return;
        }

        currentAction = null;
        selectedCell = null;
        updateUI();
        drawBoard();
    });

    window.selectAction = a => {
        if (!state || state.phase === 'OVER') return;
        if (!isLocalTurn()) return;

        // A trunk sequence in progress cannot switch action or reset its progress.
        if (currentAction === 'GROW_TRUNK' && trunkCount() > 0) {
            return showMsg(`主干生长中 (${trunkCount()}/3)，可切换生长起点或点击"结束行动"`, true);
        }

        const p = state.current;
        if (a === 'GROW_TRUNK') {
            if (state.cooldown[p]) return showMsg('主干冷却中', true);
            if (selectedCell === null ||
                (state.type[selectedCell] !== Type.BASE && state.type[selectedCell] !== Type.TRUNK)) {
                return showMsg('先选择母体或主干作为起点', true);
            }
        }
        if (selectedCell === null) return showMsg('请先选择棋子', true);
        if (a === 'GROW_SOLDIER' && state.type[selectedCell] === Type.SOLDIER &&
            !Engine.isHead(state, selectedCell)) {
            return showMsg('该分支已延伸，不能再分叉', true);
        }
        currentAction = a;
        writeLog(`[P${p}] 切换至动作模式: ${a}`, playerClass(p));
        updateUI();
        drawBoard();
    };
    btnTrunk.onclick = () => window.selectAction('GROW_TRUNK');
    btnSoldier.onclick = () => window.selectAction('GROW_SOLDIER');
    btnAttack.onclick = () => window.selectAction('ATTACK');
    btnDisable.onclick = () => window.selectAction('DISABLE');
    btnGrowTumor.onclick = () => window.selectAction('TUMOR');
    btnPass.onclick = () => {
        if (!state || state.phase !== 'PLAY') return;
        if (!isLocalTurn()) return;
        playLocalMove({type: 'END'});
    };

    /* ===================== Status panel ===================== */

    function updateUI(msg) {
        const playerEl = $('player-display');
        const turnEl = $('turn-display');
        const cur = state ? state.current : 1;
        if (playerEl) {
            let text = cur === 1 ? '蓝色 (P1)' : aiLevel === 'PVP' ? '橘色 (P2)' : '机器人';
            if (isNetMode) {
                text = cur === 1 ? '蓝色 (P1)' : '橘色 (P2)';
                if (myRole === 'host' && cur === 2) text += ' - 等待对方...';
                if (myRole === 'guest' && cur === 1) text += ' - 等待对方...';
            }
            playerEl.textContent = text;
            playerEl.className = cur === 1 ? 'p1-color' : 'p2-color';
        }
        if (turnEl) {
            const limit = state ? state.turnLimit : 0;
            if (limit > 0) {
                const round = Math.floor(state.turnCount / 2) + 1;
                turnEl.textContent = `当前回合: ${round} / ${limit} (已行动 ${state.turnCount} 步)`;
            } else {
                turnEl.textContent = '当前回合: 无限制';
            }
        }

        [btnTrunk, btnSoldier, btnAttack, btnDisable, btnGrowTumor, btnPass].forEach(b => setButtonEnabled(b, false));
        const hintEl = $('hint-text');
        if (!state) {
            if (hintEl) hintEl.textContent = '请选择己方有效节点';
            return;
        }
        if (state.phase === 'PLACE') {
            if (hintEl) hintEl.textContent = `布阵：P${cur} 放置母体`;
            return;
        }
        if (state.phase === 'OVER') return;

        const isMyTurn = isLocalTurn();
        if (isMyTurn) setButtonEnabled(btnPass, true);
        // A trunk sequence disables both growth buttons; only "end action" stays available.
        const growingTrunk = currentAction === 'GROW_TRUNK' && trunkCount() > 0;
        if (selectedCell !== null) {
            const cool = state.cooldown[cur];
            const st = state.type[selectedCell], sv = state.variant[selectedCell];
            const advanced = state.mode === 'ADVANCED';
            setButtonEnabled(btnTrunk, !growingTrunk && (st === Type.BASE || st === Type.TRUNK) && !cool && isMyTurn);
            setButtonEnabled(btnSoldier, !growingTrunk && (st === Type.TRUNK || st === Type.SOLDIER) &&
                Engine.isHead(state, selectedCell) && isMyTurn);
            setButtonEnabled(btnAttack, st === Type.SOLDIER && isMyTurn);
            setButtonEnabled(btnDisable, advanced && sv === Variant.VIRUS && isMyTurn);
            setButtonEnabled(btnGrowTumor, advanced && sv === Variant.GENE && isMyTurn);
        }
        if (hintEl) {
            if (msg) hintEl.textContent = msg;
            else if (isAiTurn()) hintEl.textContent = AI_THINKING_HINT;
            else if (growingTrunk) {
                hintEl.textContent = `主干生长中 (${trunkCount()}/3)：点击选中格相邻空格继续，或点击其他己方主干/母体切换起点`;
            } else if (selectedCell !== null) {
                hintEl.textContent = '选择动作';
            } else {
                hintEl.textContent = '请选择己方有效节点';
            }
        }
    }

    /* ===================== Rendering ===================== */

    function drawShape(x, y, s, color, type, v) {
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        if (type === Type.BASE) {
            ctx.beginPath();
            for (let k = 0; k < 5; k++) {
                const a = -Math.PI / 2 + k * 2 * Math.PI / 5;
                if (k) ctx.lineTo(x + Math.cos(a) * s * .4, y + Math.sin(a) * s * .4);
                else ctx.moveTo(x + Math.cos(a) * s * .4, y + Math.sin(a) * s * .4);
            }
            ctx.closePath();
            ctx.fill();
        } else if (type === Type.TRUNK) {
            ctx.fillRect(x - s * .3, y - s * .3, s * .6, s * .6);
        } else if (type === Type.CORPSE) {
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x - s * .3, y - s * .3); ctx.lineTo(x + s * .3, y + s * .3);
            ctx.moveTo(x + s * .3, y - s * .3); ctx.lineTo(x - s * .3, y + s * .3);
            ctx.stroke();
        } else if (type === Type.TUMOR) {
            ctx.lineWidth = 4;
            ctx.beginPath(); ctx.arc(x, y, s * .35, 0, 7); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x - s * .22, y - s * .22); ctx.lineTo(x + s * .22, y + s * .22);
            ctx.moveTo(x + s * .22, y - s * .22); ctx.lineTo(x - s * .22, y + s * .22);
            ctx.stroke();
        } else {
            ctx.beginPath(); ctx.arc(x, y, s * .3, 0, 7);
            ctx.fill();
            if (v > 0) {
                ctx.fillStyle = '#fff';
                ctx.font = `bold ${Math.max(9, s * .35)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(VARIANT_GLYPHS[v], x, y);
            }
        }
    }

    function drawBoard(effectFrame) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 1;
        for (let c = 0; c <= COLS; c++) {
            ctx.beginPath(); ctx.moveTo(c * CELL_SIZE, 0); ctx.lineTo(c * CELL_SIZE, canvas.height); ctx.stroke();
        }
        for (let r = 0; r <= ROWS; r++) {
            ctx.beginPath(); ctx.moveTo(0, r * CELL_SIZE); ctx.lineTo(canvas.width, r * CELL_SIZE); ctx.stroke();
        }

        const now = performance.now();
        if (fxList.length > 0) fxList = fxList.filter(f => now < f.t0 + f.dur);

        if (state !== null) {
            const s = state, n = s.cols * s.rows;
            const growing = growthProgress(now);

            // Ban zones: Manhattan radius 2 around every BAN soldier, tinted by owner.
            ctx.save();
            for (let i = 0; i < n; i++) {
                if (s.type[i] !== Type.SOLDIER || s.variant[i] !== Variant.BAN) continue;
                const banColor = s.owner[i] === 1 ? 'rgba(231, 76, 60, 0.1)' : 'rgba(230, 126, 34, 0.1)';
                const borderColor = s.owner[i] === 1 ? 'rgba(231, 76, 60, 0.4)' : 'rgba(230, 126, 34, 0.4)';
                ctx.fillStyle = banColor;
                ctx.strokeStyle = borderColor;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([4, 4]);
                const br = rowOf(i), bc = colOf(i);
                for (let dRow = -2; dRow <= 2; dRow++) {
                    for (let dCol = -2; dCol <= 2; dCol++) {
                        if (Math.abs(dRow) + Math.abs(dCol) > 2) continue;
                        const tr = br + dRow;
                        const tc = bc + dCol;
                        if (tr >= 0 && tr < ROWS && tc >= 0 && tc < COLS) {
                            ctx.fillRect(tc * CELL_SIZE, tr * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                            ctx.strokeRect(tc * CELL_SIZE, tr * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                        }
                    }
                }
            }
            ctx.restore();

            drawAiMarkTints();

            for (let i = 0; i < n; i++) {
                const t = s.type[i];
                if (t === Type.EMPTY) continue;
                const row = rowOf(i), col = colOf(i);
                const X = (col + .5) * CELL_SIZE, Y = (row + .5) * CELL_SIZE;
                const color = s.owner[i] === 1 ? '#3498db' : '#e67e22';
                const par = s.parent[i];
                // A unit with a running grow effect is drawn scaled; a newly created link grows from the parent.
                const gf = growing !== null ? growing.get(i) : undefined;
                const g = gf !== undefined ? gf.g : 1;
                // Links are drawn only between live units.
                if (par >= 0 && t !== Type.CORPSE && s.type[par] !== Type.CORPSE && s.type[par] !== Type.EMPTY) {
                    const PX = (colOf(par) + .5) * CELL_SIZE, PY = (rowOf(par) + .5) * CELL_SIZE;
                    const k = gf !== undefined && gf.link ? Math.min(1, g * 1.6) : 1;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(PX, PY);
                    ctx.lineTo(PX + (X - PX) * k, PY + (Y - PY) * k);
                    ctx.stroke();
                }
                drawShape(X, Y, g < 1 ? CELL_SIZE * growScale(g) : CELL_SIZE, color, t, s.variant[i]);
                if (s.disabled[i]) {
                    ctx.strokeStyle = '#9b59b6';
                    ctx.strokeRect(col * CELL_SIZE + 2, row * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
                }
            }

            if (selectedCell !== null) {
                ctx.strokeStyle = '#f1c40f';
                ctx.lineWidth = 3;
                ctx.strokeRect(colOf(selectedCell) * CELL_SIZE + 2, rowOf(selectedCell) * CELL_SIZE + 2,
                    CELL_SIZE - 4, CELL_SIZE - 4);
            }

            drawAiMarkBadges();
            drawEffects(now);
        }
        // Effect frames leave the state unchanged, so the minimap is not redrawn for them.
        if (!effectFrame) drawMiniMap();
    }

    function drawMiniMap() {
        miniCtx.fillStyle = '#111';
        miniCtx.fillRect(0, 0, miniMap.width, miniMap.height);
        if (state === null) return;
        const s = state, n = s.cols * s.rows;
        for (let i = 0; i < n; i++) {
            if (s.type[i] === Type.EMPTY) continue;
            miniCtx.fillStyle = s.owner[i] === 1 ? '#3498db' : '#e67e22';
            miniCtx.fillRect(colOf(i) * miniMap.width / COLS, rowOf(i) * miniMap.height / ROWS,
                Math.max(1, miniMap.width / COLS), Math.max(1, miniMap.height / ROWS));
        }
    }

    /* ===================== AI move presentation ===================== */

    // Cells with a running grow effect -> {g: pop-in progress in [0, 1], link: the parent link is new},
    // or null when there is none.
    function growthProgress(now) {
        let growing = null;
        for (const f of fxList) {
            if (f.kind !== 'grow') continue;
            if (growing === null) growing = new Map();
            growing.set(f.at, {g: Math.max(0, Math.min(1, (now - f.t0) / f.dur)), link: f.link});
        }
        return growing;
    }

    // Shape scale of a growing unit: ease-out-back from 0.2 to 1 with a slight overshoot.
    function growScale(g) {
        const c1 = 1.70158, c3 = c1 + 1, x = g - 1;
        return .2 + .8 * (1 + c3 * x * x * x + c1 * x * x);
    }

    // Cell tints of the latest AI turn, drawn under the units.
    function drawAiMarkTints() {
        if (aiMarks.size === 0) return;
        ctx.save();
        ctx.globalAlpha = .18;
        for (const [i, m] of aiMarks) {
            ctx.fillStyle = MARK_COLORS[m.kind];
            ctx.fillRect(colOf(i) * CELL_SIZE, rowOf(i) * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
        ctx.restore();
    }

    // Step-number badges of the latest AI turn in the top-left corner of each marked cell, sized to
    // stay clear of the centred variant glyph; a cell acted on twice (e.g. corpse cleared, then grown
    // into) lists both steps. The white outline separates a badge from a unit of the same colour.
    function drawAiMarkBadges() {
        if (aiMarks.size === 0) return;
        const r = Math.max(5.5, CELL_SIZE * .18);
        ctx.save();
        ctx.font = `bold ${Math.max(8, Math.round(r * 1.5))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        for (const [i, m] of aiMarks) {
            const label = m.steps.join(',');
            const w = Math.max(0, ctx.measureText(label).width - r);
            const cx = colOf(i) * CELL_SIZE + r + 1, cy = rowOf(i) * CELL_SIZE + r + 1;
            ctx.fillStyle = MARK_COLORS[m.kind];
            ctx.beginPath();
            ctx.arc(cx, cy, r, Math.PI / 2, Math.PI * 1.5);
            ctx.arc(cx + w, cy, r, Math.PI * 1.5, Math.PI / 2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.fillText(label, cx + w / 2, cy + .5);
        }
        ctx.restore();
    }

    // Transient effects of AI moves, drawn over the units. A removed unit keeps its ghost visible
    // until its delayed fade starts; other delayed effects are not drawn before they start. Ghosts and
    // death flashes end early when a later move has changed their cell again.
    function drawEffects(now) {
        for (const f of fxList) {
            const p = (now - f.t0) / f.dur;
            if (p >= 1 || (p < 0 && f.kind !== 'vanish')) continue;
            if (f.kind === 'vanish' && state.type[f.at] !== Type.EMPTY) continue;
            if (f.kind === 'die' && state.type[f.at] !== Type.CORPSE) continue;
            const q = Math.max(0, p);
            const X = (colOf(f.at) + .5) * CELL_SIZE, Y = (rowOf(f.at) + .5) * CELL_SIZE;
            ctx.save();
            if (f.kind === 'grow') {
                ctx.globalAlpha = 1 - q;
                ctx.strokeStyle = f.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(X, Y, CELL_SIZE * (.3 + .5 * q), 0, Math.PI * 2);
                ctx.stroke();
            } else if (f.kind === 'strike') {
                // Streak from the acting unit to the target during the first 40 %, then an impact ring.
                const SX = (colOf(f.from) + .5) * CELL_SIZE, SY = (rowOf(f.from) + .5) * CELL_SIZE;
                const head = Math.min(1, q / .4);
                ctx.globalAlpha = q < .4 ? 1 : 1 - (q - .4) / .6;
                ctx.strokeStyle = f.color;
                ctx.lineCap = 'round';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(SX, SY);
                ctx.lineTo(SX + (X - SX) * head, SY + (Y - SY) * head);
                ctx.stroke();
                if (q >= .4) {
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.arc(X, Y, CELL_SIZE * (.2 + .6 * (q - .4) / .6), 0, Math.PI * 2);
                    ctx.stroke();
                }
            } else if (f.kind === 'die') {
                ctx.globalAlpha = .55 * (1 - q);
                ctx.fillStyle = '#e74c3c';
                ctx.fillRect(colOf(f.at) * CELL_SIZE, rowOf(f.at) * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            } else if (f.kind === 'vanish') {
                ctx.globalAlpha = 1 - q;
                drawShape(X, Y, CELL_SIZE * (1 - .5 * q), f.color, f.type, f.variant);
            } else if (f.kind === 'blast') {
                // Flash over the blast area (Manhattan radius 2) and an expanding shock ring.
                const br = rowOf(f.at), bc = colOf(f.at);
                ctx.globalAlpha = .6 * (1 - q);
                ctx.fillStyle = '#f39c12';
                for (let dRow = -2; dRow <= 2; dRow++) {
                    for (let dCol = -2; dCol <= 2; dCol++) {
                        if (Math.abs(dRow) + Math.abs(dCol) > 2) continue;
                        const tr = br + dRow, tc = bc + dCol;
                        if (tr >= 0 && tr < ROWS && tc >= 0 && tc < COLS) {
                            ctx.fillRect(tc * CELL_SIZE, tr * CELL_SIZE, CELL_SIZE, CELL_SIZE);
                        }
                    }
                }
                ctx.globalAlpha = 1 - q;
                ctx.strokeStyle = '#e74c3c';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(X, Y, CELL_SIZE * (.5 + 2.2 * q), 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    function startFxLoop() {
        if (fxFrame === 0 && fxList.length > 0) fxFrame = requestAnimationFrame(fxTick);
    }

    // One animation frame: drawBoard drops finished effects; the loop stops when none is left.
    function fxTick() {
        fxFrame = 0;
        drawBoard(true);
        startFxLoop();
    }

    function clearAiPresentation() {
        if (fxFrame !== 0) cancelAnimationFrame(fxFrame);
        fxFrame = 0;
        fxList = [];
        aiMarks = new Map();
        aiStep = 0;
    }

    // Drops the marks of the previous AI turn.
    function beginAiTurnMarks() {
        aiMarks = new Map();
        aiStep = 0;
    }

    // True when applying the validated move changes what the board shows. Every move except END
    // places, removes or freezes a unit; END changes the board only when the turn-end squeeze kills
    // units or a disable frame of the next player expires.
    function changesBoard(s, move) {
        if (move.type !== 'END') return true;
        const next = Engine.applyMove(s, move, {validate: false, events: false});
        for (let i = 0, n = s.cols * s.rows; i < n; i++) {
            if (next.type[i] !== s.type[i] || next.owner[i] !== s.owner[i] ||
                (next.disabled[i] > 0) !== (s.disabled[i] > 0)) return true;
        }
        return false;
    }

    // Records the canvas effects and the turn mark of an AI micro-move that has just been committed;
    // prev is the state before the move. Cell effects are derived from the cells whose type or owner
    // changed, which covers the consequences of the move (trample, chain death, squeeze, explosion).
    // Effects are drawn in list order: blasts first, so that ghosts and death flashes stay on top.
    function presentAiMove(prev, move) {
        const next = state, n = next.cols * next.rows, t0 = performance.now();
        const origin = typeof move.to === 'number' && move.to >= 0 ? move.to : -1;
        for (const ev of next.events) {
            if (ev.k === 'EXPLODE') fxList.push({kind: 'blast', at: ev.at, t0: t0, dur: FX_BLAST_MS});
        }
        for (let i = 0; i < n; i++) {
            const pt = prev.type[i], nt = next.type[i];
            if (pt === nt && prev.owner[i] === next.owner[i]) continue;
            // Fades spread from the move target as a short wave.
            const wave = origin < 0 ? 0 : Math.min(FX_WAVE_MAX_MS,
                FX_WAVE_MS * (Math.abs(rowOf(i) - rowOf(origin)) + Math.abs(colOf(i) - colOf(origin))));
            if (nt === Type.EMPTY) {
                fxList.push({kind: 'vanish', at: i, t0: t0 + wave, dur: FX_FADE_MS, type: pt,
                    variant: prev.variant[i], color: prev.owner[i] === 1 ? '#3498db' : '#e67e22'});
            } else if (nt === Type.CORPSE) {
                fxList.push({kind: 'die', at: i, t0: t0 + wave, dur: FX_FADE_MS});
            } else {
                // A unit converted in place (tumour) keeps its existing link; only a new link grows.
                fxList.push({kind: 'grow', at: i, t0: t0, dur: FX_GROW_MS,
                    color: next.owner[i] === 1 ? '#3498db' : '#e67e22',
                    link: pt === Type.EMPTY || pt === Type.CORPSE || prev.parent[i] !== next.parent[i]});
            }
        }
        if (move.type === 'ATTACK' || move.type === 'DISABLE') {
            fxList.push({kind: 'strike', at: move.to, from: move.from, t0: t0, dur: FX_STRIKE_MS,
                color: move.type === 'ATTACK' ? MARK_COLORS.attack : MARK_COLORS.disable});
        }

        const kind = move.type === 'END' ? null :
            move.type === 'ATTACK' ? 'attack' : move.type === 'DISABLE' ? 'disable' : 'grow';
        if (kind !== null && origin >= 0) {
            aiStep += 1;
            const mark = aiMarks.get(origin);
            if (mark) {
                mark.steps.push(aiStep);
                mark.kind = kind;
            } else {
                aiMarks.set(origin, {steps: [aiStep], kind: kind});
            }
        }
        startFxLoop();
    }

    /* ===================== Computer opponent ===================== */

    // P2 base placement in AI mode, applied right after P1's PLACE.
    function placeAiBase() {
        let move = null;
        const ai = window.GridAI;
        if (ai && typeof ai.choosePlacement === 'function') {
            try {
                move = ai.choosePlacement(state, AI_PLAYER);
            } catch (err) {
                console.error('[Game] GridAI.choosePlacement failed', err);
            }
        }
        if (!move || Engine.validateMove(state, move) !== null) {
            if (move) console.error('[Game] GridAI.choosePlacement returned an illegal move', move);
            const options = Engine.legalMoves(state, AI_PLAYER);
            move = options[Math.floor(Math.random() * options.length)];
        }
        const prev = state;
        commitMove(move, {log: false});
        beginAiTurnMarks();
        presentAiMove(prev, move);
        writeLog(`[机器人] 在 ${cellLabel(move.to)} 放置了母体`, 'bot');
        writeLog('[系统] 机器人已部署完毕，游戏开始！', 'sys');
    }

    function scheduleAiTurn() {
        if (aiRunning || !isAiTurn()) return;
        aiRunning = true;
        const token = gameToken;
        setTimeout(() => {
            runAiTurn(token)
                .catch(err => console.error('[Game] AI turn failed', err))
                .finally(() => {
                    if (token !== gameToken) return;
                    aiRunning = false;
                    updateUI();
                    drawBoard();
                });
        }, AI_TURN_DELAY_MS);
    }

    function nextTick() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Plays micro-moves chosen by GridAI until the turn passes back or the game ends. Any failure
    // or illegal suggestion degrades to END, which is always legal during PLAY. Board-changing
    // micro-moves are applied at least AI_STEP_MS apart so that each one can be followed on screen.
    async function runAiTurn(token) {
        if (token !== gameToken || !isAiTurn()) return;
        writeLog(AI_TURN_BANNERS[aiLevel] || AI_TURN_BANNERS.EASY, 'bot');
        if (!hasAi()) writeLog('[系统] AI 模块 (ai.js) 未加载，机器人跳过回合', 'warn');
        beginAiTurnMarks();
        updateUI();
        drawBoard();
        let shownAt = -Infinity;    // time of the last board-changing AI micro-move of this turn
        while (token === gameToken && isAiTurn()) {
            const snapshot = state;
            let move = null;
            if (hasAi()) {
                try {
                    move = await window.GridAI.chooseMove(snapshot, aiLevel);
                } catch (err) {
                    console.error('[Game] GridAI.chooseMove failed', err);
                }
            }
            if (token !== gameToken || state !== snapshot || !isAiTurn()) return;
            const err = move ? Engine.validateMove(state, move) : 'no move';
            if (err !== null) {
                if (move) console.error('[Game] GridAI.chooseMove returned an illegal move', move, err);
                move = {type: 'END'};
            }
            const visible = changesBoard(state, move);
            if (visible) {
                const wait = shownAt + AI_STEP_MS - performance.now();
                if (wait > 0) {
                    // setTimeout truncates fractional delays; rounding up keeps the full interval.
                    await sleep(Math.ceil(wait));
                    if (token !== gameToken || state !== snapshot || !isAiTurn()) return;
                }
            }
            const prev = state;
            commitMove(move, {log: true});
            presentAiMove(prev, move);
            if (visible) shownAt = performance.now();
            updateUI();
            drawBoard();
            if (isAiTurn()) await nextTick();
        }
    }

    /* ===================== Native WebRTC networking ===================== */

    window.togglePeerPanel = () => {
        const isPeer = $('ai-select').value === 'PEER';
        $('peer-panel').style.display = isPeer ? 'block' : 'none';
        $('game-start-buttons').style.display = isPeer ? 'none' : 'block';
    };

    function netSend(msg) {
        if (!dc || dc.readyState !== 'open') return;
        try {
            dc.send(JSON.stringify(msg));
        } catch (err) {
            console.error('[Game] DataChannel send failed', err);
        }
    }

    // Forwards a locally applied move: {type: 'move', seq, epoch, move, hash of the resulting state}.
    function netSendMove(move) {
        if (!isNetMode) return;
        netSeq += 1;
        netSend({type: 'move', seq: netSeq, epoch: netEpoch, move: move, hash: Engine.hashState(state)});
    }

    // Host: sends the authoritative snapshot and opens a new sync epoch. Guest moves stamped with an
    // older epoch were made before the guest applied this snapshot and are ignored on arrival.
    function sendSync() {
        if (!state) return;
        netEpoch += 1;
        netSend({type: 'sync', seq: netSeq, epoch: netEpoch, state: Engine.serialize(state)});
    }

    // Any protocol mismatch: the guest asks the host for a snapshot, the host sends its own state.
    function reportDesync(reason) {
        console.warn(`[Game] network desync: ${reason}`);
        if (myRole === 'host') {
            writeLog('[系统] 检测到联机状态不一致，已发送房主棋局进行同步', 'warn');
            sendSync();
        } else if (!awaitingSync) {
            awaitingSync = true;
            writeLog('[系统] 联机状态不一致，正在向房主请求同步...', 'warn');
            netSend({type: 'desync', seq: netSeq, reason: reason});
            updateUI();
            drawBoard();
        }
    }

    function handleRemoteMove(msg) {
        if (!state) return;
        if (myRole === 'guest' && awaitingSync) return;
        // Host: a guest move from an older sync epoch was made on a state that the snapshot already
        // sent to the guest replaces; the guest drops it as well when it applies that snapshot.
        if (myRole === 'host' && msg.epoch !== netEpoch) {
            console.warn(`[Game] ignored guest move from sync epoch ${msg.epoch} (current ${netEpoch})`);
            return;
        }
        const seq = msg.seq;
        if (typeof seq !== 'number' || !Number.isInteger(seq)) return reportDesync('invalid seq');
        // The DataChannel is ordered and reliable: a repeated or older seq means that the two pages
        // disagree about the move history.
        if (seq <= netSeq) return reportDesync(`stale seq: expected ${netSeq + 1}, got ${seq}`);
        if (seq !== netSeq + 1) return reportDesync(`seq gap: expected ${netSeq + 1}, got ${seq}`);
        const remotePlayer = myRole === 'host' ? 2 : 1;
        if (state.current !== remotePlayer) return reportDesync('move received outside the sender turn');
        const err = Engine.validateMove(state, msg.move);
        if (err !== null) return reportDesync(`illegal move: ${err}`);
        // Guest: a host move whose result differs from the host state is neither applied nor logged
        // (no game-over screen from a diverged state); the host snapshot replaces the state. The host
        // is authoritative and keeps a legal guest move before it sends its snapshot.
        if (myRole === 'guest' && Engine.hashState(Engine.applyMove(state, msg.move)) !== msg.hash) {
            return reportDesync('state hash mismatch');
        }
        commitMove(msg.move, {log: true});
        netSeq = seq;
        updateUI();
        drawBoard();
        if (Engine.hashState(state) !== msg.hash) reportDesync('state hash mismatch');
    }

    // Guest: replaces the local state with the host snapshot.
    function applySync(msg) {
        let next;
        try {
            next = Engine.deserialize(msg.state);
        } catch (err) {
            console.error('[Game] invalid sync snapshot', err);
            return;
        }
        if (next.cols !== COLS || next.rows !== ROWS) configureBoard(next.cols, next.rows);
        variantPanel.style.display = next.mode === 'ADVANCED' ? 'block' : 'none';
        state = next;
        netSeq = Number.isInteger(msg.seq) ? msg.seq : 0;
        if (Number.isInteger(msg.epoch)) netEpoch = msg.epoch;
        awaitingSync = false;
        syncSelectionToState();
        writeLog('[系统] 已与房主棋局同步', 'sys');
        updateUI();
        drawBoard();
        syncGameOverScreen();
    }

    // 1. Connect to the signalling server.
    function initSignaling(roomId) {
        // ★ 直接写死云端信令服务器地址，不再自动识别网页域名
        const wsUrl = `wss://gridlinewar.li-eses.deno.net/?room=${roomId}`;

        $('net-status').innerText = `正在连接信令服务器 (${wsUrl})...`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            $('net-status').innerText = `已进入房间 ${roomId}，等待对方加入...`;
            // Keep-alive heartbeat.
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

    // 2. Create the WebRTC peer connection.
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

    // 3. Handle signalling messages (WebSocket) and game messages (DataChannel).
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
            // Flush candidates buffered before the remote description was set.
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
            // Buffer candidates until the remote description is available.
            if (pc.remoteDescription && pc.remoteDescription.type) {
                try { await pc.addIceCandidate(cand); } catch (e) {}
            } else {
                pendingCandidates.push(cand);
            }
            return;
        }

        // -------- In-game messages ----------------
        if (msg.type === 'config') {
            if (myRole === 'guest') {
                $('map-size').value = msg.data.mapSize;
                $('turn-limit').value = msg.data.turnLimit;
                startGameInternal(msg.data.mode);
            }
        } else if (msg.type === 'move') {
            handleRemoteMove(msg);
        } else if (msg.type === 'desync') {
            if (myRole === 'host') {
                console.warn('[Game] guest reported a desync', msg.reason || '');
                sendSync();
            }
        } else if (msg.type === 'sync') {
            if (myRole === 'guest') applySync(msg);
        }
    }

    function sendSignal(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    // 4. Lobby button handlers.
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

    // 5. DataChannel wiring.
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

    /* ===================== Game start ===================== */

    function configureBoard(cols, rows) {
        COLS = cols;
        ROWS = rows;
        CELL_SIZE = Math.floor(1120 / COLS);
        canvas.width = COLS * CELL_SIZE;
        canvas.height = ROWS * CELL_SIZE;
        miniMap.width = 200;
        miniMap.height = Math.floor(200 * ROWS / COLS);
    }

    function startGameInternal(mode) {
        aiLevel = isNetMode ? 'PVP' : $('ai-select').value;
        const turnLimit = parseInt($('turn-limit').value, 10) || 0;
        if (mode === 'CLASSIC') {
            variantSelect.value = '0';
        }

        const cols = Number($('map-size').value);
        configureBoard(cols, cols === 40 ? 30 : cols);
        $('start-screen').style.display = 'none';
        variantPanel.style.display = mode === 'ADVANCED' ? 'block' : 'none';

        state = Engine.createState({cols: COLS, rows: ROWS, mode: mode, turnLimit: turnLimit});
        gameToken += 1;
        aiRunning = false;
        clearAiPresentation();
        gameOverShown = false;
        awaitingSync = false;
        selectedCell = null;
        currentAction = null;
        netSeq = 0;
        netEpoch = 0;
        gameOverTitle = '';
        gameOverReason = '';
        writeLog(`[系统] 游戏初始化完成。模式: ${mode}，地图: ${COLS}x${ROWS}${turnLimit > 0 ? '，限制回合: ' + turnLimit : ''}`, 'sys');
        updateUI();
        drawBoard();
    }

    // Read-only debug hook (state objects are immutable; callers must not modify them).
    window.GridGame = Object.freeze({
        getState: () => state,
        getUiState: () => ({
            selectedCell: selectedCell,
            currentAction: currentAction,
            aiLevel: aiLevel,
            aiRunning: aiRunning,
            isNetMode: isNetMode,
            myRole: myRole,
            netSeq: netSeq,
            netEpoch: netEpoch,
            awaitingSync: awaitingSync,
            aiMarks: Array.from(aiMarks, ([at, m]) => ({at: at, steps: m.steps.slice(), kind: m.kind})),
            fxActive: fxList.filter(f => performance.now() < f.t0 + f.dur).length
        })
    });

    /* ===================== Boot ===================== */

    drawBoard();
    updateUI();
}());
