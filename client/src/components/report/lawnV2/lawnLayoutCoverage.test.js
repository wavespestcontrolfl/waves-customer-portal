// @vitest-environment node
// The audit of the standard page body against the lawn layout: every top-level mount inside
// <LawnLayoutSwitch> is slotted, moved, split, deliberately hidden, declined or unreachable (see
// lawnLayoutCoverage.js), and each claim is checked against the code that makes it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { STANDARD_BODY_COVERAGE } from './lawnLayoutCoverage';
import { INSTRUCTION_SOURCES, INVITATIONS, LAYOUT_DECLINES, SLOT_CLASS } from './lawnLayoutRules';
import { LAYOUT_ORDER } from './LawnLayout';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const pageSource = read('../../../pages/ReportViewPage.jsx');
const layoutSource = read('./LawnLayout.jsx');

const jsxName = (node) => {
  const name = node.openingElement.name;
  if (name.type === 'JSXIdentifier') return name.name;
  return name.type === 'JSXMemberExpression' ? `${name.object.name}.${name.property.name}` : '?';
};
const stringAttr = (node, attr) => {
  const found = node.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === attr);
  return found && found.value && found.value.type === 'StringLiteral' ? found.value.value : null;
};

// Every top-level mount among the switch's children: a component (not descended into), an identifier
// holding an element, or a host element carrying an id. Host elements, fragments, conditions and maps are walked through.
function standardBodyMounts(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const found = new Set();
  let slotKeys = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'JSXElement') {
      const name = jsxName(node);
      if (/^[A-Z]/.test(name) && !name.endsWith('.Provider')) { found.add(name); return; }
      const id = !name.endsWith('.Provider') && stringAttr(node, 'id');
      if (id) found.add(`host:${name}#${id}`);
      node.children.forEach(walk);
      return;
    }
    if (node.type === 'JSXFragment') { node.children.forEach(walk); return; }
    if (node.type === 'JSXExpressionContainer' && node.expression.type === 'Identifier') { found.add(`$${node.expression.name}`); return; }
    Object.keys(node).forEach((key) => { if (key !== 'loc' && node[key] && typeof node[key] === 'object') walk(node[key]); });
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'JSXElement' && jsxName(node) === 'LawnLayoutSwitch') {
      const layout = node.openingElement.attributes.find((a) => a.name && a.name.name === 'layout');
      const body = layout.value.expression;
      const slots = body.openingElement.attributes.find((a) => a.name && a.name.name === 'slots');
      slotKeys = slots.value.expression.properties.map((p) => p.key.name);
      node.children.forEach(walk);
      return;
    }
    Object.keys(node).forEach((key) => { if (key !== 'loc' && node[key] && typeof node[key] === 'object') visit(node[key]); });
  };
  visit(ast.program);
  return { mounts: [...found], slotKeys };
}

describe('the standard lawn page body against the lawn layout', () => {
  const { mounts, slotKeys } = standardBodyMounts(pageSource);

  it('finds the standard body', () => {
    expect(mounts.length).toBeGreaterThan(30);
    expect(slotKeys.length).toBeGreaterThan(10);
  });

  it('every mount of the standard body is accounted for (a new section must be slotted, hidden or declined)', () => {
    const unknown = mounts.filter((name) => !STANDARD_BODY_COVERAGE[name]);
    expect(unknown).toEqual([]);
  });

  it('no coverage entry is stale (listed but no longer in the body)', () => {
    const stale = Object.keys(STANDARD_BODY_COVERAGE).filter((name) => !mounts.includes(name));
    expect(stale).toEqual([]);
  });

  it('a slotted mount names a slot the page passes AND the layout prints', () => {
    Object.entries(STANDARD_BODY_COVERAGE).filter(([, v]) => v.how === 'slot').forEach(([name, v]) => {
      expect(slotKeys, name).toContain(v.key);
      expect(new RegExp(`slots\\.${v.key}\\b`).test(layoutSource), `${name} -> slots.${v.key}`).toBe(true);
    });
  });

  it('every slot the page passes is printed by the layout, and every section in LAYOUT_ORDER exists', () => {
    slotKeys.forEach((key) => expect(new RegExp(`slots\\.${key}\\b`).test(layoutSource), `slots.${key}`).toBe(true));
    LAYOUT_ORDER.forEach((section) => expect(layoutSource).toMatch(new RegExp(`\\b${section}:`)));
  });

  it('a declined mount names a real decline rule', () => {
    Object.entries(STANDARD_BODY_COVERAGE).filter(([, v]) => v.how === 'declines').forEach(([name, v]) => {
      expect(Object.keys(LAYOUT_DECLINES), name).toContain(v.key);
    });
  });

  it('the only mounts hidden on purpose are on the brief\'s cut list (the Visit Timeline)', () => {
    const hidden = Object.entries(STANDARD_BODY_COVERAGE).filter(([, v]) => v.how === 'hidden').map(([name]) => name);
    expect(hidden.sort()).toEqual(['LawnVisitTimeline', 'host:div#service-timeline']);
  });

  it('an unreachable mount is behind a condition that a lawn report with reportV2 fails', () => {
    // Each unreachable mount is guarded in the page by !isV2LeadLayout, !data.reportV2 or the tree & shrub line.
    const guards = ['!isV2LeadLayout', '!data.reportV2', "data.serviceLine === 'tree_shrub'", '!reviewAskOnTop'];
    guards.forEach((guard) => expect(pageSource).toContain(guard));
    expect(pageSource).toContain('const isV2LeadLayout = (isLawnReport && !!data.reportV2) || isTreeShrubV2;');
    expect(pageSource).toContain('const reviewAskOnTop = Boolean(data.reportV2)');
  });
});

describe('what the "nothing to do" sentence may be said over', () => {
  const { slotKeys } = standardBodyMounts(pageSource);

  it('every slot the page hands the layout is classified: instruction, invitation or information (a new slot must be classified)', () => {
    expect(slotKeys.filter((key) => !SLOT_CLASS[key])).toEqual([]);
    expect(Object.keys(SLOT_CLASS).filter((key) => !slotKeys.includes(key))).toEqual([]);
    Object.values(SLOT_CLASS).forEach((kind) => expect(['instruction', 'invitation', 'information']).toContain(kind));
  });

  it('every slot classified as an instruction is backed by an instruction source (or is the Your part card itself)', () => {
    const claimed = { recommendations: 'recommendations', techNote: 'techTips' };
    Object.entries(SLOT_CLASS).filter(([, kind]) => kind === 'instruction').forEach(([key]) => {
      if (key === 'yourPart') return;
      expect(Object.keys(INSTRUCTION_SOURCES), key).toContain(claimed[key]);
    });
  });

  it('the two closed lists share no entry, and each entry has a reason', () => {
    expect(Object.keys(INSTRUCTION_SOURCES).filter((key) => key in INVITATIONS)).toEqual([]);
    Object.values(INSTRUCTION_SOURCES).forEach((source) => expect(source.reason.length).toBeGreaterThan(10));
    Object.values(INVITATIONS).forEach((reason) => expect(reason.length).toBeGreaterThan(10));
  });
});
