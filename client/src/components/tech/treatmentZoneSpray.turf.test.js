// Pins the lawn-highlight turf classifier (codex P1 #3075: saturated
// non-turf surfaces — terracotta/barrel-tile roofs, mulch, stained
// hardscape — must never be painted as treated lawn on a customer report).
import { describe, expect, test } from 'vitest';
import { isTurfPixel } from './treatmentZoneSpray';

describe('isTurfPixel (lawn highlight classifier)', () => {
  const TURF = [
    ['healthy green grass', 80, 140, 60],
    ['browning turf', 170, 150, 110],
    ['dry tan turf', 160, 140, 100],
    ['dark tree canopy (vegetation on the lawn)', 50, 80, 45],
  ];
  const NOT_TURF = [
    ['terracotta roof', 150, 60, 40],
    ['barrel tile', 180, 90, 60],
    ['brown roof (codex example)', 140, 90, 60],
    ['mulch bed', 110, 80, 55],
    ['gray shingle roof', 150, 150, 148],
    ['asphalt', 120, 122, 125],
    ['pool water', 80, 150, 180],
    ['white lanai / bright concrete', 230, 230, 225],
  ];

  test.each(TURF)('lights %s', (_name, r, g, b) => {
    expect(isTurfPixel(r, g, b)).toBe(true);
  });

  test.each(NOT_TURF)('rejects %s', (_name, r, g, b) => {
    expect(isTurfPixel(r, g, b)).toBe(false);
  });
});
