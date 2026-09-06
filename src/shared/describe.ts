/**
 * storybook-annotakit — one-line element summary.
 *
 * Shared by the digest renderer (server, CJS) and the preview composer (ESM):
 * both surfaces show THE SAME compact element description so a reviewer
 * talking about "<span#kpi-value.value>" in the composer reads the exact same
 * string an agent later reads in the markdown digest (v0.5.0 precision push).
 *
 * Format (dense but grep-able, css-selector flavored):
 *   span#kpi-value.value.tabular-nums:nth(2) [testid=kpi-value label="Revenue"] "Revenue Q3"
 * Rules:
 *   - tag first, then #id, then .classes (max 3, clipped), then :nth(n)
 *   - bracketed identity helpers: testid / name / label / placeholder / alt / value
 *   - quoted own text last (the comment usually references it)
 *   - nothing present but the tag → bare "<span>"
 */

import type { TargetContext } from './types';

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Render the shared one-line element summary for a captured context. */
export function elementSummary(ctx: TargetContext | null | undefined): string {
  if (!ctx || !ctx.tag) return '(unknown element)';
  const parts: string[] = [ctx.tag];
  if (ctx.id) parts.push(`#${ctx.id}`);
  if (ctx.classes) {
    const classes = ctx.classes.split(/\s+/).filter(Boolean).slice(0, 3);
    if (classes.length) parts.push(classes.map((c) => `.${c}`).join(''));
  }
  if (ctx.nth && ctx.nth > 0) parts.push(`:nth(${ctx.nth})`);

  const attrs: string[] = [];
  if (ctx.testid) attrs.push(`testid=${ctx.testid}`);
  if (ctx.name) attrs.push(`name=${ctx.name}`);
  if (ctx.label) attrs.push(`label="${clip(ctx.label, 30)}"`);
  if (ctx.placeholder) attrs.push(`placeholder="${clip(ctx.placeholder, 30)}"`);
  if (ctx.alt) attrs.push(`alt="${clip(ctx.alt, 30)}"`);
  if (ctx.value) attrs.push(`value="${clip(ctx.value, 30)}"`);
  if (ctx.ariaLabel && !ctx.text) attrs.push(`aria-label="${clip(ctx.ariaLabel, 30)}"`);
  if (attrs.length) parts.push(` [${attrs.join(' ')}]`);

  const text = ctx.text ?? null;
  if (text) parts.push(` "${clip(text.replace(/\s+/g, ' '), 48)}"`);
  return `<${parts.join('')}>`;
}
