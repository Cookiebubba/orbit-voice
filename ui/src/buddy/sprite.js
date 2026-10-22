// Orbit's pixel buddy, drawn from a pose rather than a sprite sheet: one small figure, 16 art
// pixels tall (antenna 3, head 7, body 4, legs 2), whose arms, legs, eyes, mouth, squash and
// lying-down are all pose fields. Plain JS with no DOM, so it runs (and is tested) in Node too.
//
// drawBuddy(pose) returns the figure's pixels as [x, y, color] with the origin at the middle of
// its feet: x grows right, y grows UP (y = 0 is the row the feet stand on). glyph(name) does the
// same for the little effects (Z's, sparkles, the laptop, the paper plane...).

export const PALETTE = Object.freeze({
  line: '#1b1210',
  body: '#e07b53', // Claude orange
  shade: '#b9583a',
  light: '#f6a47f',
  blush: '#ff9d8c',
  eye: '#1b1210',
  shine: '#ffffff',
  mouth: '#5a1e10',
  tongue: '#ff8f7a',
  leg: '#3a2a26',
  foot: '#241815',
  stem: '#8a8a8a',
});

/** A standing pose, the defaults every other pose changes. */
export const BASE_POSE = Object.freeze({
  facing: 1, // 1 right, -1 left, 0 toward you
  squash: 0, // 0–2: crouched before a jump, or landing
  bob: 0, // 0–1: breathing / bouncing (head and arms only)
  legs: 'stand', // stand | walk0-3 | jump | sit | dangle0 | dangle1 | spread
  armL: 'down', // down | up | out | ear | chin | wave0 | wave1 | hold | push | type0 | type1 | flail0 | flail1
  armR: 'down',
  eyes: 'open', // open | closed | half | wide | happy | dizzy | look
  lookX: 0, // -1..1 with eyes 'look' (or any open eyes)
  lookY: 0,
  mouth: 'none', // none | smile | open1 | open2 | yawn | o | flat | grin
  antenna: '#9a9a9a', // the ball's colour: Orbit's state
  antennaGlow: 0, // 0–1: a halo around the ball
  lie: 0, // 1: lying on its back (asleep, or knocked flat)
  blush: false,
});

const W = 12; // the standing grid is 12 wide (columns 0–11; the middle is between 5 and 6) and 16 tall

/**
 * The figure's pixels for a pose. Built on a standing 12×16 grid (row 0 = antenna top, row 15 =
 * feet), then mirrored for facing left and turned on its side for lying down.
 */
export function drawBuddy(poseIn = {}) {
  const p = { ...BASE_POSE, ...poseIn };
  const C = PALETTE;
  const grid = new Map(); // "c,r" -> colour, on the standing grid (r may go past 15 for dangling legs)
  const put = (c, r, color) => grid.set(`${c},${r}`, color);
  const rect = (c0, r0, c1, r1, color) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) put(c, r, color);
  };

  const sitting = p.legs === 'sit' || p.legs.startsWith('dangle');
  const sq = sitting ? 0 : Math.max(0, Math.min(2, Math.round(p.squash))); // sitting is low enough
  const bob = p.bob ? 1 : 0;
  const drop = sq + (sitting ? 2 : 0); // the head and body sink this far
  const up = drop + bob; // ...and the head this much more (breathing)
  const front = p.facing === 0;
  const f = (c) => c; // drawn facing right; mirrored afterwards for left

  // Antenna: a stem and a 2×2 ball in Orbit's colour (with an optional glow halo).
  if (p.antennaGlow > 0.05) {
    const glow = withAlpha(p.antenna, 0.25 + 0.35 * Math.min(1, p.antennaGlow));
    for (const [c, r] of [[4, 0], [7, 0], [4, 1], [7, 1], [5, -1], [6, -1], [5, 2], [6, 2]]) put(f(c), r + up, glow);
  }
  rect(f(5), 0 + up, f(6), 1 + up, p.antenna);
  put(f(5), 2 + up, C.stem);

  // Head: an 8×7 rounded block (rows 3–9).
  const hr = 3 + up;
  rect(3, hr, 8, hr, C.line);
  for (let r = hr + 1; r <= hr + 5; r++) {
    put(2, r, C.line);
    rect(3, r, 8, r, C.body);
    put(9, r, C.line);
  }
  rect(3, hr + 6, 8, hr + 6, C.line);
  put(3, hr + 1, C.light);
  put(4, hr + 1, C.light);
  put(3, hr + 2, C.light);
  rect(4, hr + 5, 8, hr + 5, C.shade); // chin shadow
  if (p.blush) {
    put(front ? 3 : 4, hr + 4, C.blush);
    put(8, hr + 4, C.blush);
  }

  // Eyes (rows hr+2..hr+3): two 1×2 eyes, shifted toward where it looks.
  const lx = Math.round(Math.max(-1, Math.min(1, p.lookX)));
  const ly = Math.round(Math.max(-1, Math.min(1, p.lookY)));
  const [e1, e2] = front ? [4 + lx, 7 + lx] : [5 + lx, 7 + lx];
  const er = hr + 2 + Math.max(0, ly);
  switch (p.eyes) {
    case 'closed':
      put(e1, er + 1, C.eye);
      put(e2, er + 1, C.eye);
      if (front) (put(e1 - 1, er + 1, C.eye), put(e2 + 1, er + 1, C.eye));
      break;
    case 'half':
      put(e1, er + 1, C.eye);
      put(e2, er + 1, C.eye);
      break;
    case 'happy': // ^ ^
      for (const e of [e1, e2]) (put(e, er, C.eye), put(e - 1, er + 1, C.eye), put(e + 1, er + 1, C.eye));
      break;
    case 'dizzy': // x x
      for (const e of [e1, e2]) (put(e - 1, er, C.eye), put(e + 1, er, C.eye), put(e, er + 1, C.eye), put(e - 1, er + 2, C.eye), put(e + 1, er + 2, C.eye));
      break;
    case 'wide':
      for (const e of [e1, e2]) (put(e, er - 1, C.eye), put(e, er, C.shine), put(e, er + 1, C.eye));
      break;
    default:
      for (const e of [e1, e2]) (put(e, er, C.eye), put(e, er + 1, C.eye));
  }

  // Mouth (row hr+4..hr+5).
  const mc = front ? 5 : 7;
  const mr = hr + 4;
  switch (p.mouth) {
    case 'smile':
      put(mc - 1, mr, C.mouth);
      put(mc + 2, mr, C.mouth);
      rect(mc, mr + 1, mc + 1, mr + 1, C.mouth);
      break;
    case 'grin':
      rect(mc - 1, mr, mc + 2, mr, C.mouth);
      rect(mc, mr + 1, mc + 1, mr + 1, C.tongue);
      break;
    case 'open1':
      rect(mc, mr, mc + 1, mr, C.mouth);
      break;
    case 'open2':
      rect(mc, mr, mc + 1, mr + 1, C.mouth);
      put(mc, mr + 1, C.tongue);
      break;
    case 'yawn':
    case 'o':
      rect(mc, mr - (p.mouth === 'yawn' ? 1 : 0), mc + 1, mr + 1, C.mouth);
      if (p.mouth === 'yawn') put(mc + 1, mr + 1, C.tongue);
      break;
    case 'flat':
      rect(mc, mr + 1, mc + 1, mr + 1, C.mouth);
      break;
  }

  // Body: 6×4 (rows 10–13), sitting lower when crouched or sitting.
  const br = 10 + drop;
  const bodyRows = sq ? 4 - Math.min(sq, 1) : 4;
  for (let r = br; r < br + bodyRows - 1; r++) {
    put(3, r, C.line);
    rect(4, r, 7, r, C.shade);
    put(8, r, C.line);
  }
  put(4, br, C.body);
  put(5, br, C.body); // a little shine on the chest
  rect(3, br + bodyRows - 1, 8, br + bodyRows - 1, C.line);

  // Arms: from the shoulders (row br) on each side.
  drawArm(put, p.armL, -1, br, hr, C);
  drawArm(put, p.armR, 1, br, hr, C);

  // Legs and feet below the body.
  const lr = br + bodyRows; // first leg row
  const leg = (c, r, len = 1) => rect(c, r, c, r + len - 1, C.leg);
  const foot = (c, r, toward = 1) => rect(Math.min(c, c + toward), r, Math.max(c, c + toward), r, C.foot);
  const legs = p.legs;
  if (legs === 'jump') {
    // Tucked up: feet right under the body.
    foot(3, lr, 1);
    foot(7, lr, 1);
  } else if (legs === 'spread') {
    leg(3, lr);
    leg(8, lr);
    foot(2, lr + 1, 1);
    foot(8, lr + 1, 1);
  } else if (legs === 'sit') {
    // Sitting on the ground: legs straight out in front, toes up.
    rect(9, lr - 1, 10, lr - 1, C.leg);
    put(11, lr - 1, C.foot);
    put(11, lr - 2, C.foot);
  } else if (legs.startsWith('dangle')) {
    const k = legs === 'dangle1' ? 1 : 0;
    leg(4, lr, 2);
    leg(7, lr, 2);
    foot(4 + k, lr + 2, 1);
    foot(7 - k, lr + 2, 1);
  } else if (legs.startsWith('walk')) {
    // A four-frame cycle: stride, pass (one foot lifted), stride the other way, pass.
    const k = (Number(legs.slice(4)) || 0) % 4;
    if (k === 0 || k === 2) {
      const [back, fwd] = k === 0 ? [3, 8] : [4, 7];
      leg(back + 1, lr);
      leg(fwd - 1, lr);
      foot(back, lr + 1, 1);
      foot(fwd, lr + 1, 1);
    } else {
      leg(5, lr);
      foot(5, lr + 1, 1); // the foot on the ground
      leg(6, lr - 1 + 1);
      foot(6, lr, 1); // the lifted one, a row up
    }
  } else {
    leg(4, lr);
    leg(7, lr);
    foot(front ? 3 : 4, lr + 1, 1);
    foot(7, lr + 1, 1);
  }

  // From the standing grid to output pixels: origin between columns 5 and 6, feet row 15 at y=0.
  const out = [];
  const dir = p.facing === -1 ? -1 : 1;
  for (const [key, color] of grid) {
    const [c, r] = key.split(',').map(Number);
    let x = c - 6; // columns 0–11 → x −6..5 (the middle at 0)
    if (dir === -1) x = -1 - x;
    let y = 15 - r;
    if (p.lie) {
      // On its back, head toward the way it faces: the standing column becomes the height.
      const nx = (15 - r) * dir - 7 * dir;
      const ny = c - 1;
      x = nx;
      y = ny;
      if (dir === -1) x -= 1;
    }
    out.push([x, y, color]);
  }
  return out;
}

function drawArm(put, kind, side, br, hr, C) {
  // side −1 = the left arm (column 2), +1 = the right arm (column 9); drawn facing right.
  const col = side < 0 ? 2 : 9;
  const out1 = col + side; // one further out
  const hand = C.light;
  const arm = C.body;
  switch (kind) {
    case 'up':
      put(col, br - 1, arm);
      put(out1, br - 2, arm);
      put(out1, br - 3, arm);
      put(out1, br - 4, hand);
      break;
    case 'out':
      put(col, br, arm);
      put(out1, br, arm);
      put(out1 + side, br, hand);
      break;
    case 'ear': // a hand cupped to the side of the head
      put(col, br, arm);
      put(out1, br - 1, arm);
      put(out1, br - 2, arm);
      put(col, hr + 3, hand);
      put(out1, hr + 3, hand);
      break;
    case 'chin': // thinking: a hand on the chin
      put(col, br, arm);
      put(col - side, br - 1, hand);
      break;
    case 'wave0':
    case 'wave1': {
      const k = kind === 'wave1' ? 1 : 0;
      put(col, br - 1, arm);
      put(out1, br - 2, arm);
      put(out1 + side * k, br - 3, arm);
      put(out1 + side * k, br - 4, hand);
      break;
    }
    case 'hold': // both hands above the head (carrying something)
      put(col, br - 1, arm);
      put(col, br - 2, arm);
      put(col - side, br - 3, hand);
      break;
    case 'push':
      put(col, br + 1, arm);
      put(out1, br + 1, arm);
      put(out1 + side, br + 1, hand);
      break;
    case 'type0':
    case 'type1': {
      const k = kind === 'type1' ? 1 : 0;
      put(col, br + 1, arm);
      put(col + side, br + 2 - (side > 0 ? k : 1 - k), hand);
      break;
    }
    case 'flail0':
    case 'flail1': {
      const k = (kind === 'flail1') === side > 0 ? 1 : 0;
      put(col, br - k, arm);
      put(out1, br - 1 - k, arm);
      put(out1 + side, br - 2 - k, hand);
      break;
    }
    default: // down
      put(col, br, arm);
      put(col, br + 1, arm);
      put(col, br + 2, hand);
  }
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(2)})`;
}

// ---------- effects ----------
// Tiny bitmaps, rows top to bottom; '#' is the glyph's colour, 'o' its outline/second colour.
const GLYPHS = {
  z: ['###', '..#', '.#.', '###'],
  Z: ['####', '...#', '..#.', '.#..', '####'],
  '?': ['.##.', '#..#', '..#.', '.#..', '....', '.#..'],
  '!': ['#', '#', '#', '.', '#'],
  heart: ['.#.#.', '#####', '#####', '.###.', '..#..'],
  sparkle: ['.#.', '###', '.#.'],
  star: ['#.#', '.#.', '#.#'],
  dust: ['.#.', '###'],
  note: ['.##', '.#.', '##.', '##.'],
  dot: ['#'],
  drop: ['.#', '##', '##'],
  laptop: ['.oooooo.', '.o####o.', '.o####o.', '.oooooo.', 'oooooooo'],
  letter: ['oooooo', 'o#oo#o', 'o##o#o', 'oooooo'],
  plane: ['#....', '###..', '.####', '###..'],
  gear: ['.#.#.', '#####', '##.##', '#####', '.#.#.'],
  ball: ['.#.', '###', '.#.'],
};

/** A glyph's pixels with its bottom-left at (0, 0) and y up; null for an unknown name. */
export function glyph(name, color = '#ffffff', second = '#1b1210') {
  const g = GLYPHS[name];
  if (!g) return null;
  const out = [];
  g.forEach((row, i) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '#') out.push([x, g.length - 1 - i, color]);
      else if (ch === 'o') out.push([x, g.length - 1 - i, second]);
    }
  });
  return out;
}

export const GLYPH_NAMES = Object.freeze(Object.keys(GLYPHS));
