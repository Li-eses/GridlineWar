/*
 * Gridline War (格线战争) - AI module: EASY / HARD / MASTER.
 *
 * UMD module: browser global `GridAI` (classic <script>, loaded after engine.js, works under
 * file://) and Node `module.exports` (engine obtained with require('./engine.js')).
 * The AI changes game state only through GridEngine (legalMoves / validateMove / applyMove) and
 * never mutates a state object. Randomness comes from a seeded PRNG (opts.seed); Math.random()
 * is used only to draw a default seed.
 *
 * API
 *   GridAI.LEVELS                               ['EASY', 'HARD', 'MASTER']
 *   GridAI.choosePlacement(state, player, opts) PLACE move: random EMPTY cell in the own half
 *   GridAI.chooseMove(state, level, opts)       Promise<Move>, one micro-move for state.current
 *        opts.timeMs          MASTER budget for the first decision of a turn (default 1500 ms)
 *        opts.continuationMs  MASTER budget inside a pending TRUNK / CRYSTAL sequence
 *                             (default 400 ms, or 30 % of opts.timeMs when only that is given)
 *        opts.seed            PRNG seed (number)
 *        opts.onProgress(info) called after every MASTER time slice
 *        opts.stats           optional object, filled with search statistics
 *   GridAI.evaluate(state, player)              shared heuristic in [-1, 1]
 *
 * Levels
 *   EASY    Port of the original botTurnEasy as engine micro-moves.
 *   HARD    Port of the original botTurnHard: top-15 own macro moves x top-5 replies, the original
 *           presortMoves / evaluateState heuristics, greedy 3-step trunk path, small noise. The
 *           search is simulated and executed through the engine, so it can no longer break rules.
 *   MASTER  Monte Carlo tree search:
 *   - The tree is built over engine micro-moves. A turn may consist of several micro-moves of the
 *     same player (pending TRUNK / CRYSTAL), so each node stores its mover and every value is
 *     read from the perspective of the player choosing the edge.
 *   - Expansion uses legalMoves(..., {canonicalTrunk: true}). Every move receives a cheap prior
 *     score: subtree value killed by attacks / tramples, base kills, threats on the enemy base,
 *     own-base liberties and ban protection, progress towards the enemy base, cells attackable by
 *     the enemy, squeezes caused or suffered, sensible variant creation. Root moves are also
 *     ranked by a one-ply static evaluation.
 *   - Selection is PUCT with these priors and progressive widening: only the best
 *     k = kBase + kMul * sqrt(N) children (by prior) are eligible.
 *   - Leaves are scored by evaluate(): a static heuristic squashed with tanh to [-1, 1]. It models
 *     the base-kill race (turns each side needs to attack, virus-trample or squeeze the enemy
 *     base, liberties walled by corpses or enemy units at the cost of clearing them, honouring
 *     ban zones and the edge immunity of the squeeze rule), role-weighted material, capture
 *     threats for and against the side to move, squeeze vulnerabilities, and the turn-limit
 *     tie-break (minimum Euclidean distance to the enemy base). A small linear progress term
 *     (base-kill turns, distance to the enemy base), weighted by the squashed value, is added
 *     outside the tanh so that decided positions still reward progress.
 *   - Sieges: in decided positions (|value| above 0.75) the part of the value above that level
 *     shrinks with the leader's siege cost, a path search around the enemy base through
 *     corpses and enemy units (two fronts against a defender that refills cleared liberties,
 *     squeezes, and a bomb route against a ban-guarded base), and the leader's priors favour
 *     the moves that shorten it.
 *   - Solver: terminal states and states where the side to move can destroy the enemy base within
 *     the current turn are proven results; proofs propagate upwards (MCTS-Solver). The exact
 *     one-turn search covers attack, virus trample, crystal approach, squeeze-by-filling (trunk
 *     steps, branch, gene jump, tumour, crystal double move, crystal attack on the ban covering
 *     the last liberty) and bomb blasts (segments with up to three liberties, self-enclosing new
 *     bombs); every sequence it reports is verified with the engine.
 *   - Root guards: an available base kill is played at once; root moves after which the opponent
 *     can destroy our base in its next turn are proven losses and are never chosen while an
 *     alternative exists. A root move that leaves the turn in progress (trunk step, crystal first
 *     action) is a proven loss when every completion of the turn leaves the opponent a base
 *     kill; completions are checked exactly, skipping only those that cannot change the outcome
 *     of a known opponent kill (bounded work per decision, no verdict over budget).
 *   - Repetition: MASTER keeps the positions of the game it is playing (module state, reset when
 *     a state does not continue that game); in games without a turn limit, ending its turn in
 *     one of them scores as a draw.
 *   - The search runs in time slices of about 12 ms and yields (setImmediate / MessageChannel /
 *     setTimeout) between slices. It stops early once the most visited root move can no longer be
 *     overtaken in the remaining time. The subtree of the chosen move is reused for the
 *     continuation decisions of the same turn.
 *   - Memory: leaf nodes do not keep their state; a node caches its state only after several
 *     visits and is otherwise rebuilt from its parent while descending. Inner nodes keep only the
 *     best few moves by prior and extend that prefix when progressive widening needs more.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module !== null && module.exports) {
        module.exports = factory(require('./engine.js'));
    } else {
        root.GridAI = factory(root.GridEngine);
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
    'use strict';

    if (!E || typeof E.applyMove !== 'function') {
        throw new Error('GridAI: GridEngine must be loaded before ai.js');
    }

    // -----------------------------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------------------------

    const EMPTY = E.Type.EMPTY, BASE = E.Type.BASE, TRUNK = E.Type.TRUNK;
    const SOLDIER = E.Type.SOLDIER, CORPSE = E.Type.CORPSE, TUMOR = E.Type.TUMOR;
    const NORMAL = E.Variant.NORMAL, DEVOURER = E.Variant.DEVOURER, VIRUS = E.Variant.VIRUS;
    const CRYSTAL = E.Variant.CRYSTAL, GENE = E.Variant.GENE, BOMB = E.Variant.BOMB;
    const BAN = E.Variant.BAN;

    const LEVELS = Object.freeze(['EASY', 'HARD', 'MASTER']);
    const FAST = Object.freeze({validate: false, events: false});
    const CANONICAL = Object.freeze({canonicalTrunk: true});

    const DEFAULT_FIRST_MS = 1500;
    const DEFAULT_CONT_MS = 400;
    const SLICE_MS = 12;

    // -----------------------------------------------------------------------------------------
    // Utilities: PRNG, clock, yielding
    // -----------------------------------------------------------------------------------------

    function randomSeed() {
        return Math.floor(Math.random() * 4294967296) >>> 0;
    }

    // mulberry32
    function makeRng(seed) {
        let a = (seed === undefined || seed === null || !Number.isFinite(Number(seed)))
            ? randomSeed() : (Number(seed) >>> 0);
        return function () {
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const now = (typeof performance !== 'undefined' && performance !== null &&
        typeof performance.now === 'function')
        ? function () { return performance.now(); }
        : function () { return Date.now(); };

    // Yields to the event loop. setImmediate (Node) and MessageChannel (browsers) avoid the
    // 4 ms clamping of nested setTimeout calls.
    const yieldNow = (function () {
        if (typeof setImmediate === 'function') {
            return function () { return new Promise(function (r) { setImmediate(r); }); };
        }
        if (typeof MessageChannel === 'function') {
            const queue = [];
            const ch = new MessageChannel();
            ch.port1.onmessage = function () {
                const r = queue.shift();
                if (r) r();
            };
            return function () {
                return new Promise(function (r) {
                    queue.push(r);
                    ch.port2.postMessage(0);
                });
            };
        }
        return function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    }());

    function shuffle(arr, rng) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
        }
        return arr;
    }

    function copyMove(m) {
        switch (m.type) {
            case 'END': return {type: 'END'};
            case 'PLACE': return {type: 'PLACE', to: m.to};
            case 'BRANCH': return {type: 'BRANCH', from: m.from, to: m.to, variant: m.variant | 0};
            default: return {type: m.type, from: m.from, to: m.to};
        }
    }

    function endMove() {
        return {type: 'END'};
    }

    // -----------------------------------------------------------------------------------------
    // Board geometry (cached per board size)
    // -----------------------------------------------------------------------------------------

    const GEO_CACHE = new Map();

    function geometry(cols, rows) {
        const key = cols * 65536 + rows;
        let g = GEO_CACHE.get(key);
        if (g !== undefined) return g;
        const n = cols * rows;
        const row = new Int16Array(n), col = new Int16Array(n), edge = new Uint8Array(n);
        const orth = new Int32Array(n * 4).fill(-1);
        const adj = new Int32Array(n * 8).fill(-1);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                row[i] = r;
                col[i] = c;
                edge[i] = (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) ? 1 : 0;
                // Orthogonal order: up, down, left, right (the order used by the original AIs).
                if (r > 0) orth[i * 4] = i - cols;
                if (r < rows - 1) orth[i * 4 + 1] = i + cols;
                if (c > 0) orth[i * 4 + 2] = i - 1;
                if (c < cols - 1) orth[i * 4 + 3] = i + 1;
                let k = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const rr = r + dr, cc = c + dc;
                        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) adj[i * 8 + k] = rr * cols + cc;
                        k++;
                    }
                }
            }
        }
        g = {cols: cols, rows: rows, n: n, row: row, col: col, edge: edge, orth: orth, adj: adj};
        GEO_CACHE.set(key, g);
        return g;
    }

    function cheb(g, a, b) {
        const dr = g.row[a] - g.row[b], dc = g.col[a] - g.col[b];
        const ar = dr < 0 ? -dr : dr, ac = dc < 0 ? -dc : dc;
        return ar > ac ? ar : ac;
    }

    function manh(g, a, b) {
        const dr = g.row[a] - g.row[b], dc = g.col[a] - g.col[b];
        return (dr < 0 ? -dr : dr) + (dc < 0 ? -dc : dc);
    }

    function eucl(g, a, b) {
        const dr = g.row[a] - g.row[b], dc = g.col[a] - g.col[b];
        return Math.sqrt(dr * dr + dc * dc);
    }

    function isOrthNb(g, a, b) {
        return b >= 0 && manh(g, a, b) === 1;
    }

    // -----------------------------------------------------------------------------------------
    // Plan cache: continuation micro-moves of a multi-step decision, keyed by the state hash
    // -----------------------------------------------------------------------------------------

    const PLAN = new Map();

    function planKey(level, state) {
        return level + ':' + E.hashState(state);
    }

    // Returns seq[0]; stores the remaining steps for the intermediate states of the same turn.
    function startPlan(level, state, seq) {
        const p = state.current;
        let st = state;
        if (PLAN.size > 256) PLAN.clear();
        for (let k = 0; k + 1 < seq.length; k++) {
            if (E.validateMove(st, seq[k]) !== null) break;
            st = E.applyMove(st, seq[k], FAST);
            if (st.phase !== 'PLAY' || st.current !== p) break;
            PLAN.set(planKey(level, st), copyMove(seq[k + 1]));
        }
        return copyMove(seq[0]);
    }

    function takePlan(level, state) {
        if (PLAN.size === 0) return null;
        const key = planKey(level, state);
        const m = PLAN.get(key);
        if (m === undefined) return null;
        PLAN.delete(key);
        return E.validateMove(state, m) === null ? copyMove(m) : null;
    }

    // -----------------------------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------------------------

    // flags[i] = 1 when cell i has a SOLDIER child (so a SOLDIER i is not a head).
    function soldierChildFlags(s, out) {
        const n = s.cols * s.rows, type = s.type, parent = s.parent;
        const flags = out || new Uint8Array(n);
        flags.fill(0, 0, n);
        for (let i = 0; i < n; i++) {
            if (type[i] === SOLDIER) {
                const par = parent[i];
                if (par >= 0) flags[par] = 1;
            }
        }
        return flags;
    }

    // True when player x can grow trunk cells in its current (x to move) or next turn.
    function trunkAvailable(s, x) {
        if (s.current === x) {
            const pend = s.pending;
            if (pend === null) return !s.cooldown[x];
            return pend.kind === 'TRUNK';
        }
        return !s.cooldown[x];
    }

    // -----------------------------------------------------------------------------------------
    // Placement
    // -----------------------------------------------------------------------------------------

    // Random EMPTY cell in the own half, drawn like the original placeBotBase.
    function choosePlacement(state, player, opts) {
        const p = player === 1 ? 1 : 2;
        const rng = makeRng(opts && opts.seed);
        const cols = state.cols, rows = state.rows;
        const probe = state.current === p ? state : Object.assign({}, state, {current: p});
        for (let tries = 0; tries < 10000; tries++) {
            const r = Math.floor(rng() * rows);
            const c = p === 2 ? Math.floor(cols / 2 + rng() * cols / 2) : Math.floor(rng() * cols / 2);
            const to = r * cols + c;
            if (E.validateMove(probe, {type: 'PLACE', to: to}) === null) return {type: 'PLACE', to: to};
        }
        const all = E.legalMoves(probe, p);
        if (all.length === 0) throw new Error('GridAI.choosePlacement: no empty cell available');
        return copyMove(all[Math.floor(rng() * all.length)]);
    }

    // -----------------------------------------------------------------------------------------
    // EASY: port of the original botTurnEasy
    // -----------------------------------------------------------------------------------------

    function easyMove(s, rng) {
        if (s.pending !== null) {
            const planned = takePlan('EASY', s);
            return planned !== null ? planned : endMove();
        }
        const p = s.current, o = 3 - p;
        const g = geometry(s.cols, s.rows), n = g.n;
        const type = s.type, owner = s.owner, disabled = s.disabled;
        const sc = soldierChildFlags(s);

        // 1. A soldier head attacks an orthogonally adjacent live enemy unit.
        for (let i = 0; i < n; i++) {
            if (owner[i] !== p || type[i] !== SOLDIER || sc[i] || disabled[i] > 0) continue;
            for (let k = 0; k < 4; k++) {
                const j = g.orth[i * 4 + k];
                if (j < 0) continue;
                const t = type[j];
                if (t !== EMPTY && t !== TUMOR && t !== CORPSE && owner[j] === o) {
                    const m = {type: 'ATTACK', from: i, to: j};
                    if (E.validateMove(s, m) === null) return startPlan('EASY', s, [m, endMove()]);
                    break;
                }
            }
        }

        // 2. Not on cooldown: grow up to 3 random trunk cells.
        if (!s.cooldown[p]) {
            const pairs = [];
            for (let i = 0; i < n; i++) {
                if (owner[i] !== p || (type[i] !== BASE && type[i] !== TRUNK)) continue;
                for (let k = 0; k < 8; k++) {
                    const j = g.adj[i * 8 + k];
                    if (j >= 0 && type[j] === EMPTY && !E.isEnemyBanned(s, j, p)) pairs.push(i, j);
                }
            }
            const order = [];
            for (let k = 0; k < pairs.length; k += 2) order.push(k);
            shuffle(order, rng);
            const seq = [], used = new Set();
            for (let k = 0; k < order.length && seq.length < 3; k++) {
                const from = pairs[order[k]], to = pairs[order[k] + 1];
                if (used.has(to)) continue;
                used.add(to);
                seq.push({type: 'TRUNK', from: from, to: to});
            }
            if (seq.length > 0) {
                if (seq.length < 3) seq.push(endMove());
                return startPlan('EASY', s, seq);
            }
        }

        // 3. Grow / extend a branch from the first head with a free neighbour.
        for (let i = 0; i < n; i++) {
            if (owner[i] !== p || disabled[i] > 0) continue;
            const t = type[i];
            if (t !== TRUNK && !(t === SOLDIER && !sc[i])) continue;
            for (let k = 0; k < 8; k++) {
                const j = g.adj[i * 8 + k];
                if (j < 0 || type[j] !== EMPTY || E.isEnemyBanned(s, j, p)) continue;
                const m = {type: 'BRANCH', from: i, to: j, variant: NORMAL};
                if (E.validateMove(s, m) === null) return startPlan('EASY', s, [m, endMove()]);
            }
        }
        return endMove();
    }

    // -----------------------------------------------------------------------------------------
    // HARD: port of the original botTurnHard (getSimulatedMoves / presortMoves / evaluateState)
    // -----------------------------------------------------------------------------------------

    const HARD_JUMPS = [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [-2, 2], [2, -2], [2, 2]];
    const HARD_ADV_VARIANTS = [VIRUS, CRYSTAL, BOMB, GENE];

    function minDistToBase(s, p, base, g) {
        const type = s.type, owner = s.owner, n = g.n;
        let best = Infinity;
        for (let i = 0; i < n; i++) {
            if (owner[i] !== p) continue;
            const t = type[i];
            if (t === EMPTY || t === CORPSE) continue;
            const d = Math.hypot(g.row[i] - g.row[base], g.col[i] - g.col[base]);
            if (d < best) best = d;
        }
        return best;
    }

    // Candidate macro moves in the original generation order, kept only when legal in the engine.
    function hardGenMoves(s, p, isCooldown, g, sc) {
        const out = [];
        if (s.phase !== 'PLAY' || s.current !== p) return out;
        const n = g.n, cols = g.cols, rows = g.rows;
        const type = s.type, owner = s.owner, variant = s.variant, disabled = s.disabled;
        const adv = s.mode === 'ADVANCED';
        let hasV = null, hasBan = false;
        for (let i = 0; i < n; i++) {
            if (owner[i] !== p || disabled[i] > 0) continue;
            const t = type[i];
            if (t === SOLDIER && !sc[i]) {
                for (let k = 0; k < 4; k++) {
                    const j = g.orth[i * 4 + k];
                    if (j < 0) continue;
                    const tt = type[j];
                    if (tt === EMPTY || tt === TUMOR) continue;
                    if (owner[j] === p && tt !== CORPSE) continue;
                    pushIfLegal(s, out, 'ATTACK', i, j, -1, {type: 'ATTACK', from: i, to: j});
                }
                const v = variant[i];
                for (let k = 0; k < 8; k++) {
                    const j = g.adj[i * 8 + k];
                    if (j >= 0 && type[j] === EMPTY) {
                        pushIfLegal(s, out, 'MOVE', i, j, v, {type: 'BRANCH', from: i, to: j, variant: v});
                    }
                }
                if (v === GENE) {
                    const r = g.row[i], c = g.col[i];
                    for (let k = 0; k < HARD_JUMPS.length; k++) {
                        const tr = r + HARD_JUMPS[k][0], tc = c + HARD_JUMPS[k][1];
                        const mr = r + HARD_JUMPS[k][0] / 2, mc = c + HARD_JUMPS[k][1] / 2;
                        if (tr < 0 || tr >= rows || tc < 0 || tc >= cols) continue;
                        const j = tr * cols + tc, mid = mr * cols + mc;
                        if (type[j] === EMPTY && type[mid] !== EMPTY) {
                            pushIfLegal(s, out, 'MOVE', i, j, v, {type: 'BRANCH', from: i, to: j, variant: v});
                        }
                    }
                }
            }
            if (t === BASE || t === TRUNK) {
                if (t === TRUNK) {
                    if (adv && hasV === null) {
                        hasV = [];
                        for (let k = 0; k < HARD_ADV_VARIANTS.length; k++) {
                            hasV.push(E.hasVariantOnField(s, p, HARD_ADV_VARIANTS[k]));
                        }
                        hasBan = E.hasVariantOnField(s, p, BAN);
                    }
                    for (let k = 0; k < 8; k++) {
                        const j = g.adj[i * 8 + k];
                        if (j < 0 || type[j] !== EMPTY || E.isEnemyBanned(s, j, p)) continue;
                        pushIfLegal(s, out, 'GROW_SOLDIER', i, j, NORMAL,
                            {type: 'BRANCH', from: i, to: j, variant: NORMAL});
                        if (adv) {
                            for (let q = 0; q < HARD_ADV_VARIANTS.length; q++) {
                                if (hasV[q]) continue;
                                const vv = HARD_ADV_VARIANTS[q];
                                pushIfLegal(s, out, 'GROW_SOLDIER', i, j, vv,
                                    {type: 'BRANCH', from: i, to: j, variant: vv});
                            }
                            if (!hasBan) {
                                pushIfLegal(s, out, 'GROW_SOLDIER', i, j, BAN,
                                    {type: 'BRANCH', from: i, to: j, variant: BAN});
                            }
                        }
                    }
                }
                if (!isCooldown) {
                    for (let k = 0; k < 8; k++) {
                        const j = g.adj[i * 8 + k];
                        if (j < 0 || type[j] !== EMPTY || E.isEnemyBanned(s, j, p)) continue;
                        pushIfLegal(s, out, 'GROW_TRUNK', i, j, -1, {type: 'TRUNK', from: i, to: j});
                    }
                }
            }
        }
        return out;
    }

    function pushIfLegal(s, out, action, src, target, variant, first) {
        if (E.validateMove(s, first) !== null) return;
        out.push({action: action, src: src, target: target, variant: variant, first: first, score: 0});
    }

    function hardPresort(s, moves, p, tc, g) {
        const type = s.type, owner = s.owner, o = 3 - p;
        const myBase = E.findBase(s, p);
        let isEmergency = false, dangerTile = -1;
        let baseThreatened = false;
        if (myBase >= 0) {
            let emptyCount = 0;
            for (let k = 0; k < 4; k++) {
                const j = g.orth[myBase * 4 + k];
                if (j >= 0 && type[j] === EMPTY) {
                    emptyCount++;
                    dangerTile = j;
                }
            }
            if (emptyCount === 1) isEmergency = true;
            for (let k = 0; k < 4; k++) {
                const j = g.orth[myBase * 4 + k];
                if (j >= 0 && owner[j] === o && type[j] !== EMPTY && type[j] !== CORPSE) baseThreatened = true;
            }
        }
        let mustRush = false;
        const tl = s.turnLimit;
        if (tl > 0 && myBase >= 0 && !baseThreatened) {
            const enBase = E.findBase(s, o);
            if (enBase >= 0) {
                const remaining = tl - Math.floor(tc / 2);
                const myMin = minDistToBase(s, p, enBase, g);
                const enMin = minDistToBase(s, o, myBase, g);
                if (enMin < myMin || remaining < 15) mustRush = true;
            }
        }
        for (let k = 0; k < moves.length; k++) {
            const m = moves[k];
            const tg = m.target;
            m.score = 1;
            if (m.action === 'ATTACK') {
                if (type[tg] === CORPSE) m.score = 25;
                else if (owner[tg] !== p) m.score = 200;
                if (type[tg] === BASE) m.score = 999999;
                if (myBase >= 0 && owner[tg] !== p) {
                    const d = Math.hypot(g.row[tg] - g.row[myBase], g.col[tg] - g.col[myBase]);
                    if (d <= 3) m.score += 10000;
                }
            }
            if (m.action === 'MOVE' || m.action === 'GROW_SOLDIER') {
                m.score = 15;
                if (m.variant === VIRUS) m.score += 10;
                if (mustRush) m.score += 500;
            }
            if (m.action === 'GROW_TRUNK') {
                m.score = 5;
                if (mustRush) m.score += 2000;
            }
            if (isEmergency && dangerTile >= 0 && tg === dangerTile) m.score += 1000000;
            if (isEmergency && myBase >= 0) {
                const d = Math.hypot(g.row[tg] - g.row[myBase], g.col[tg] - g.col[myBase]);
                if (d <= 2 && m.action !== 'ATTACK') m.score += 5000;
            }
            if (baseThreatened && myBase >= 0) {
                const d = Math.hypot(g.row[tg] - g.row[myBase], g.col[tg] - g.col[myBase]);
                if (m.action === 'ATTACK' && d <= 1 && owner[tg] === o) m.score += 500000;
                if (d <= 1) m.score += 50000;
                if (d > 3) m.score -= 100000;
            }
        }
        // Array.prototype.sort is stable, as in the original.
        moves.sort(function (a, b) { return b.score - a.score; });
        return moves;
    }

    function hardEvaluate(s, p, trunkFlag, tc, g) {
        const o = 3 - p;
        const type = s.type, owner = s.owner, variant = s.variant, n = g.n;
        const myBase = E.findBase(s, p), enBase = E.findBase(s, o);
        if (enBase < 0 && myBase >= 0) return 1000000;
        if (myBase < 0 && enBase >= 0) return -1000000;
        const tl = s.turnLimit;
        let aggression = 1.5 + Math.min(3.0, tc / 10);
        if (tl > 0 && tc >= (tl * 2 - 4)) aggression += 5.0;

        let baseThreatened = false;
        if (myBase >= 0) {
            const br = g.row[myBase], bc = g.col[myBase];
            for (let r = br - 1; r <= br + 1; r++) {
                for (let c = bc - 1; c <= bc + 1; c++) {
                    if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) continue;
                    const j = r * g.cols + c;
                    if (owner[j] === o && type[j] !== EMPTY && type[j] !== CORPSE) baseThreatened = true;
                }
            }
        }
        let mustRush = false;
        if (tl > 0 && myBase >= 0 && enBase >= 0 && !baseThreatened) {
            const remaining = tl - Math.floor(tc / 2);
            const myMin = minDistToBase(s, p, enBase, g);
            const enMin = minDistToBase(s, o, myBase, g);
            if (enMin < myMin || remaining < 15) mustRush = true;
        }

        let score = 0;
        for (let i = 0; i < n; i++) {
            const t = type[i];
            if (t === EMPTY) continue;
            let val = 1;
            if (t === TRUNK) val = 1.5;
            if (t === SOLDIER && variant[i] !== NORMAL) val = 4;
            if (t === TUMOR) val = 2;
            if (t === CORPSE) val = 0.1;
            let blocked = 0;
            for (let k = 0; k < 4; k++) {
                const j = g.orth[i * 4 + k];
                if (j < 0 || type[j] !== EMPTY) blocked++;
            }
            const isDev = t === SOLDIER && variant[i] === DEVOURER;
            if (blocked === 4 && !isDev && t !== CORPSE && t !== TUMOR) val = -10;
            else if (blocked === 3 && t !== TUMOR) val -= 2;

            if (owner[i] === p) {
                score += val;
                if (t === BASE) {
                    if (blocked === 3) score -= 50000;
                    if (blocked === 4) score -= 500000;
                    let enemyNear = false;
                    for (let k = 0; k < 4; k++) {
                        const j = g.orth[i * 4 + k];
                        if (j >= 0 && owner[j] === o && (type[j] === SOLDIER || type[j] === TRUNK)) enemyNear = true;
                    }
                    if (enemyNear) score -= 500000;
                }
                if (enBase >= 0 && t !== CORPSE) {
                    const d = Math.hypot(g.row[i] - g.row[enBase], g.col[i] - g.col[enBase]);
                    if (mustRush) score += Math.max(0, 40 - d) * 20 * aggression;
                    else if (!baseThreatened) score += Math.max(0, 40 - d) * 0.5 * aggression;
                }
            } else {
                score -= val * 15;
                if (blocked === 3) score += 2000;
                if (blocked === 4) score += 5000;
                if (t === BASE) {
                    if (blocked === 3) score += 50000;
                    if (blocked === 4) score += 500000;
                }
                if (myBase >= 0) {
                    const d = Math.hypot(g.row[i] - g.row[myBase], g.col[i] - g.col[myBase]);
                    if (d <= 3) score -= Math.pow(10, 4 - d) * 200;
                }
            }
        }
        for (let i = 0; i < n; i++) {
            if (owner[i] !== p || (type[i] !== TRUNK && type[i] !== BASE)) continue;
            const r = g.row[i], c = g.col[i];
            let enemyNear = false;
            for (let dr = -2; dr <= 2 && !enemyNear; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    if (Math.abs(dr) + Math.abs(dc) > 2) continue;
                    const rr = r + dr, cc = c + dc;
                    if (rr < 0 || rr >= g.rows || cc < 0 || cc >= g.cols) continue;
                    const j = rr * g.cols + cc;
                    if (owner[j] === o && (type[j] === SOLDIER || type[j] === TRUNK)) {
                        enemyNear = true;
                        break;
                    }
                }
            }
            if (enemyNear) score -= 10;
        }
        if (trunkFlag) score -= 5;
        return score;
    }

    // Greedy next trunk cell from `cur` towards the enemy base (original path rule), or -1.
    function hardGreedyNext(s, p, cur, g) {
        const type = s.type;
        const enBase = E.findBase(s, 3 - p);
        let bestDist = Infinity, next = -1;
        for (let k = 0; k < 8; k++) {
            const t = g.adj[cur * 8 + k];
            if (t < 0 || type[t] !== EMPTY || E.isEnemyBanned(s, t, p)) continue;
            const dist = enBase >= 0 ? Math.hypot(g.row[t] - g.row[enBase], g.col[t] - g.col[enBase]) : 0;
            if (dist < bestDist) {
                let blocked = 0;
                for (let q = 0; q < 4; q++) {
                    const nt = g.orth[cur * 4 + q];
                    if (nt >= 0 && type[nt] !== EMPTY && nt !== t) blocked++;
                }
                if (blocked >= 3) continue;
                bestDist = dist;
                next = t;
            }
        }
        return next;
    }

    // Plays a macro move through the engine until the mover's turn ends. Returns {state, seq}.
    function hardExecute(s, mv, g) {
        const p = s.current;
        const seq = [mv.first];
        let st = E.applyMove(s, mv.first, FAST);
        if (mv.action === 'GROW_TRUNK') {
            let cur = mv.target;
            while (st.phase === 'PLAY' && st.current === p && st.pending !== null &&
                st.pending.kind === 'TRUNK') {
                const nx = hardGreedyNext(st, p, cur, g);
                if (nx < 0) break;
                const m = {type: 'TRUNK', from: cur, to: nx};
                seq.push(m);
                st = E.applyMove(st, m, FAST);
                cur = nx;
            }
        }
        if (st.phase === 'PLAY' && st.current === p) {
            const m = endMove();
            seq.push(m);
            st = E.applyMove(st, m, FAST);
        }
        return {state: st, seq: seq};
    }

    async function hardMove(s, rng) {
        const p = s.current, o = 3 - p;
        const g = geometry(s.cols, s.rows);
        if (s.pending !== null) {
            const planned = takePlan('HARD', s);
            if (planned !== null) return planned;
            if (s.pending.kind === 'TRUNK' && s.pending.last >= 0) {
                const nx = hardGreedyNext(s, p, s.pending.last, g);
                if (nx >= 0) return {type: 'TRUNK', from: s.pending.last, to: nx};
            }
            return endMove();
        }
        const tc = s.turnCount;
        const sc = new Uint8Array(g.n);
        soldierChildFlags(s, sc);
        let myMoves = hardGenMoves(s, p, s.cooldown[p], g, sc);
        if (myMoves.length === 0) return endMove();
        myMoves = hardPresort(s, myMoves, p, tc, g).slice(0, 15);
        let best = null, bestScore = -Infinity;
        let sliceStart = now();
        for (let k = 0; k < myMoves.length; k++) {
            const mv = myMoves[k];
            const r1 = hardExecute(s, mv, g);
            const s1 = r1.state;
            let worst = Infinity;
            let enemyMoves = [];
            if (s1.phase === 'PLAY') {
                soldierChildFlags(s1, sc);
                enemyMoves = hardGenMoves(s1, o, s1.cooldown[o], g, sc);
            }
            if (enemyMoves.length === 0) {
                worst = hardEvaluate(s1, p, false, tc, g);
            } else {
                enemyMoves = hardPresort(s1, enemyMoves, o, tc, g).slice(0, 5);
                const trunkFlag = mv.action === 'GROW_TRUNK';
                for (let q = 0; q < enemyMoves.length; q++) {
                    const s2 = hardExecute(s1, enemyMoves[q], g).state;
                    const sc2 = hardEvaluate(s2, p, trunkFlag, tc, g);
                    if (sc2 < worst) worst = sc2;
                }
            }
            const finalScore = worst + rng() * 0.5;
            if (finalScore > bestScore) {
                bestScore = finalScore;
                best = r1;
            }
            if (now() - sliceStart > SLICE_MS) {
                await yieldNow();
                sliceStart = now();
            }
        }
        if (best === null) return endMove();
        return startPlan('HARD', s, best.seq);
    }

    // -----------------------------------------------------------------------------------------
    // MASTER: scratch buffers and position analysis
    // -----------------------------------------------------------------------------------------

    let SN = 0;
    let A_SC = new Uint8Array(0);     // soldier-child flags
    let A_BAN = new Uint8Array(0);    // bit (1 << p): cell is inside an enemy ban zone of p
    let A_DEPTH = new Int32Array(0);
    let A_ORDER = new Int32Array(0);
    let A_CNT = new Int32Array(0);
    let A_STACK = new Int32Array(0);
    let A_SUB = new Float64Array(0);  // weighted value of the live subtree rooted at a cell
    let A_THR = new Uint8Array(0);    // prior scoring: enemy attack (1) / trample (2) reach

    function ensureScratch(n) {
        if (n <= SN) return;
        A_SC = new Uint8Array(n);
        A_BAN = new Uint8Array(n);
        A_DEPTH = new Int32Array(n);
        A_ORDER = new Int32Array(n);
        A_CNT = new Int32Array(n + 2);
        A_STACK = new Int32Array(n + 1);
        A_SUB = new Float64Array(n);
        A_THR = new Uint8Array(n);
        SN = n;
    }

    // Unit weights. Tumours survive chain death, so they carry no subtree loss value.
    const W_TRUNK = 1.0, W_HEAD = 1.0, W_BODY = 0.6, W_TUMOR_MAT = 0.4;
    const VARIANT_BONUS = [0, 0.5, 1.5, 0.8, 0.6, 0.4, 1.0];

    // Results of the last analyze() call (index by player).
    const AN = {
        base: [-1, -1, -1],
        virus: [false, false, false],
        crystal: [false, false, false],
        mat: [0, 0, 0],
        dmin: [0, 0, 0],      // min Euclidean distance of a live unit to the enemy base
        banGuard: [false, false, false]
    };

    function markBan(g, ban, i, bit) {
        const r = g.row[i], c = g.col[i], cols = g.cols, rows = g.rows;
        for (let dr = -2; dr <= 2; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            const w = 2 - (dr < 0 ? -dr : dr);
            for (let dc = -w; dc <= w; dc++) {
                const cc = c + dc;
                if (cc >= 0 && cc < cols) ban[rr * cols + cc] |= bit;
            }
        }
    }

    function analyze(s) {
        const g = geometry(s.cols, s.rows), n = g.n;
        ensureScratch(n);
        const type = s.type, owner = s.owner, variant = s.variant, parent = s.parent;
        const sc = A_SC, ban = A_BAN, depth = A_DEPTH, sub = A_SUB, stack = A_STACK;
        sc.fill(0, 0, n);
        ban.fill(0, 0, n);
        AN.base[1] = AN.base[2] = -1;
        AN.virus[1] = AN.virus[2] = false;
        AN.crystal[1] = AN.crystal[2] = false;
        for (let i = 0; i < n; i++) {
            depth[i] = -1;
            sub[i] = 0;
            const t = type[i];
            if (t === EMPTY) continue;
            const o = owner[i];
            if (t === BASE) {
                AN.base[o] = i;
            } else if (t === SOLDIER) {
                const par = parent[i];
                if (par >= 0) sc[par] = 1;
                const v = variant[i];
                if (v === VIRUS) AN.virus[o] = true;
                else if (v === CRYSTAL) AN.crystal[o] = true;
                else if (v === BAN && o !== 0) markBan(g, ban, i, 1 << (3 - o));
            }
        }
        // Depth of every live cell along parent links.
        let maxD = 0;
        for (let i = 0; i < n; i++) {
            const t = type[i];
            if (t === EMPTY || t === CORPSE || depth[i] >= 0) continue;
            let x = i, len = 0;
            while (x >= 0 && depth[x] < 0 && len < n) {
                stack[len++] = x;
                x = parent[x];
            }
            let d = x >= 0 ? depth[x] : -1;
            while (len > 0) {
                d++;
                depth[stack[--len]] = d;
            }
            if (d > maxD) maxD = d;
        }
        const cnt = A_CNT, order = A_ORDER;
        cnt.fill(0, 0, maxD + 1);
        for (let i = 0; i < n; i++) if (depth[i] >= 0) cnt[depth[i]]++;
        let pos = 0;
        for (let d = maxD; d >= 0; d--) {
            const c = cnt[d];
            cnt[d] = pos;
            pos += c;
        }
        for (let i = 0; i < n; i++) if (depth[i] >= 0) order[cnt[depth[i]]++] = i;
        // Children before parents: accumulate subtree values, material and frontier distance.
        const b1 = AN.base[1], b2 = AN.base[2];
        let m1 = 0, m2 = 0, d1 = 99, d2 = 99;
        for (let k = 0; k < pos; k++) {
            const i = order[k];
            const t = type[i];
            let w = 0, mat = 0;
            if (t === TRUNK) {
                w = W_TRUNK;
                mat = w;
            } else if (t === SOLDIER) {
                w = (sc[i] ? W_BODY : W_HEAD) + VARIANT_BONUS[variant[i]];
                mat = w;
            } else if (t === TUMOR) {
                mat = W_TUMOR_MAT;
            }
            const s0 = sub[i] + w;
            sub[i] = s0;
            const par = parent[i];
            if (par >= 0) sub[par] += s0;
            if (owner[i] === 1) {
                m1 += mat;
                if (b2 >= 0) {
                    const d = eucl(g, i, b2);
                    if (d < d1) d1 = d;
                }
            } else {
                m2 += mat;
                if (b1 >= 0) {
                    const d = eucl(g, i, b1);
                    if (d < d2) d2 = d;
                }
            }
        }
        AN.mat[1] = m1;
        AN.mat[2] = m2;
        AN.dmin[1] = d1;
        AN.dmin[2] = d2;
        AN.banGuard[1] = b1 >= 0 && (ban[b1] & 4) !== 0;
        AN.banGuard[2] = b2 >= 0 && (ban[b2] & 2) !== 0;
        return AN;
    }

    // -----------------------------------------------------------------------------------------
    // MASTER: exact base-kill detection within the current turn
    // -----------------------------------------------------------------------------------------

    const KILL_CACHE = new Map();

    function stillMover(st, p) {
        return st.phase === 'PLAY' && st.current === p;
    }

    function wins(st, p) {
        return st.phase === 'OVER' && st.winner === p;
    }

    // Move sequence for player p (the side to move) that destroys the enemy base within the
    // current turn, or null. Covers adjacent attack, virus trample (head or new virus branch),
    // crystal approach + attack, squeezes by filling the last liberties (trunk steps, branch,
    // gene jump, tumour, crystal double move, crystal move next to the last liberty or crystal
    // attack on the unit whose ban covers it, then the fill) and bomb blasts that reach the
    // base. Every returned sequence was replayed with the engine.
    function findKill(s, p) {
        const res = directKill(s, p);
        return res !== null ? res : blastKill(s, p);
    }

    // Kills that act on the enemy base or its own liberties (everything except bomb blasts).
    function directKill(s, p) {
        if (s.phase !== 'PLAY' || s.current !== p) return null;
        const o = 3 - p;
        const b = E.findBase(s, o);
        if (b < 0) return null;
        const g = geometry(s.cols, s.rows);
        const type = s.type, owner = s.owner, variant = s.variant, disabled = s.disabled;
        const pend = s.pending;
        const trunkPend = pend !== null && pend.kind === 'TRUNK';
        const crystalAt = pend !== null && pend.kind === 'CRYSTAL' ? pend.at : -1;
        const adv = s.mode === 'ADVANCED';

        if (!trunkPend) {
            for (let k = 0; k < 4; k++) {
                const a = g.orth[b * 4 + k];
                if (a < 0 || owner[a] !== p || type[a] !== SOLDIER || disabled[a] !== 0) continue;
                if (crystalAt >= 0 && crystalAt !== a) continue;
                const m = {type: 'ATTACK', from: a, to: b};
                if (E.validateMove(s, m) === null) return [m];
            }
            if (adv) {
                for (let k = 0; k < 8; k++) {
                    const a = g.adj[b * 8 + k];
                    if (a < 0 || owner[a] !== p || disabled[a] !== 0) continue;
                    if (crystalAt >= 0 && crystalAt !== a) continue;
                    const t = type[a];
                    if ((t === SOLDIER && variant[a] === VIRUS) || t === TRUNK) {
                        const m = {type: 'BRANCH', from: a, to: b, variant: VIRUS};
                        if (E.validateMove(s, m) === null) return [m];
                    }
                }
            }
        }

        // Cheap exit: no own unit near the enemy base.
        const R = 4, br = g.row[b], bc = g.col[b];
        let near = false;
        for (let r = br - R; r <= br + R && !near; r++) {
            if (r < 0 || r >= g.rows) continue;
            for (let c = bc - R; c <= bc + R; c++) {
                if (c < 0 || c >= g.cols) continue;
                const j = r * g.cols + c;
                if (owner[j] === p && type[j] >= BASE && type[j] <= SOLDIER) {
                    near = true;
                    break;
                }
            }
        }
        if (!near) return null;

        const edge = g.edge[b] === 1;
        let k = 0, bannedLib = false;
        for (let q = 0; q < 4; q++) {
            const a = g.orth[b * 4 + q];
            if (a >= 0 && type[a] === EMPTY) {
                k++;
                if (E.isEnemyBanned(s, a, p)) bannedLib = true;
            }
        }
        if (!edge && k === 0) {
            const m = endMove();
            return wins(E.applyMove(s, m, FAST), p) ? [m] : null;
        }
        if (k === 0) return null;
        // Deeper searches are memoised by state hash.
        const key = E.hashState(s);
        const cached = KILL_CACHE.get(key);
        if (cached !== undefined) return cached === null ? null : cached.map(copyMove);
        let res = null;
        if (!edge && !bannedLib && k <= 3) {
            let steps = 0;
            if (trunkPend) steps = 3 - pend.count;
            else if (pend === null && !s.cooldown[p]) steps = 3;
            if (steps >= k) res = trunkFill(s, p, b, g, steps);
        }
        if (res === null && !trunkPend) res = branchFill(s, p, b, g, 2);
        if (res === null && !edge && k === 1 && pend === null && adv) res = crystalFill(s, p, b, g);
        if (KILL_CACHE.size > 20000) KILL_CACHE.clear();
        KILL_CACHE.set(key, res);
        return res === null ? null : res.map(copyMove);
    }

    function trunkParent(st, p, t, g) {
        const pend = st.pending;
        if (pend !== null && pend.kind === 'TRUNK' && pend.last >= 0 && cheb(g, pend.last, t) === 1 &&
            st.owner[pend.last] === p && st.type[pend.last] === TRUNK) {
            return pend.last;
        }
        for (let k = 0; k < 8; k++) {
            const f = g.adj[t * 8 + k];
            if (f >= 0 && st.owner[f] === p && (st.type[f] === BASE || st.type[f] === TRUNK)) return f;
        }
        return -1;
    }

    // Squeeze the enemy base `b` with up to `steps` trunk cells, then end the turn.
    function trunkFill(st, p, b, g, steps) {
        const type = st.type;
        const libs = [];
        for (let q = 0; q < 4; q++) {
            const a = g.orth[b * 4 + q];
            if (a >= 0 && type[a] === EMPTY) libs.push(a);
        }
        if (libs.length === 0) {
            const m = endMove();
            return wins(E.applyMove(st, m, FAST), p) ? [m] : null;
        }
        if (steps < libs.length) return null;
        const slack = steps - libs.length;
        const cand = libs.slice();
        if (slack > 0) {
            const R = slack + 1, br = g.row[b], bc = g.col[b];
            for (let r = br - R; r <= br + R; r++) {
                if (r < 0 || r >= g.rows) continue;
                for (let c = bc - R; c <= bc + R; c++) {
                    if (c < 0 || c >= g.cols) continue;
                    const t = r * g.cols + c;
                    if (type[t] !== EMPTY || t === b || libs.indexOf(t) >= 0) continue;
                    let dmin = 99;
                    for (let q = 0; q < libs.length; q++) {
                        const d = cheb(g, t, libs[q]);
                        if (d < dmin) dmin = d;
                    }
                    if (dmin <= slack) cand.push(t);
                }
            }
        }
        for (let q = 0; q < cand.length; q++) {
            const t = cand[q];
            const f = trunkParent(st, p, t, g);
            if (f < 0) continue;
            const m = {type: 'TRUNK', from: f, to: t};
            if (E.validateMove(st, m) !== null) continue;
            const st2 = E.applyMove(st, m, FAST);
            if (st2.phase === 'OVER') {
                if (st2.winner === p) return [m];
                continue;
            }
            if (st2.current !== p) continue;
            const rest = trunkFill(st2, p, b, g, steps - 1);
            if (rest !== null) return [m].concat(rest);
        }
        return null;
    }

    // Fill moves (BRANCH / TUMOR) into cell `lib` for the side to move. Sources two cells away
    // can only reach it with a gene jump (gene head, or a trunk creating a gene).
    function fillMoves(st, p, lib, g) {
        const out = [];
        const type = st.type, owner = st.owner, variant = st.variant, disabled = st.disabled;
        const pend = st.pending;
        const crystalAt = pend !== null && pend.kind === 'CRYSTAL' ? pend.at : -1;
        const adv = st.mode === 'ADVANCED';
        const r0 = g.row[lib], c0 = g.col[lib];
        for (let r = r0 - 2; r <= r0 + 2; r++) {
            if (r < 0 || r >= g.rows) continue;
            for (let c = c0 - 2; c <= c0 + 2; c++) {
                if (c < 0 || c >= g.cols) continue;
                const x = r * g.cols + c;
                if (owner[x] !== p || disabled[x] !== 0 || x === lib) continue;
                if (crystalAt >= 0 && x !== crystalAt) continue;
                const t = type[x];
                if (cheb(g, x, lib) === 2) {
                    if (!adv) continue;
                    if (t === TRUNK || (t === SOLDIER && variant[x] === GENE)) {
                        tryPush(st, out, {type: 'BRANCH', from: x, to: lib, variant: GENE});
                    }
                } else if (t === TRUNK) {
                    tryPush(st, out, {type: 'BRANCH', from: x, to: lib, variant: NORMAL});
                    if (adv) tryPush(st, out, {type: 'BRANCH', from: x, to: lib, variant: CRYSTAL});
                } else if (t === SOLDIER) {
                    tryPush(st, out, {type: 'BRANCH', from: x, to: lib, variant: variant[x]});
                    if (variant[x] === GENE) tryPush(st, out, {type: 'TUMOR', from: x, to: lib});
                }
            }
        }
        return out;
    }

    function tryPush(st, out, m) {
        if (E.validateMove(st, m) === null) out.push(m);
    }

    // Branch-based kills: single fill of the last liberty, crystal double fill, or a crystal
    // move onto a liberty followed by the extra attack on the base. `b` is the enemy base or a
    // bomb segment whose squeeze blast reaches it (then only fills count, never the attack).
    function branchFill(st, p, b, g, depth) {
        const type = st.type;
        const libs = [];
        for (let q = 0; q < 4; q++) {
            const a = g.orth[b * 4 + q];
            if (a >= 0 && type[a] === EMPTY && !E.isEnemyBanned(st, a, p)) libs.push(a);
        }
        for (let q = 0; q < libs.length; q++) {
            const ms = fillMoves(st, p, libs[q], g);
            for (let k = 0; k < ms.length; k++) {
                const m = ms[k];
                const st2 = E.applyMove(st, m, FAST);
                if (st2.phase === 'OVER') {
                    if (st2.winner === p) return [m];
                    continue;
                }
                if (st2.current !== p) continue;
                const at = st2.pending !== null && st2.pending.kind === 'CRYSTAL' ? st2.pending.at : -1;
                if (at >= 0 && st2.type[b] === BASE) {
                    const att = {type: 'ATTACK', from: at, to: b};
                    if (E.validateMove(st2, att) === null) return [m, att];
                }
                const e = endMove();
                if (wins(E.applyMove(st2, e, FAST), p)) return [m, e];
                if (depth > 1) {
                    const rest = branchFill(st2, p, b, g, depth - 1);
                    if (rest !== null) return [m].concat(rest);
                }
            }
        }
        return null;
    }

    // Crystal kills at the start of a turn on `b` (enemy base or bomb segment) whose single empty
    // liberty `lib` no unit reaches directly: a crystal branch (from a crystal head or a trunk two
    // cells away) onto a cell next to `lib`, then the extra branch into `lib`; or, when `lib` lies
    // in an enemy ban zone, an attack of an adjacent crystal head on an enemy unit (the ban or an
    // ancestor of it), then the extra branch into `lib`.
    function crystalFill(st, p, b, g) {
        const type = st.type, owner = st.owner, variant = st.variant, disabled = st.disabled;
        let lib = -1;
        for (let q = 0; q < 4; q++) {
            const a = g.orth[b * 4 + q];
            if (a >= 0 && type[a] === EMPTY) lib = a;
        }
        if (lib < 0) return null;
        const banned = E.isEnemyBanned(st, lib, p);
        const r0 = g.row[lib], c0 = g.col[lib];
        for (let r = r0 - 2; r <= r0 + 2; r++) {
            if (r < 0 || r >= g.rows) continue;
            for (let c = c0 - 2; c <= c0 + 2; c++) {
                if (c < 0 || c >= g.cols) continue;
                const x = r * g.cols + c;
                if (owner[x] !== p || disabled[x] !== 0) continue;
                const t = type[x];
                const crystal = t === SOLDIER && variant[x] === CRYSTAL;
                if (!crystal && t !== TRUNK) continue;
                const d = cheb(g, x, lib);
                if (banned) {
                    if (!crystal || d !== 1) continue;
                    for (let q = 0; q < 4; q++) {
                        const z = g.orth[x * 4 + q];
                        if (z < 0 || owner[z] === p || owner[z] === 0) continue;
                        if (type[z] !== TRUNK && type[z] !== SOLDIER) continue;
                        const res = crystalPair(st, p, {type: 'ATTACK', from: x, to: z}, x, lib);
                        if (res !== null) return res;
                    }
                } else if (d === 2) {
                    for (let k = 0; k < 8; k++) {
                        const y = g.adj[x * 8 + k];
                        if (y < 0 || type[y] !== EMPTY || cheb(g, y, lib) !== 1) continue;
                        const m = {type: 'BRANCH', from: x, to: y, variant: CRYSTAL};
                        const res = crystalPair(st, p, m, y, lib);
                        if (res !== null) return res;
                    }
                }
            }
        }
        return null;
    }

    // First crystal action `m` (its extra action comes from `at`), then the branch from `at`
    // into `lib`; the sequence when it wins, otherwise null.
    function crystalPair(st, p, m, at, lib) {
        if (E.validateMove(st, m) !== null) return null;
        const st2 = E.applyMove(st, m, FAST);
        if (!stillMover(st2, p)) return null;
        const m2 = {type: 'BRANCH', from: at, to: lib, variant: CRYSTAL};
        if (E.validateMove(st2, m2) !== null) return null;
        return wins(E.applyMove(st2, m2, FAST), p) ? [m, m2] : null;
    }

    // First soldier child of cell i, scanning the 5x5 parent window in the engine's order.
    function firstSoldierChild(s, g, i) {
        const parent = s.parent, type = s.type, cols = g.cols;
        const r = g.row[i], c = g.col[i];
        const r0 = r > 1 ? r - 2 : 0, r1 = r + 2 < g.rows ? r + 2 : g.rows - 1;
        const c0 = c > 1 ? c - 2 : 0, c1 = c + 2 < cols ? c + 2 : cols - 1;
        for (let rr = r0; rr <= r1; rr++) {
            for (let j = rr * cols + c0, je = rr * cols + c1; j <= je; j++) {
                if (parent[j] === i && j !== i && type[j] === SOLDIER) return j;
            }
        }
        return -1;
    }

    // Cell where a squeezed bomb segment `u` explodes: the engine follows first soldier
    // children to the branch head. The blast clears every non-tumour cell (bases included)
    // within Manhattan distance 2 of that head.
    function blastHead(s, g, u) {
        let h = u;
        for (let steps = 0; steps < g.n; steps++) {
            const ch = firstSoldierChild(s, g, h);
            if (ch < 0) break;
            h = ch;
        }
        return h;
    }

    function emptyOrthCount(s, g, i) {
        let k = 0;
        for (let q = 0; q < 4; q++) {
            const a = g.orth[i * 4 + q];
            if (a >= 0 && s.type[a] === EMPTY) k++;
        }
        return k;
    }

    // Bomb segments (either owner) that p may squeeze this turn so that the blast reaches the
    // enemy base `b`: segments with at most three empty liberties (three only by trunk steps) of
    // a branch whose head lies within Manhattan distance 2 of `b`, and segments of p's own branch
    // whose single liberty the head can grow into (the new head then lies within distance 2).
    // Null when none.
    function blastSegments(s, p, b, g) {
        const type = s.type, variant = s.variant, owner = s.owner, parent = s.parent;
        const br = g.row[b], bc = g.col[b];
        let out = null;
        for (let dr = -4; dr <= 4; dr++) {
            const r = br + dr;
            if (r < 0 || r >= g.rows) continue;
            const w = 4 - (dr < 0 ? -dr : dr);
            for (let dc = -w; dc <= w; dc++) {
                const c = bc + dc;
                if (c < 0 || c >= g.cols) continue;
                const h = r * g.cols + c;
                if (type[h] !== SOLDIER || variant[h] !== BOMB) continue;
                if (firstSoldierChild(s, g, h) >= 0) continue;
                const direct = manh(g, h, b) <= 2;
                if (!direct && owner[h] !== p) continue;
                for (let x = h, steps = 0; x >= 0 && steps < g.n; x = parent[x], steps++) {
                    if (type[x] !== SOLDIER || variant[x] !== BOMB) break;
                    if (g.edge[x] === 1) continue;
                    const k = emptyOrthCount(s, g, x);
                    let ok = direct && k <= 3;
                    if (!direct && k === 1) {
                        for (let q = 0; q < 4; q++) {
                            const e = g.orth[x * 4 + q];
                            if (e < 0 || type[e] !== EMPTY) continue;
                            if (cheb(g, e, h) === 1 && manh(g, e, b) <= 2) ok = true;
                        }
                    }
                    if (!ok) continue;
                    if (out === null) out = [];
                    out.push(x);
                }
            }
        }
        return out;
    }

    // Base kills by a bomb blast: END when a candidate segment is already enclosed (mid-turn),
    // otherwise filling its liberties with trunk steps or branch / tumour / crystal moves, then
    // END; or a new bomb cell that encloses itself (holeBlast). A blast that also removes p's own
    // base ends in a draw and is rejected by the replay.
    function blastKill(s, p) {
        if (s.phase !== 'PLAY' || s.current !== p) return null;
        const b = E.findBase(s, 3 - p);
        if (b < 0) return null;
        const g = geometry(s.cols, s.rows);
        if (s.pending === null && s.mode === 'ADVANCED') {
            const hole = holeBlast(s, p, b, g);
            if (hole !== null) return hole;
        }
        const segs = blastSegments(s, p, b, g);
        if (segs === null) return null;
        const key = 'X' + E.hashState(s);
        const cached = KILL_CACHE.get(key);
        if (cached !== undefined) return cached === null ? null : cached.map(copyMove);
        const pend = s.pending;
        const trunkPend = pend !== null && pend.kind === 'TRUNK';
        let steps = 0;
        if (trunkPend) steps = 3 - pend.count;
        else if (pend === null && !s.cooldown[p]) steps = 3;
        let res = null;
        for (let q = 0; q < segs.length && res === null; q++) {
            const u = segs[q];
            const k = emptyOrthCount(s, g, u);
            if (k === 0) {
                const m = endMove();
                if (wins(E.applyMove(s, m, FAST), p)) res = [m];
                continue;
            }
            if (steps >= k) res = trunkFill(s, p, u, g, steps);
            if (res === null && !trunkPend && k <= 2) res = branchFill(s, p, u, g, 2);
            if (res === null && k === 1 && pend === null && s.mode === 'ADVANCED') {
                res = crystalFill(s, p, u, g);
            }
        }
        if (KILL_CACHE.size > 20000) KILL_CACHE.clear();
        KILL_CACHE.set(key, res);
        return res === null ? null : res.map(copyMove);
    }

    // A BOMB branch (new from a trunk, or grown from an own bomb head) into an empty cell within
    // Manhattan distance 2 of the enemy base `b` whose four orthogonal neighbours are occupied:
    // the new cell is the branch head, it is squeezed when the turn ends and explodes in place.
    function holeBlast(s, p, b, g) {
        const type = s.type, owner = s.owner, variant = s.variant;
        const br = g.row[b], bc = g.col[b];
        for (let dr = -2; dr <= 2; dr++) {
            const r = br + dr;
            if (r <= 0 || r >= g.rows - 1) continue;
            const w = 2 - (dr < 0 ? -dr : dr);
            for (let dc = -w; dc <= w; dc++) {
                const c = bc + dc;
                if (c <= 0 || c >= g.cols - 1) continue;
                const e = r * g.cols + c;
                if (type[e] !== EMPTY || emptyOrthCount(s, g, e) !== 0) continue;
                for (let k = 0; k < 8; k++) {
                    const x = g.adj[e * 8 + k];
                    if (x < 0 || owner[x] !== p) continue;
                    if (type[x] !== TRUNK && !(type[x] === SOLDIER && variant[x] === BOMB)) continue;
                    const m = {type: 'BRANCH', from: x, to: e, variant: BOMB};
                    if (E.validateMove(s, m) === null && wins(E.applyMove(s, m, FAST), p)) return [m];
                }
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------------------------
    // MASTER: static evaluation
    // -----------------------------------------------------------------------------------------

    const EVAL_SCALE = 10;
    // Danger of losing the base, by estimated attacker turns; attacker to move / defender to move.
    const DANGER_ATT = [40, 20, 11, 5, 2, 0.8, 0.3, 0];
    const DANGER_DEF = [40, 14, 6, 2.5, 1, 0.4, 0.15, 0];
    const W_PROG = 0.3;
    const TB_W = 25;
    // Progress tie-break (see the end of evalP1): weight, threat-turn cap, distance weight and
    // cap, and the resulting bound of the progress score (threat turns are >= 1).
    const EVAL_TIE = 0.1;
    const PROG_T_CAP = 12;
    const PROG_DIST_W = 0.25;
    const PROG_DIST_CAP = 24;
    const PROG_NORM = (PROG_T_CAP - 1) + PROG_DIST_W * PROG_DIST_CAP;

    let EVAL_SOLVED = -1;
    let THREAT_CNT = 0;
    let CAP_BEST = 0, CAP_SECOND = 0;

    function growTurns(cells, avail) {
        if (cells <= 0) return 0;
        return 2 * Math.ceil(cells / 3) - 1 + (avail ? 0 : 1);
    }

    // Estimated number of attacker turns needed to destroy the base of q (1 = the attacker's
    // next action), ignoring defence. Sets THREAT_CNT to the number of sources at that level.
    function baseThreat(s, q, g) {
        const o = 3 - q, bq = AN.base[q];
        THREAT_CNT = 0;
        if (bq < 0) return 0;
        const type = s.type, owner = s.owner, variant = s.variant, disabled = s.disabled;
        const ban = A_BAN, sc = A_SC;
        const oBit = 1 << o;
        const adv = s.mode === 'ADVANCED';
        const oMoves = s.current === o;
        const avail = trunkAvailable(s, o);
        const baseBanned = (ban[bq] & oBit) !== 0;
        const noVirus = adv && !AN.virus[o] && !baseBanned;
        let libEmpty = 0, libBlocked = false;
        const l0 = g.orth[bq * 4], l1 = g.orth[bq * 4 + 1], l2 = g.orth[bq * 4 + 2], l3 = g.orth[bq * 4 + 3];
        const libs = [l0, l1, l2, l3];
        for (let k = 0; k < 4; k++) {
            const a = libs[k];
            if (a >= 0 && type[a] === EMPTY) {
                libEmpty++;
                if ((ban[a] & oBit) !== 0) libBlocked = true;
            }
        }
        let best = 99, cnt = 0;
        let minTrunkLib = 99, minHeadLib = 99;
        const R = 6, br = g.row[bq], bc = g.col[bq];
        const rLo = br - R < 0 ? 0 : br - R, rHi = br + R >= g.rows ? g.rows - 1 : br + R;
        const cLo = bc - R < 0 ? 0 : bc - R, cHi = bc + R >= g.cols ? g.cols - 1 : bc + R;
        for (let r = rLo; r <= rHi; r++) {
            for (let c = cLo; c <= cHi; c++) {
                const j = r * g.cols + c;
                if (owner[j] !== o) continue;
                const t = type[j];
                let cost = 99;
                if (t === SOLDIER) {
                    if (sc[j]) continue;
                    const dis = disabled[j];
                    const delay = oMoves ? dis : (dis > 0 ? dis - 1 : 0);
                    for (let k = 0; k < 4; k++) {
                        const a = libs[k];
                        if (a < 0) continue;
                        if (a === j) {
                            cost = 1;
                            break;
                        }
                        if ((ban[a] & oBit) !== 0) continue;
                        const ta = type[a];
                        if (ta !== EMPTY) {
                            // Walled liberty: a corpse is cleared by an attack from an orthogonal
                            // neighbour and then entered (+2; a devourer enters it directly); an
                            // enemy unit is attacked first (+3). A diagonal head first steps next
                            // to the liberty.
                            if (ta === CORPSE || ((ta === TRUNK || ta === SOLDIER) && owner[a] === q)) {
                                const d = cheb(g, j, a);
                                let cc;
                                if (adv && ta === CORPSE && variant[j] === DEVOURER) cc = d + 1;
                                else cc = (d === 1 && manh(g, j, a) === 2 ? 2 : d) + (ta === CORPSE ? 2 : 3);
                                if (cc < cost) cost = cc;
                            }
                            continue;
                        }
                        const d = cheb(g, j, a);
                        let cc = d + 1;
                        if (adv && variant[j] === GENE) {
                            const cj = ((d + 1) >> 1) + 1;
                            if (cj < cc) cc = cj;
                        }
                        if (adv && variant[j] === CRYSTAL && d <= 1) cc = 1;
                        if (cc < cost) cost = cc;
                        if (d < minHeadLib) minHeadLib = d;
                    }
                    if (adv && variant[j] === VIRUS && !baseBanned) {
                        const d = cheb(g, j, bq);
                        const cc = (d > 1 ? d - 1 : 0) + 1;
                        if (cc < cost) cost = cc;
                    }
                    cost += delay;
                } else if (t === TRUNK || t === BASE) {
                    for (let k = 0; k < 4; k++) {
                        const a = libs[k];
                        if (a < 0 || type[a] !== EMPTY || (ban[a] & oBit) !== 0) continue;
                        const d = cheb(g, j, a);
                        if (d < minTrunkLib) minTrunkLib = d;
                        const need = t === BASE ? Math.max(d - 1, 1) : d - 1;
                        let cc = growTurns(need, avail) + 2;
                        if (adv && t === TRUNK && need === 0 && !AN.crystal[o] && oMoves) cc = 1;
                        if (cc < cost) cost = cc;
                        if (d < minHeadLib && t === TRUNK) minHeadLib = d;
                    }
                    if (noVirus) {
                        const d = cheb(g, j, bq);
                        const need = t === BASE ? Math.max(d - 1, 1) : d - 1;
                        const cc = growTurns(need, avail) + 1;
                        if (cc < cost) cost = cc;
                    }
                } else {
                    continue;
                }
                if (cost < best) {
                    best = cost;
                    cnt = 1;
                } else if (cost === best) {
                    cnt++;
                }
            }
        }
        if (g.edge[bq] === 0 && !libBlocked) {
            let cost = 99;
            if (libEmpty === 0) {
                cost = 1;
            } else {
                if (minTrunkLib < 99) cost = growTurns(minTrunkLib - 1 + libEmpty, avail);
                const src = minHeadLib < minTrunkLib ? minHeadLib : minTrunkLib;
                if (src < 99) {
                    const cb = libEmpty + (src > 1 ? src - 1 : 0);
                    if (cb < cost) cost = cb;
                }
            }
            if (cost < best) {
                best = cost;
                cnt = 1;
            } else if (cost === best && cost < 99) {
                cnt++;
            }
        }
        THREAT_CNT = cnt;
        return best;
    }

    // Siege estimate for decided positions. baseThreat measures Chebyshev distances and ignores
    // walls; the siege field follows the actual path through corpses and enemy units, so every
    // step of a multi-turn siege (clear a corpse, enter it, attack the next unit) lowers it.
    const SIEGE_R = 6;          // window (Chebyshev radius) around the attacked base
    const SIEGE_MAXC = 60;      // largest tracked cost (turns)
    const SIEGE_NONE = 255;     // no route
    const SIEGE_U0 = 0.75;      // |value| above which the siege term and priors apply
    const SIEGE_SHARE = 0.75;   // share of the value above SIEGE_U0 that depends on the siege cost
    const SIEGE_K = 8;          // siege cost S enters as S / (S + SIEGE_K)
    const SIEGE_SOLO = 3;       // one source holds two fronts only when this close to both
    const SIEGE_TRAP = 2;       // extra turns to enter a cell that would be squeezed at once
    const SIEGE_PRIOR = 4;      // prior bonus per turn of siege gained (at most two turns)
    // Bomb route (label 4) against a ban-guarded base: a bomb head within Manhattan 2 of the
    // base, or of the guarding ban soldier or one of its parent trunks (their death removes
    // the ban zone), then a squeeze of its branch (SIEGE_SQZ) and, for a guard, the attack
    // that follows (SIEGE_POST).
    const SIEGE_BOMB = 4;
    const SIEGE_SQZ = 2;
    const SIEGE_POST = 3;

    let SG_N = 0;
    let SG_FN = 0;                   // board size of the current field
    let SG_PK = new Uint8Array(0);   // SG_PK[k * n + c]: route of a head at c via label k
    let SG_EC = new Int32Array(0);   // bucket queue entries: cell * 8 + label, next entry
    let SG_EN = new Int32Array(0);
    const SG_HEAD = new Int32Array(SIEGE_MAXC + 1);
    const SG_LIB = new Int32Array(4);    // orthogonal neighbours of the attacked base (-1: none)
    const SG_BEST = new Int32Array(20);  // per label: best cost, its source, next cost, source
    const SG_TRY = new Int32Array(20);
    let SG_SQ = 0;                   // bit k: liberty k is EMPTY and the base can be squeezed
    let SG_SAFE = 0;                 // bit k: liberty k cannot be refilled (banned for the defender)
    let SG_TRAPL = 0;                // bit k: a unit entering EMPTY liberty k is squeezed at once
    let SG_OPEN = false;             // some attack route leaves the liberties
    let SG_BOMBF = false;            // the field has the bomb label
    let SG_NEWBOMB = false;          // ... and the attacker may create a bomb branch (siegeCost)
    const SG_GUARD = new Int32Array(16); // guard ban soldiers and their parent trunks (siegeGuards)
    let SG_NGUARD = 0;
    let SG_GX = 0;                   // attacker the guards were collected for

    let SG_TRC = new Int32Array(0);  // per cell: trap code, step cost, stamp of their computation
    let SG_TSTEP = new Uint8Array(0);
    let SG_TRS = new Uint16Array(0);
    let SG_STAMP = 0;
    // Recent fields, keyed by a hash of the window: a node is evaluated when it is created and
    // scored again when it is expanded, and most moves leave the window unchanged.
    const SIEGE_CACHE = 256;
    const SG_CACHE = [];
    const SG_CMAP = new Map();       // h1 -> cache entry
    let SG_CNEXT = 0;

    // Collects into SG_GUARD the ban soldiers of the defender that ban the attacker x from its
    // base bq (Manhattan distance <= 2, ADVANCED) and their parent trunks.
    function siegeGuards(s, x, bq, g) {
        SG_NGUARD = 0;
        SG_GX = x;
        if (s.mode !== 'ADVANCED' || bq < 0 || (A_BAN[bq] & (1 << x)) === 0) return;
        const type = s.type, owner = s.owner, variant = s.variant, parent = s.parent, y = 3 - x;
        const br = g.row[bq], bc = g.col[bq];
        for (let dr = -2; dr <= 2; dr++) {
            const r = br + dr;
            if (r < 0 || r >= g.rows) continue;
            const w = 2 - (dr < 0 ? -dr : dr);
            for (let dc = -w; dc <= w; dc++) {
                const c = bc + dc;
                if (c < 0 || c >= g.cols) continue;
                const b = r * g.cols + c;
                if (type[b] !== SOLDIER || variant[b] !== BAN || owner[b] !== y || SG_NGUARD >= 16) continue;
                SG_GUARD[SG_NGUARD++] = b;
                let q = parent[b];
                while (q >= 0 && q !== bq && type[q] === TRUNK && SG_NGUARD < 16) {
                    SG_GUARD[SG_NGUARD++] = q;
                    q = parent[q];
                }
            }
        }
    }

    function ensureSiege(n) {
        if (n <= SG_N) return;
        SG_EC = new Int32Array(40 * n + 64);
        SG_EN = new Int32Array(40 * n + 64);
        SG_TRC = new Int32Array(n);
        SG_TSTEP = new Uint8Array(n);
        SG_TRS = new Uint16Array(n);
        SG_STAMP = 0;
        SG_N = n;
    }

    // Siege field of player x against the base bq, one per orthogonal liberty k of bq:
    // SG_PK[k * n + c] = turns a head of x standing at c needs to attack bq from liberty k,
    // ignoring defence; with a guarded base also label SIEGE_BOMB for a bomb head. An adjacent
    // EMPTY cell costs 1 (branch), an orthogonal CORPSE 2 (attack, branch), an orthogonal enemy
    // unit 3 (attack, clear the corpse, branch), plus SIEGE_TRAP when the entered cell would be
    // squeezed at once. Enemy-banned cells, own units, tumours and bases are not entered.
    // Limited to Chebyshev distance SIEGE_R of bq. Reads A_BAN (analyze).
    function siegeField(s, x, bq, g) {
        const n = g.n;
        ensureSiege(n);
        SG_FN = n;
        const type = s.type, owner = s.owner, ban = A_BAN;
        const xBit = 1 << x, y = 3 - x, yBit = 1 << y;
        const br = g.row[bq], bc = g.col[bq];
        siegeGuards(s, x, bq, g);
        const nl = SG_NGUARD > 0 ? 5 : 4;
        // The field depends only on the window, a margin of one cell and the guards.
        let h1 = (bq * 4 + x) | 0, h2 = (n * 31 + x) | 0;
        for (let q = 0; q < SG_NGUARD; q++) {
            h1 = Math.imul(h1 ^ (SG_GUARD[q] + 7), 0x01000193);
            h2 = Math.imul(h2 + SG_GUARD[q] + 7, 0x5bd1e995) ^ (h2 >>> 13);
        }
        const rA = br - SIEGE_R - 1 < 0 ? 0 : br - SIEGE_R - 1;
        const rB = br + SIEGE_R + 1 >= g.rows ? g.rows - 1 : br + SIEGE_R + 1;
        const cA = bc - SIEGE_R - 1 < 0 ? 0 : bc - SIEGE_R - 1;
        const cB = bc + SIEGE_R + 1 >= g.cols ? g.cols - 1 : bc + SIEGE_R + 1;
        for (let r = rA; r <= rB; r++) {
            for (let i = r * g.cols + cA, iEnd = r * g.cols + cB; i <= iEnd; i++) {
                const b = ban[i];
                const v = type[i] | (owner[i] << 3) | ((b & xBit) !== 0 ? 32 : 0) | ((b & yBit) !== 0 ? 64 : 0);
                h1 = Math.imul(h1 ^ v, 0x01000193);
                h2 = Math.imul(h2 + v, 0x5bd1e995) ^ (h2 >>> 13);
            }
        }
        SG_BOMBF = nl === 5;
        const hit = SG_CMAP.get(h1);
        if (hit !== undefined && hit.h2 === h2 && hit.n === n && hit.bq === bq && hit.x === x) {
            SG_PK = hit.pk;
            SG_SQ = hit.sq;
            SG_SAFE = hit.safe;
            SG_TRAPL = hit.trapl;
            SG_OPEN = hit.open;
            for (let k = 0; k < 4; k++) SG_LIB[k] = g.orth[bq * 4 + k];
            return;
        }
        let ce = SG_CACHE[SG_CNEXT];
        if (ce === undefined) {
            ce = {h1: 0, h2: 0, n: 0, bq: -1, x: 0, pk: null, sq: 0, safe: 0, trapl: 0, open: false};
            SG_CACHE[SG_CNEXT] = ce;
        } else if (SG_CMAP.get(ce.h1) === ce) {
            SG_CMAP.delete(ce.h1);
        }
        SG_CNEXT = (SG_CNEXT + 1) % SIEGE_CACHE;
        if (ce.pk === null || ce.pk.length < 5 * n) ce.pk = new Uint8Array(5 * n);
        SG_PK = ce.pk;
        const pk = SG_PK, head = SG_HEAD, ec = SG_EC, en = SG_EN;
        pk.fill(SIEGE_NONE, 0, 5 * n);
        head.fill(-1);
        let ne = 0, blocked = false;
        SG_SQ = 0;
        SG_SAFE = 0;
        SG_TRAPL = 0;
        SG_OPEN = false;
        if (nl === 5) {
            // Bomb seeds: blast centres the attacker can enter, within Manhattan 2 of a target.
            for (let q = -1; q < SG_NGUARD; q++) {
                const t = q < 0 ? bq : SG_GUARD[q];
                const sv = SIEGE_SQZ + (q < 0 ? 0 : SIEGE_POST);
                const tr = g.row[t], tc = g.col[t];
                for (let dr = -2; dr <= 2; dr++) {
                    const r = tr + dr;
                    if (r < 0 || r >= g.rows || r < br - SIEGE_R || r > br + SIEGE_R) continue;
                    const w = 2 - (dr < 0 ? -dr : dr);
                    for (let dc = -w; dc <= w; dc++) {
                        const c = tc + dc;
                        if (c < 0 || c >= g.cols || c < bc - SIEGE_R || c > bc + SIEGE_R) continue;
                        const h = r * g.cols + c;
                        if (h === bq || (ban[h] & xBit) !== 0 || pk[4 * n + h] <= sv) continue;
                        pk[4 * n + h] = sv;
                        ec[ne] = h * 8 + SIEGE_BOMB;
                        en[ne] = head[sv];
                        head[sv] = ne++;
                    }
                }
            }
        }
        for (let k = 0; k < 4; k++) {
            const a = g.orth[bq * 4 + k];
            SG_LIB[k] = a;
            if (a < 0) continue;
            pk[k * n + a] = 1;
            ec[ne] = a * 8 + k;
            en[ne] = head[1];
            head[1] = ne++;
            if ((ban[a] & (1 << y)) !== 0) SG_SAFE |= 1 << k;
            if (type[a] === EMPTY) {
                SG_SQ |= 1 << k;
                if ((ban[a] & xBit) !== 0) blocked = true;
                if (g.edge[a] === 0 && type[a - 1] !== EMPTY && type[a + 1] !== EMPTY &&
                    type[a - g.cols] !== EMPTY && type[a + g.cols] !== EMPTY) {
                    SG_TRAPL |= 1 << k;
                }
            }
        }
        if (g.edge[bq] === 1 || blocked) SG_SQ = 0;
        const r0 = br - SIEGE_R, r1 = br + SIEGE_R, c0 = bc - SIEGE_R, c1 = bc + SIEGE_R;
        const trc = SG_TRC, trs = SG_TRS;
        if (++SG_STAMP > 65535) {
            SG_STAMP = 1;
            trs.fill(0);
        }
        const stamp = SG_STAMP;
        for (let v = 1; v < SIEGE_MAXC; v++) {
            while (head[v] >= 0) {
                const e = head[v];
                head[v] = en[e];
                const c = ec[e] >> 3, k0 = ec[e] & 7, kb = k0 * n;
                if (pk[kb + c] !== v) continue;
                // Per cell, once: step cost (0: not entered) and trap code. A head entering an
                // interior cell without another EMPTY orthogonal neighbour is squeezed at the
                // end of that turn, so a side cell has to be cleared first: code -1 always,
                // >= 0 when coming from that only EMPTY neighbour, -2 never.
                let code;
                if (trs[c] !== stamp) {
                    trs[c] = stamp;
                    const t = type[c];
                    let step = 0;
                    if ((ban[c] & xBit) !== 0) step = 0;
                    else if (t === EMPTY) step = 1;
                    else if (t === CORPSE) step = 2;
                    else if ((t === TRUNK || t === SOLDIER) && owner[c] === y) step = 3;
                    code = -2;
                    if (step > 0 && g.edge[c] === 0) {
                        let eCnt = 0, eOne = -1;
                        for (let k = 0; k < 4; k++) {
                            const e2 = g.orth[c * 4 + k];
                            if (type[e2] === EMPTY) {
                                eCnt++;
                                eOne = e2;
                            }
                        }
                        if (eCnt === 0) code = -1;
                        else if (eCnt === 1) code = eOne;
                    }
                    SG_TSTEP[c] = step;
                    trc[c] = code;
                } else {
                    code = trc[c];
                }
                const step = SG_TSTEP[c];
                if (step === 0) continue;
                const nv = v + step;
                if (nv > SIEGE_MAXC) continue;
                const nb = step === 1 ? 8 : 4;
                for (let k = 0; k < nb; k++) {
                    const d = nb === 8 ? g.adj[c * 8 + k] : g.orth[c * 4 + k];
                    if (d < 0) continue;
                    const nd = code === -1 || code === d ? nv + SIEGE_TRAP : nv;
                    if (nd > SIEGE_MAXC || pk[kb + d] <= nd) continue;
                    const dr = g.row[d], dc = g.col[d];
                    if (dr < r0 || dr > r1 || dc < c0 || dc > c1) continue;
                    pk[kb + d] = nd;
                    if (k0 < 4) SG_OPEN = true;
                    ec[ne] = d * 8 + k0;
                    en[ne] = head[nd];
                    head[nd] = ne++;
                }
            }
        }
        ce.h1 = h1;
        ce.h2 = h2;
        ce.n = n;
        ce.bq = bq;
        ce.x = x;
        ce.sq = SG_SQ;
        ce.safe = SG_SAFE;
        ce.trapl = SG_TRAPL;
        ce.open = SG_OPEN;
        SG_CMAP.set(h1, ce);
    }

    // Per-label minima over own sources (SG_BEST layout): [0, 5) best cost, [5, 10) its source
    // cell, [10, 15) best cost from another source, [15, 20) that source.
    function siegeTake(best, k, v, src) {
        if (v < best[k]) {
            if (best[5 + k] !== src) {
                best[10 + k] = best[k];
                best[15 + k] = best[5 + k];
            }
            best[k] = v;
            best[5 + k] = src;
        } else if (src !== best[5 + k] && v < best[10 + k]) {
            best[10 + k] = v;
            best[15 + k] = src;
        }
    }

    // Offers the routes of cell c, plus `add` turns, as routes of source src (bomb: a bomb head).
    function siegeOffer(best, c, add, src, bomb) {
        const pk = SG_PK, n = SG_FN;
        const nl = bomb && SG_BOMBF ? 5 : 4;
        for (let k = 0; k < nl; k++) {
            const v = pk[k * n + c];
            if (v !== SIEGE_NONE) siegeTake(best, k, v + add, src);
        }
    }

    function siegeReset(best) {
        for (let k = 0; k < 5; k++) {
            best[k] = SIEGE_NONE;
            best[5 + k] = -1;
            best[10 + k] = SIEGE_NONE;
            best[15 + k] = -2;
        }
    }

    // Offers a source j outside the window: the routes of the nearest window cell plus the
    // distance to it (+ add); without such routes, when an attack route leaves the liberties at
    // all, its Chebyshev distance to the base bq + 2, towards the nearest liberty.
    function siegeFar(best, g, bq, j, add, src, bomb) {
        const br = g.row[bq], bc = g.col[bq];
        let wr = g.row[j], wc = g.col[j];
        if (wr < br - SIEGE_R) wr = br - SIEGE_R;
        else if (wr > br + SIEGE_R) wr = br + SIEGE_R;
        if (wc < bc - SIEGE_R) wc = bc - SIEGE_R;
        else if (wc > bc + SIEGE_R) wc = bc + SIEGE_R;
        const w = wr * g.cols + wc, n = SG_FN;
        const pk = SG_PK;
        if (pk[w] !== SIEGE_NONE || pk[n + w] !== SIEGE_NONE || pk[2 * n + w] !== SIEGE_NONE ||
            pk[3 * n + w] !== SIEGE_NONE || (bomb && SG_BOMBF && pk[4 * n + w] !== SIEGE_NONE)) {
            siegeOffer(best, w, cheb(g, j, w) + add, src, bomb);
            return;
        }
        if (!SG_OPEN) return;
        let lab = -1, ld = SIEGE_NONE;
        for (let k = 0; k < 4; k++) {
            const a = SG_LIB[k];
            if (a < 0) continue;
            const d = cheb(g, j, a);
            if (d < ld) {
                ld = d;
                lab = k;
            }
        }
        const v = cheb(g, j, bq) + 2 + add;
        if (lab >= 0) siegeTake(best, lab, v < SIEGE_MAXC ? v : SIEGE_MAXC, src);
    }

    // Siege cost from the per-label minima, with the EMPTY liberties in `filled` taken as
    // filled. Attack: a defender refills a cleared liberty from its base, so two fronts on two
    // liberties are needed, by two sources (their costs add up, the last turns overlap) or by one
    // source next to both (at most SIEGE_SOLO each), unless a head stands on a liberty or the
    // liberty is banned for the defender; a missing front counts as SIEGE_MAXC. Squeeze: one fill
    // per EMPTY liberty, each after its source's approach. Bomb: its label alone.
    function siegeCombine(best, filled) {
        let att = best[SIEGE_BOMB];
        for (let a = 0; a < 4; a++) {
            const va = best[a];
            if (va >= SIEGE_NONE) continue;
            if (va <= 1 || (SG_SAFE & (1 << a)) !== 0) {
                if (va < att) att = va;
                continue;
            }
            let pair = va + SIEGE_MAXC - 2;
            for (let b = 0; b < 4; b++) {
                const vb = best[b];
                if (b === a || vb >= SIEGE_NONE) continue;
                let v = SIEGE_NONE;
                if (best[5 + a] !== best[5 + b]) {
                    v = va + vb - 2;
                } else if (va <= SIEGE_SOLO && vb <= SIEGE_SOLO) {
                    v = (va > vb ? va : vb) + 1;
                }
                const v2 = va + (best[10 + b] < SIEGE_NONE ? best[10 + b] : SIEGE_MAXC) - 2;
                if (v2 < v) v = v2;
                if (v < pair) pair = v;
            }
            if (pair < va) pair = va;
            if (pair < att) att = pair;
        }
        const open = SG_SQ & ~filled;
        if (SG_SQ !== 0) {
            let sq = 0;
            for (let k = 0; k < 4 && sq < att; k++) {
                if ((open & (1 << k)) === 0) continue;
                if (best[k] >= SIEGE_NONE) {
                    sq = SIEGE_NONE;
                    break;
                }
                const f = best[k] - 1 - ((SG_TRAPL & (1 << k)) !== 0 ? SIEGE_TRAP : 0);
                sq += f > 1 ? f : 1;
            }
            if (sq < att) att = sq;
        }
        return att;
    }

    // Siege cost of player x against the enemy base (turns, SIEGE_NONE without any route): a
    // head inside the window acts from its cell (delayed while disabled); a trunk spawns a branch
    // into (or fills) an adjacent EMPTY cell, a bomb branch when x has no bomb yet; a head or
    // trunk outside the window enters it first (siegeFar). Leaves the field and the per-label
    // minima (SG_BEST). Reads AN / A_SC / A_BAN.
    function siegeCost(s, x, g) {
        const best = SG_BEST;
        siegeReset(best);
        const bq = AN.base[3 - x];
        if (bq < 0) return SIEGE_NONE;
        siegeField(s, x, bq, g);
        const type = s.type, owner = s.owner, variant = s.variant, disabled = s.disabled;
        const sc = A_SC, ban = A_BAN;
        const xBit = 1 << x;
        const br = g.row[bq], bc = g.col[bq], n = g.n;
        let newBomb = SG_BOMBF;
        if (newBomb) {
            for (let j = 0; j < n; j++) {
                if (owner[j] === x && type[j] === SOLDIER && variant[j] === BOMB) {
                    newBomb = false;
                    break;
                }
            }
        }
        SG_NEWBOMB = newBomb;
        // Sources inside the window first, then the others, skipping those that cannot improve
        // a second-best route.
        const r0 = br - SIEGE_R < 0 ? 0 : br - SIEGE_R, r1 = br + SIEGE_R >= g.rows ? g.rows - 1 : br + SIEGE_R;
        const c0 = bc - SIEGE_R < 0 ? 0 : bc - SIEGE_R, c1 = bc + SIEGE_R >= g.cols ? g.cols - 1 : bc + SIEGE_R;
        for (let r = r0; r <= r1; r++) {
            for (let j = r * g.cols + c0, jEnd = r * g.cols + c1; j <= jEnd; j++) {
                if (owner[j] !== x) continue;
                const t = type[j];
                if (t === SOLDIER) {
                    if (!sc[j]) siegeOffer(best, j, disabled[j], j, variant[j] === BOMB);
                } else if (t === TRUNK) {
                    for (let k = 0; k < 8; k++) {
                        const z = g.adj[j * 8 + k];
                        if (z >= 0 && type[z] === EMPTY && (ban[z] & xBit) === 0) siegeOffer(best, z, 1, j, newBomb);
                    }
                }
            }
        }
        let worst = 0;
        for (let k = 0; k < 5; k++) if (best[10 + k] > worst) worst = best[10 + k];
        for (let j = 0; j < n; j++) {
            if (owner[j] !== x) continue;
            const t = type[j];
            if (t !== SOLDIER && t !== TRUNK) continue;
            const dr = g.row[j] - br, dc = g.col[j] - bc;
            const ar = dr < 0 ? -dr : dr, ac = dc < 0 ? -dc : dc;
            if ((ar > ac ? ar : ac) <= SIEGE_R || (ar > ac ? ar : ac) - SIEGE_R >= worst) continue;
            if (t === SOLDIER && sc[j]) continue;
            if (t === SOLDIER) siegeFar(best, g, bq, j, disabled[j], j, variant[j] === BOMB);
            else siegeFar(best, g, bq, j, 1, j, newBomb);
        }
        return siegeCombine(best, 0);
    }

    // Siege cost after a move of player x (approximation from the current field and SG_BEST; a
    // source keeps its old routes): source src gets a head (or trunk; bomb: a bomb head) at `to`
    // (to >= 0), the EMPTY liberties in `filled` are filled, or the head h clears the corpse y
    // (y >= 0; the best next step from h, where y is EMPTY and may no longer trap a neighbour).
    function siegeAfter(s, g, x, to, add, h, y, src, filled, bomb) {
        const tr = SG_TRY;
        tr.set(SG_BEST);
        if (y < 0) {
            if (to >= 0) {
                const bq = AN.base[3 - x];
                if (cheb(g, to, bq) > SIEGE_R) siegeFar(tr, g, bq, to, add, src, bomb);
                else siegeOffer(tr, to, add, src, bomb);
            }
            return siegeCombine(tr, filled);
        }
        const type = s.type, owner = s.owner, ban = A_BAN;
        const xBit = 1 << x;
        for (let k = 0; k < 8; k++) {
            const c = g.adj[h * 8 + k];
            if (c < 0 || (ban[c] & xBit) !== 0) continue;
            const t = c === y ? EMPTY : type[c];
            let cost;
            if (t === EMPTY) cost = 1;
            else if (k === 1 || k === 3 || k === 4 || k === 6) cost = t === CORPSE ? 2 : (owner[c] === 3 - x &&
                (t === TRUNK || t === SOLDIER) ? 3 : SIEGE_NONE);
            else continue;
            if (cost === SIEGE_NONE) continue;
            if (g.edge[c] === 0) {
                let free = false;
                for (let q = 0; q < 4; q++) {
                    const e = g.orth[c * 4 + q];
                    if (e !== h && (e === y || type[e] === EMPTY)) {
                        free = true;
                        break;
                    }
                }
                if (!free) cost += SIEGE_TRAP;
            }
            siegeOffer(tr, c, cost, src, bomb);
        }
        return siegeCombine(tr, 0);
    }

    // Decided positions (|v| above SIEGE_U0): the part of the value above SIEGE_U0 is scaled down
    // by the leader's remaining siege cost, so that the search keeps reducing it. Monotone in v
    // (slope at least 1 - SIEGE_SHARE) and never crosses SIEGE_U0. Needs analyze(s).
    function siegeAdjust(s, v, g) {
        const u = v < 0 ? -v : v;
        if (u <= SIEGE_U0) return v;
        const sc = siegeCost(s, v > 0 ? 1 : 2, g);
        const w = u - (u - SIEGE_U0) * SIEGE_SHARE * (sc / (sc + SIEGE_K));
        return v > 0 ? w : -w;
    }

    function dangerValue(turns, cnt, attackerToMove) {
        const tbl = attackerToMove ? DANGER_ATT : DANGER_DEF;
        const v = tbl[turns < tbl.length ? turns : tbl.length - 1];
        const extra = cnt > 1 ? Math.min(cnt - 1, 3) : 0;
        return v * (1 + 0.4 * extra);
    }

    function addCap(v) {
        if (v > CAP_BEST) {
            CAP_SECOND = CAP_BEST;
            CAP_BEST = v;
        } else if (v > CAP_SECOND) {
            CAP_SECOND = v;
        }
    }

    // Can player x fill the empty cell e with one growth in its current / next turn?
    function canFill(s, x, e, g, sc, avail) {
        const type = s.type, owner = s.owner, disabled = s.disabled;
        const thr = s.current === x ? 0 : 1;
        for (let k = 0; k < 8; k++) {
            const z = g.adj[e * 8 + k];
            if (z < 0 || owner[z] !== x) continue;
            const t = type[z];
            if (t === BASE) {
                if (avail) return true;
            } else if (t === TRUNK) {
                if (avail || disabled[z] <= thr) return true;
            } else if (t === SOLDIER && !sc[z] && disabled[z] <= thr) {
                return true;
            }
        }
        return false;
    }

    // Best and second best capture values available to player x (sets CAP_BEST / CAP_SECOND).
    function captures(s, x, g) {
        CAP_BEST = 0;
        CAP_SECOND = 0;
        const y = 3 - x, n = g.n;
        const type = s.type, owner = s.owner, variant = s.variant, disabled = s.disabled;
        const sc = A_SC, sub = A_SUB, ban = A_BAN;
        const xBit = 1 << x;
        const adv = s.mode === 'ADVANCED';
        const xMoves = s.current === x;
        const pend = xMoves ? s.pending : null;
        const thr = xMoves ? 0 : 1;
        const trunkOnly = pend !== null && pend.kind === 'TRUNK';
        const onlyFrom = pend !== null && pend.kind === 'CRYSTAL' ? pend.at : -1;
        if (!trunkOnly) {
            const trunkVirus = adv && !AN.virus[x] && pend === null;
            for (let i = 0; i < n; i++) {
                if (owner[i] !== x) continue;
                const t = type[i];
                if (t === SOLDIER) {
                    if (sc[i] || disabled[i] > thr) continue;
                    if (onlyFrom >= 0 && i !== onlyFrom) continue;
                    for (let k = 0; k < 4; k++) {
                        const j = g.orth[i * 4 + k];
                        if (j < 0 || owner[j] !== y) continue;
                        const tj = type[j];
                        if (tj === TRUNK || tj === SOLDIER) addCap(sub[j] + 0.3);
                    }
                    if (adv && variant[i] === VIRUS) {
                        for (let k = 0; k < 8; k++) {
                            const j = g.adj[i * 8 + k];
                            if (j < 0 || owner[j] !== y || (ban[j] & xBit) !== 0) continue;
                            const tj = type[j];
                            if (tj === TRUNK || tj === SOLDIER) addCap(sub[j] + 0.5);
                        }
                    }
                } else if (t === TRUNK && trunkVirus) {
                    for (let k = 0; k < 8; k++) {
                        const j = g.adj[i * 8 + k];
                        if (j < 0 || owner[j] !== y || (ban[j] & xBit) !== 0) continue;
                        const tj = type[j];
                        if (tj === TRUNK || tj === SOLDIER) addCap(sub[j] + 1.0);
                    }
                }
            }
        }
        // Squeeze captures: enemy units with exactly one empty liberty that x can fill.
        const avail = trunkAvailable(s, x);
        for (let u = 0; u < n; u++) {
            if (owner[u] !== y) continue;
            const t = type[u];
            if ((t !== TRUNK && t !== SOLDIER) || g.edge[u] === 1) continue;
            if (t === SOLDIER && variant[u] === DEVOURER) continue;
            if (sub[u] < 1.5) continue;
            let e = -1, cntE = 0;
            for (let k = 0; k < 4; k++) {
                const j = g.orth[u * 4 + k];
                if (type[j] === EMPTY) {
                    cntE++;
                    e = j;
                }
            }
            if (cntE !== 1 || (ban[e] & xBit) !== 0) continue;
            if (trunkOnly) {
                if (canFillTrunk(s, x, e, g)) addCap(sub[u]);
            } else if (canFill(s, x, e, g, sc, avail)) {
                addCap(sub[u]);
            }
        }
    }

    function canFillTrunk(s, x, e, g) {
        for (let k = 0; k < 8; k++) {
            const z = g.adj[e * 8 + k];
            if (z >= 0 && s.owner[z] === x && (s.type[z] === BASE || s.type[z] === TRUNK)) return true;
        }
        return false;
    }

    // Static value from P1's perspective in [-1, 1]. Sets EVAL_SOLVED to the winner (0, 1, 2)
    // when the value is proven (terminal state or forced base kill for the side to move).
    function evalP1(s) {
        EVAL_SOLVED = -1;
        if (s.phase === 'OVER') {
            EVAL_SOLVED = s.winner === null ? 0 : s.winner;
            return s.winner === 1 ? 1 : (s.winner === 2 ? -1 : 0);
        }
        if (s.phase !== 'PLAY') return 0;
        const m = s.current;
        if (findKill(s, m) !== null) {
            EVAL_SOLVED = m;
            return m === 1 ? 1 : -1;
        }
        const g = geometry(s.cols, s.rows);
        analyze(s);
        const b1 = AN.base[1], b2 = AN.base[2];
        if (b1 < 0 || b2 < 0) return b1 < 0 ? (b2 < 0 ? 0 : -1) : 1;
        let raw = AN.mat[1] - AN.mat[2];

        // Mid-turn: cells already surrounded die when the turn ends; a surrounded bomb segment
        // also removes every base within the blast radius of its branch head.
        if (s.pending !== null) {
            const type = s.type, variant = s.variant, owner = s.owner, sub = A_SUB;
            let dead1 = false, dead2 = false;
            for (let i = 0; i < g.n; i++) {
                const t = type[i];
                if (t === EMPTY || t >= CORPSE || g.edge[i] === 1) continue;
                if (t === SOLDIER && variant[i] === DEVOURER) continue;
                if (type[i - 1] === EMPTY || type[i + 1] === EMPTY ||
                    type[i - g.cols] === EMPTY || type[i + g.cols] === EMPTY) continue;
                if (t === BASE) {
                    if (owner[i] === 1) dead1 = true;
                    else dead2 = true;
                } else {
                    raw += owner[i] === 1 ? -sub[i] : sub[i];
                    if (t === SOLDIER && variant[i] === BOMB) {
                        const h = blastHead(s, g, i);
                        if (manh(g, h, b1) <= 2) dead1 = true;
                        if (manh(g, h, b2) <= 2) dead2 = true;
                    }
                }
            }
            if (dead1 || dead2) return dead1 && dead2 ? 0 : (dead1 ? -0.98 : 0.98);
        }

        const t1 = baseThreat(s, 1, g), c1 = THREAT_CNT;
        const t2 = baseThreat(s, 2, g), c2 = THREAT_CNT;
        raw -= dangerValue(t1, c1, m === 2);
        raw += dangerValue(t2, c2, m === 1);

        captures(s, 1, g);
        const cb1 = CAP_BEST, cs1 = CAP_SECOND;
        captures(s, 2, g);
        const cb2 = CAP_BEST, cs2 = CAP_SECOND;
        if (m === 1) raw += 0.75 * cb1 + 0.15 * cs1 - 0.35 * cb2 - 0.15 * cs2;
        else raw -= 0.75 * cb2 + 0.15 * cs2 - 0.35 * cb1 - 0.15 * cs1;

        const d1 = AN.dmin[1], d2 = AN.dmin[2];
        let diff = d2 - d1;
        if (diff > 8) diff = 8;
        else if (diff < -8) diff = -8;
        raw += W_PROG * diff;
        if (s.turnLimit > 0) {
            const rem = Math.max(0, s.turnLimit * 2 - s.turnCount);
            raw += (TB_W / (1 + rem / 3)) * Math.tanh((d2 - d1) / 1.5);
        }
        if (AN.banGuard[1]) raw += 2;
        if (AN.banGuard[2]) raw -= 2;
        raw += m === 1 ? 0.3 : -0.3;
        const main = Math.tanh(raw / EVAL_SCALE);
        // Progress tie-break outside the squash, weighted by |main|: in decided positions the
        // tanh saturates and all continuations score alike, so the leading side would stop
        // pursuing the enemy base. The linear term in [-1, 1] rewards shortening the own
        // base-kill race and approaching the enemy base; it vanishes in balanced positions.
        let dd = d2 - d1;
        if (dd > PROG_DIST_CAP) dd = PROG_DIST_CAP;
        else if (dd < -PROG_DIST_CAP) dd = -PROG_DIST_CAP;
        const prog = Math.min(t1, PROG_T_CAP) - Math.min(t2, PROG_T_CAP) + PROG_DIST_W * dd;
        return siegeAdjust(s, (1 - EVAL_TIE) * main + EVAL_TIE * Math.abs(main) * (prog / PROG_NORM), g);
    }

    function evaluate(state, player) {
        const v = evalP1(state);
        return player === 2 ? -v : v;
    }

    // -----------------------------------------------------------------------------------------
    // MASTER: move priors
    // -----------------------------------------------------------------------------------------

    const CREATE_BONUS = [0, -1, 2, 1.2, 0.3, -0.5, 0];

    // Score of a bomb blast at cell h for player p: removing the enemy base is a win, removing
    // the own base a loss (both: draw, 0). In a decided siege (guards collected for p by
    // scoreMoves) removing a guard of the enemy base's ban zone is worth 40.
    function blastDelta(g, h, p) {
        const ob = AN.base[p], eb = AN.base[3 - p];
        let d = 0;
        if (eb >= 0 && manh(g, h, eb) <= 2) d += 1000;
        if (ob >= 0 && manh(g, h, ob) <= 2) d -= 1000;
        if (SG_GX === p) {
            for (let q = 0; q < SG_NGUARD; q++) {
                if (manh(g, h, SG_GUARD[q]) <= 2) {
                    d += 40;
                    break;
                }
            }
        }
        return d;
    }

    // Change caused by filling the empty cell `to` with a unit of player p: squeezes it causes
    // for neighbours (own: negative, enemy: positive), whether the new unit is squeezed, and the
    // blasts of squeezed bomb segments. `bombFrom` is the source head when the new unit extends
    // a bomb branch (the new cell becomes that branch's head), otherwise -1. Reads AN (analyze).
    function fillDelta(s, g, to, p, newIsImmune, bombFrom) {
        const type = s.type, owner = s.owner, variant = s.variant, sub = A_SUB;
        let d = 0;
        let blasted = null;   // blast centres already scored (one blast per branch head)
        if (!newIsImmune && g.edge[to] === 0) {
            let full = true;
            for (let k = 0; k < 4; k++) {
                if (type[g.orth[to * 4 + k]] === EMPTY) {
                    full = false;
                    break;
                }
            }
            if (full) {
                d -= 3;
                if (bombFrom >= 0) {
                    d += blastDelta(g, to, p);
                    blasted = [to];
                }
            }
        }
        for (let k = 0; k < 4; k++) {
            const x = g.orth[to * 4 + k];
            if (x < 0 || g.edge[x] === 1) continue;
            const t = type[x];
            if (t === EMPTY || t === CORPSE || t === TUMOR) continue;
            if (t === SOLDIER && variant[x] === DEVOURER) continue;
            let empty = 0;
            for (let q = 0; q < 4; q++) {
                const y = g.orth[x * 4 + q];
                if (y !== to && type[y] === EMPTY) empty++;
            }
            if (empty > 0) continue;
            if (owner[x] === p) d -= t === BASE ? 1000 : 3 + 3 * sub[x];
            else d += t === BASE ? 1000 : 2 + 3 * sub[x];
            if (t === SOLDIER && variant[x] === BOMB) {
                let h = blastHead(s, g, x);
                if (h === bombFrom) h = to;
                if (blasted === null) blasted = [];
                if (blasted.indexOf(h) < 0) {
                    d += blastDelta(g, h, p);
                    blasted.push(h);
                }
            }
        }
        return d;
    }

    // Heuristic prior score of every move for the side to move (higher = more promising).
    // v0: static value of s from P1's perspective (enables the siege bonus), optional.
    function scoreMoves(s, moves, out, v0) {
        const g = geometry(s.cols, s.rows), n = g.n;
        analyze(s);
        const p = s.current, o = 3 - p;
        const type = s.type, owner = s.owner, variant = s.variant, disabled = s.disabled;
        const sc = A_SC, sub = A_SUB, thrMap = A_THR;
        const ob = AN.base[p], eb = AN.base[o];
        const adv = s.mode === 'ADVANCED';
        const obEdge = ob < 0 || g.edge[ob] === 1, ebEdge = eb < 0 || g.edge[eb] === 1;
        const lead = v0 === undefined ? 0 : (p === 1 ? v0 : -v0);
        if (lead > SIEGE_U0) siegeGuards(s, p, eb, g);
        else SG_NGUARD = 0;
        thrMap.fill(0, 0, n);
        for (let i = 0; i < n; i++) {
            if (owner[i] !== o) continue;
            const t = type[i];
            if (t === SOLDIER) {
                if (sc[i] || disabled[i] > 1) continue;
                for (let k = 0; k < 4; k++) {
                    const j = g.orth[i * 4 + k];
                    if (j >= 0) thrMap[j] |= 1;
                }
                if (adv && variant[i] === VIRUS) {
                    for (let k = 0; k < 8; k++) {
                        const j = g.adj[i * 8 + k];
                        if (j >= 0) thrMap[j] |= 2;
                    }
                }
            } else if (t === TRUNK && adv && !AN.virus[o]) {
                for (let k = 0; k < 8; k++) {
                    const j = g.adj[i * 8 + k];
                    if (j >= 0) thrMap[j] |= 2;
                }
            }
        }
        const dminOwn = AN.dmin[p];
        const pend = s.pending;
        const er = eb >= 0 ? g.row[eb] : 0, ec = eb >= 0 ? g.col[eb] : 0;
        const distE = function (x) {
            const dr = g.row[x] - er, dc = g.col[x] - ec;
            return Math.sqrt(dr * dr + dc * dc);
        };
        for (let k = 0; k < moves.length; k++) {
            const mv = moves[k];
            let sc0 = 0;
            switch (mv.type) {
                case 'END':
                    sc0 = pend === null ? -3 : (pend.kind === 'TRUNK' ? 0.5 : 0);
                    break;
                case 'ATTACK': {
                    const to = mv.to, tt = type[to];
                    if (tt === BASE) {
                        sc0 = 1000;
                    } else if (tt === CORPSE) {
                        sc0 = (!obEdge && isOrthNb(g, to, ob)) ? 2.5 : -1;
                    } else {
                        sc0 = 3 + 2.5 * sub[to];
                        if (ob >= 0 && cheb(g, to, ob) <= 3) sc0 += 4;
                    }
                    break;
                }
                case 'DISABLE':
                    sc0 = 0.5 + (ob >= 0 && cheb(g, mv.to, ob) <= 3 ? 4 : -1);
                    break;
                case 'TUMOR': {
                    const to = mv.to;
                    if (to === mv.from) {
                        sc0 = -1.5;
                    } else {
                        sc0 = (!ebEdge && isOrthNb(g, to, eb)) ? 5 : -0.8;
                        sc0 += fillDelta(s, g, to, p, true, -1);
                        if (!obEdge && isOrthNb(g, to, ob)) sc0 -= 4;
                    }
                    break;
                }
                case 'TRUNK': {
                    const to = mv.to;
                    sc0 = 0.5;
                    if (pend !== null && pend.kind === 'TRUNK' && mv.from === pend.last) sc0 += 0.3;
                    let prog = 1.2 * (dminOwn - distE(to));
                    if (prog > 4) prog = 4;
                    else if (prog < -3) prog = -3;
                    sc0 += prog + 0.4 * (distE(mv.from) - distE(to));
                    sc0 += fillDelta(s, g, to, p, false, -1);
                    const th = thrMap[to];
                    if (th & 1) sc0 -= 2.5;
                    if (th & 2) sc0 -= 2.5;
                    if (!obEdge && isOrthNb(g, to, ob)) sc0 -= 4;
                    if (!ebEdge && isOrthNb(g, to, eb)) sc0 += 3;
                    break;
                }
                case 'BRANCH': {
                    const from = mv.from, to = mv.to, v = mv.variant | 0;
                    const ft = type[from], tt = type[to];
                    if (tt !== EMPTY && tt !== CORPSE) {
                        if (tt === BASE) {
                            sc0 = 1000;
                            break;
                        }
                        sc0 = 4 + 2.5 * sub[to];
                        if (ob >= 0 && cheb(g, to, ob) <= 3) sc0 += 4;
                    } else {
                        sc0 = 0.5;
                        if (tt === EMPTY) {
                            sc0 += fillDelta(s, g, to, p, v === DEVOURER, v === BOMB ? from : -1);
                        }
                        if (!obEdge && isOrthNb(g, to, ob)) sc0 -= 4;
                        if (!ebEdge && isOrthNb(g, to, eb)) sc0 += 2;
                    }
                    if (ft === TRUNK) {
                        sc0 += 0.8;
                        if (v === BAN) sc0 += (ob >= 0 && manh(g, to, ob) <= 2) ? 10 : -4;
                        else if (v === DEVOURER) sc0 += tt === CORPSE ? 1.5 : -1;
                        else sc0 += CREATE_BONUS[v];
                    }
                    if (eb >= 0) {
                        sc0 += 0.8 * (distE(from) - distE(to));
                        if (isOrthNb(g, to, eb)) sc0 += 6;
                        if (v === VIRUS && cheb(g, to, eb) === 1) sc0 += 6;
                    }
                    let foes = 0;
                    for (let q = 0; q < 4; q++) {
                        const j = g.orth[to * 4 + q];
                        if (j >= 0 && owner[j] === o && (type[j] === TRUNK || type[j] === SOLDIER)) foes++;
                    }
                    sc0 += 0.7 * (foes > 2 ? 2 : foes);
                    const th = thrMap[to];
                    if (th & 1) sc0 -= 1.5;
                    if (th & 2) sc0 -= 1.5;
                    break;
                }
                default:
                    sc0 = -5;
            }
            out[k] = sc0;
        }
        // Decided positions led by the mover: favour moves that shorten the siege of the enemy
        // base (siegeCost): a branch or trunk acts from `to`, a cleared corpse opens a step, a
        // killed unit leaves a corpse to clear.
        if (lead > SIEGE_U0 && eb >= 0) {
            const smin = siegeCost(s, p, g);
            const wgt = SIEGE_PRIOR * Math.min(1, (lead - SIEGE_U0) / 0.15);
            for (let k = 0; k < moves.length; k++) {
                const mv = moves[k];
                let sn = SIEGE_NONE;
                if (mv.type === 'BRANCH' || mv.type === 'TRUNK') {
                    const to = mv.to;
                    let lib = -1;
                    for (let q = 0; q < 4; q++) if (SG_LIB[q] === to) lib = q;
                    const fill = lib >= 0 ? SG_SQ & (1 << lib) : 0;
                    // A unit squeezed at the end of this turn only fills a liberty; a trunk on
                    // a liberty blocks the attack from there. A head that moves stays the same
                    // source.
                    const dies = g.edge[to] === 0 && !(mv.type === 'BRANCH' && (mv.variant | 0) === DEVOURER) &&
                        type[to - 1] !== EMPTY && type[to + 1] !== EMPTY &&
                        type[to - g.cols] !== EMPTY && type[to + g.cols] !== EMPTY;
                    if (!dies && (mv.type === 'BRANCH' || lib < 0)) {
                        sn = siegeAfter(s, g, p, to, 0, -1, -1,
                            mv.type === 'BRANCH' && type[mv.from] === SOLDIER ? mv.from : to, fill,
                            mv.type === 'BRANCH' ? (mv.variant | 0) === BOMB : SG_NEWBOMB);
                    } else if (fill !== 0) {
                        sn = siegeAfter(s, g, p, -1, 0, -1, -1, -1, fill, false);
                    }
                } else if (mv.type === 'ATTACK') {
                    const tt = type[mv.to], bomb = variant[mv.from] === BOMB;
                    if (tt === CORPSE) sn = siegeAfter(s, g, p, -1, 0, mv.from, mv.to, mv.from, 0, bomb);
                    else if (tt !== BASE) sn = siegeAfter(s, g, p, mv.to, 2, -1, -1, mv.from, 0, bomb);
                }
                const b = smin - sn;
                if (b > 0) out[k] += wgt * (b > 2 ? 2 : b);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // MASTER: Monte Carlo tree search
    // -----------------------------------------------------------------------------------------

    const C_PUCT = 1.4;
    const FPU_REDUCTION = 0.25;
    const PRIOR_TEMP = 2.0;
    const ROOT_PRIOR_TEMP = 1.0;
    const INNER_CAP0 = 10;      // moves kept at a first expansion; doubled when widening needs more
    const KEEP_STATE_N = 12;    // a node caches its state once visited this often (else replayed)
    const K_BASE = 2, K_MUL = 1.0;
    const K_BASE_ROOT = 5, K_MUL_ROOT = 1.5;
    const ROOT_EVAL_CAP = 260;

    // Tree node. `state` is cached only for the root and frequently visited nodes; other states
    // are rebuilt from the parent state and `move` while descending.
    function Node(state, move) {
        this.state = state;
        this.move = move;
        this.mover = state.phase === 'PLAY' ? state.current : 0;
        this.N = 0;
        this.W = 0;            // sum of values from P1's perspective
        this.solved = -1;      // -1 unknown, otherwise the proven winner (0 = draw)
        this.moves = null;
        this.priors = null;
        this.children = null;
        this.complete = false; // moves holds every legal move
        this.v0 = 0;           // static value (P1's perspective) computed at creation
        this.ownTurn = false;  // the node lies inside the turn of the root's mover
    }

    function moveKey(m, n) {
        let tc;
        switch (m.type) {
            case 'TRUNK': tc = 1; break;
            case 'BRANCH': tc = 2; break;
            case 'ATTACK': tc = 3; break;
            case 'DISABLE': tc = 4; break;
            case 'TUMOR': tc = 5; break;
            case 'END': return -1;
            default: tc = 6;
        }
        const v = m.type === 'BRANCH' ? (m.variant | 0) : 0;
        return ((tc * 8 + v) * n + m.from) * n + m.to;
    }

    // Softmax over all `scores`; only the first `len` probabilities are returned.
    function softmaxPriors(scores, len, temp) {
        const pr = new Float64Array(len);
        const total = scores.length;
        let mx = -Infinity;
        for (let k = 0; k < total; k++) if (scores[k] > mx) mx = scores[k];
        let sum = 0;
        for (let k = 0; k < total; k++) {
            const e = Math.exp((scores[k] - mx) / temp);
            if (k < len) pr[k] = e;
            sum += e;
        }
        for (let k = 0; k < len; k++) pr[k] /= sum;
        return pr;
    }

    function sortByScore(moves, scores) {
        const idx = new Array(moves.length);
        for (let k = 0; k < idx.length; k++) idx[k] = k;
        idx.sort(function (a, b) { return scores[b] - scores[a] || a - b; });
        const ms = new Array(idx.length), ss = new Float64Array(idx.length);
        for (let k = 0; k < idx.length; k++) {
            ms[k] = moves[idx[k]];
            ss[k] = scores[idx[k]];
        }
        return {moves: ms, scores: ss};
    }

    // Generates, scores and sorts the moves of `node` (state `st`) and keeps the best `cap`
    // (cap 0 = all). Ordering is deterministic, so a later expansion with a larger cap extends
    // the same prefix and the existing children stay aligned.
    function expandNode(node, st, cap) {
        const moves = E.legalMoves(st, st.current, CANONICAL);
        const scores = new Float64Array(moves.length);
        scoreMoves(st, moves, scores, node.move === null ? evalP1(st) : node.v0);
        const sorted = sortByScore(moves, scores);
        const total = sorted.moves.length;
        const len = cap > 0 && total > cap ? cap : total;
        const old = node.children;
        node.complete = len === total;
        node.moves = len === total ? sorted.moves : sorted.moves.slice(0, len);
        node.priors = softmaxPriors(sorted.scores, len, PRIOR_TEMP);
        const ch = new Array(len).fill(null);
        if (old !== null) {
            for (let i = 0; i < old.length && i < len; i++) ch[i] = old[i];
        }
        node.children = ch;
        return sorted;
    }

    function allowedChildren(node, isRoot) {
        const sqrtN = Math.sqrt(node.N + 1);
        return isRoot ? K_BASE_ROOT + Math.floor(K_MUL_ROOT * sqrtN) : K_BASE + Math.floor(K_MUL * sqrtN);
    }

    // Creates and statically evaluates the child for edge i of `node` (state `st`). The child
    // state is not cached; it is rebuilt when the child is visited again. Ending the root
    // mover's turn in a position this game has already reached (S.hist; set only in games without
    // a turn limit) scores as a draw.
    function createChild(S, node, st0, i) {
        const st = E.applyMove(st0, node.moves[i], FAST);
        const child = new Node(st, node.moves[i]);
        let v = evalP1(st);
        if (EVAL_SOLVED >= 0) {
            child.solved = EVAL_SOLVED;
        } else if (node.ownTurn && S.hist !== null && st.phase === 'PLAY' &&
            st.current !== node.mover && S.hist.has(boardKey(st))) {
            child.solved = 0;
            v = 0;
        }
        child.ownTurn = node.ownTurn && st.phase === 'PLAY' && st.current === node.mover;
        child.state = null;
        child.v0 = v;
        node.children[i] = child;
        S.nodes++;
        return child;
    }

    function solvedValue(w) {
        return w === 1 ? 1 : (w === 2 ? -1 : 0);
    }

    function selectChild(node, isRoot) {
        const moves = node.moves, ch = node.children, pr = node.priors;
        const M = moves.length;
        const sqrtN = Math.sqrt(node.N + 1);
        let allow = Math.min(M, allowedChildren(node, isRoot));
        const sign = node.mover === 1 ? 1 : -1;
        const fpu = (node.N > 0 ? sign * node.W / node.N : 0) - FPU_REDUCTION;
        const mover = node.mover;
        let best = -1, bestScore = -Infinity, solvedCount = 0, anyDraw = false;
        for (let i = 0; i < allow; i++) {
            const c = ch[i];
            let q, nv;
            if (c !== null) {
                if (c.solved >= 0) {
                    if (c.solved === mover) {
                        node.solved = mover;
                        return i;
                    }
                    solvedCount++;
                    if (c.solved !== 0) {
                        if (allow < M) allow++;
                        continue;
                    }
                    anyDraw = true;
                    q = 0;
                } else {
                    q = sign * c.W / c.N;
                }
                nv = c.N;
            } else {
                q = fpu;
                nv = 0;
            }
            const u = q + C_PUCT * pr[i] * sqrtN / (1 + nv);
            if (u > bestScore) {
                bestScore = u;
                best = i;
            }
        }
        if (node.complete && solvedCount === M) node.solved = anyDraw ? 0 : 3 - mover;
        if (best < 0 && node.solved < 0 && node.complete) node.solved = 3 - mover;
        return best;
    }

    // Re-derives the solved status of a node from its children (MCTS-Solver).
    function updateSolved(node) {
        if (node.solved >= 0 || node.children === null) return node.solved >= 0;
        const mover = node.mover, ch = node.children;
        let all = node.complete, anyDraw = false;
        for (let i = 0; i < ch.length; i++) {
            const c = ch[i];
            if (c === null || c.solved < 0) {
                all = false;
                continue;
            }
            if (c.solved === mover) {
                node.solved = mover;
                return true;
            }
            if (c.solved === 0) anyDraw = true;
        }
        if (all) {
            node.solved = anyDraw ? 0 : 3 - mover;
            return true;
        }
        return false;
    }

    function iterate(S) {
        const path = S.path;
        path.length = 0;
        let node = S.root, st = node.state;
        path.push(node);
        let v;
        let leafSolved = false;
        for (;;) {
            if (node.solved >= 0) {
                v = solvedValue(node.solved);
                leafSolved = true;
                break;
            }
            const isRoot = node === S.root;
            if (node.moves === null) {
                expandNode(node, st, INNER_CAP0);
            } else if (!node.complete && allowedChildren(node, isRoot) + 2 > node.moves.length) {
                expandNode(node, st, node.moves.length * 2);
            }
            let i = selectChild(node, isRoot);
            if (i < 0 && node.solved < 0 && !node.complete) {
                expandNode(node, st, node.moves.length * 2);
                i = selectChild(node, isRoot);
            }
            if (i < 0 || node.solved >= 0) {
                v = node.solved >= 0 ? solvedValue(node.solved) : (node.N > 0 ? node.W / node.N : 0);
                leafSolved = node.solved >= 0;
                break;
            }
            let c = node.children[i];
            if (c === null) {
                c = createChild(S, node, st, i);
                if (node === S.root) guardRootChild(S, c, st);
                path.push(c);
                v = c.solved >= 0 ? solvedValue(c.solved) : c.v0;
                leafSolved = c.solved >= 0;
                break;
            }
            path.push(c);
            let cs = c.state;
            if (cs === null) {
                cs = E.applyMove(st, c.move, FAST);
                if (c.N + 1 >= KEEP_STATE_N) c.state = cs;
            }
            st = cs;
            node = c;
        }
        for (let k = path.length - 1; k >= 0; k--) {
            const nd = path[k];
            nd.N++;
            nd.W += v;
        }
        if (leafSolved) {
            for (let k = path.length - 2; k >= 0; k--) {
                if (!updateSolved(path[k])) break;
            }
        }
    }

    function SearchCtx(state, me, rng) {
        this.me = me;
        this.rng = rng;
        this.root = new Node(state, null);
        this.root.ownTurn = true;
        this.hist = null;      // Set of board keys of this game's earlier positions, or null
        this.path = [];
        this.nodes = 1;
        this.iterations = 0;
        this.rootPrep = 0;
        this.rootEvalCount = 0;
        this.rootHeur = null;
        this.guardChecks = 0;  // exact completion checks spent by the turn guard (guardRootChild)
        this.guardBusy = false;
        this.guardKills = [];  // opponent kills found by the turn guard, replayed first
        this.rootLost = 0;     // root moves proven lost during root preparation
    }

    // -----------------------------------------------------------------------------------------
    // MASTER: root guard for turns in progress
    // -----------------------------------------------------------------------------------------

    // A root move that leaves the own turn in progress (TRUNK step, crystal first action) is a
    // proven loss when every completion of the turn leaves the opponent a one-turn base kill
    // (found by findKill, verified by replay). Completions are checked exactly, except trunk
    // completions that add no cell of the zone of a known kill (guardZone): those cannot change
    // that kill's outcome. Over budget there is no verdict.
    const GUARD_CHILD_CHECKS = 600;   // per root move
    const GUARD_ROOT_CHECKS = 8000;   // per decision

    function guardRootChild(S, c, st0) {
        S.guardBusy = false;
        if (c.solved >= 0 || S.guardChecks >= GUARD_ROOT_CHECKS) return;
        const t = c.move.type;
        if (t !== 'TRUNK' && t !== 'BRANCH' && t !== 'ATTACK') return;
        const st = E.applyMove(st0, c.move, FAST);
        if (!stillMover(st, S.me)) return;
        // Not when ending the turn may end the game by the turn limit (distance decides), and not
        // when ending it now already ends the game (e.g. the step fills the own base's last
        // liberty): the search resolves those terminal completions itself.
        if (st.turnLimit > 0 && st.turnCount + 1 >= st.turnLimit * 2) return;
        if (E.applyMove(st, endMove(), FAST).phase === 'OVER') return;
        const G = {me: S.me, opp: 3 - S.me, g: geometry(st.cols, st.rows), kills: S.guardKills,
            checks: 0, limit: Math.min(GUARD_CHILD_CHECKS, GUARD_ROOT_CHECKS - S.guardChecks)};
        let lost;
        if (st.pending.kind === 'TRUNK') {
            lost = trunkLost(G, st, 3 - st.pending.count) !== null;
        } else {
            lost = true;
            const moves = E.legalMoves(st, S.me);
            for (let k = 0; k < moves.length && lost; k++) {
                lost = refute(G, E.applyMove(st, moves[k], FAST)) !== null;
            }
        }
        S.guardChecks += G.checks;
        S.guardBusy = G.checks > 1;
        if (lost) {
            c.solved = G.opp;
            c.v0 = solvedValue(G.opp);
        }
    }

    // The opponent's verified one-turn base kill after the completed own turn `fin`: the kill
    // sequence, [] when the own turn has already lost the game, null when not proven.
    function refute(G, fin) {
        if (fin.phase === 'OVER') return fin.winner === G.opp ? [] : null;
        if (G.checks >= G.limit) return null;
        G.checks++;
        const kills = G.kills;
        for (let k = 0; k < kills.length; k++) {
            if (replayKill(G, kills[k], fin)) {
                const seq = kills[k];
                if (k > 0) {
                    kills.splice(k, 1);
                    kills.unshift(seq);
                }
                return seq;
            }
        }
        const seq = findKill(fin, G.opp);
        if (seq === null || !replayKill(G, seq, fin)) return null;
        kills.unshift(seq);
        if (kills.length > 16) kills.pop();
        return seq;
    }

    function replayKill(G, seq, st) {
        let s = st;
        for (let k = 0; k < seq.length; k++) {
            if (!stillMover(s, G.opp) || E.validateMove(s, seq[k]) !== null) return false;
            s = E.applyMove(s, seq[k], FAST);
        }
        return wins(s, G.opp) && E.findBase(s, G.me) < 0;
    }

    // Every completion of the own trunk sequence in progress at `st` (r = 1 or 2 more steps)
    // leaves the opponent a verified base kill. Returns the kill after ending the turn at once
    // ([] when that loses by itself), or null when not proven. Completions that add no cell of
    // the zone of a kill already found for a smaller completion are covered by that kill.
    function trunkLost(G, st, r) {
        const k0 = refute(G, E.applyMove(st, endMove(), FAST));
        if (k0 === null) return null;
        const moves = E.legalMoves(st, G.me, CANONICAL);
        const z0 = k0.length > 0 ? guardZone(G, st, k0, r) : null;
        const rep = [];   // r = 2: target y in the zone, and the kill after st + y + END
        for (let i = 0; i < moves.length; i++) {
            const m = moves[i];
            if (m.type !== 'TRUNK' || (z0 !== null && z0[m.to] === 0)) continue;
            const sx = E.applyMove(st, m, FAST);
            if (r === 1) {
                if (refute(G, sx) === null) return null;
            } else {
                const kx = trunkLost(G, sx, 1);
                if (kx === null) return null;
                rep.push(m.to, kx);
            }
        }
        if (r === 1 || z0 === null) return k0;
        // Remaining completions st + x (+ y) with x outside the zone of k0: k0 still wins unless y
        // lies in the zone; then the kill found after st + y + END covers x outside its own zone.
        const g = G.g, tg = new Uint8Array(g.n);
        for (let i = 0; i < moves.length; i++) if (moves[i].type === 'TRUNK') tg[moves[i].to] = 1;
        for (let k = 0; k < rep.length; k += 2) {
            const y = rep[k], ky = rep[k + 1];
            if (ky === k0) continue;
            const zy = ky.length > 0 ? guardZone(G, st, ky, 2) : z0;
            for (let i = 0; i < moves.length; i++) {
                const m = moves[i];
                if (m.type !== 'TRUNK' || m.to === y || z0[m.to] === 1 || zy[m.to] === 0) continue;
                if (!pairLost(G, st, m, y)) return null;
            }
        }
        for (let i = 0; i < moves.length; i++) {
            const m = moves[i];
            if (m.type !== 'TRUNK' || z0[m.to] === 1) continue;
            for (let k = 0; k < 8; k++) {
                const y = g.adj[m.to * 8 + k];
                if (y < 0 || tg[y] === 1 || z0[y] === 0 || st.type[y] !== EMPTY) continue;
                if (!pairLost(G, st, m, y)) return null;
            }
        }
        return k0;
    }

    // Completion st + m + TRUNK into y (ends the turn) loses; true as well when it is illegal.
    function pairLost(G, st, m, y) {
        const sx = E.applyMove(st, m, FAST);
        const f = trunkParent(sx, G.me, y, G.g);
        if (f < 0) return true;
        const m2 = {type: 'TRUNK', from: f, to: y};
        if (E.validateMove(sx, m2) !== null) return true;
        return refute(G, E.applyMove(sx, m2, FAST)) !== null;
    }

    // Cells whose filling by the remaining own trunk steps (at most r, from `st`) may change the
    // outcome of the opponent's kill `seq`: its empty target cells; the empty liberties of the
    // units it uses and their ancestors (a squeeze kills the whole subtree) and of its non-empty
    // targets other than the own base, when r steps can fill them; and those of the opponent's
    // base and of every bomb segment when r steps plus the kill's own fills can enclose them
    // (base squeezed, blast). Other cells change neither the legality nor the effect of `seq`.
    function guardZone(G, st, seq, r) {
        const g = G.g, n = g.n, type = st.type, owner = st.owner, parent = st.parent;
        const z = new Uint8Array(n), tk = new Uint8Array(n);
        const myBase = E.findBase(st, G.me), opp = G.opp;
        G.checks++;
        for (let k = 0; k < seq.length; k++) {
            const m = seq[k];
            if (m.type !== 'END' && type[m.to] === EMPTY) {
                z[m.to] = 1;
                tk[m.to] = 1;
            }
        }
        for (let k = 0; k < seq.length; k++) {
            const m = seq[k];
            if (m.type === 'END') continue;
            if (type[m.to] !== EMPTY && m.to !== myBase) zoneLibs(st, g, m.to, r, null, z);
            for (let x = m.from, d = 0; x >= 0 && d < n; x = parent[x], d++) {
                if (owner[x] !== opp || type[x] === EMPTY || type[x] > SOLDIER) break;
                zoneLibs(st, g, x, r, null, z);
            }
        }
        const ob = E.findBase(st, opp);
        if (ob >= 0) zoneLibs(st, g, ob, r, tk, z);
        const variant = st.variant;
        for (let i = 0; i < n; i++) {
            if (type[i] === SOLDIER && variant[i] === BOMB) zoneLibs(st, g, i, r, tk, z);
        }
        return z;
    }

    // Marks the empty orthogonal neighbours of unit u when at most r of them (not counting
    // cells of `tk`) are left, i.e. when u can be squeezed.
    function zoneLibs(st, g, u, r, tk, z) {
        const t = st.type[u];
        if (g.edge[u] === 1 || t === EMPTY || t >= CORPSE) return;
        if (t === SOLDIER && st.variant[u] === DEVOURER) return;
        let cnt = 0;
        for (let q = 0; q < 4; q++) {
            const a = g.orth[u * 4 + q];
            if (st.type[a] === EMPTY && (tk === null || tk[a] === 0)) cnt++;
        }
        if (cnt > r) return;
        for (let q = 0; q < 4; q++) {
            const a = g.orth[u * 4 + q];
            if (st.type[a] === EMPTY) z[a] = 1;
        }
    }

    // Root expansion: every legal move, heuristic ranking, then a one-ply evaluation of the
    // best ROOT_EVAL_CAP moves (one more for every move proven lost, and every capture). Runs
    // incrementally until `deadline`.
    function prepareRoot(S, deadline, reuse) {
        const root = S.root;
        if (root.moves === null) {
            const sorted = expandNode(root, root.state, 0);
            S.rootHeur = sorted.scores;
            S.rootPrep = 0;
            if (reuse !== null && reuse.children !== null) {
                const n = root.state.cols * root.state.rows;
                const map = new Map();
                for (let i = 0; i < reuse.children.length; i++) {
                    const c = reuse.children[i];
                    if (c !== null) map.set(moveKey(c.move, n), c);
                }
                for (let i = 0; i < root.moves.length; i++) {
                    const c = map.get(moveKey(root.moves[i], n));
                    if (c !== undefined) {
                        root.children[i] = c;
                        root.N += c.N;
                        root.W += c.W;
                    }
                }
            }
        }
        const M = root.moves.length;
        while (S.rootPrep < M) {
            const i = S.rootPrep;
            const mv = root.moves[i];
            const tactical = mv.type === 'ATTACK' ||
                (mv.type === 'BRANCH' && root.state.type[mv.to] !== EMPTY && root.state.type[mv.to] !== CORPSE);
            if (root.children[i] === null && (i < ROOT_EVAL_CAP + S.rootLost || tactical)) {
                const c = createChild(S, root, root.state, i);
                guardRootChild(S, c, root.state);
                if (c.solved === 3 - S.me) S.rootLost++;
                const v = c.solved >= 0 ? solvedValue(c.solved) : c.v0;
                c.N = 1;
                c.W = v;
                root.N++;
                root.W += v;
                S.rootEvalCount++;
            } else if (root.children[i] !== null) {
                guardRootChild(S, root.children[i], root.state);   // reused from the last decision
            }
            S.rootPrep++;
            if (((S.rootPrep & 7) === 0 || S.guardBusy) && now() >= deadline) return false;
        }
        // Re-rank root moves by one-ply value plus heuristic score.
        const me = S.me, sign = me === 1 ? 1 : -1;
        const keys = new Float64Array(M);
        for (let i = 0; i < M; i++) {
            const c = root.children[i];
            const h = S.rootHeur[i];
            if (c !== null) {
                const q = c.solved >= 0 ? sign * solvedValue(c.solved) : sign * c.W / c.N;
                keys[i] = 12 * q + 0.25 * Math.max(-20, Math.min(20, h));
            } else {
                keys[i] = -14 + 0.25 * Math.max(-20, Math.min(20, h));
            }
            // Tiny seeded jitter: breaks ties differently between games, never changes the ranking
            // of moves whose keys differ by more than 0.02.
            keys[i] += 0.02 * S.rng();
        }
        const idx = new Array(M);
        for (let i = 0; i < M; i++) idx[i] = i;
        idx.sort(function (a, b) { return keys[b] - keys[a] || a - b; });
        const moves = new Array(M), children = new Array(M), ks = new Float64Array(M);
        for (let k = 0; k < M; k++) {
            moves[k] = root.moves[idx[k]];
            children[k] = root.children[idx[k]];
            ks[k] = keys[idx[k]];
        }
        root.moves = moves;
        root.children = children;
        root.priors = softmaxPriors(ks, M, ROOT_PRIOR_TEMP);
        updateSolved(root);
        return true;
    }

    function bestRootIndex(S) {
        const root = S.root, me = S.me, sign = me === 1 ? 1 : -1;
        let best = -1, bestN = -1, bestQ = -Infinity;
        let fallback = -1, fbN = -1;
        for (let i = 0; i < root.children.length; i++) {
            const c = root.children[i];
            if (c === null) continue;
            if (c.solved === me) return i;
            if (c.N > fbN) {
                fbN = c.N;
                fallback = i;
            }
            if (c.solved >= 0 && c.solved !== 0) continue;
            const q = c.solved === 0 ? 0 : sign * c.W / c.N;
            if (c.N > bestN || (c.N === bestN && q > bestQ)) {
                best = i;
                bestN = c.N;
                bestQ = q;
            }
        }
        if (best >= 0) return best;
        return fallback >= 0 ? fallback : 0;
    }

    // Visit lead of the most visited root move over the runner-up (unsolved or drawn moves).
    function visitLead(S) {
        const ch = S.root.children;
        let first = 0, second = 0;
        for (let i = 0; i < ch.length; i++) {
            const c = ch[i];
            if (c === null || (c.solved >= 0 && c.solved !== 0)) continue;
            if (c.N > first) {
                second = first;
                first = c.N;
            } else if (c.N > second) {
                second = c.N;
            }
        }
        return first - second;
    }

    let REUSE = null;   // {hash, node}: subtree of the last chosen MASTER move (same turn)

    // Position history of the game MASTER is playing: board keys of the positions it searched
    // and of the positions its turns produced, newest last. A state that does not continue the
    // recorded game (other settings, or a turn count outside [last, last + 2]) starts a new one.
    const HIST_MAX = 64;
    const HIST = {cfg: '', tc: -1, list: [], set: new Set()};

    // State hash without the turn counter: equal keys mean the same position.
    function boardKey(st) {
        return E.hashState(Object.assign({}, st, {turnCount: 0}));
    }

    function historyRecord(st) {
        const cfg = st.cols + 'x' + st.rows + ':' + st.mode + ':' + st.turnLimit;
        if (cfg !== HIST.cfg || st.turnCount < HIST.tc || st.turnCount > HIST.tc + 2) {
            HIST.cfg = cfg;
            HIST.list.length = 0;
            HIST.set.clear();
        }
        HIST.tc = st.turnCount;
        const k = boardKey(st);
        if (HIST.set.has(k)) return;
        HIST.list.push(k);
        HIST.set.add(k);
        if (HIST.list.length > HIST_MAX) HIST.set.delete(HIST.list.shift());
    }

    async function masterMove(state, rng, opts) {
        const t0 = now();
        const me = state.current;
        const first = state.pending === null;
        let budget;
        if (first) {
            budget = opts.timeMs !== undefined ? Number(opts.timeMs) : DEFAULT_FIRST_MS;
        } else if (opts.continuationMs !== undefined) {
            budget = Number(opts.continuationMs);
        } else {
            budget = opts.timeMs !== undefined ? Math.max(40, Math.round(Number(opts.timeMs) * 0.3))
                : DEFAULT_CONT_MS;
        }
        if (!Number.isFinite(budget) || budget < 1) budget = 1;
        const stats = opts.stats || {};
        stats.iterations = 0;
        stats.nodes = 0;
        stats.maxChunkMs = 0;
        stats.chunks = 0;
        stats.kind = 'search';

        const planned = takePlan('MASTER', state);
        if (planned !== null) {
            stats.kind = 'plan';
            stats.elapsedMs = now() - t0;
            return planned;
        }
        historyRecord(state);
        const kill = findKill(state, me);
        if (kill !== null) {
            stats.kind = 'kill';
            stats.elapsedMs = now() - t0;
            stats.maxChunkMs = stats.elapsedMs;
            return startPlan('MASTER', state, kill);
        }

        let reuseNode = null;
        if (REUSE !== null && !first) {
            if (REUSE.hash === E.hashState(state)) reuseNode = REUSE.node;
        }
        REUSE = null;

        // Yield once before the search so that the kill check above never shares a slice with it.
        const preMs = now() - t0;
        await yieldNow();
        const S = new SearchCtx(state, me, rng);
        // Repetition draws apply only without a turn limit. With a limit the turn counter keeps
        // advancing, the rules have no repetition draw, and the turn-limit result decides.
        if (HIST.list.length > 1 && !(state.turnLimit > 0)) S.hist = HIST.set;
        const deadline = t0 + budget;
        let maxChunk = preMs, maxPrep = 0;
        let chunks = 1;
        // Root preparation (sliced).
        for (;;) {
            const cs = now();
            const done = prepareRoot(S, Math.min(deadline, cs + SLICE_MS), reuseNode);
            const ce = now();
            if (ce - cs > maxPrep) maxPrep = ce - cs;
            chunks++;
            if (done) break;
            if (ce >= deadline) break;
            await yieldNow();
        }
        if (maxPrep > maxChunk) maxChunk = maxPrep;
        await yieldNow();
        const root = S.root;
        let open = 0, won = false;
        for (let i = 0; i < root.children.length; i++) {
            const c = root.children[i];
            if (c !== null && c.solved === me) {
                won = true;
                break;
            }
            if (c === null || c.solved < 0 || c.solved === 0) open++;
        }
        let stoppedEarly = false;
        if (!won && open >= 2 && root.solved < 0) {
            const searchStart = now();
            for (;;) {
                const cs = now();
                if (cs >= deadline) break;
                const sliceEnd = Math.min(deadline, cs + SLICE_MS);
                let it = 0;
                do {
                    iterate(S);
                    it++;
                } while (root.solved < 0 && ((it & 3) !== 0 || now() < sliceEnd));
                S.iterations += it;
                const ce = now();
                if (ce - cs > maxChunk) maxChunk = ce - cs;
                if (typeof opts.onProgress === 'function') {
                    try {
                        opts.onProgress({iterations: S.iterations, elapsedMs: ce - t0, timeMs: budget});
                    } catch (e) {
                        // Progress callbacks must not break the search.
                    }
                }
                if (root.solved >= 0 || ce >= deadline) break;
                // Stop when the most visited move can no longer be overtaken in the time left.
                if (S.iterations >= 200) {
                    const remaining = S.iterations / Math.max(1, ce - searchStart) * (deadline - ce);
                    if (visitLead(S) > remaining) {
                        stoppedEarly = true;
                        break;
                    }
                }
                chunks++;
                await yieldNow();
            }
        }
        const bi = bestRootIndex(S);
        const move = copyMove(root.moves[bi]);
        const child = root.children[bi];
        if (child !== null && child.solved < 0) {
            if (child.state === null) child.state = E.applyMove(state, root.moves[bi], FAST);
            if (child.state.phase === 'PLAY' && child.state.current === me) {
                REUSE = {hash: E.hashState(child.state), node: child};
            }
        }
        const next = child !== null && child.state !== null ? child.state
            : E.applyMove(state, root.moves[bi], FAST);
        if (next.phase === 'PLAY' && next.current !== me) historyRecord(next);
        stats.iterations = S.iterations;
        stats.nodes = S.nodes;
        stats.rootMoves = root.moves.length;
        stats.rootEvaluated = S.rootEvalCount;
        stats.maxChunkMs = maxChunk;
        stats.preMs = preMs;
        stats.maxPrepChunkMs = maxPrep;
        stats.chunks = chunks;
        stats.elapsedMs = now() - t0;
        stats.reused = reuseNode !== null;
        stats.stoppedEarly = stoppedEarly;
        if (child !== null) {
            stats.visits = child.N;
            stats.value = child.solved >= 0 ? (me === 1 ? 1 : -1) * solvedValue(child.solved)
                : (me === 1 ? 1 : -1) * child.W / Math.max(1, child.N);
        }
        return move;
    }

    // -----------------------------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------------------------

    async function chooseMove(state, level, opts) {
        const o = opts || {};
        if (!state || state.phase === 'OVER') throw new Error('GridAI.chooseMove: the game is over');
        if (state.phase === 'PLACE') return choosePlacement(state, state.current, o);
        const lvl = typeof level === 'string' ? level.toUpperCase() : 'HARD';
        const rng = makeRng(o.seed);
        let move;
        if (lvl === 'EASY') move = easyMove(state, rng);
        else if (lvl === 'MASTER') move = await masterMove(state, rng, o);
        else move = await hardMove(state, rng);
        if (!move || E.validateMove(state, move) !== null) move = endMove();
        return move;
    }

    return Object.freeze({
        LEVELS: LEVELS,
        choosePlacement: choosePlacement,
        chooseMove: chooseMove,
        evaluate: evaluate,
        // Internal helpers exposed for tests and the arena (not part of the stable API).
        _internal: Object.freeze({
            findKill: findKill,
            makeRng: makeRng,
            analyze: analyze,
            historyKeys: function () { return HIST.list.slice(); }
        })
    });
}));
