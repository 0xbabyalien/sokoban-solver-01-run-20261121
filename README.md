[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/0xbabyalien/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/0xbabyalien/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Built for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty ($100 in USDC). See the bounty page: https://make.fun/bounty/sokoban-solver-01-run-20261121

# Sokoban solver — push-optimal, room by room

One program (`main.ts`, plain JavaScript, Node 22, no dependencies) that
answers a whole set of Sokoban levels in a single run.

## Idea

A level is a one-square-wide hallway with small rooms (3–4 boxes each)
opening onto it through a single door, and a box never leaves its room —
so the push-optimal count of a level is the sum of its rooms' optima.
The solver therefore:

1. splits the level into rooms (the hallway is the row the player starts
   on; removing it leaves one connected component per room, door included),
2. solves each room push-optimally on its own,
3. joins the room solutions with the player's walks along the hallway.

Each room is solved by A* over pushes. A state is the sorted box cells
plus the player's canonical cell (the smallest cell of the region the
player can reach around the boxes). The heuristic is the minimum-cost
matching of boxes to goals under reverse-push distances — each push moves
one box one square, so the matching cost can fall by at most one per push,
which makes the heuristic admissible and the A* result push-optimal.
States are pruned by dead squares (cells no goal is reachable from by
pushes) and by 2×2 freeze deadlocks; a transposition table keeps the best
push count per state. If a level does not split cleanly into rooms, the
same A* runs on the whole level as a fallback.

Search budgets are counted in expansions, never in wall-clock time, so two
executions write the same bytes. Any instance that cannot be solved inside
its budget gets an empty (valid, unscored) answer rather than risking the
whole run.

## Results on the practice set

| instance | P* | pushes | points |
|----------|----|--------|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

Total score **1,000,000 / 1,000,000** (house baseline plain-astar 1.0.0
scores 200,000 on the same set). The solver was also run on 16 freshly
drawn sets from the kit's own generator: 1,000,000 on every one, each set
in under 0.4 s (budget: 60 s), with only a few hundred to a few thousand
A* expansions per set.

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
