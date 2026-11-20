/**
 * pest-insider-motion.js — READ-ONLY helper for ops/agents/pest-insider-heroes.js
 *
 * Draws one frame of a top picture's motion (server/services/pest-insider/
 * heroes.js MOTION_KINDS) as an SVG the size of the picture, to lay over the
 * finished picture. The motion moves what the art already shows (a lamp's
 * glow, a drip, rain, a spray) and adds no words. It is clipped to the art,
 * right of HERO_ART_LEFT, so it never touches the title panel, and every color
 * is a Waves color (cards.js WAVES_COLORS).
 *
 * Each motion loops: frame MOTION_FRAMES looks like frame 0, so the GIF
 * plays smoothly. Change any drawing here -> bump HERO_MOTION_DESIGN in
 * heroes.js, so every moving picture gets a new file name.
 */
'use strict';

const { WAVES_COLORS: C } = require('../../server/services/pest-insider/cards');
const { HERO_ART_LEFT, HERO_WIDTH } = require('../../server/services/pest-insider/heroes');

/** 16 frames of 100 ms: one loop takes 1.6 s. The GIF plays 3 times, then stops. */
const MOTION_FRAMES = 16;
const MOTION_DELAY_MS = 100;
const MOTION_LOOPS = 3;

const f1 = (n) => n.toFixed(1);
const f2 = (n) => n.toFixed(2);

// The shapes of one frame. t runs from 0 to 1 over one loop; W and H are the
// picture's size in pixels, and S scales the 582-wide sizes to it.
function shapes(m, t, W, H) {
  const S = W / HERO_WIDTH;
  const P = (v) => v * S;
  const X = (share) => share * W;
  const Y = (share) => share * H;
  const tau = 2 * Math.PI * t;
  const color = C[m.color];
  const defs = [];
  const parts = [];
  switch (m.kind) {
    case 'swarm': { // a light: its glow pulses and specks circle it
      const cx = X(m.x);
      const cy = Y(m.y);
      defs.push(`<radialGradient id="glow"><stop offset="0" stop-color="${C.gold}" stop-opacity="${(0.30 + 0.22 * Math.sin(tau)).toFixed(3)}"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>`);
      parts.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(P(60))}" fill="url(#glow)"/>`);
      for (let i = 0; i < 10; i += 1) {
        const a = tau * (i % 2 ? 1 : -1) + (i * 2 * Math.PI) / 10;
        const r = P(16 + (i % 4) * 9);
        parts.push(`<ellipse cx="${f1(cx + r * Math.cos(a))}" cy="${f1(cy + P(6) + r * 0.6 * Math.sin(a))}" rx="${f1(P(2.2))}" ry="${f1(P(1.2))}" fill="${color}"/>`);
      }
      break;
    }
    case 'rise': { // specks drift from one spot to another, swaying
      const ax = X(m.x); const ay = Y(m.y); const bx = X(m.x2); const by = Y(m.y2);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / len; const ny = (bx - ax) / len;
      for (let i = 0; i < 12; i += 1) {
        const p = (t + i / 12) % 1;
        const sway = P(8) * Math.sin(2 * Math.PI * (p * 1.5 + i / 5)) + P(((i % 5) - 2) * 2.5);
        const o = Math.min(1, p * 5, (1 - p) * 4);
        parts.push(`<ellipse cx="${f1(ax + (bx - ax) * p + nx * sway)}" cy="${f1(ay + (by - ay) * p + ny * sway)}" rx="${f1(P(2.2))}" ry="${f1(P(1.1))}" fill="${color}" opacity="${f2(o)}"/>`);
      }
      break;
    }
    case 'drop': { // a drop forms, falls and splashes
      const x = X(m.x); const y0 = Y(m.y); const y1 = Y(m.to);
      const r = P(m.size);
      if (t < 0.25) {
        const s = 0.35 + 0.65 * (t / 0.25);
        parts.push(`<ellipse cx="${f1(x)}" cy="${f1(y0 + r * s)}" rx="${f1(r * 0.8 * s)}" ry="${f1(r * s)}" fill="${color}"/>`);
      } else if (t < 0.7) {
        const y = y0 + r + (((t - 0.25) / 0.45) ** 2) * (y1 - y0 - r);
        parts.push(`<path d="M ${f1(x)} ${f1(y - r * 1.5)} Q ${f1(x + r)} ${f1(y)} ${f1(x)} ${f1(y + r * 0.9)} Q ${f1(x - r)} ${f1(y)} ${f1(x)} ${f1(y - r * 1.5)} Z" fill="${color}"/>`);
      } else {
        const s = (t - 0.7) / 0.3;
        parts.push(`<ellipse cx="${f1(x)}" cy="${f1(y1)}" rx="${f1(r * (0.8 + 2.6 * s))}" ry="${f1(r * (0.3 + 0.7 * s))}" fill="none" stroke="${color}" stroke-width="${f1(P(1.5))}" opacity="${f2(1 - s)}"/>`);
      }
      break;
    }
    case 'rain': { // slanted streaks fall across the art right of x
      const left = X(m.x);
      const len = P(14);
      for (let i = 0; i < 26; i += 1) {
        const x0 = left + ((i * 97 * S) % Math.max(1, W - left));
        const y = (((t + (i * 37) / 100) % 1) * (H + len)) - len;
        const dx = (y + len) * 0.25;
        parts.push(`<line x1="${f1(x0 - dx)}" y1="${f1(y)}" x2="${f1(x0 - dx - len * 0.25)}" y2="${f1(y + len)}" stroke="${color}" stroke-width="${f1(P(1.4))}" stroke-linecap="round" opacity="0.85"/>`);
      }
      break;
    }
    case 'march': { // specks walk a curve, each one spacing on per loop
      const n = 9;
      const at = (q) => {
        const u = 1 - q;
        return [u * u * X(m.x) + 2 * u * q * X(m.cx) + q * q * X(m.x2), u * u * Y(m.y) + 2 * u * q * Y(m.cy) + q * q * Y(m.y2)];
      };
      for (let i = 0; i < n; i += 1) {
        const q = (i + t) / n;
        const [x, y] = at(q);
        const [ahead, aheadY] = at(Math.min(1, q + 0.01));
        const turn = (Math.atan2(aheadY - y, ahead - x) * 180) / Math.PI;
        const o = Math.min(1, q * n * 1.5, (1 - q) * n * 1.5);
        parts.push(`<g transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(turn)})" opacity="${f2(o)}"><ellipse cx="${f1(-P(3.6))}" cy="0" rx="${f1(P(3.3))}" ry="${f1(P(2.1))}" fill="${color}"/><ellipse cx="${f1(P(1.7))}" cy="0" rx="${f1(P(1.7))}" ry="${f1(P(1.4))}" fill="${color}"/><circle cx="${f1(P(4.8))}" cy="0" r="${f1(P(1.7))}" fill="${color}"/></g>`);
      }
      break;
    }
    case 'pulse': { // two rings grow from a spot, to point at it
      for (let k = 0; k < 2; k += 1) {
        const p = (t + k / 2) % 1;
        const r = P(m.r0) + P(m.r1 - m.r0) * p;
        parts.push(`<circle cx="${f1(X(m.x))}" cy="${f1(Y(m.y))}" r="${f1(r)}" fill="none" stroke="${color}" stroke-width="${f1(P(3))}" opacity="${f2(1 - p)}"/>`);
      }
      break;
    }
    case 'spray': { // drops fly out of a nozzle in a fan, and fall a little
      const n = 14;
      for (let i = 0; i < n; i += 1) {
        const a = ((m.angle - m.spread / 2 + (m.spread * ((i * 5) % n)) / (n - 1)) * Math.PI) / 180;
        const p = (t + i * 0.37) % 1;
        const o = Math.min(1, p * 6, (1 - p) * 3);
        const x = X(m.x) + P(m.reach) * Math.cos(a) * p;
        const y = Y(m.y) - P(m.reach) * Math.sin(a) * p + P(m.fall) * p * p;
        parts.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(P(m.size))}" fill="${color}" opacity="${f2(o)}"/>`);
      }
      break;
    }
    case 'heat': { // three wavy lines rise and fade
      for (let k = 0; k < 3; k += 1) {
        const p = (t + k / 3) % 1;
        const x = X(m.x) + P((k - 1) * 12);
        const y = Y(m.y) - P(30) * p;
        const h = P(16); const w = P(3);
        parts.push(`<path d="M ${f1(x)} ${f1(y)} q ${f1(w)} ${f1(-h / 4)} 0 ${f1(-h / 2)} q ${f1(-w)} ${f1(-h / 4)} 0 ${f1(-h / 2)}" fill="none" stroke="${color}" stroke-width="${f1(P(2))}" stroke-linecap="round" opacity="${f2(Math.sin(Math.PI * p))}"/>`);
      }
      break;
    }
    default:
      throw new Error(`pest-insider motion: no drawing for the kind ${m.kind}`);
  }
  return { defs, parts };
}

/** Frame `frame` (0 to MOTION_FRAMES - 1) of a checked motion, as an SVG of W x H pixels, clipped to the art. */
function motionSvg(motion, frame, W, H) {
  const { defs, parts } = shapes(motion, frame / MOTION_FRAMES, W, H);
  const left = HERO_ART_LEFT * W;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs.join('')}<clipPath id="art"><rect x="${f1(left)}" y="0" width="${f1(W - left)}" height="${H}"/></clipPath></defs><g clip-path="url(#art)">${parts.join('')}</g></svg>`;
}

module.exports = { motionSvg, MOTION_FRAMES, MOTION_DELAY_MS, MOTION_LOOPS };
