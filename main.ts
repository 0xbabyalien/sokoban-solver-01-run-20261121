// Sokoban solver: push-optimal, one program answering a whole set.
//
// Idea. A level is a one-square-wide hallway with small rooms (3-4 boxes)
// opening onto it through a single door each, and a box never leaves its
// room, so the push-optimal count of a level is the sum of its rooms'
// optima. This solver therefore splits the level into rooms, solves each
// room push-optimally on its own, and joins the room solutions with the
// player's walks along the hallway.
//
// Each room is solved by A* over pushes. A state is the sorted box cells
// plus the player's canonical cell (the smallest cell of the region the
// player can reach around the boxes). The heuristic is the minimum-cost
// matching of boxes to goals under reverse-push distances (each push moves
// one box one square, so the matching cost can fall by at most one per
// push: the heuristic is admissible, and A* returns a push-optimal room
// solution). States are pruned by dead squares (a cell no goal is reachable
// from by pushes) and by 2x2 freeze deadlocks. A transposition table keeps
// the best push count per state. Search budgets are counted in expansions,
// never in wall-clock time, so two runs write the same bytes.
//
// If the level does not split cleanly into rooms, the same A* runs on the
// whole level as a fallback. Any instance that cannot be solved inside its
// budget gets an empty (valid, unscored) answer rather than risking the
// whole run.
//
// Deterministic: no clock, no randomness, fixed iteration orders.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: 0 up, 1 down, 2 left, 3 right. Opposite of k is k ^ 1.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

// Deterministic work budgets (expansions, never wall-clock time).
const ROOM_MAX_EXP = 600_000;
const ROOM_RETRY_MAX_EXP = 2_500_000;
const TOTAL_MAX_EXP = 9_000_000;

let totalExpansions = 0;

/** Parse an XSB level into grid arrays. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  // Neighbour table: nbr[i * 4 + k] is the cell k steps from i, or -1.
  const nbr = new Int32Array(size * 4).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) nbr[i * 4 + k] = ny * w + nx;
      }
    }
  }
  return { w, h, size, wall, goal, boxes, player, nbr };
}

/** All permutations of [0..n-1], as index arrays. n is at most 4 here. */
function permutations(n) {
  const out = [];
  const a = [];
  for (let i = 0; i < n; i++) a.push(i);
  const gen = (k) => {
    if (k === n) { out.push(a.slice()); return; }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i], a[k]];
      gen(k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  gen(0);
  return out;
}

/**
 * Push-optimal A* for one sub-problem.
 *   playerFloor: cells the player may stand on (room floor + approach cell)
 *   boxFloor:    cells a box may sit on (room floor; never the approach cell)
 *   goals, boxes: sorted cell lists, same length
 *   player:      start cell of the player
 * Returns { moves, pushes } or null when the budget runs out.
 */
function solvePush(board, playerFloor, boxFloor, goals, boxes, player, maxExp) {
  const { w, h, size, nbr } = board;
  const n = boxes.length;
  if (n === 0) return { moves: '', pushes: 0 };
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;

  // Reverse-push distances from each goal: dist[gIdx][cell] is the fewest
  // pushes to move a box from cell onto that goal, ignoring other boxes.
  // A push from c in direction k lands on c+k and needs the player at c-k.
  const dists = goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi];
      for (let k = 0; k < 4; k++) {
        const c = nbr[x * 4 + (k ^ 1)];
        if (c < 0 || !boxFloor[c] || dist[c] >= 0) continue;
        const behind = nbr[c * 4 + (k ^ 1)];
        if (behind < 0 || !playerFloor[behind]) continue;
        dist[c] = dist[x] + 1;
        q.push(c);
      }
    }
    return dist;
  });
  // Dead squares: no goal reachable from here by pushes at all.
  const dead = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    if (!boxFloor[c]) continue;
    let live = false;
    for (let j = 0; j < n; j++) if (dists[j][c] >= 0) { live = true; break; }
    if (!live) dead[c] = 1;
  }
  for (const b of boxes) if (dead[b]) return null;

  const perms = permutations(n);
  // Heuristic cache: matching cost depends on the boxes only, not the player.
  const hCache = new Map();
  const heuristic = (bs) => {
    const key = packBoxes(bs);
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const p of perms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dists[p[i]][bs[i]];
        if (d < 0) { sum = Infinity; break; }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    hCache.set(key, best);
    return best;
  };

  // Box packing into one number for fast keys (cells fit in a byte here;
  // larger boards fall back to a string key).
  const numericKeys = size <= 255;
  function packBoxes(bs) {
    if (!numericKeys) return bs.join(',');
    let k = 0;
    for (let i = 0; i < n; i++) k |= (bs[i] + 1) << (8 * i);
    return k;
  }
  const stateKey = (packed, canonPlayer) =>
    numericKeys ? packed + canonPlayer * 4294967296 : packed + '|' + canonPlayer;

  // Player region flood fill around the boxes; returns the smallest cell
  // of the region and stamps the region cells into the given seen array.
  // Two independent stamp arrays are kept: one for the region of the state
  // being expanded (push positions are tested against it), one for the
  // canonical player cell of a successor state.
  const seenA = new Int32Array(size);
  const seenB = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;
  const region = (from, occupied, seenArr, stamp) => {
    let min = from;
    const stack = [from];
    seenArr[from] = stamp;
    while (stack.length > 0) {
      const c = stack.pop();
      if (c < min) min = c;
      for (let k = 0; k < 4; k++) {
        const q = nbr[c * 4 + k];
        if (q >= 0 && playerFloor[q] && !occupied[q] && seenArr[q] !== stamp) {
          seenArr[q] = stamp;
          stack.push(q);
        }
      }
    }
    return min;
  };

  // 2x2 freeze deadlock: a 2x2 block of wall-or-box with no goal inside,
  // holding at least one box, can never be undone.
  const frozen = (bs, occupied, cell) => {
    const x = cell % w;
    const y = (cell / w) | 0;
    for (let oy = -1; oy <= 0; oy++) {
      for (let ox = -1; ox <= 0; ox++) {
        const x0 = x + ox;
        const y0 = y + oy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
        let allSolid = true;
        let anyBox = false;
        for (let j = 0; j < 4; j++) {
          const c = (y0 + (j >> 1)) * w + x0 + (j & 1);
          if (goalSet[c]) { allSolid = false; break; }
          if (occupied[c]) { anyBox = true; continue; }
          if (!playerFloor[c]) continue; // a wall: solid
          allSolid = false;
          break;
        }
        if (allSolid && anyBox) return true;
      }
    }
    return false;
  };

  // A* state storage (parallel arrays, index = state id).
  const sBoxes = [];   // sorted box arrays
  const sPacked = [];  // packed boxes
  const sPlayer = [];  // canonical player cell
  const sG = [];       // pushes so far
  const sParent = [];  // parent state id
  const sPush = [];    // push that made this state: fromCell * 4 + dir, or -1
  const best = new Map(); // state key -> best g seen

  const startBoxes = boxes.slice();
  const startPacked = packBoxes(startBoxes);
  const occ0 = new Uint8Array(size);
  for (const b of startBoxes) occ0[b] = 1;
  const startCanon = region(player, occ0, seenA, ++stampA);
  const h0 = heuristic(startBoxes);
  if (h0 === 0) return { moves: '', pushes: 0 };
  if (!Number.isFinite(h0)) return null;

  // Binary heap of [f, h, seq, stateId], smallest first.
  const heap = [];
  let seq = 0;
  const heapLess = (a, b) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };

  sBoxes.push(startBoxes);
  sPacked.push(startPacked);
  sPlayer.push(startCanon);
  sG.push(0);
  sParent.push(-1);
  sPush.push(-1);
  best.set(stateKey(startPacked, startCanon), 0);
  heapPush([h0, h0, seq++, 0]);

  let expansions = 0;
  let goalId = -1;
  const occ = new Uint8Array(size);
  while (heap.length > 0) {
    const [, , , id] = heapPop();
    if (best.get(stateKey(sPacked[id], sPlayer[id])) !== sG[id]) continue;
    expansions++;
    totalExpansions++;
    if (expansions > maxExp || totalExpansions > TOTAL_MAX_EXP) return null;
    const bs = sBoxes[id];
    const g = sG[id];
    // Player region from this state's canonical cell.
    for (const b of bs) occ[b] = 1;
    const canon = region(sPlayer[id], occ, seenA, ++stampA);
    const myStamp = stampA;
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const dest = nbr[b * 4 + k];
        if (dest < 0 || !boxFloor[dest] || occ[dest]) continue;
        const pushPos = nbr[b * 4 + (k ^ 1)];
        if (pushPos < 0 || seenA[pushPos] !== myStamp) continue;
        if (dead[dest]) continue;
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        occ[b] = 0;
        occ[dest] = 1;
        if (frozen(nb, occ, dest)) { occ[dest] = 0; occ[b] = 1; continue; }
        const h = heuristic(nb);
        if (!Number.isFinite(h)) { occ[dest] = 0; occ[b] = 1; continue; }
        const ng = g + 1;
        const npacked = packBoxes(nb);
        // Canonical player after the push, with the NEW box layout in place:
        // the player ends on b.
        const ncanon = region(b, occ, seenB, ++stampB);
        const key = stateKey(npacked, ncanon);
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) { occ[dest] = 0; occ[b] = 1; continue; }
        best.set(key, ng);
        const nid = sBoxes.length;
        sBoxes.push(nb);
        sPacked.push(npacked);
        sPlayer.push(ncanon);
        sG.push(ng);
        sParent.push(id);
        sPush.push(b * 4 + k);
        occ[dest] = 0;
        occ[b] = 1;
        if (h === 0) { goalId = nid; heap.length = 0; break; }
        heapPush([ng + h, h, seq++, nid]);
      }
      if (goalId >= 0) break;
    }
    for (const b of bs) occ[b] = 0;
    if (goalId >= 0) break;
  }
  if (goalId < 0) return null;

  // Reconstruct the push list, then expand each push with the player's walk.
  const pushes = [];
  for (let t = goalId; t > 0; t = sParent[t]) pushes.push(sPush[t]);
  pushes.reverse();
  let moves = '';
  let curBoxes = startBoxes.slice();
  let curPlayer = player;
  const walkSeen = new Int32Array(size);
  const walkParent = new Int32Array(size);
  const walkDir = new Int8Array(size);
  let walkStamp = 0;
  const walkTo = (from, to) => {
    if (from === to) return '';
    walkStamp++;
    const q = [from];
    walkSeen[from] = walkStamp;
    walkParent[from] = -1;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (c === to) break;
      for (let k = 0; k < 4; k++) {
        const nq = nbr[c * 4 + k];
        if (nq < 0 || !playerFloor[nq] || occ[nq] || walkSeen[nq] === walkStamp) continue;
        walkSeen[nq] = walkStamp;
        walkParent[nq] = c;
        walkDir[nq] = k;
        q.push(nq);
      }
    }
    if (walkSeen[to] !== walkStamp) return null;
    let out = '';
    for (let c = to; c !== from; c = walkParent[c]) out = LETTER[walkDir[c]] + out;
    return out;
  };
  for (const b of curBoxes) occ[b] = 1;
  for (const pk of pushes) {
    const from = (pk / 4) | 0;
    const k = pk % 4;
    const pushPos = nbr[from * 4 + (k ^ 1)];
    const walk = walkTo(curPlayer, pushPos);
    if (walk === null) return null; // should not happen; stay safe
    moves += walk + LETTER[k];
    occ[from] = 0;
    const dest = nbr[from * 4 + k];
    occ[dest] = 1;
    const at = curBoxes.indexOf(from);
    curBoxes[at] = dest;
    curBoxes.sort((a, b2) => a - b2);
    curPlayer = from;
  }
  for (const b of curBoxes) occ[b] = 0;
  return { moves, pushes: pushes.length };
}

/**
 * Split a level into rooms. The hallway is the row the player starts on;
 * removing it leaves one connected component per room, each holding its
 * door cell. Returns the rooms, or null when the split is not clean.
 */
function splitRooms(board) {
  const { w, h, size, wall, goal, boxes, player, nbr } = board;
  const hallRow = (player / w) | 0;
  // No box may sit in the hallway row.
  for (const b of boxes) if (((b / w) | 0) === hallRow) return null;
  const floor = new Uint8Array(size);
  for (let i = 0; i < size; i++) floor[i] = wall[i] ? 0 : 1;
  const comp = new Int32Array(size).fill(-1);
  const rooms = [];
  let compId = 0;
  for (let i = 0; i < size; i++) {
    if (!floor[i] || ((i / w) | 0) === hallRow || comp[i] >= 0) continue;
    // Flood fill this component (all rows but the hallway row).
    const cells = [i];
    comp[i] = compId;
    for (let q = 0; q < cells.length; q++) {
      const c = cells[q];
      for (let k = 0; k < 4; k++) {
        const nq = nbr[c * 4 + k];
        if (nq < 0 || !floor[nq] || ((nq / w) | 0) === hallRow || comp[nq] >= 0) continue;
        comp[nq] = compId;
        cells.push(nq);
      }
    }
    compId++;
    const inComp = new Uint8Array(size);
    for (const c of cells) inComp[c] = 1;
    const rBoxes = boxes.filter((b) => inComp[b]);
    const rGoals = [];
    for (const c of cells) if (goal[c]) rGoals.push(c);
    if (rBoxes.length !== rGoals.length) return null;
    if (rBoxes.length === 0) continue; // bare floor, no room
    // The door: the one component cell touching a hallway floor cell.
    let door = -1;
    let approach = -1;
    for (const c of cells) {
      const y = (c / w) | 0;
      if (Math.abs(y - hallRow) !== 1) continue;
      const a = (hallRow - y > 0 ? c + w : c - w);
      if (a >= 0 && a < size && floor[a] && ((a / w) | 0) === hallRow) {
        if (door >= 0) return null; // more than one door: not clean
        door = c;
        approach = a;
      }
    }
    if (door < 0) return null;
    const playerFloor = new Uint8Array(size);
    for (const c of cells) playerFloor[c] = 1;
    playerFloor[approach] = 1;
    rooms.push({ cells, boxes: rBoxes, goals: rGoals, door, approach, playerFloor, boxFloor: inComp });
  }
  const assigned = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (assigned !== boxes.length) return null;
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

/** Replay moves on the level; true when every box ends on a goal. */
function replayOk(board, moves) {
  const { w, wall, goal, nbr } = board;
  const occ = new Uint8Array(board.size);
  for (const b of board.boxes) occ[b] = 1;
  let p = board.player;
  const idx = { u: 0, d: 1, l: 2, r: 3 };
  for (const ch of moves) {
    const k = idx[ch];
    if (k === undefined) return false;
    const q = nbr[p * 4 + k];
    if (q < 0 || wall[q]) return false;
    if (occ[q]) {
      const beyond = nbr[q * 4 + k];
      if (beyond < 0 || wall[beyond] || occ[beyond]) return false;
      occ[q] = 0;
      occ[beyond] = 1;
    }
    p = q;
  }
  for (let i = 0; i < board.size; i++) if (occ[i] && !goal[i]) return false;
  return true;
}

/** Solve one level; returns the move string ('' when unsolved). */
function solveLevel(text) {
  const board = parseLevel(text);
  const { w, size, wall, nbr } = board;
  try {
    const rooms = splitRooms(board);
    if (rooms) {
      // Solve each room on its own, then join with hallway walks.
      const occ = new Uint8Array(size);
      for (const b of board.boxes) occ[b] = 1;
      let curPlayer = board.player;
      let allMoves = '';
      const walkSeen = new Int32Array(size);
      const walkParent = new Int32Array(size);
      const walkDir = new Int8Array(size);
      let walkStamp = 0;
      const walkTo = (from, to) => {
        if (from === to) return '';
        walkStamp++;
        const q = [from];
        walkSeen[from] = walkStamp;
        walkParent[from] = -1;
        for (let qi = 0; qi < q.length; qi++) {
          const c = q[qi];
          if (c === to) break;
          for (let k = 0; k < 4; k++) {
            const nq = nbr[c * 4 + k];
            if (nq < 0 || wall[nq] || occ[nq] || walkSeen[nq] === walkStamp) continue;
            walkSeen[nq] = walkStamp;
            walkParent[nq] = c;
            walkDir[nq] = k;
            q.push(nq);
          }
        }
        if (walkSeen[to] !== walkStamp) return null;
        let out = '';
        for (let c = to; c !== from; c = walkParent[c]) out = LETTER[walkDir[c]] + out;
        return out;
      };
      let ok = true;
      for (const room of rooms) {
        let solved = solvePush(board, room.playerFloor, room.boxFloor, room.goals, room.boxes, room.approach, ROOM_MAX_EXP);
        if (!solved) solved = solvePush(board, room.playerFloor, room.boxFloor, room.goals, room.boxes, room.approach, ROOM_RETRY_MAX_EXP);
        if (!solved) { ok = false; break; }
        const walk = walkTo(curPlayer, room.approach);
        if (walk === null) { ok = false; break; }
        allMoves += walk + solved.moves;
        // Advance the simulated position: walk the moves on the real board.
        for (const ch of walk + solved.moves) {
          const k = { u: 0, d: 1, l: 2, r: 3 }[ch];
          const q = nbr[curPlayer * 4 + k];
          if (occ[q]) {
            const beyond = nbr[q * 4 + k];
            occ[q] = 0;
            occ[beyond] = 1;
          }
          curPlayer = q;
        }
      }
      if (ok && replayOk(board, allMoves)) return allMoves;
      // A room failed or the join broke: fall through to the whole-level try.
    }
    // Fallback: the same A* on the whole level.
    const floor = new Uint8Array(size);
    for (let i = 0; i < size; i++) floor[i] = wall[i] ? 0 : 1;
    const goals = [];
    for (let i = 0; i < size; i++) if (board.goal[i]) goals.push(i);
    const solved = solvePush(board, floor, floor, goals, board.boxes, board.player, Math.min(ROOM_RETRY_MAX_EXP, TOTAL_MAX_EXP - totalExpansions));
    if (solved && replayOk(board, solved.moves)) return solved.moves;
    return '';
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
