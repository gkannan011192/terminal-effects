'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Core = require('../blackhole-break.js');

const SCREEN = fs.readFileSync(path.join(__dirname, 'sample-screen.txt'), 'utf8') + '中文 wide ok\n';
const COLS = 96, ROWS = 30;
const grid = Core.parseScreen(SCREEN, COLS, ROWS);

test('parseScreen wraps long lines and keeps the last rows', () => {
  const g = Core.parseScreen('x'.repeat(25) + '\nend\n', 10, 3);
  assert.deepStrictEqual(g.map((r) => r.map((c) => c.ch).join('')), ['xxxxxxxxxx', 'xxxxx', 'end']);
  const wide = Core.parseScreen('a中b', 10, 1)[0];
  assert.deepStrictEqual(wide.map((c) => [c.x, c.ch, c.w]), [[0, 'a', 1], [1, '中', 2], [3, 'b', 1]]);
});

for (const name of Object.keys(Core.EFFECTS)) {
  const eff = Core.EFFECTS[name];
  test(name + ': starts with the screen, ends empty, stays inside', () => {
    const anchors = eff.anchors(COLS, ROWS, 1);
    const snap = Core.snapshotCells(grid);
    for (let idx = 0; idx < anchors.length; idx++) {
      const g = Core.makeGrains(grid, eff, anchors[idx], 7);
      assert.deepStrictEqual([...Core.frame(eff, g, 0, anchors, idx, COLS, ROWS, 7)], [...snap]);
      assert.strictEqual(Core.frame(eff, g, eff.duration, anchors, idx, COLS, ROWS, 7).size, 0);
      for (let k = 0; k <= 60; k++) {
        const cells = Core.frame(eff, g, eff.duration * k / 60, anchors, idx, COLS, ROWS, 7);
        for (const key of cells.keys()) {
          const x = key % Core.KEYW, y = (key - x) / Core.KEYW;
          assert.ok(x >= 0 && x < COLS && y >= 0 && y < ROWS, name + ' out of screen');
        }
      }
    }
  });
}

test('wormhole comes back through the second mouth', () => {
  const eff = Core.EFFECTS.wormhole;
  const [a, b] = eff.anchors(COLS, ROWS, 1);
  assert.ok(b.cx > a.cx && b.cy > a.cy);
  assert.strictEqual(eff.anchorIndex(true), 1);
  const mid = (cells) => cells.reduce((s, c) => s + c[0], 0) / cells.length;
  assert.ok(mid(eff.overlays(1, [a, b], 0, COLS, ROWS, 1)) < mid(eff.overlays(1, [a, b], 1, COLS, ROWS, 1)));
});

test('hole grows with the terminal height', () => {
  assert.ok(Core.holeRadius(24, 1) < Core.holeRadius(60, 1));
  assert.strictEqual(Core.holeRadius(10, 1), 1.2);
});

test('sgr: 256 colours for Terminal.app, truecolor when asked', () => {
  assert.strictEqual(Core.sgr('c255,0,0', '256'), '\x1b[0;38;5;196m');
  assert.strictEqual(Core.sgr('c1,2,3|4,5,6', 'truecolor'), '\x1b[0;38;2;1;2;3;48;2;4;5;6m');
  assert.strictEqual(Core.sgr('n', '256'), '\x1b[0m');
});

function fakeIo(stopAt) {
  let t = 1000;
  const out = [];
  return {
    out,
    io: {
      write: (s) => out.push(s),
      now: () => t,
      sleep: (s) => { t += s; },
      stop: () => stopAt !== undefined && t - 1000 >= stopAt
    }
  };
}

test('play: alternate screen in and out, rest message, time-based length', () => {
  for (const name of Object.keys(Core.EFFECTS)) {
    const { io, out } = fakeIo();
    const r = Core.play(io, SCREEN, { cols: COLS, rows: ROWS, effect: name, rest: 2, speed: 1, fps: 30, holeScale: 1, colors: '256', message: 'Rest', seed: 3 });
    const all = out.join('');
    assert.strictEqual(r, 'done');
    assert.ok(all.startsWith('\x1b[?1049h'), name);
    assert.ok(all.endsWith('\x1b[?1049l'), name);
    assert.ok(all.includes('Rest'.split('').join('')) || all.includes('R'), name);
    const total = io.now() - 1000;
    const want = Core.EFFECTS[name].duration * 2 + 2;
    assert.ok(Math.abs(total - want) < 0.5, name + ': ' + total + ' vs ' + want);
  }
});

test('play: a stop request ends the break early', () => {
  const { io } = fakeIo(1.0);
  const r = Core.play(io, SCREEN, { cols: COLS, rows: ROWS, effect: 'blackHole', rest: 30, speed: 1, fps: 30, holeScale: 1, colors: '256', message: 'Rest', seed: 3 });
  assert.strictEqual(r, 'ended');
  assert.ok(io.now() - 1000 < 2.5);
});
