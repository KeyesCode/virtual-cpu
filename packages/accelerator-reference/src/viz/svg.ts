/**
 * Draws docs/hardware/accelerators/images/systolic-4x4-dataflow.svg: the 4 × 4 output-stationary
 * array with its input skew registers, and four clocks of a K = 2 tile, each frame showing which
 * PE multiplies which A[i, k] × B[k, j] and which operands sit in the skew registers. Every frame
 * comes from {@link tileSchedule}, so the picture follows the documented timing rule.
 */

import { tileDoneClock, tileSchedule, type ScheduleClock, type TileShape } from './schedule.js';

/** The tile the frames show. */
export const DATAFLOW_SVG_SHAPE: TileShape = { rows: 4, cols: 4, k: 2 };
/** The clocks (from `tile_start`) the frames show: the wavefront filling the array. */
export const DATAFLOW_SVG_CLOCKS: readonly number[] = [1, 2, 3, 4];

const A_COLOUR = '#1d4ed8';
const B_COLOUR = '#b45309';
const INK = '#111827';
const MUTED = '#6b7280';
const ACTIVE_FILL = '#dcfce7';
const ACTIVE_STROKE = '#15803d';
const DONE_FILL = '#e5e7eb';

// One tile drawing: skew registers to the left and above, then the PE grid.
const CELL_W = 92;
const CELL_H = 50;
const PITCH_X = 104;
const PITCH_Y = 62;
const REG_W = 48;
const REG_H = 22;
const REG_PITCH_X = 56;
const REG_PITCH_Y = 34;
const INPUT_W = 56;
const INPUT_H = 26;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function rect(box: Box, attrs: string): string {
  return `<rect x="${String(box.x)}" y="${String(box.y)}" width="${String(box.w)}" height="${String(box.h)}" ${attrs}/>`;
}

function text(x: number, y: number, body: string, attrs = ''): string {
  return `<text x="${String(x)}" y="${String(y)}"${attrs === '' ? '' : ` ${attrs}`}>${body}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, flow: 'a' | 'b'): string {
  const style =
    flow === 'a'
      ? `stroke="${A_COLOUR}" marker-end="url(#arrow-a)"`
      : `stroke="${B_COLOUR}" stroke-dasharray="5 3" marker-end="url(#arrow-b)"`;
  return `<line x1="${String(x1)}" y1="${String(y1)}" x2="${String(x2)}" y2="${String(y2)}" stroke-width="1.6" ${style}/>`;
}

/** The size of one tile drawing for `shape`. */
function tileSize(shape: TileShape): { w: number; h: number; gridX: number; gridY: number } {
  const gridX = INPUT_W + 14 + (shape.rows - 1) * REG_PITCH_X + 14;
  const gridY = INPUT_H + 14 + (shape.cols - 1) * REG_PITCH_Y + 14;
  return {
    gridX,
    gridY,
    w: gridX + (shape.cols - 1) * PITCH_X + CELL_W,
    h: gridY + (shape.rows - 1) * PITCH_Y + CELL_H,
  };
}

/**
 * One tile at (x, y). With `step` null it is the structure diagram (PE and register names);
 * otherwise the frame for that clock (operands in flight, active and finished PEs).
 */
function drawTile(x: number, y: number, shape: TileShape, step: ScheduleClock | null): string {
  const { gridX, gridY } = tileSize(shape);
  const out: string[] = [];
  const cellBox = (i: number, j: number): Box => ({
    x: x + gridX + j * PITCH_X,
    y: y + gridY + i * PITCH_Y,
    w: CELL_W,
    h: CELL_H,
  });
  // Operand k at skew stage `stage` (0 = the caller's input) in this clock, or null.
  const heldK = (stage: number): number | null => {
    if (step === null) {
      return null;
    }
    const k = step.clock - 1 - stage;
    return k >= 0 && k < shape.k ? k : null;
  };

  // A edge: the caller's input for row i, then i skew registers, then PE(i, 0).
  for (let i = 0; i < shape.rows; i += 1) {
    const cy = y + gridY + i * PITCH_Y + CELL_H / 2;
    const input: Box = { x, y: cy - INPUT_H / 2, w: INPUT_W, h: INPUT_H };
    const inputK = heldK(0);
    out.push(rect(input, `rx="4" fill="#ffffff" stroke="${A_COLOUR}" stroke-width="1.4"`));
    out.push(
      text(
        x + INPUT_W / 2,
        cy + 4,
        step === null
          ? `A[${String(i)},k]`
          : inputK === null
            ? '·'
            : `A[${String(i)},${String(inputK)}]`,
        `text-anchor="middle" fill="${A_COLOUR}" font-size="11"`,
      ),
    );
    let fromX = x + INPUT_W;
    for (let s = 1; s <= i; s += 1) {
      const regX = x + gridX - 14 - (i - s + 1) * REG_PITCH_X + (REG_PITCH_X - REG_W);
      out.push(line(fromX, cy, regX - 2, cy, 'a'));
      const reg: Box = { x: regX, y: cy - REG_H / 2, w: REG_W, h: REG_H };
      const k = heldK(s);
      out.push(
        rect(
          reg,
          `fill="${k === null ? '#ffffff' : '#dbeafe'}" stroke="${A_COLOUR}" stroke-width="1.2"`,
        ),
      );
      out.push(
        text(
          regX + REG_W / 2,
          cy + 4,
          step === null ? 'reg' : k === null ? '·' : `A[${String(i)},${String(k)}]`,
          `text-anchor="middle" fill="${A_COLOUR}" font-size="10"`,
        ),
      );
      fromX = regX + REG_W;
    }
    out.push(line(fromX, cy, x + gridX - 2, cy, 'a'));
  }

  // B edge: the caller's input for column j, then j skew registers, then PE(0, j).
  for (let j = 0; j < shape.cols; j += 1) {
    const cx = x + gridX + j * PITCH_X + CELL_W / 2;
    const input: Box = { x: cx - INPUT_W / 2, y, w: INPUT_W, h: INPUT_H };
    const inputK = heldK(0);
    out.push(rect(input, `rx="4" fill="#ffffff" stroke="${B_COLOUR}" stroke-width="1.4"`));
    out.push(
      text(
        cx,
        y + INPUT_H / 2 + 4,
        step === null
          ? `B[k,${String(j)}]`
          : inputK === null
            ? '·'
            : `B[${String(inputK)},${String(j)}]`,
        `text-anchor="middle" fill="${B_COLOUR}" font-size="11"`,
      ),
    );
    let fromY = y + INPUT_H;
    for (let s = 1; s <= j; s += 1) {
      const regY = y + gridY - 14 - (j - s + 1) * REG_PITCH_Y + (REG_PITCH_Y - REG_H);
      out.push(line(cx, fromY, cx, regY - 2, 'b'));
      const reg: Box = { x: cx - REG_W / 2, y: regY, w: REG_W, h: REG_H };
      const k = heldK(s);
      out.push(
        rect(
          reg,
          `fill="${k === null ? '#ffffff' : '#fef3c7'}" stroke="${B_COLOUR}" stroke-width="1.2" stroke-dasharray="4 2"`,
        ),
      );
      out.push(
        text(
          cx,
          regY + REG_H / 2 + 4,
          step === null ? 'reg' : k === null ? '·' : `B[${String(k)},${String(j)}]`,
          `text-anchor="middle" fill="${B_COLOUR}" font-size="10"`,
        ),
      );
      fromY = regY + REG_H;
    }
    out.push(line(cx, fromY, cx, y + gridY - 2, 'b'));
  }

  // The forwarding links: A to the right, B down.
  for (let i = 0; i < shape.rows; i += 1) {
    for (let j = 0; j < shape.cols; j += 1) {
      const box = cellBox(i, j);
      if (j + 1 < shape.cols) {
        const cy = box.y + box.h / 2;
        out.push(line(box.x + box.w, cy, box.x + PITCH_X - 2, cy, 'a'));
      }
      if (i + 1 < shape.rows) {
        const cx = box.x + box.w / 2;
        out.push(line(cx, box.y + box.h, cx, box.y + PITCH_Y - 2, 'b'));
      }
    }
  }

  // The PEs.
  for (let i = 0; i < shape.rows; i += 1) {
    for (let j = 0; j < shape.cols; j += 1) {
      const box = cellBox(i, j);
      const cx = box.x + box.w / 2;
      const label = `PE(${String(i)},${String(j)})`;
      if (step === null) {
        out.push(rect(box, `rx="6" fill="#ffffff" stroke="${INK}" stroke-width="1.4"`));
        out.push(text(cx, box.y + 20, label, `text-anchor="middle" fill="${INK}" font-size="12"`));
        out.push(
          text(
            cx,
            box.y + 38,
            `acc = C[${String(i)},${String(j)}]`,
            `text-anchor="middle" fill="${MUTED}" font-size="11"`,
          ),
        );
        continue;
      }
      const k = step.macK[i]?.[j] ?? null;
      const finished = step.clock >= shape.k + i + j + 1;
      if (k !== null) {
        out.push(
          rect(box, `rx="6" fill="${ACTIVE_FILL}" stroke="${ACTIVE_STROKE}" stroke-width="3"`),
        );
        out.push(
          text(
            cx,
            box.y + 20,
            `${label} k=${String(k)}`,
            `text-anchor="middle" fill="${INK}" font-size="11" font-weight="700"`,
          ),
        );
        out.push(
          text(
            cx,
            box.y + 38,
            `<tspan fill="${A_COLOUR}">A[${String(i)},${String(k)}]</tspan>·<tspan fill="${B_COLOUR}">B[${String(k)},${String(j)}]</tspan>`,
            `text-anchor="middle" fill="${INK}" font-size="11" font-weight="700"`,
          ),
        );
      } else if (finished) {
        out.push(rect(box, `rx="6" fill="${DONE_FILL}" stroke="${INK}" stroke-width="1.2"`));
        out.push(text(cx, box.y + 20, label, `text-anchor="middle" fill="${INK}" font-size="11"`));
        out.push(
          text(
            cx,
            box.y + 38,
            `✓ C[${String(i)},${String(j)}] final`,
            `text-anchor="middle" fill="${INK}" font-size="11"`,
          ),
        );
      } else {
        out.push(
          rect(
            box,
            `rx="6" fill="#ffffff" stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="4 3"`,
          ),
        );
        out.push(
          text(cx, box.y + 20, label, `text-anchor="middle" fill="${MUTED}" font-size="11"`),
        );
        out.push(
          text(cx, box.y + 38, 'idle', `text-anchor="middle" fill="${MUTED}" font-size="11"`),
        );
      }
    }
  }
  return out.join('\n');
}

function legend(x: number, y: number): string {
  const out: string[] = [];
  const row = (index: number, swatch: string, body: string) => {
    const ry = y + 26 + index * 30;
    out.push(swatch.replaceAll('$Y', String(ry)));
    out.push(text(x + 54, ry + 4, body, `fill="${INK}" font-size="12"`));
  };
  out.push(text(x, y, 'Legend', `fill="${INK}" font-size="14" font-weight="700"`));
  row(
    0,
    `<line x1="${String(x)}" y1="$Y" x2="${String(x + 40)}" y2="$Y" stroke="${A_COLOUR}" stroke-width="1.6" marker-end="url(#arrow-a)"/>`,
    'A operand, moves right (solid)',
  );
  row(
    1,
    `<line x1="${String(x)}" y1="$Y" x2="${String(x + 40)}" y2="$Y" stroke="${B_COLOUR}" stroke-width="1.6" stroke-dasharray="5 3" marker-end="url(#arrow-b)"/>`,
    'B operand, moves down (dashed)',
  );
  row(
    2,
    `<rect x="${String(x + 2)}" y="${String(y + 26 + 2 * 30 - 11)}" width="18" height="22" fill="#ffffff" stroke="${A_COLOUR}" stroke-width="1.2"/><rect x="${String(x + 24)}" y="${String(y + 26 + 2 * 30 - 11)}" width="18" height="22" fill="#ffffff" stroke="${B_COLOUR}" stroke-width="1.2" stroke-dasharray="4 2"/>`,
    'skew register, A | B (row i has i, column j has j)',
  );
  row(
    3,
    `<rect x="${String(x + 4)}" y="${String(y + 26 + 3 * 30 - 11)}" width="32" height="22" rx="4" fill="${ACTIVE_FILL}" stroke="${ACTIVE_STROKE}" stroke-width="3"/>`,
    'active PE: bold outline, does A[i,k]·B[k,j]',
  );
  row(
    4,
    `<rect x="${String(x + 4)}" y="${String(y + 26 + 4 * 30 - 11)}" width="32" height="22" rx="4" fill="#ffffff" stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    'idle PE: dashed outline',
  );
  row(
    5,
    `<rect x="${String(x + 4)}" y="${String(y + 26 + 5 * 30 - 11)}" width="32" height="22" rx="4" fill="${DONE_FILL}" stroke="${INK}" stroke-width="1.2"/>`,
    '✓ accumulator final, holds C[i,j]',
  );
  return out.join('\n');
}

/** The complete SVG document, deterministic: the same text on every run. */
export function dataflowSvg(): string {
  const shape = DATAFLOW_SVG_SHAPE;
  const size = tileSize(shape);
  const margin = 24;
  const schedule = tileSchedule(shape);
  const frameGapX = 48;
  const frameW = size.w;
  const frameH = size.h + 64;
  const topY = 96;
  const framesY = topY + size.h + 72;
  const width = margin * 2 + frameW * 2 + frameGapX;
  const height = framesY + frameH * 2 + 40 + margin;
  const done = tileDoneClock(shape);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" role="img" aria-labelledby="title desc">`,
    '<title id="title">Operand flow through a 4 × 4 output-stationary systolic array</title>',
    `<desc id="desc">The 16 processing elements with A rows entering from the left through i skew registers and B columns entering from the top through j skew registers; then clocks ${DATAFLOW_SVG_CLOCKS.join(', ')} of a K = ${String(shape.k)} tile, PE(i, j) multiplying A[i, k] by B[k, j] in clock k + i + j + 1 after tile_start.</desc>`,
    '<defs>',
    `<marker id="arrow-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${A_COLOUR}"/></marker>`,
    `<marker id="arrow-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${B_COLOUR}"/></marker>`,
    '</defs>',
    `<rect x="0" y="0" width="${String(width)}" height="${String(height)}" fill="#ffffff"/>`,
    text(
      margin,
      40,
      '4 × 4 output-stationary systolic array: operand flow',
      `fill="${INK}" font-size="20" font-weight="700"`,
    ),
    text(
      margin,
      64,
      'PE(i,j) keeps C[i,j] in its accumulator. The caller presents A[·,k] and B[k,·] unskewed in clock k + 1; the skew registers delay row i by i and column j by j clocks,',
      `fill="${INK}" font-size="12"`,
    ),
    text(
      margin,
      82,
      'so A[i,k] and B[k,j] meet at PE(i,j) in clock k + i + j + 1 (clocks counted from tile_start = 0). Each PE forwards A to the right and B down.',
      `fill="${INK}" font-size="12"`,
    ),
    drawTile(margin, topY, shape, null),
    legend(margin + frameW + frameGapX, topY + 20),
    text(
      margin + frameW + frameGapX,
      topY + 240,
      `Below: a K = ${String(shape.k)} tile. tile_done pulses in clock`,
      `fill="${INK}" font-size="12"`,
    ),
    text(
      margin + frameW + frameGapX,
      topY + 258,
      `K + ROWS + COLS − 1 = ${String(done)}; the last MAC is in clock ${String(done - 1)}.`,
      `fill="${INK}" font-size="12"`,
    ),
  ];
  DATAFLOW_SVG_CLOCKS.forEach((clock, index) => {
    const step = schedule[clock];
    if (step === undefined) {
      throw new RangeError(`clock ${String(clock)} is past tile_done`);
    }
    const fx = margin + (index % 2) * (frameW + frameGapX);
    const fy = framesY + Math.floor(index / 2) * frameH;
    parts.push(
      text(
        fx,
        fy,
        `Clock ${String(clock)} (operand clock ${String(clock - 1)}): ${String(step.macs)} MAC${step.macs === 1 ? '' : 's'}${step.inputK === null ? ', no new input' : ''}`,
        `fill="${INK}" font-size="14" font-weight="700"`,
      ),
    );
    parts.push(drawTile(fx, fy + 16, shape, step));
  });
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}
