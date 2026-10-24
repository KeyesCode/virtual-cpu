/**
 * The generated parts of the two visualization files in docs/hardware/accelerators/images/: the
 * SVG is written whole by {@link dataflowSvg}; the animated page is hand-written and only its
 * embedded trace (a `<script type="application/json">` block) is generated, from
 * {@link tileTrace} of {@link SYSTOLIC_4X4_EXAMPLE}. The page renders that trace and computes no
 * timing of its own, so the drift test that regenerates the trace and compares it keeps the page
 * on the documented rule.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataflowSvg } from './svg.js';
import { SYSTOLIC_4X4_EXAMPLE, tileTrace, type TileTrace } from './schedule.js';

/** docs/hardware/accelerators/images/, from this file. */
export const VIZ_IMAGES_DIR = fileURLToPath(
  new URL('../../../../docs/hardware/accelerators/images/', import.meta.url),
);
export const DATAFLOW_SVG_PATH = `${VIZ_IMAGES_DIR}systolic-4x4-dataflow.svg`;
export const SYSTOLIC_PAGE_PATH = `${VIZ_IMAGES_DIR}systolic-4x4.html`;

const TRACE_OPEN = '<script type="application/json" id="systolic-trace">';
const TRACE_CLOSE = '</script>';

/** The trace the page embeds. */
export function systolicPageTrace(): TileTrace {
  return tileTrace(SYSTOLIC_4X4_EXAMPLE);
}

/** The trace as the page embeds it: one clock per line, so a diff names the clock that changed. */
export function formatTrace(trace: TileTrace): string {
  const { clocks, ...head } = trace;
  const fields = Object.entries(head).map(([key, value]) => `"${key}":${JSON.stringify(value)}`);
  const lines = clocks.map((clock) => JSON.stringify(clock));
  return `{${fields.join(',')},\n"clocks":[\n${lines.join(',\n')}\n]}`;
}

function traceBounds(html: string): { start: number; end: number } {
  const open = html.indexOf(TRACE_OPEN);
  if (open < 0) {
    throw new Error(`no ${TRACE_OPEN} block in the page`);
  }
  const start = open + TRACE_OPEN.length;
  const end = html.indexOf(TRACE_CLOSE, start);
  if (end < 0) {
    throw new Error(`the ${TRACE_OPEN} block is not closed`);
  }
  return { start, end };
}

/** The trace embedded in the page's HTML, parsed. */
export function extractTrace(html: string): unknown {
  const { start, end } = traceBounds(html);
  return JSON.parse(html.slice(start, end)) as unknown;
}

/** The page's HTML with its embedded trace replaced by `trace`. */
export function embedTrace(html: string, trace: TileTrace): string {
  const { start, end } = traceBounds(html);
  return `${html.slice(0, start)}\n${formatTrace(trace)}\n${html.slice(end)}`;
}

/** Writes the SVG and the page's embedded trace; returns the paths written. */
export function writeVisualizations(): string[] {
  writeFileSync(DATAFLOW_SVG_PATH, dataflowSvg());
  const html = readFileSync(SYSTOLIC_PAGE_PATH, 'utf8');
  writeFileSync(SYSTOLIC_PAGE_PATH, embedTrace(html, systolicPageTrace()));
  return [DATAFLOW_SVG_PATH, SYSTOLIC_PAGE_PATH];
}
