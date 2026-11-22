// Black-Hole Break for macOS Terminal.app: the animation.
//
// Started by blackhole-break.plugin.zsh with the macOS JavaScript engine:
//     osascript -l JavaScript blackhole-break.js <options as key=value>
// It reads the visible text of this shell's Terminal tab (found by its tty),
// switches the terminal to the alternate screen, plays the effect, rests,
// plays it backward, and switches back. Terminal.app then restores the
// normal screen exactly. Nothing to install: JavaScript for Automation is
// part of macOS.
//
// Time model: every frame is a pure function of t (seconds). The clock adds
// real elapsed time x speed x direction, so a slow terminal gets fewer
// frames, not a longer animation, and reverse play is exact.

'use strict';

var Core = (function () {
  var ASPECT = 2.0;            // cell height / cell width
  var STAGES = 16;
  var VARIANTS = 4;
  var DRAIN = 3;

  // ------------------------------------------------------------- helpers
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smoothstep(a, b, x) {
    if (b === a) return x >= b ? 1 : 0;
    var c = clamp((x - a) / (b - a), 0, 1);
    return c * c * (3 - 2 * c);
  }
  function blend(a, b, k) {
    k = clamp(k, 0, 1);
    return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(ix, iy, seed) {
    var h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function valueNoise(x, y, seed) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
    var c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    var top = a + (b - a) * fx;
    return top + ((c + (d - c) * fx) - top) * fy;
  }

  // East Asian wide and emoji code points take two cells.
  function charWidth(cp) {
    if (cp < 0x1100) return 1;
    if ((cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF) || (cp >= 0x20000 && cp <= 0x3FFFD)) {
      return 2;
    }
    return 1;
  }

  // ------------------------------------------------------------- screen text -> grid
  // Terminal.app gives plain text: one line per row (long lines may come as one
  // logical line). Wrap to the column count, keep the last `rows` rows.
  function parseScreen(text, cols, rows) {
    var lines = String(text || '').replace(/\r/g, '').split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    var grid = [];
    for (var i = 0; i < lines.length; i++) {
      var row = [], x = 0;
      var chars = Array.from(lines[i]);
      for (var j = 0; j < chars.length; j++) {
        var ch = chars[j];
        var cp = ch.codePointAt(0);
        if (cp < 32 || cp === 127) continue;
        var w = charWidth(cp);
        if (x + w > cols) { grid.push(row); row = []; x = 0; }
        row.push({ x: x, ch: ch, w: w });
        x += w;
      }
      grid.push(row);
    }
    if (grid.length > rows) grid = grid.slice(grid.length - rows);
    return grid;     // grid[y] = list of {x, ch, w}
  }

  function snapshotCells(grid) {
    var cells = new Map();
    for (var y = 0; y < grid.length; y++) {
      var row = grid[y];
      for (var i = 0; i < row.length; i++) {
        var c = row[i];
        if (c.ch === ' ') continue;
        cells.set(key(c.x, y), [c.ch, 'n']);
        if (c.w === 2) cells.set(key(c.x + 1, y), ['', 'cont']);
      }
    }
    return cells;
  }

  var KEYW = 4096;
  function key(x, y) { return y * KEYW + x; }

  // ------------------------------------------------------------- grains
  // [x, y, ch, w, vx, vy, delay, life, lead, variant]
  function makeGrains(grid, eff, anchor, seed) {
    var p = eff.profile, out = [];
    for (var y = 0; y < grid.length; y++) {
      var row = grid[y];
      for (var i = 0; i < row.length; i++) {
        var c = row[i];
        if (c.ch === ' ') continue;
        var x = c.x;
        var rand = mulberry32(Math.floor(hash2(x, y, seed) * 4294967296));
        var vx = 0, vy = 0, delay;
        if (anchor) {
          vx = x + c.w / 2 - anchor.cx;
          vy = (y + 0.5 - anchor.cy) * ASPECT;
          var dist = Math.hypot(vx, vy);
          var dn = Math.min(1, dist / 70);
          delay = p.firstAt + p.lead + p.sweep * Math.pow(dn, 0.85) +
            p.noise * (valueNoise(x * 0.08, y * 0.25, seed) - 0.5) + p.jitter * rand();
          if (p.minDist && dist < p.minDist) {
            var a = dist > 0.01 ? Math.atan2(vy, vx) : rand() * 2 * Math.PI;
            vx = p.minDist * Math.cos(a); vy = p.minDist * Math.sin(a);
          }
        } else {
          var f = 0.45 * (1 - Math.min(1, x / 100)) + 0.55 * valueNoise(x * 0.06, y * 0.22, seed);
          delay = p.firstAt + p.lead + p.sweep * Math.min(1, f) + p.jitter * rand();
        }
        delay = Math.max(p.firstAt + p.lead, delay);
        var life = p.lifeMin + (p.lifeMax - p.lifeMin) * rand();
        var variant = Math.floor(rand() * VARIANTS) % VARIANTS;
        out.push([x, y, c.ch, c.w, vx, vy, delay, life, p.lead, variant]);
      }
    }
    return out;
  }

  var BASE = [204, 204, 204];          // assumed text colour (Terminal.app gives no colours)

  function shrunk(ch, p) { return p > 0.85 ? '·' : p > 0.68 ? '•' : ch; }
  function rgbStyle(fg, bg) { return 'c' + fg.join(',') + (bg ? '|' + bg.join(',') : ''); }

  // ------------------------------------------------------------- overlays (half blocks)
  function sampleOverlay(cx, cy, rx, ry, cols, rows, sample, out) {
    var x0 = Math.max(0, Math.floor(cx - rx) - 1), x1 = Math.min(cols - 1, Math.floor(cx + rx) + 1);
    var y0 = Math.max(0, Math.floor(cy - ry) - 1), y1 = Math.min(rows - 1, Math.floor(cy + ry) + 1);
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - cx;
        var top = sample(dx, y + 0.25 - cy), bot = sample(dx, y + 0.75 - cy);
        if (!top && !bot) continue;
        if (top && bot && top[0] === bot[0] && top[1] === bot[1] && top[2] === bot[2]) out.push([x, y, '█', rgbStyle(top)]);
        else if (!top) out.push([x, y, '▄', rgbStyle(bot)]);
        else out.push([x, y, '▀', rgbStyle(top, bot)]);
      }
    }
    return out;
  }

  function holeRadius(rows, scale) {
    return Math.round(clamp(rows * 0.07, 1.2, 8) * clamp(scale || 1, 0.5, 3) * 100) / 100;
  }

  function holeSize(t) {
    var growEnd = 0.5, cs = 4.25, ce = 4.7, s;
    if (t <= 0 || t >= ce) return 0;
    if (t < growEnd) { var x = t / growEnd; s = 1 + 2.7 * Math.pow(x - 1, 3) + 1.7 * Math.pow(x - 1, 2); } else s = 1;
    s *= 1 + 0.25 * smoothstep(growEnd, cs, t);
    if (t > cs) { var q = (t - cs) / (ce - cs); s *= 1 - q * q * q; }
    return Math.max(0, s);
  }

  function conic(phi) { return 0.5 + 0.35 * Math.cos(phi - 1.48) + 0.15 * Math.cos(2 * phi + 0.6); }

  function burstCells(a, q, cols, rows, color, out) {
    var rb = a.r * (0.6 + 6 * q), al = Math.pow(1 - q, 1.4);
    var col = blend([40, 32, 28], color, al);
    return sampleOverlay(a.cx, a.cy, (rb + 1.2) * ASPECT, rb + 1.2, cols, rows, function (dx, dy) {
      var d = Math.hypot(dx / ASPECT, dy);
      return Math.abs(d - rb) < 0.45 + 0.6 * (1 - q) ? col : null;
    }, out);
  }

  // ------------------------------------------------------------- effects
  var SPIRAL = { firstAt: 0.35, lead: 0.3, sweep: 1.7, noise: 0.25, jitter: 0.12, lifeMin: 0.9, lifeMax: 1.6 };
  var THETA = [3.6, 4.6, 5.6, 6.6];
  var COLLAPSE_END = 4.7, BURST = 0.3;

  function spiralTable() {
    var t = [];
    for (var v = 0; v < VARIANTS; v++) {
      var row = [];
      for (var k = 0; k < STAGES; k++) {
        var p = (k + 0.5) / STAGES, r = Math.pow(1 - p, 1.5), th = THETA[v] * Math.pow(p, 1.7);
        row.push([r * Math.cos(th) - 1, r * Math.sin(th)]);
      }
      t.push(row);
    }
    return t;
  }

  function hotFlight(hot, glow, end) {
    return function (p) {
      var heat = smoothstep(0.15, 0.75, p);
      var c = blend(blend(BASE, hot, heat), glow, 0.35 * heat);
      if (p > 0.8) c = blend(c, end, (p - 0.8) / 0.2);
      return c;
    };
  }

  var blackHole = {
    name: 'blackHole',
    duration: COLLAPSE_END + BURST + 0.05,
    profile: SPIRAL,
    table: spiralTable(),
    anchors: function (cols, rows, scale) { return [{ cx: cols / 2, cy: rows / 2, r: holeRadius(rows, scale), rows: rows }]; },
    anchorIndex: function () { return 0; },
    drainPull: -0.04,
    drainColor: function (g) { return blend(BASE, [200, 80, 50], 0.35 * g); },
    flightColor: hotFlight([255, 150, 60], [255, 230, 180], [60, 25, 10]),
    overlays: function (t, anchors, idx, cols, rows) {
      var a = anchors[0], out = [], s = holeSize(t);
      if (s > 0.025) {
        var R = a.r * s, ax = 2.96 * R * ASPECT, ay = R, spin = t * 150 * Math.PI / 180;
        sampleOverlay(a.cx, a.cy, ax, Math.max(ay, R * 1.2), cols, rows, function (dx, dy) {
          var rh = Math.hypot(dx / ASPECT, dy);
          if (rh <= R) return [0, 0, 0];
          if (rh <= R * 1.2) return blend([255, 170, 90], [255, 236, 200], conic(Math.atan2(dy, dx / ASPECT) - spin));
          var rho = Math.hypot(dx / ax, dy / ay);
          if (rho >= 0.42 && rho <= 1) {
            var i = smoothstep(0.42, 0.55, rho) * (1 - smoothstep(0.8, 1, rho)) * conic(Math.atan2(dy / ay, dx / ax) - spin);
            if (i > 0.16) return blend([185, 65, 15], [255, 228, 175], i);
          }
          return null;
        }, out);
      }
      var b = t - COLLAPSE_END;
      if (b > 0 && b < BURST) burstCells(a, b / BURST, cols, rows, [255, 220, 170], out);
      return out;
    }
  };

  var wormhole = Object.assign({}, blackHole, {
    name: 'wormhole',
    anchors: function (cols, rows, scale) {
      var r = Math.round(holeRadius(rows, scale) * 0.85 * 100) / 100;
      return [{ cx: cols * 0.28, cy: rows * 0.33, r: r, rows: rows }, { cx: cols * 0.72, cy: rows * 0.68, r: r, rows: rows }];
    },
    anchorIndex: function (returning) { return returning ? 1 : 0; },
    drainColor: function (g) { return blend(BASE, [90, 110, 200], 0.35 * g); },
    flightColor: hotFlight([110, 170, 255], [200, 230, 255], [15, 20, 60]),
    overlays: function (t, anchors, idx, cols, rows) {
      var a = anchors[idx], out = [], s = holeSize(t);
      if (s > 0.025) {
        var R = a.r * s, sw = 2.2 * R, spin = t * 150 * Math.PI / 180;
        sampleOverlay(a.cx, a.cy, sw * ASPECT, sw, cols, rows, function (dx, dy) {
          var rh = Math.hypot(dx / ASPECT, dy);
          if (rh <= R) return rh < 0.28 * R ? [215, 235, 255] : blend([60, 80, 170], [11, 16, 48], rh / R);
          if (rh <= R * 1.15) return [150, 225, 255];
          if (rh <= R * 1.3) return [150, 95, 255];
          var rho = rh / sw;
          if (rho >= 0.45 && rho <= 1) {
            var i = smoothstep(0.45, 0.58, rho) * (1 - smoothstep(0.78, 1, rho)) *
              conic(Math.atan2(dy, dx / ASPECT) - spin + rho * 2.5);
            if (i > 0.16) return blend(blend([40, 40, 120], [200, 230, 255], i), [160, 100, 255], 0.3 * (1 - i));
          }
          return null;
        }, out);
      }
      var b = t - COLLAPSE_END;
      if (b > 0 && b < BURST) burstCells(a, b / BURST, cols, rows, [170, 200, 255], out);
      return out;
    }
  });

  var SN = { explode: 0.75, shock: 1.5, nebFrom: 0.9, nebTo: 4.0, starTo: 3.7, swirl: [-0.45, -0.18, 0.18, 0.45] };
  function coreSize(t) {
    if (t <= 0 || t >= SN.explode) return 0;
    return smoothstep(0, 0.45, t) * (1 + 0.08 * Math.sin(t * 40)) * (1 - 0.75 * smoothstep(0.6, SN.explode, t));
  }

  var supernova = {
    name: 'supernova',
    duration: SN.nebTo + 0.05,
    profile: { firstAt: 0.35, lead: 0.4, sweep: 1.0, noise: 0.1, jitter: 0.08, lifeMin: 1.0, lifeMax: 1.7, minDist: 14 },
    table: (function () {
      var t = [];
      for (var v = 0; v < VARIANTS; v++) {
        var row = [];
        for (var k = 0; k < STAGES; k++) {
          var p = (k + 0.5) / STAGES, r = 1 + 5.5 * Math.pow(p, 1.3), th = SN.swirl[v] * p;
          row.push([r * Math.cos(th) - 1, r * Math.sin(th)]);
        }
        t.push(row);
      }
      return t;
    })(),
    anchors: blackHole.anchors,
    anchorIndex: function () { return 0; },
    drainPull: -0.06,
    drainColor: function (g) { return blend(BASE, [255, 240, 200], 0.5 * g); },
    flightColor: function (p) {
      return blend(blend([255, 250, 235], [255, 150, 60], smoothstep(0, 0.5, p)), [60, 20, 10], smoothstep(0.5, 1, p));
    },
    overlays: function (t, anchors, idx, cols, rows, seed) {
      var a = anchors[0], out = [];
      var nebula = [];
      var qn = (t - SN.nebFrom) / (SN.nebTo - SN.nebFrom);
      if (qn > 0 && qn < 1) {
        var rn = 0.45 * a.rows * (0.2 + 0.8 * Math.sqrt(qn));
        var op = smoothstep(0, 0.2, qn) * (1 - smoothstep(0.55, 1, qn));
        if (op > 0.05) {
          sampleOverlay(a.cx, a.cy, rn * ASPECT, rn * 0.8, cols, rows, function (dx, dy) {
            var rho = Math.hypot(dx / ASPECT / rn, dy / (rn * 0.8));
            if (rho >= 1) return null;
            var n = valueNoise((a.cx + dx) * 0.18, (a.cy + dy) * 0.36, seed);
            var dens = op * (1 - rho) * (0.35 + 0.65 * n);
            if (dens < 0.14) return null;
            var hue = blend(blend([255, 120, 180], [110, 210, 255], rho), [150, 110, 255], n * 0.6);
            return blend([22, 16, 28], hue, Math.min(1, dens * 1.8));
          }, nebula);
        }
      }
      var cs = coreSize(t);
      if (cs > 0.02) {
        var rc = 0.8 * a.r * cs;
        sampleOverlay(a.cx, a.cy, rc * 1.5 * ASPECT, rc * 1.5, cols, rows, function (dx, dy) {
          var d = Math.hypot(dx / ASPECT, dy);
          if (d <= rc) return blend([255, 255, 255], [255, 190, 90], d / rc);
          return d <= rc * 1.5 ? [120, 70, 25] : null;
        }, out);
      }
      var b = t - SN.explode;
      if (b > 0 && b < 0.3) burstCells(a, b / 0.3, cols, rows, [255, 245, 225], out);
      var q = b / SN.shock;
      if (q > 0 && q < 1) {
        var e = 1 - Math.pow(1 - q, 3), rs = (0.6 + 0.75 * a.rows) * e, al = Math.pow(1 - q, 1.6);
        if (al > 0.1) {
          var c1 = blend([35, 30, 28], [255, 236, 205], al), c2 = blend([35, 30, 28], [255, 160, 80], al);
          sampleOverlay(a.cx, a.cy, (rs + 1) * ASPECT, rs + 1, cols, rows, function (dx, dy) {
            var d = Math.hypot(dx / ASPECT, dy);
            if (Math.abs(d - rs) < 0.35) return c1;
            return (d > rs - 1.1 && d < rs - 0.35) ? c2 : null;
          }, out);
        }
      }
      if (t > SN.explode && t < SN.starTo) {
        var pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 18));
        var fade = 1 - smoothstep(SN.starTo - 0.7, SN.starTo, t);
        out.push([Math.floor(a.cx), Math.floor(a.cy), '✦', rgbStyle(blend([40, 40, 50], blend([170, 210, 255], [255, 255, 255], pulse), fade))]);
      }
      return nebula.concat(out);
    }
  };

  var dust = {
    name: 'dust',
    profile: { firstAt: 0.2, lead: 0.35, sweep: 1.4, noise: 0, jitter: 0.12, lifeMin: 0.8, lifeMax: 1.5 },
    duration: 0.2 + 0.35 + 1.4 + 0.12 + 1.5 + 0.05,
    table: (function () {
      var t = [];
      for (var v = 0; v < VARIANTS; v++) {
        var row = [];
        for (var k = 0; k < STAGES; k++) {
          var p = (k + 0.5) / STAGES, dist = 6 + v * 4;
          row.push([dist * (0.3 * p + 0.7 * p * p), (-dist * 0.5 * p + 0.8 * Math.sin(p * Math.PI * 2 + v * 1.7)) / ASPECT]);
        }
        t.push(row);
      }
      return t;
    })(),
    direct: true,                 // table holds offsets in cells, not spiral factors
    anchors: function () { return [null]; },
    anchorIndex: function () { return 0; },
    drainPull: 0,
    drainColor: function (g) { return blend(BASE, [214, 203, 184], 0.75 * g); },
    flightColor: function (p) { return blend([224, 202, 175], [35, 33, 31], smoothstep(0.2, 1, p)); },
    overlays: function () { return []; }
  };

  var EFFECTS = { blackHole: blackHole, wormhole: wormhole, supernova: supernova, dust: dust };
  function getEffect(name) { return EFFECTS[name] || blackHole; }

  // ------------------------------------------------------------- frame(t)
  function frame(eff, grains, t, anchors, idx, cols, rows, seed) {
    var cells = new Map(), wides = [];
    for (var i = 0; i < grains.length; i++) {
      var g = grains[i], delay = g[6], life = g[7];
      if (t >= delay + life) continue;
      var x = g[0], y = g[1];
      if (t < delay - g[8]) {
        cells.set(key(x, y), [g[2], 'n']);
        if (g[3] === 2) { cells.set(key(x + 1, y), ['', 'cont']); wides.push([x, y]); }
        continue;
      }
      var px, py, ch, style;
      if (t < delay) {
        var lvl = (Math.min(DRAIN - 1, Math.floor((t - (delay - g[8])) / g[8] * DRAIN)) + 1) / DRAIN;
        var pull = (eff.drainPull || 0) * lvl;
        px = Math.round(x + pull * g[4]); py = Math.round(y + pull * g[5] / ASPECT);
        ch = g[2]; style = rgbStyle(eff.drainColor(lvl));
      } else {
        var p = (t - delay) / life, k = Math.min(STAGES - 1, Math.floor(p * STAGES));
        var row = eff.table[g[9]][k], ox, oy;
        if (eff.direct) { ox = row[0]; oy = row[1]; } else { ox = row[0] * g[4] - row[1] * g[5]; oy = (row[1] * g[4] + row[0] * g[5]) / ASPECT; }
        px = Math.round(x + ox); py = Math.round(y + oy);
        ch = shrunk(g[2], p); style = rgbStyle(eff.flightColor(p));
      }
      if (px < 0 || py < 0 || px >= cols || py >= rows) continue;
      var wide = g[3] === 2 && ch === g[2];
      if (wide && px + 1 >= cols) continue;
      cells.set(key(px, py), [ch, style]);
      if (wide) { cells.set(key(px + 1, py), ['', 'cont']); wides.push([px, py]); }
    }
    var ov = eff.overlays(t, anchors, idx, cols, rows, seed);
    for (var j = 0; j < ov.length; j++) {
      var o = ov[j];
      if (o[0] >= 0 && o[0] < cols && o[1] >= 0 && o[1] < rows) cells.set(key(o[0], o[1]), [o[2], o[3]]);
    }
    for (var w = 0; w < wides.length; w++) {         // a wide char needs its second cell
      var wx = wides[w][0], wy = wides[w][1];
      var here = cells.get(key(wx, wy)), nxt = cells.get(key(wx + 1, wy));
      var hereWide = here && here[1] !== 'cont' && here[0] && charWidth(here[0].codePointAt(0)) === 2;
      if (hereWide && (!nxt || nxt[1] !== 'cont')) cells.set(key(wx, wy), ['•', here[1]]);
      else if (!hereWide && nxt && nxt[1] === 'cont') cells.delete(key(wx + 1, wy));
    }
    return cells;
  }

  function messageCells(text, cols, rows, cells) {
    if (!text) return cells;
    var chars = Array.from(text).slice(0, Math.max(0, cols - 2));
    var x0 = Math.max(0, Math.floor((cols - chars.length) / 2)), y = Math.floor(rows / 2);
    for (var i = 0; i < chars.length; i++) if (chars[i] !== ' ') cells.set(key(x0 + i, y), [chars[i], 'c140,140,140']);
    return cells;
  }

  // ------------------------------------------------------------- ANSI renderer
  function rgbTo256(r, g, b) {
    if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
      if (r < 8) return 16;
      if (r > 248) return 231;
      return 232 + Math.round((r - 8) / 247 * 24);
    }
    var q = function (v) { return v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40); };
    return 16 + 36 * q(r) + 6 * q(g) + q(b);
  }

  function sgr(style, mode) {
    if (style === 'n' || style === 'cont') return '\x1b[0m';
    var parts = style.slice(1).split('|');
    var out = ['0'];
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].split(',').map(Number), base = i === 0 ? 38 : 48;
      out.push(mode === 'truecolor' ? base + ';2;' + c.join(';') : base + ';5;' + rgbTo256(c[0], c[1], c[2]));
    }
    return '\x1b[' + out.join(';') + 'm';
  }

  function Renderer(write, cols, rows, mode) {
    this.write = write; this.cols = cols; this.rows = rows; this.mode = mode;
    this.prev = new Map(); this.cache = {};
  }
  Renderer.prototype.draw = function (cells) {
    var prev = this.prev, changed = [];
    cells.forEach(function (v, k) { var p = prev.get(k); if (!p || p[0] !== v[0] || p[1] !== v[1]) changed.push(k); });
    prev.forEach(function (v, k) { if (!cells.has(k)) changed.push(k); });
    this.prev = cells;
    if (!changed.length) return 0;
    changed.sort(function (a, b) { return a - b; });
    var out = [], cur = null, cx = -1, cy = -1;
    for (var i = 0; i < changed.length; i++) {
      var k = changed[i], x = k % KEYW, y = (k - x) / KEYW;
      var v = cells.get(k) || [' ', 'n'];
      if (v[1] === 'cont') continue;
      if (x !== cx || y !== cy) out.push('\x1b[' + (y + 1) + ';' + (x + 1) + 'H');
      if (v[1] !== cur) {
        var s = this.cache[v[1]];
        if (!s) s = this.cache[v[1]] = sgr(v[1], this.mode);
        out.push(s); cur = v[1];
      }
      var ch = v[0] || ' ';
      out.push(ch);
      cx = x + charWidth(ch.codePointAt(0)); cy = y;
    }
    out.push('\x1b[0m');
    this.write(out.join(''));
    return changed.length;
  };

  // ------------------------------------------------------------- the break
  // io: { write(str), now() -> seconds, sleep(seconds), stop() -> bool }
  function play(io, screenText, o) {
    var cols = o.cols, rows = o.rows;
    var eff = getEffect(o.effect);
    var grid = parseScreen(screenText, cols, rows);
    var anchors = eff.anchors(cols, rows, o.holeScale);
    var seed = o.seed >>> 0;
    var grains = {};
    grains[0] = makeGrains(grid, eff, anchors[0], seed);
    var r = new Renderer(io.write, cols, rows, o.colors);
    io.write('\x1b[?1049h\x1b[?25l\x1b[0m\x1b[H\x1b[2J');
    r.draw(snapshotCells(grid));

    var t = 0, dir = 1, speed = o.speed, last = io.now(), returning = false, phase = 'out', restEnd = 0;
    var frameDt = 1 / o.fps, ended = false;
    while (true) {
      var now = io.now();
      var dt = Math.min(now - last, 0.1);
      last = now;
      if (phase !== 'rest') t = clamp(t + dt * speed * dir, 0, eff.duration);
      if (!ended && io.stop() && (phase === 'out' || phase === 'rest')) {
        ended = true; phase = 'in'; dir = -1; speed = o.speed * 1.6;
      }
      if (phase === 'out' && t >= eff.duration) { phase = 'rest'; restEnd = now + o.rest; returning = true; }
      var msg = null;
      if (phase === 'rest') {
        var left = restEnd - now;
        if (left <= 0) { phase = 'in'; dir = -1; }
        else if (o.message) { var s = Math.ceil(left); msg = o.message + '  ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
      }
      var idx = Math.min(eff.anchorIndex(returning), anchors.length - 1);
      if (!grains[idx]) grains[idx] = makeGrains(grid, eff, anchors[idx], seed);
      var cells = frame(eff, grains[idx], t, anchors, idx, cols, rows, seed);
      if (msg) messageCells(msg, cols, rows, cells);
      r.draw(cells);
      if (phase === 'in' && t <= 0) break;
      io.sleep(phase === 'rest' ? 0.2 : frameDt);
    }
    io.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    return ended ? 'ended' : 'done';
  }

  return {
    ASPECT: ASPECT, STAGES: STAGES, EFFECTS: EFFECTS, getEffect: getEffect, parseScreen: parseScreen,
    snapshotCells: snapshotCells, makeGrains: makeGrains, frame: frame, messageCells: messageCells,
    holeRadius: holeRadius, holeSize: holeSize, rgbTo256: rgbTo256, sgr: sgr, Renderer: Renderer, play: play,
    key: key, KEYW: KEYW, charWidth: charWidth
  };
})();

// --------------------------------------------------------------- JXA entry point
// Arguments: key=value pairs. tty=/dev/ttys003 effect=blackHole rest=20 speed=1 fps=30
// scale=1 colors=256 message=... stop=<file> result=<file>
// Test mode: screen=<file> cols=<n> rows=<n> out=<file> (no Terminal.app needed).
function run(argv) {
  ObjC.import('Foundation');
  var o = { effect: 'blackHole', rest: 20, speed: 1, fps: 30, scale: 1, colors: '256', message: '', front: '1' };
  for (var i = 0; i < argv.length; i++) {
    var eq = argv[i].indexOf('=');
    if (eq > 0) o[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
  }
  var fm = $.NSFileManager.defaultManager;
  function writeFile(path, text) {
    if (path) $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  }
  function readFile(path) {
    return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)) || '';
  }

  var text, cols, rows;
  if (o.screen) {
    text = readFile(o.screen); cols = Number(o.cols) || 80; rows = Number(o.rows) || 24;
  } else {
    var term = Application('Terminal');
    var tab = null, win = null;
    var wins = term.windows();
    for (var w = 0; w < wins.length && !tab; w++) {
      var tabs = wins[w].tabs();
      for (var j = 0; j < tabs.length; j++) {
        if (tabs[j].tty() === o.tty) { tab = tabs[j]; win = wins[w]; break; }
      }
    }
    // Only when the user looks at this tab: Terminal frontmost, tab selected, its window in front.
    if (!tab || (o.front === '1' && !(term.frontmost() && tab.selected() && win.index() === 1))) {
      writeFile(o.result, 'skip');
      return 'skip';
    }
    text = tab.contents(); cols = tab.numberOfColumns(); rows = tab.numberOfRows();
  }

  var outPath = o.out || '/dev/tty';
  var fh = o.out ? (function () {
    fm.createFileAtPathContentsAttributes(outPath, $.NSData.data, $());
    return $.NSFileHandle.fileHandleForWritingAtPath(outPath);
  })() : $.NSFileHandle.fileHandleForWritingAtPath(outPath);
  if (!fh || fh.isNil()) { writeFile(o.result, 'error: cannot open ' + outPath); return 'error'; }

  var io = {
    write: function (s) { fh.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding)); },
    now: function () { return Date.now() / 1000; },
    sleep: function (s) { delay(s); },
    stop: function () { return !!o.stop && fm.fileExistsAtPath(o.stop); }
  };
  var result = Core.play(io, text, {
    cols: cols, rows: rows, effect: o.effect, rest: Number(o.rest), speed: Number(o.speed),
    fps: Number(o.fps), holeScale: Number(o.scale), colors: o.colors, message: o.message,
    seed: Math.floor(Math.random() * 4294967296)
  });
  fh.closeFile;                      // JXA: an ObjC method with no arguments is a property
  writeFile(o.result, result);
  return result;
}

if (typeof module !== 'undefined') module.exports = Core;   // Node (tests only)
