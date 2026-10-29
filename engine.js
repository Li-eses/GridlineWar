/*
 * Gridline War (格线战争) - pure-function rules engine.
 *
 * Shared by the player UI (Game.js), the AI (ai.js) and network sync. UMD module:
 * browser global `GridEngine` (classic <script>, works under file://) and Node `module.exports`.
 * No dependencies, no DOM access, no randomness, no wall-clock reads.
 *
 * ---------------------------------------------------------------------------------------------
 * State (plain object; callers MUST treat it as immutable - applyMove never mutates its input)
 * ---------------------------------------------------------------------------------------------
 *   cols, rows            board size; cell index i = r * cols + c, N = cols * rows (<= 32767)
 *   mode                  'CLASSIC' | 'ADVANCED'
 *   turnLimit             rounds, 0 = unlimited
 *   owner    Uint8Array   0 none, 1, 2
 *   type     Uint8Array   Type.*
 *   variant  Uint8Array   Variant.*
 *   parent   Int16Array   parent cell index, -1 none (children are derived from parent links)
 *   disabled Uint8Array   virus-disable rounds remaining
 *   phase                 'PLACE' | 'PLAY' | 'OVER'
 *   current               1 | 2, player to move
 *   cooldown              [false, p1, p2] trunk cooldown flags, indexed by player
 *   turnCount             number of completed turns (both players)
 *   pending               null
 *                         | {kind: 'TRUNK', count, last}   trunk sequence in progress; `last` is the
 *                                                          most recently grown trunk cell (extension
 *                                                          of the documented {kind, count} shape)
 *                         | {kind: 'CRYSTAL', at}          crystal extra action, only from `at`
 *   winner                null | 0 (draw) | 1 | 2 (meaningful when phase === 'OVER')
 *   overReason            Chinese reason text when the game is over, '' otherwise
 *   events                events produced by the applyMove call that created this state
 *
 * Invariants maintained by the engine:
 *   - type EMPTY  =>  owner 0, variant 0, parent -1, disabled 0.
 *   - Corpses keep owner and variant, have parent -1 and disabled 0, and never have children.
 *   - Every parent link connects two cells of the same owner, the parent is a live unit, there
 *     are no cycles, and a child lies within Chebyshev distance 2 of its parent (PARENT_RADIUS).
 *     Child lookups scan only that 5x5 window.
 *
 * ---------------------------------------------------------------------------------------------
 * Moves (plain JSON objects, cell indices)
 * ---------------------------------------------------------------------------------------------
 *   {type: 'PLACE',   to}
 *   {type: 'TRUNK',   from, to}
 *   {type: 'BRANCH',  from, to, variant}   variant is read only when `from` is a TRUNK in ADVANCED
 *                                          mode; otherwise the effective variant is derived and
 *                                          legalMoves emits the effective variant
 *   {type: 'ATTACK',  from, to}
 *   {type: 'DISABLE', from, to}
 *   {type: 'TUMOR',   from, to}            to === from converts the gene head itself
 *   {type: 'END'}
 *
 * ---------------------------------------------------------------------------------------------
 * API
 * ---------------------------------------------------------------------------------------------
 *   createState({cols, rows, mode, turnLimit})       -> state (phase 'PLACE', P1 to move)
 *   legalMoves(state, player, {canonicalTrunk})      -> Move[] (deterministic order)
 *   validateMove(state, move)                        -> null | Chinese reason string
 *   applyMove(state, move, {validate, events})       -> new state
 *   cloneState, serialize, deserialize, hashState
 *   idx, rowOf, colOf, inBounds, isHead, isEnemyBanned, hasVariantOnField, findBase (-1 if none),
 *   childrenOf, subtreeOf, effectiveVariant, variantName, opponent
 *
 * Events (state.events):
 *   PLACE{p,at} GROW{p,kind,at,from,variant} VARIANT_CREATED{p,variant} TRAMPLE{p,at}
 *   ERASE{root,count} ATTACK{p,from,at} CLEAR_CORPSE{p,at} CHAIN_DEATH{root,count} DISABLE{p,at}
 *   TUMOR_SELF{p,at} CRYSTAL_EXTRA{p,at} SQUEEZE{count} EXPLODE{at,count} TURN_END{p,action}
 *   GAME_OVER{winner,reason}
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module !== null && module.exports) {
        module.exports = api;
    } else {
        root.GridEngine = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // -----------------------------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------------------------

    const Type = Object.freeze({EMPTY: 0, BASE: 1, TRUNK: 2, SOLDIER: 3, CORPSE: 4, TUMOR: 5});
    const Variant = Object.freeze({
        NORMAL: 0, DEVOURER: 1, VIRUS: 2, CRYSTAL: 3, GENE: 4, BOMB: 5, BAN: 6
    });
    const Player = Object.freeze({NONE: 0, P1: 1, P2: 2});

    const EMPTY = 0, BASE = 1, TRUNK = 2, SOLDIER = 3, CORPSE = 4, TUMOR = 5;
    const NORMAL = 0, DEVOURER = 1, VIRUS = 2, CRYSTAL = 3, GENE = 4, BOMB = 5, BAN = 6;
    const VARIANT_COUNT = 7;
    const ALL_VARIANTS_MASK = (1 << VARIANT_COUNT) - 1;
    const LIMITED_MASK = (1 << DEVOURER) | (1 << VIRUS) | (1 << CRYSTAL) | (1 << GENE) | (1 << BOMB);
    const BAN_BIT = 1 << BAN;
    // The six advanced variants: each may be started from a trunk once per player per game.
    const ADV_MASK = LIMITED_MASK | BAN_BIT;

    // Rules revision (network version handshake). Bump on any change of legality, hashing or
    // game-over semantics.
    const RULES_VERSION = 'gw-rules-4.0';

    // Ban/pick draft (ADVANCED): draftable variants in display order and picks per player.
    const DRAFT_VARIANTS = Object.freeze([DEVOURER, VIRUS, CRYSTAL, GENE, BOMB, BAN]);
    const DRAFT_PICKS = 3;

    // Air counting: forced count after this many consecutive separated turn ends (3 rounds);
    // own turns a player must wait after an air-count offer.
    const AIR_HOLD_TURNS = 6;
    const COUNT_OFFER_COOLDOWN = 3;

    // Set of limited variants (one live branch per player). Also exposes includes() so that
    // array-style membership checks work as well as Set.has().
    const LIMITED_VARIANTS = new Set([DEVOURER, VIRUS, GENE, CRYSTAL, BOMB]);
    Object.defineProperty(LIMITED_VARIANTS, 'includes', {
        value: function (v) { return this.has(v); }
    });

    const VARIANT_NAMES = Object.freeze(['普通', '噬体', '病毒', '晶体', '基因', '炸弹', '禁']);
    const PARENT_RADIUS = 2;
    const MAX_CELLS = 32767;
    const TRUNK_STEPS = 3;
    const DISABLE_ROUNDS = 3;
    const MODES = ['CLASSIC', 'ADVANCED'];
    const PHASES = ['PLACE', 'PLAY', 'OVER'];

    // Gene jump offsets: (+-2, 0), (0, +-2), (+-2, +-2).
    const JUMP_DR = [-2, -2, -2, 0, 0, 2, 2, 2];
    const JUMP_DC = [-2, 0, 2, -2, 2, -2, 0, 2];

    const MSG = Object.freeze({
        OVER: '游戏已结束',
        BAD_MOVE: '无效的行动',
        OUT_OF_BOARD: '目标超出棋盘范围',
        PLACE_ONLY: '布阵阶段：请先放置母体',
        PLACE_DONE: '布阵阶段已结束',
        PLACE_HALF: '请在己方半场空格放置母体',
        CRYSTAL_BUSY: '晶体额外行动中，只能由该晶体头部移动或攻击',
        TRUNK_COOLDOWN: '主干冷却中',
        TRUNK_FROM: '先选择母体或主干作为起点',
        TRUNK_TARGET: '主干只能进入未封锁空格',
        TRUNK_NO_PARENT: '目标格必须邻接任意己方母体或主干',
        TRUNK_PICK_PARENT: '请先选择与该目标格相邻的己方母体/主干作为生长起点',
        SOURCE: '请选择己方有效节点',
        DISABLED: '该分支仍被病毒禁用',
        BRANCH_FROM: '分支只能从主干生长或从已有分支头部延伸',
        BRANCH_NOT_HEAD: '该分支已延伸，不能再分叉',
        BAD_VARIANT: '无效的变异类型',
        BAN_ONLY_ONE: '己方场上只能存在一个“禁”',
        STEP: '必须移动一步；基因可越过一格障碍',
        BANNED: '目标处于“禁”领域，无法进入',
        JUMP_LANDING: '基因跳跃落点必须是空格',
        TUMOR_IMMORTAL: '肿瘤无法被杀死',
        BLOCKED: '目标不可进入',
        ATTACK_RANGE: '攻击仅限头部上下左右一格',
        ATTACK_OWN: '不能攻击己方活体单位',
        DISABLE_RULE: '只能禁用病毒头部3×3内的敌方分支',
        TUMOR_RULE: '基因只能在相邻空格分化肿瘤',
        // Templates: '{v}' = variant name, '{n}' = number of own turns.
        VARIANT_NOT_PICKED: '本局未携带【{v}】',
        VARIANT_SPENT: '本局已长过【{v}】分支，每种变异体每局只能长一条',
        COUNT_NOT_SEPARATED: '双方母体尚未被完全隔开，不能请求数空气',
        COUNT_WAITING: '已请求数空气，等待对方回应',
        COUNT_ANSWER: '对方已请求数空气，请先同意或拒绝',
        COUNT_COOLDOWN: '请求数空气后需等待 {n} 个己方回合',
        COUNT_NONE: '对方没有请求数空气'
    });

    function trunkBusyMsg(count) {
        return `主干生长中 (${count}/3)，可切换生长起点或点击"结束行动"`;
    }

    function limitedMsg(v) {
        return `${variantName(v)}同时只能存在一条`;
    }

    function notPickedMsg(v) {
        return MSG.VARIANT_NOT_PICKED.replace('{v}', variantName(v));
    }

    function spentMsg(v) {
        return MSG.VARIANT_SPENT.replace('{v}', variantName(v));
    }

    function countCooldownMsg(n) {
        return MSG.COUNT_COOLDOWN.replace('{n}', String(n));
    }

    // Same mapping as the original Game.js variantName().
    function variantName(v) {
        switch (v) {
            case DEVOURER: return '噬体';
            case VIRUS: return '病毒';
            case GENE: return '基因';
            case CRYSTAL: return '晶体';
            case BOMB: return '炸弹';
            case BAN: return '禁';
            default: return '变异体';
        }
    }

    const NO_EVENTS = Object.freeze([]);

    // -----------------------------------------------------------------------------------------
    // Module-level scratch buffers (reused across calls; never observable by callers)
    // -----------------------------------------------------------------------------------------

    let scratchSize = 0;
    let stamp = 0;
    let CHILD_MARK = new Int32Array(0);
    let BAN_MARK = new Int32Array(0);
    let TGT_MARK = new Int32Array(0);
    let MARK = new Int32Array(0);
    let SRC = new Int32Array(0);
    let BAN_LIST = new Int32Array(0);
    let DEAD = new Int32Array(0);
    let ROOTS = new Int32Array(0);
    let STACK = new Int32Array(0);
    let srcLen = 0;

    // Event sink of the applyMove call in progress (null when events are disabled).
    let EV = null;

    function ensureScratch(n) {
        if (n <= scratchSize) return;
        CHILD_MARK = new Int32Array(n);
        BAN_MARK = new Int32Array(n);
        TGT_MARK = new Int32Array(n);
        MARK = new Int32Array(n);
        SRC = new Int32Array(n);
        BAN_LIST = new Int32Array(n);
        DEAD = new Int32Array(n);
        ROOTS = new Int32Array(n);
        STACK = new Int32Array(n + 1);
        scratchSize = n;
        stamp = 0;
    }

    function nextStamp() {
        if (stamp >= 0x7ffffff0) {
            CHILD_MARK.fill(0);
            BAN_MARK.fill(0);
            TGT_MARK.fill(0);
            MARK.fill(0);
            stamp = 0;
        }
        stamp += 1;
        return stamp;
    }

    // -----------------------------------------------------------------------------------------
    // State construction / copying
    // -----------------------------------------------------------------------------------------

    // Single factory so that every state object shares one hidden class.
    function makeState(cols, rows, mode, turnLimit, owner, type, variant, parent, disabled,
        phase, current, cooldown, turnCount, pending, winner, overReason, events,
        spent, draft, airSep, countOffer, countCd) {
        return {
            cols: cols,
            rows: rows,
            mode: mode,
            turnLimit: turnLimit,
            owner: owner,
            type: type,
            variant: variant,
            parent: parent,
            disabled: disabled,
            phase: phase,
            current: current,
            cooldown: cooldown,
            turnCount: turnCount,
            pending: pending,
            winner: winner,
            overReason: overReason,
            events: events,
            spent: spent,
            draft: draft,
            airSep: airSep,
            countOffer: countOffer,
            countCd: countCd
        };
    }

    // Frozen canonical copy of a draft that passed validateDraft.
    function freezeDraft(d) {
        return Object.freeze({
            banBy: Object.freeze([-1, d.banBy[1], d.banBy[2]]),
            picks: Object.freeze([0, d.picks[1], d.picks[2]])
        });
    }

    function clonePending(p) {
        if (p === null || p === undefined) return null;
        if (p.kind === 'TRUNK') {
            return {kind: 'TRUNK', count: p.count, last: p.last === undefined ? -1 : p.last};
        }
        return {kind: 'CRYSTAL', at: p.at};
    }

    function createState(opts) {
        const o = opts || {};
        const cols = o.cols === undefined || o.cols === null ? 40 : Number(o.cols);
        const rows = o.rows === undefined || o.rows === null ? (cols === 40 ? 30 : cols) : Number(o.rows);
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 ||
            cols * rows > MAX_CELLS) {
            throw new Error(`createState: invalid board size ${o.cols}x${o.rows}`);
        }
        const mode = o.mode === undefined || o.mode === null ? 'CLASSIC' : o.mode;
        if (MODES.indexOf(mode) < 0) throw new Error(`createState: invalid mode ${mode}`);
        const tl = parseInt(o.turnLimit, 10);
        const turnLimit = Number.isFinite(tl) && tl > 0 ? tl : 0;
        const n = cols * rows;
        return makeState(cols, rows, mode, turnLimit,
            new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Int16Array(n).fill(-1),
            new Uint8Array(n), 'PLACE', 1, [false, false, false], 0, null, null, '', []);
    }

    function cloneState(s) {
        return makeState(s.cols, s.rows, s.mode, s.turnLimit,
            s.owner.slice(), s.type.slice(), s.variant.slice(), s.parent.slice(), s.disabled.slice(),
            s.phase, s.current, s.cooldown.slice(), s.turnCount, clonePending(s.pending), s.winner,
            s.overReason, s.events.slice());
    }

    // -----------------------------------------------------------------------------------------
    // Geometry helpers
    // -----------------------------------------------------------------------------------------

    function isIndex(x, n) {
        return typeof x === 'number' && (x | 0) === x && x >= 0 && x < n;
    }

    function idx(s, r, c) { return r * s.cols + c; }
    function rowOf(s, i) { return (i / s.cols) | 0; }
    function colOf(s, i) { return i % s.cols; }
    function inBounds(s, r, c) { return r >= 0 && r < s.rows && c >= 0 && c < s.cols; }
    function opponent(p) { return p === 1 ? 2 : 1; }

    function chebyshev(cols, a, b) {
        const ar = (a / cols) | 0, br = (b / cols) | 0;
        const dr = ar > br ? ar - br : br - ar;
        const ac = a - ar * cols, bc = b - br * cols;
        const dc = ac > bc ? ac - bc : bc - ac;
        return dr > dc ? dr : dc;
    }

    function isOrth(cols, a, b) {
        const ar = (a / cols) | 0, br = (b / cols) | 0;
        const dr = ar > br ? ar - br : br - ar;
        const ac = a - ar * cols, bc = b - br * cols;
        const dc = ac > bc ? ac - bc : bc - ac;
        return dr + dc === 1;
    }

    // -----------------------------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------------------------

    // True when cell i has a SOLDIER child (tumour children do not count).
    function hasSoldierChild(s, i) {
        const cols = s.cols, rows = s.rows, type = s.type, parent = s.parent;
        const r = (i / cols) | 0, c = i - r * cols;
        const r0 = r > 1 ? r - 2 : 0, r1 = r + 2 < rows ? r + 2 : rows - 1;
        const c0 = c > 1 ? c - 2 : 0, c1 = c + 2 < cols ? c + 2 : cols - 1;
        for (let rr = r0; rr <= r1; rr++) {
            const rb = rr * cols;
            for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                if (parent[j] === i && j !== i && type[j] === SOLDIER) return true;
            }
        }
        return false;
    }

    function firstSoldierChild(s, i) {
        const cols = s.cols, rows = s.rows, type = s.type, parent = s.parent;
        const r = (i / cols) | 0, c = i - r * cols;
        const r0 = r > 1 ? r - 2 : 0, r1 = r + 2 < rows ? r + 2 : rows - 1;
        const c0 = c > 1 ? c - 2 : 0, c1 = c + 2 < cols ? c + 2 : cols - 1;
        for (let rr = r0; rr <= r1; rr++) {
            const rb = rr * cols;
            for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                if (parent[j] === i && j !== i && type[j] === SOLDIER) return j;
            }
        }
        return -1;
    }

    function isHead(s, i) {
        if (!isIndex(i, s.cols * s.rows)) return false;
        const t = s.type[i];
        if (t === BASE || t === TRUNK) return true;
        if (t !== SOLDIER) return false;
        return !hasSoldierChild(s, i);
    }

    // True when cell i lies within Manhattan distance 2 of a BAN soldier owned by the opponent
    // of `p` (owner != p and != 0).
    function isEnemyBanned(s, i, p) {
        const cols = s.cols, rows = s.rows, type = s.type, variant = s.variant, owner = s.owner;
        if (!isIndex(i, cols * rows)) return false;
        const r = (i / cols) | 0, c = i - r * cols;
        for (let dr = -2; dr <= 2; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            const w = dr < 0 ? 2 + dr : 2 - dr;
            const lo = c - w < 0 ? 0 : c - w, hi = c + w >= cols ? cols - 1 : c + w;
            const rb = rr * cols;
            for (let j = rb + lo, je = rb + hi; j <= je; j++) {
                if (type[j] === SOLDIER && variant[j] === BAN) {
                    const o = owner[j];
                    if (o !== p && o !== 0) return true;
                }
            }
        }
        return false;
    }

    function hasVariantOnField(s, p, v) {
        const type = s.type, owner = s.owner, variant = s.variant, n = s.cols * s.rows;
        for (let i = 0; i < n; i++) {
            if (type[i] === SOLDIER && owner[i] === p && variant[i] === v) return true;
        }
        return false;
    }

    // Index of the player's BASE, or -1 when it does not exist.
    function findBase(s, p) {
        const type = s.type, owner = s.owner;
        let i = type.indexOf(BASE);
        while (i !== -1) {
            if (owner[i] === p) return i;
            i = type.indexOf(BASE, i + 1);
        }
        return -1;
    }

    function childrenOf(s, i) {
        const out = [];
        if (!isIndex(i, s.cols * s.rows)) return out;
        const cols = s.cols, rows = s.rows, parent = s.parent;
        const r = (i / cols) | 0, c = i - r * cols;
        const r0 = r > 1 ? r - 2 : 0, r1 = r + 2 < rows ? r + 2 : rows - 1;
        const c0 = c > 1 ? c - 2 : 0, c1 = c + 2 < cols ? c + 2 : cols - 1;
        for (let rr = r0; rr <= r1; rr++) {
            const rb = rr * cols;
            for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                if (parent[j] === i && j !== i) out.push(j);
            }
        }
        return out;
    }

    // Root followed by all descendants (breadth-first, children in ascending index order).
    function subtreeOf(s, i) {
        if (!isIndex(i, s.cols * s.rows)) return [];
        const out = [i];
        const seen = new Set(out);
        for (let k = 0; k < out.length; k++) {
            const ch = childrenOf(s, out[k]);
            for (let m = 0; m < ch.length; m++) {
                if (!seen.has(ch[m])) {
                    seen.add(ch[m]);
                    out.push(ch[m]);
                }
            }
        }
        return out;
    }

    function isVariantValue(v) {
        return typeof v === 'number' && (v | 0) === v && v >= 0 && v < VARIANT_COUNT;
    }

    // Effective variant of a BRANCH grown from `from` with the requested variant.
    function branchVariantOf(s, from, requested) {
        if (s.mode !== 'ADVANCED') return NORMAL;
        if (s.type[from] === SOLDIER) return s.variant[from];
        return requested === undefined || requested === null ? NORMAL : requested;
    }

    // Effective variant of a BRANCH move (the value legalMoves emits). -1 for non-BRANCH moves.
    function effectiveVariant(s, move) {
        if (!move || move.type !== 'BRANCH' || !isIndex(move.from, s.cols * s.rows)) return -1;
        return branchVariantOf(s, move.from, move.variant);
    }

    function hasAdjacentTrunkParent(s, to, p) {
        const cols = s.cols, rows = s.rows, type = s.type, owner = s.owner;
        const r = (to / cols) | 0, c = to - r * cols;
        for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            for (let dc = -1; dc <= 1; dc++) {
                const cc = c + dc;
                if ((dr === 0 && dc === 0) || cc < 0 || cc >= cols) continue;
                const j = rr * cols + cc;
                if (owner[j] === p && (type[j] === BASE || type[j] === TRUNK)) return true;
            }
        }
        return false;
    }

    // -----------------------------------------------------------------------------------------
    // validateMove
    // -----------------------------------------------------------------------------------------

    function validateMove(state, move) {
        if (move === null || typeof move !== 'object') return MSG.BAD_MOVE;
        if (state.phase === 'OVER') return MSG.OVER;
        const mt = move.type;
        const n = state.cols * state.rows;
        const p = state.current;
        if (state.phase === 'PLACE') {
            if (mt !== 'PLACE') return MSG.PLACE_ONLY;
            const to = move.to;
            if (!isIndex(to, n)) return MSG.OUT_OF_BOARD;
            const c = to % state.cols;
            if (state.type[to] !== EMPTY || (p === 1 ? c >= state.cols / 2 : c < state.cols / 2)) {
                return MSG.PLACE_HALF;
            }
            return null;
        }
        if (state.phase !== 'PLAY') return MSG.BAD_MOVE;
        switch (mt) {
            case 'END':
                return null;
            case 'PLACE':
                return MSG.PLACE_DONE;
            case 'TRUNK':
                return validateTrunk(state, move, p, n);
            case 'BRANCH':
            case 'ATTACK':
            case 'DISABLE':
            case 'TUMOR':
                return validateSourced(state, move, p, n);
            default:
                return MSG.BAD_MOVE;
        }
    }

    function validateTrunk(s, m, p, n) {
        const pend = s.pending;
        if (pend !== null && pend.kind !== 'TRUNK') return MSG.CRYSTAL_BUSY;
        if (pend === null && s.cooldown[p]) return MSG.TRUNK_COOLDOWN;
        const from = m.from, to = m.to;
        if (!isIndex(from, n) || !isIndex(to, n)) return MSG.OUT_OF_BOARD;
        const ft = s.type[from];
        if (s.owner[from] !== p || (ft !== BASE && ft !== TRUNK)) return MSG.TRUNK_FROM;
        if (s.type[to] !== EMPTY || isEnemyBanned(s, to, p)) return MSG.TRUNK_TARGET;
        if (chebyshev(s.cols, from, to) !== 1) {
            return hasAdjacentTrunkParent(s, to, p) ? MSG.TRUNK_PICK_PARENT : MSG.TRUNK_NO_PARENT;
        }
        return null;
    }

    function validateSourced(s, m, p, n) {
        const mt = m.type, pend = s.pending;
        if (pend !== null) {
            if (pend.kind === 'TRUNK') return trunkBusyMsg(pend.count);
            if (mt === 'DISABLE' || mt === 'TUMOR' || m.from !== pend.at) return MSG.CRYSTAL_BUSY;
        }
        const from = m.from, to = m.to;
        if (!isIndex(from, n)) return MSG.OUT_OF_BOARD;
        const ft = s.type[from];
        if (s.owner[from] !== p || ft < BASE || ft > SOLDIER) return MSG.SOURCE;
        if (s.disabled[from] > 0) return MSG.DISABLED;
        if (!isIndex(to, n)) return MSG.OUT_OF_BOARD;
        switch (mt) {
            case 'BRANCH':
                return validateBranch(s, m, p, from, to, ft);
            case 'ATTACK':
                if (ft !== SOLDIER || hasSoldierChild(s, from) || to === from ||
                    !isOrth(s.cols, from, to) || s.type[to] === EMPTY) {
                    return MSG.ATTACK_RANGE;
                }
                if (s.owner[to] === p && s.type[to] !== CORPSE) return MSG.ATTACK_OWN;
                if (s.type[to] === TUMOR) return MSG.TUMOR_IMMORTAL;
                return null;
            case 'DISABLE':
                if (ft !== SOLDIER || s.variant[from] !== VIRUS || hasSoldierChild(s, from) ||
                    s.owner[to] === p || s.type[to] !== SOLDIER || chebyshev(s.cols, from, to) > 1) {
                    return MSG.DISABLE_RULE;
                }
                return null;
            default: // TUMOR
                if (ft !== SOLDIER || s.variant[from] !== GENE || hasSoldierChild(s, from)) {
                    return MSG.TUMOR_RULE;
                }
                if (to === from) return null;
                if (s.type[to] !== EMPTY || chebyshev(s.cols, from, to) !== 1 ||
                    isEnemyBanned(s, to, p)) {
                    return MSG.TUMOR_RULE;
                }
                return null;
        }
    }

    function validateBranch(s, m, p, from, to, ft) {
        if (ft !== TRUNK && ft !== SOLDIER) return MSG.BRANCH_FROM;
        if (ft === SOLDIER && hasSoldierChild(s, from)) return MSG.BRANCH_NOT_HEAD;
        let v;
        if (s.mode !== 'ADVANCED') {
            v = NORMAL;
        } else if (ft === SOLDIER) {
            v = s.variant[from];
        } else {
            const raw = m.variant === undefined || m.variant === null ? NORMAL : m.variant;
            if (!isVariantValue(raw)) return MSG.BAD_VARIANT;
            v = raw;
        }
        if (ft === TRUNK && ((1 << v) & LIMITED_MASK) !== 0 && hasVariantOnField(s, p, v)) {
            return limitedMsg(v);
        }
        if (v === BAN && hasVariantOnField(s, p, BAN)) return MSG.BAN_ONLY_ONE;
        const cols = s.cols;
        const fr = (from / cols) | 0, fc = from - fr * cols;
        const tr = (to / cols) | 0, tc = to - tr * cols;
        const dr = tr - fr, dc = tc - fc;
        const adr = dr < 0 ? -dr : dr, adc = dc < 0 ? -dc : dc;
        let jump = false;
        if (v === GENE && ((adr === 2 && dc === 0) || (adc === 2 && dr === 0) || (adr === 2 && adc === 2))) {
            jump = s.type[(fr + dr / 2) * cols + (fc + dc / 2)] !== EMPTY;
        }
        if (!jump && (adr > 1 || adc > 1 || (adr === 0 && adc === 0))) return MSG.STEP;
        if (isEnemyBanned(s, to, p)) return MSG.BANNED;
        const tt = s.type[to];
        if (jump && tt !== EMPTY) return MSG.JUMP_LANDING;
        const tOwner = s.owner[to];
        if (v === VIRUS && tOwner !== 0 && tOwner !== p && tt !== CORPSE) {
            return tt === TUMOR ? MSG.TUMOR_IMMORTAL : null;
        }
        if (tt !== EMPTY && !(tt === CORPSE && v === DEVOURER)) return MSG.BLOCKED;
        return null;
    }

    // -----------------------------------------------------------------------------------------
    // legalMoves
    // -----------------------------------------------------------------------------------------

    function legalMoves(state, player, opts) {
        const out = [];
        if (state.phase === 'OVER' || player !== state.current) return out;
        const cols = state.cols, rows = state.rows, n = cols * rows;
        const type = state.type, owner = state.owner;
        if (state.phase === 'PLACE') {
            const half = cols / 2;
            for (let i = 0, c = 0; i < n; i++) {
                if (type[i] === EMPTY && (player === 1 ? c < half : c >= half)) {
                    out.push({type: 'PLACE', to: i});
                }
                if (++c === cols) c = 0;
            }
            return out;
        }
        if (state.phase !== 'PLAY') return out;

        ensureScratch(n);
        const g = nextStamp();
        const p = player;
        const parent = state.parent, variant = state.variant, disabled = state.disabled;
        const childMark = CHILD_MARK, src = SRC, banList = BAN_LIST;

        // One pass: soldier-child marks, own variant mask, enemy bans, own source cells.
        let varMask = 0, nBan = 0, nSrc = 0;
        for (let i = 0; i < n; i++) {
            const t = type[i];
            if (t === EMPTY) continue;
            const o = owner[i];
            if (t === SOLDIER) {
                const par = parent[i];
                if (par >= 0) childMark[par] = g;
                const v = variant[i];
                if (o === p) varMask |= 1 << v;
                else if (v === BAN && o !== 0) banList[nBan++] = i;
            }
            if (o === p && t <= SOLDIER) src[nSrc++] = i;
        }
        srcLen = nSrc;
        for (let k = 0; k < nBan; k++) markDiamond(BAN_MARK, banList[k], g, cols, rows);

        const pend = state.pending;
        if (pend !== null && pend.kind === 'CRYSTAL') {
            const a = pend.at;
            if (isIndex(a, n) && owner[a] === p && disabled[a] === 0) {
                const t = type[a];
                if (t === TRUNK) {
                    genTrunkBranches(state, p, g, out, a, varMask);
                } else if (t === SOLDIER && childMark[a] !== g) {
                    genSoldierBranches(state, p, g, out, a, varMask);
                    genAttacks(state, p, out, a);
                }
            }
            out.push({type: 'END'});
            return out;
        }

        const canTrunk = pend === null ? !state.cooldown[p] : pend.kind === 'TRUNK';
        if (canTrunk) {
            const canonical = !!(opts && opts.canonicalTrunk);
            let last = -1;
            if (canonical && pend !== null && isIndex(pend.last, n) && owner[pend.last] === p &&
                (type[pend.last] === BASE || type[pend.last] === TRUNK)) {
                last = pend.last;
            }
            genTrunks(state, g, out, canonical, last);
        }
        if (pend !== null) {
            out.push({type: 'END'});
            return out;
        }

        for (let k = 0; k < nSrc; k++) {
            const f = src[k];
            if (disabled[f] !== 0) continue;
            const t = type[f];
            if (t === TRUNK) {
                genTrunkBranches(state, p, g, out, f, varMask);
            } else if (t === SOLDIER && childMark[f] !== g) {
                genSoldierBranches(state, p, g, out, f, varMask);
                genAttacks(state, p, out, f);
                const raw = variant[f];
                if (raw === VIRUS) genDisables(state, p, out, f);
                else if (raw === GENE) genTumors(state, g, out, f);
            }
        }
        out.push({type: 'END'});
        return out;
    }

    function markDiamond(mark, i, g, cols, rows) {
        const r = (i / cols) | 0, c = i - r * cols;
        for (let dr = -2; dr <= 2; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            const w = dr < 0 ? 2 + dr : 2 - dr;
            const lo = c - w < 0 ? 0 : c - w, hi = c + w >= cols ? cols - 1 : c + w;
            const rb = rr * cols;
            for (let j = rb + lo, je = rb + hi; j <= je; j++) mark[j] = g;
        }
    }

    function genTrunks(s, g, out, canonical, last) {
        const cols = s.cols, rows = s.rows, type = s.type;
        const banMark = BAN_MARK, tgtMark = TGT_MARK, src = SRC, nSrc = srcLen;
        let lr = -1, lc = -1;
        if (last >= 0) {
            lr = (last / cols) | 0;
            lc = last - lr * cols;
        }
        for (let k = 0; k < nSrc; k++) {
            const f = src[k];
            const ft = type[f];
            if (ft !== BASE && ft !== TRUNK) continue;
            const r = (f / cols) | 0, c = f - r * cols;
            const r0 = r > 0 ? r - 1 : 0, r1 = r < rows - 1 ? r + 1 : r;
            const c0 = c > 0 ? c - 1 : 0, c1 = c < cols - 1 ? c + 1 : c;
            for (let rr = r0; rr <= r1; rr++) {
                const rb = rr * cols;
                for (let cc = c0; cc <= c1; cc++) {
                    const j = rb + cc;
                    if (type[j] !== EMPTY || banMark[j] === g) continue;
                    if (!canonical) {
                        out.push({type: 'TRUNK', from: f, to: j});
                        continue;
                    }
                    if (tgtMark[j] === g) continue;
                    tgtMark[j] = g;
                    let from = f;
                    if (last >= 0) {
                        const dr = rr - lr, dc = cc - lc;
                        if (dr >= -1 && dr <= 1 && dc >= -1 && dc <= 1) from = last;
                    }
                    out.push({type: 'TRUNK', from: from, to: j});
                }
            }
        }
    }

    // BRANCH moves from an own TRUNK. ADVANCED: every allowed variant; CLASSIC: NORMAL only.
    function genTrunkBranches(s, p, g, out, f, varMask) {
        if (s.mode !== 'ADVANCED') {
            genBranchesSingle(s, p, g, out, f, NORMAL);
            return;
        }
        const allowed = ALL_VARIANTS_MASK & ~(varMask & (LIMITED_MASK | BAN_BIT));
        const cols = s.cols, rows = s.rows, type = s.type, owner = s.owner, banMark = BAN_MARK;
        const r = (f / cols) | 0, c = f - r * cols;
        const r0 = r > 0 ? r - 1 : 0, r1 = r < rows - 1 ? r + 1 : r;
        const c0 = c > 0 ? c - 1 : 0, c1 = c < cols - 1 ? c + 1 : c;
        for (let rr = r0; rr <= r1; rr++) {
            const rb = rr * cols;
            for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                if (j === f || banMark[j] === g) continue;
                const tt = type[j];
                if (tt === EMPTY) {
                    for (let v = 0; v < VARIANT_COUNT; v++) {
                        if ((allowed & (1 << v)) !== 0) {
                            out.push({type: 'BRANCH', from: f, to: j, variant: v});
                        }
                    }
                } else if (tt === CORPSE) {
                    if ((allowed & (1 << DEVOURER)) !== 0) {
                        out.push({type: 'BRANCH', from: f, to: j, variant: DEVOURER});
                    }
                } else if (tt !== TUMOR && owner[j] !== p && owner[j] !== 0) {
                    if ((allowed & (1 << VIRUS)) !== 0) {
                        out.push({type: 'BRANCH', from: f, to: j, variant: VIRUS});
                    }
                }
            }
        }
        if ((allowed & (1 << GENE)) !== 0) genGeneJumps(s, g, out, f);
    }

    function genSoldierBranches(s, p, g, out, f, varMask) {
        const v = s.mode === 'ADVANCED' ? s.variant[f] : NORMAL;
        if (v === BAN && (varMask & BAN_BIT) !== 0) return;
        genBranchesSingle(s, p, g, out, f, v);
    }

    function genBranchesSingle(s, p, g, out, f, v) {
        const cols = s.cols, rows = s.rows, type = s.type, owner = s.owner, banMark = BAN_MARK;
        const r = (f / cols) | 0, c = f - r * cols;
        const r0 = r > 0 ? r - 1 : 0, r1 = r < rows - 1 ? r + 1 : r;
        const c0 = c > 0 ? c - 1 : 0, c1 = c < cols - 1 ? c + 1 : c;
        for (let rr = r0; rr <= r1; rr++) {
            const rb = rr * cols;
            for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                if (j === f || banMark[j] === g) continue;
                const tt = type[j];
                if (tt === EMPTY) {
                    out.push({type: 'BRANCH', from: f, to: j, variant: v});
                } else if (tt === CORPSE) {
                    if (v === DEVOURER) out.push({type: 'BRANCH', from: f, to: j, variant: v});
                } else if (v === VIRUS && tt !== TUMOR && owner[j] !== p && owner[j] !== 0) {
                    out.push({type: 'BRANCH', from: f, to: j, variant: v});
                }
            }
        }
        if (v === GENE) genGeneJumps(s, g, out, f);
    }

    function genGeneJumps(s, g, out, f) {
        const cols = s.cols, rows = s.rows, type = s.type, banMark = BAN_MARK;
        const r = (f / cols) | 0, c = f - r * cols;
        for (let k = 0; k < 8; k++) {
            const dr = JUMP_DR[k], dc = JUMP_DC[k];
            const tr = r + dr, tc = c + dc;
            if (tr < 0 || tr >= rows || tc < 0 || tc >= cols) continue;
            const j = tr * cols + tc;
            if (type[j] !== EMPTY || banMark[j] === g) continue;
            if (type[(r + dr / 2) * cols + (c + dc / 2)] === EMPTY) continue;
            out.push({type: 'BRANCH', from: f, to: j, variant: GENE});
        }
    }

    function genAttacks(s, p, out, f) {
        const cols = s.cols, rows = s.rows;
        const r = (f / cols) | 0, c = f - r * cols;
        if (r > 0) pushAttack(s, p, out, f, f - cols);
        if (c > 0) pushAttack(s, p, out, f, f - 1);
        if (c < cols - 1) pushAttack(s, p, out, f, f + 1);
        if (r < rows - 1) pushAttack(s, p, out, f, f + cols);
    }

    function pushAttack(s, p, out, f, j) {
        const tt = s.type[j];
        if (tt === EMPTY || tt === TUMOR) return;
        if (s.owner[j] === p && tt !== CORPSE) return;
        out.push({type: 'ATTACK', from: f, to: j});
    }

    function genDisables(s, p, out, f) {
        const cols = s.cols, rows = s.rows, type = s.type, owner = s.owner;
        const r = (f / cols) | 0, c = f - r * cols;
        const r0 = r > 0 ? r - 1 : 0, r1 = r < rows - 1 ? r + 1 : r;
        const c0 = c > 0 ? c - 1 : 0, c1 = c < cols - 1 ? c + 1 : c;
        for (let rr = r0; rr <= r1; rr++) {
            const rb = rr * cols;
            for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                if (type[j] === SOLDIER && owner[j] !== p) out.push({type: 'DISABLE', from: f, to: j});
            }
        }
    }

    function genTumors(s, g, out, f) {
        const cols = s.cols, rows = s.rows, type = s.type, banMark = BAN_MARK;
        out.push({type: 'TUMOR', from: f, to: f});
        const r = (f / cols) | 0, c = f - r * cols;
        const r0 = r > 0 ? r - 1 : 0, r1 = r < rows - 1 ? r + 1 : r;
        const c0 = c > 0 ? c - 1 : 0, c1 = c < cols - 1 ? c + 1 : c;
        for (let rr = r0; rr <= r1; rr++) {
            const rb = rr * cols;
            for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                if (type[j] === EMPTY && banMark[j] !== g) out.push({type: 'TUMOR', from: f, to: j});
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // applyMove and rule primitives (operate in place on the fresh working copy)
    // -----------------------------------------------------------------------------------------

    function applyMove(state, move, opts) {
        const validate = !(opts && opts.validate === false);
        const withEvents = !(opts && opts.events === false);
        if (validate) {
            const err = validateMove(state, move);
            if (err !== null) throw new Error(err);
        }
        ensureScratch(state.cols * state.rows);
        const s = makeState(state.cols, state.rows, state.mode, state.turnLimit,
            state.owner.slice(), state.type.slice(), state.variant.slice(), state.parent.slice(),
            state.disabled.slice(), state.phase, state.current, state.cooldown.slice(),
            state.turnCount, clonePending(state.pending), state.winner, state.overReason,
            withEvents ? [] : NO_EVENTS);
        EV = withEvents ? s.events : null;
        switch (move.type) {
            case 'PLACE':
                doPlace(s, move.to);
                break;
            case 'TRUNK':
                doTrunk(s, move.from, move.to);
                break;
            case 'BRANCH':
                doBranch(s, move.from, move.to, move.variant);
                break;
            case 'ATTACK':
                doAttack(s, move.from, move.to);
                break;
            case 'DISABLE':
                doDisable(s, move.to);
                break;
            case 'TUMOR':
                doTumor(s, move.from, move.to);
                break;
            case 'END':
                endTurn(s, s.pending !== null && s.pending.kind === 'TRUNK' ? 'GROW_TRUNK' : 'PASS');
                break;
            default:
                EV = null;
                throw new Error(`applyMove: unknown move type ${String(move.type)}`);
        }
        EV = null;
        return s;
    }

    function growCell(s, i, par, t, v, p) {
        s.type[i] = t;
        s.owner[i] = p;
        s.variant[i] = v;
        s.parent[i] = par;
        s.disabled[i] = 0;
    }

    function clearCell(s, i) {
        s.type[i] = EMPTY;
        s.owner[i] = 0;
        s.variant[i] = 0;
        s.parent[i] = -1;
        s.disabled[i] = 0;
    }

    function doPlace(s, to) {
        const p = s.current;
        growCell(s, to, -1, BASE, NORMAL, p);
        if (EV !== null) EV.push({k: 'PLACE', p: p, at: to});
        if (p === 1) {
            s.current = 2;
        } else {
            s.phase = 'PLAY';
            s.current = 1;
        }
    }

    function doTrunk(s, from, to) {
        const p = s.current;
        growCell(s, to, from, TRUNK, NORMAL, p);
        if (EV !== null) EV.push({k: 'GROW', p: p, kind: 'TRUNK', at: to, from: from, variant: NORMAL});
        const pend = s.pending;
        const count = (pend !== null && pend.kind === 'TRUNK' ? pend.count : 0) + 1;
        if (count >= TRUNK_STEPS) {
            endTurn(s, 'GROW_TRUNK');
        } else {
            s.pending = {kind: 'TRUNK', count: count, last: to};
        }
    }

    function doBranch(s, from, to, requested) {
        const p = s.current;
        const ft = s.type[from];
        const v = branchVariantOf(s, from, requested);
        const creatingLimited = ft === TRUNK && ((1 << v) & LIMITED_MASK) !== 0;
        const wasCrystal = s.pending !== null && s.pending.kind === 'CRYSTAL';
        const fromCrystal = ft === SOLDIER && s.variant[from] === CRYSTAL;
        const tOwner = s.owner[to];
        if (v === VIRUS && tOwner !== 0 && tOwner !== p && s.type[to] !== CORPSE) {
            if (EV !== null) EV.push({k: 'TRAMPLE', p: p, at: to});
            const cnt = killSubtree(s, to, true);
            if (EV !== null) EV.push({k: 'ERASE', root: to, count: cnt});
            if (checkGameOver(s)) return;
        }
        growCell(s, to, from, SOLDIER, v, p);
        if (EV !== null) {
            EV.push({k: 'GROW', p: p, kind: 'SOLDIER', at: to, from: from, variant: v});
            if (creatingLimited) EV.push({k: 'VARIANT_CREATED', p: p, variant: v});
        }
        if (wasCrystal) {
            endTurn(s, 'GROW_SOLDIER');
        } else if (fromCrystal || v === CRYSTAL) {
            s.pending = {kind: 'CRYSTAL', at: to};
            if (EV !== null) EV.push({k: 'CRYSTAL_EXTRA', p: p, at: to});
        } else {
            endTurn(s, 'GROW_SOLDIER');
        }
    }

    function doAttack(s, from, to) {
        const p = s.current;
        const wasCrystal = s.pending !== null && s.pending.kind === 'CRYSTAL';
        if (s.type[to] === CORPSE) {
            clearCell(s, to);
            if (EV !== null) EV.push({k: 'CLEAR_CORPSE', p: p, at: to});
        } else {
            if (EV !== null) EV.push({k: 'ATTACK', p: p, from: from, at: to});
            const cnt = killSubtree(s, to, false);
            if (EV !== null) EV.push({k: 'CHAIN_DEATH', root: to, count: cnt});
            if (checkGameOver(s)) return;
        }
        if (wasCrystal) {
            endTurn(s, 'ATTACK');
        } else if (s.type[from] === SOLDIER && s.variant[from] === CRYSTAL) {
            s.pending = {kind: 'CRYSTAL', at: from};
            if (EV !== null) EV.push({k: 'CRYSTAL_EXTRA', p: p, at: from});
        } else {
            endTurn(s, 'ATTACK');
        }
    }

    function doDisable(s, to) {
        const p = s.current;
        s.disabled[to] = DISABLE_ROUNDS;
        if (EV !== null) EV.push({k: 'DISABLE', p: p, at: to});
        endTurn(s, 'DISABLE');
    }

    function doTumor(s, from, to) {
        const p = s.current;
        if (to === from) {
            s.type[from] = TUMOR;
            if (EV !== null) EV.push({k: 'TUMOR_SELF', p: p, at: from});
        } else {
            growCell(s, to, from, TUMOR, GENE, p);
            if (EV !== null) EV.push({k: 'GROW', p: p, kind: 'TUMOR', at: to, from: from, variant: GENE});
        }
        endTurn(s, 'TUMOR');
    }

    // chainDeath (erase = false) / eraseSubtree (erase = true) of root and all descendants.
    // Every visited node is detached (parent = -1); tumours stay alive. Returns the node count.
    function killSubtree(s, root, erase) {
        const cols = s.cols, rows = s.rows;
        const type = s.type, owner = s.owner, variant = s.variant, parent = s.parent;
        const disabled = s.disabled, stack = STACK;
        let sp = 0, count = 0;
        stack[sp++] = root;
        while (sp > 0) {
            const x = stack[--sp];
            const r = (x / cols) | 0, c = x - r * cols;
            const r0 = r > 1 ? r - 2 : 0, r1 = r + 2 < rows ? r + 2 : rows - 1;
            const c0 = c > 1 ? c - 2 : 0, c1 = c + 2 < cols ? c + 2 : cols - 1;
            for (let rr = r0; rr <= r1; rr++) {
                const rb = rr * cols;
                for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                    if (parent[j] === x && j !== x) stack[sp++] = j;
                }
            }
            count++;
            parent[x] = -1;
            const t = type[x];
            if (t === TUMOR || t === EMPTY) continue;
            if (erase) {
                type[x] = EMPTY;
                owner[x] = 0;
                variant[x] = 0;
                disabled[x] = 0;
            } else {
                type[x] = CORPSE;
                disabled[x] = 0;
            }
        }
        return count;
    }

    function finishGame(s, winner, reason) {
        s.phase = 'OVER';
        s.winner = winner;
        s.overReason = reason;
        s.pending = null;
        if (EV !== null) EV.push({k: 'GAME_OVER', winner: winner, reason: reason});
    }

    function checkGameOver(s) {
        if (s.phase === 'OVER') return true;
        const type = s.type, owner = s.owner;
        let a = false, b = false;
        let i = type.indexOf(BASE);
        while (i !== -1) {
            if (owner[i] === 1) a = true;
            else if (owner[i] === 2) b = true;
            if (a && b) return false;
            i = type.indexOf(BASE, i + 1);
        }
        finishGame(s, !a && !b ? 0 : (!a ? 2 : 1), '母体被消灭');
        return true;
    }

    function minDistToBase(s, p, base) {
        const type = s.type, owner = s.owner, cols = s.cols, n = cols * s.rows;
        const br = (base / cols) | 0, bc = base - br * cols;
        let best = Infinity;
        for (let i = 0; i < n; i++) {
            if (owner[i] !== p) continue;
            const t = type[i];
            if (t === EMPTY || t === CORPSE) continue;
            const r = (i / cols) | 0;
            const d = Math.hypot(r - br, i - r * cols - bc);
            if (d < best) best = d;
        }
        return best;
    }

    function endTurn(s, action) {
        s.pending = null;
        s.turnCount += 1;
        resolveSqueeze(s);
        if (checkGameOver(s)) return;
        if (s.turnLimit > 0 && s.turnCount >= s.turnLimit * 2 && s.current === 2) {
            const b1 = findBase(s, 1), b2 = findBase(s, 2);
            if (b1 >= 0 && b2 >= 0) {
                const d1 = minDistToBase(s, 1, b2), d2 = minDistToBase(s, 2, b1);
                let winner, reason;
                if (d1 < d2) {
                    winner = 1;
                    reason = `回合数已满，P1 距离敌方母体更近 (${d1.toFixed(1)} vs ${d2.toFixed(1)})`;
                } else if (d2 < d1) {
                    winner = 2;
                    reason = `回合数已满，P2 距离敌方母体更近 (${d2.toFixed(1)} vs ${d1.toFixed(1)})`;
                } else {
                    winner = 0;
                    reason = `回合数已满，双方最近距离相同 (${d1.toFixed(1)})，平局`;
                }
                finishGame(s, winner, reason);
                return;
            }
        }
        const p = s.current;
        s.cooldown[p] = action === 'GROW_TRUNK';
        if (EV !== null) EV.push({k: 'TURN_END', p: p, action: action});
        const np = p === 1 ? 2 : 1;
        s.current = np;
        const owner = s.owner, disabled = s.disabled, n = s.cols * s.rows;
        for (let i = 0; i < n; i++) {
            if (disabled[i] !== 0 && owner[i] === np) disabled[i] -= 1;
        }
    }

    function resolveSqueeze(s) {
        const cols = s.cols, rows = s.rows, n = cols * rows;
        const type = s.type, variant = s.variant, parent = s.parent;
        const dead = DEAD;
        let nd = 0;
        for (let r = 1; r < rows - 1; r++) {
            for (let i = r * cols + 1, e = r * cols + cols - 1; i < e; i++) {
                const t = type[i];
                if (t === EMPTY || t >= CORPSE) continue;
                if (type[i - 1] === EMPTY || type[i + 1] === EMPTY ||
                    type[i - cols] === EMPTY || type[i + cols] === EMPTY) continue;
                if (t === SOLDIER && variant[i] === DEVOURER) continue;
                dead[nd++] = i;
            }
        }
        if (nd === 0) return;
        if (EV !== null) EV.push({k: 'SQUEEZE', count: nd});

        // Bomb branches, computed before any death. Only a squeezed bomb segment explodes.
        let bombHeads = null, bombBranches = null;
        for (let k = 0; k < nd; k++) {
            const d = dead[k];
            if (type[d] !== SOLDIER || variant[d] !== BOMB) continue;
            let h = d;
            for (let steps = 0; steps < n; steps++) {
                const ch = firstSoldierChild(s, h);
                if (ch < 0) break;
                h = ch;
            }
            if (bombHeads !== null && bombHeads.indexOf(h) >= 0) continue;
            const branch = [];
            for (let x = h, steps = 0; x >= 0 && steps < n; x = parent[x], steps++) {
                if (type[x] !== SOLDIER || variant[x] !== BOMB) break;
                branch.push(x);
            }
            if (bombHeads === null) {
                bombHeads = [];
                bombBranches = [];
            }
            bombHeads.push(h);
            bombBranches.push(branch);
        }

        // Roots: dead cells that do not descend from another dead cell (computed before deaths).
        const g = nextStamp();
        const mark = MARK, roots = ROOTS;
        for (let k = 0; k < nd; k++) mark[dead[k]] = g;
        let nr = 0;
        for (let k = 0; k < nd; k++) {
            const d = dead[k];
            let a = parent[d], covered = false;
            for (let steps = 0; a >= 0 && steps < n; steps++) {
                if (mark[a] === g) {
                    covered = true;
                    break;
                }
                a = parent[a];
            }
            if (!covered) roots[nr++] = d;
        }
        for (let k = 0; k < nr; k++) {
            const rt = roots[k];
            const cnt = killSubtree(s, rt, false);
            if (EV !== null) EV.push({k: 'CHAIN_DEATH', root: rt, count: cnt});
        }

        // Explosions after all chain deaths; they never trigger further squeezes.
        if (bombHeads !== null) {
            for (let k = 0; k < bombHeads.length; k++) explode(s, bombHeads[k], bombBranches[k]);
        }
    }

    function explode(s, h, branch) {
        const cols = s.cols, rows = s.rows, type = s.type, parent = s.parent;
        const g = nextStamp();
        const mark = MARK;
        const vList = [];
        const r = (h / cols) | 0, c = h - r * cols;
        for (let dr = -2; dr <= 2; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            const w = dr < 0 ? 2 + dr : 2 - dr;
            for (let dc = -w; dc <= w; dc++) {
                const cc = c + dc;
                if (cc < 0 || cc >= cols) continue;
                const j = rr * cols + cc, t = type[j];
                if (t !== EMPTY && t !== TUMOR) {
                    mark[j] = g;
                    vList.push(j);
                }
            }
        }
        for (let k = 0; k < branch.length; k++) {
            const x = branch[k], t = type[x];
            if (t !== EMPTY && t !== TUMOR && mark[x] !== g) {
                mark[x] = g;
                vList.push(x);
            }
        }
        // Children (current links) of blasted cells that are outside the blast.
        const orphans = [];
        for (let k = 0; k < vList.length; k++) {
            const v = vList[k];
            const vr = (v / cols) | 0, vc = v - vr * cols;
            const r0 = vr > 1 ? vr - 2 : 0, r1 = vr + 2 < rows ? vr + 2 : rows - 1;
            const c0 = vc > 1 ? vc - 2 : 0, c1 = vc + 2 < cols ? vc + 2 : cols - 1;
            for (let rr = r0; rr <= r1; rr++) {
                const rb = rr * cols;
                for (let j = rb + c0, je = rb + c1; j <= je; j++) {
                    if (parent[j] === v && j !== v && mark[j] !== g) orphans.push(j);
                }
            }
        }
        for (let k = 0; k < vList.length; k++) clearCell(s, vList[k]);
        if (EV !== null) EV.push({k: 'EXPLODE', at: h, count: vList.length});
        for (let k = 0; k < orphans.length; k++) {
            const o = orphans[k];
            const t = type[o];
            if (t === TUMOR || t === EMPTY || t === CORPSE) {
                parent[o] = -1;
            } else {
                const cnt = killSubtree(s, o, false);
                if (EV !== null) EV.push({k: 'CHAIN_DEATH', root: o, count: cnt});
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Serialization and hashing
    // -----------------------------------------------------------------------------------------

    const SERIAL_FORMAT = 'gridline-engine/1';
    const CELL_STRIDE = 6;

    // Plain JSON snapshot. Cells are sparse: a flat array of
    // [index, owner, type, variant, parent, disabled] for every cell that is not a fully reset
    // EMPTY cell, in ascending index order. Events are not included.
    function serialize(s) {
        const n = s.cols * s.rows;
        const owner = s.owner, type = s.type, variant = s.variant, parent = s.parent;
        const disabled = s.disabled;
        const cells = [];
        for (let i = 0; i < n; i++) {
            if (type[i] === EMPTY && owner[i] === 0 && variant[i] === 0 && parent[i] === -1 &&
                disabled[i] === 0) continue;
            cells.push(i, owner[i], type[i], variant[i], parent[i], disabled[i]);
        }
        return {
            format: SERIAL_FORMAT,
            cols: s.cols,
            rows: s.rows,
            mode: s.mode,
            turnLimit: s.turnLimit,
            phase: s.phase,
            current: s.current,
            cooldown: [!!s.cooldown[0], !!s.cooldown[1], !!s.cooldown[2]],
            turnCount: s.turnCount,
            pending: clonePending(s.pending),
            winner: s.winner,
            overReason: s.overReason,
            cells: cells
        };
    }

    function isInt(x, lo, hi) {
        return typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
    }

    function deserialize(obj) {
        const o = typeof obj === 'string' ? JSON.parse(obj) : obj;
        const fail = (what) => { throw new Error(`deserialize: invalid ${what}`); };
        if (o === null || typeof o !== 'object') fail('payload');
        const cols = o.cols, rows = o.rows;
        if (!isInt(cols, 2, MAX_CELLS) || !isInt(rows, 1, MAX_CELLS) || cols * rows > MAX_CELLS) {
            fail('board size');
        }
        const n = cols * rows;
        if (MODES.indexOf(o.mode) < 0) fail('mode');
        if (PHASES.indexOf(o.phase) < 0) fail('phase');
        if (o.current !== 1 && o.current !== 2) fail('current');
        if (!isInt(o.turnLimit, 0, Number.MAX_SAFE_INTEGER)) fail('turnLimit');
        if (!isInt(o.turnCount, 0, Number.MAX_SAFE_INTEGER)) fail('turnCount');
        if (!Array.isArray(o.cooldown) || o.cooldown.length !== 3) fail('cooldown');
        if (o.winner !== null && o.winner !== 0 && o.winner !== 1 && o.winner !== 2) fail('winner');
        if (typeof o.overReason !== 'string') fail('overReason');
        let pending = null;
        if (o.pending !== null && o.pending !== undefined) {
            const pd = o.pending;
            if (pd.kind === 'TRUNK') {
                const last = pd.last === undefined ? -1 : pd.last;
                if (!isInt(pd.count, 1, TRUNK_STEPS - 1) || !isInt(last, -1, n - 1)) fail('pending');
                pending = {kind: 'TRUNK', count: pd.count, last: last};
            } else if (pd.kind === 'CRYSTAL') {
                if (!isInt(pd.at, 0, n - 1)) fail('pending');
                pending = {kind: 'CRYSTAL', at: pd.at};
            } else {
                fail('pending');
            }
        }
        const cells = o.cells;
        if (!Array.isArray(cells) || cells.length % CELL_STRIDE !== 0) fail('cells');
        const owner = new Uint8Array(n), type = new Uint8Array(n), variant = new Uint8Array(n);
        const parent = new Int16Array(n).fill(-1), disabled = new Uint8Array(n);
        for (let k = 0; k < cells.length; k += CELL_STRIDE) {
            const i = cells[k];
            if (!isInt(i, 0, n - 1) || !isInt(cells[k + 1], 0, 2) || !isInt(cells[k + 2], 0, 5) ||
                !isInt(cells[k + 3], 0, VARIANT_COUNT - 1) || !isInt(cells[k + 4], -1, n - 1) ||
                !isInt(cells[k + 5], 0, 255)) {
                fail('cell');
            }
            const par = cells[k + 4];
            if (par >= 0 && (par === i || chebyshev(cols, i, par) > PARENT_RADIUS)) fail('parent link');
            owner[i] = cells[k + 1];
            type[i] = cells[k + 2];
            variant[i] = cells[k + 3];
            parent[i] = par;
            disabled[i] = cells[k + 5];
        }
        return makeState(cols, rows, o.mode, o.turnLimit, owner, type, variant, parent, disabled,
            o.phase, o.current, [!!o.cooldown[0], !!o.cooldown[1], !!o.cooldown[2]], o.turnCount,
            pending, o.winner, o.overReason, []);
    }

    function mixA(h, k) {
        k = Math.imul(k, 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        k = Math.imul(k, 0x1b873593);
        h ^= k;
        h = (h << 13) | (h >>> 19);
        return (Math.imul(h, 5) + 0xe6546b64) | 0;
    }

    function mixB(h, k) {
        k = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b);
        k = (k << 17) | (k >>> 15);
        k = Math.imul(k, 0xc2b2ae35);
        h ^= k;
        h = (h << 11) | (h >>> 21);
        return (Math.imul(h, 9) + 0x7f4a7c15) | 0;
    }

    function fmix(h) {
        h ^= h >>> 16;
        h = Math.imul(h, 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        return h >>> 0;
    }

    function hex8(x) {
        const str = x.toString(16);
        return '00000000'.slice(str.length) + str;
    }

    // Deterministic 64-bit (16 hex chars) digest of every state field except `events`.
    function hashState(s) {
        let a = 0x2545f491, b = 0x6c8e9cf5;
        const pend = s.pending;
        const header = [
            s.cols, s.rows, MODES.indexOf(s.mode), s.turnLimit, PHASES.indexOf(s.phase), s.current,
            (s.cooldown[1] ? 1 : 0) | (s.cooldown[2] ? 2 : 0) | (s.cooldown[0] ? 4 : 0), s.turnCount,
            pend === null ? 0 : (pend.kind === 'TRUNK' ? 1 : 2),
            pend === null ? 0 : (pend.kind === 'TRUNK' ? pend.count : pend.at),
            pend === null || pend.kind !== 'TRUNK' ? 0 : (pend.last === undefined ? -1 : pend.last),
            s.winner === null ? 3 : s.winner
        ];
        for (let k = 0; k < header.length; k++) {
            a = mixA(a, header[k] | 0);
            b = mixB(b, header[k] | 0);
        }
        const reason = s.overReason;
        for (let k = 0; k < reason.length; k++) {
            const ch = reason.charCodeAt(k);
            a = mixA(a, ch);
            b = mixB(b, ch);
        }
        const owner = s.owner, type = s.type, variant = s.variant, parent = s.parent;
        const disabled = s.disabled, n = s.cols * s.rows;
        for (let i = 0; i < n; i++) {
            const word = owner[i] | (type[i] << 2) | (variant[i] << 5) | (disabled[i] << 8) |
                ((parent[i] + 1) << 16);
            a = mixA(a, word);
            b = mixB(b, word ^ i);
        }
        a = fmix(a ^ n);
        b = fmix(b ^ (n * 31));
        return hex8(a) + hex8(b);
    }

    // -----------------------------------------------------------------------------------------
    // Exports
    // -----------------------------------------------------------------------------------------

    return Object.freeze({
        Type: Type,
        Variant: Variant,
        Player: Player,
        LIMITED_VARIANTS: LIMITED_VARIANTS,
        VARIANT_NAMES: VARIANT_NAMES,
        PARENT_RADIUS: PARENT_RADIUS,
        TRUNK_STEPS: TRUNK_STEPS,
        DISABLE_ROUNDS: DISABLE_ROUNDS,
        MSG: MSG,

        createState: createState,
        legalMoves: legalMoves,
        validateMove: validateMove,
        applyMove: applyMove,
        cloneState: cloneState,
        serialize: serialize,
        deserialize: deserialize,
        hashState: hashState,

        idx: idx,
        rowOf: rowOf,
        colOf: colOf,
        inBounds: inBounds,
        isHead: isHead,
        isEnemyBanned: isEnemyBanned,
        hasVariantOnField: hasVariantOnField,
        findBase: findBase,
        childrenOf: childrenOf,
        subtreeOf: subtreeOf,

        effectiveVariant: effectiveVariant,
        variantName: variantName,
        opponent: opponent
    });
}));
