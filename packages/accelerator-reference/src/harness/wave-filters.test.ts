import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderWaveDemo } from './wave.js';
import { renderWaveFilters, WAVE_DIR, WAVE_FILTER_FILES } from './wave-filters.js';

// The files in hardware/accelerators/matmul/tb/wave/ are generated and committed; regenerate them
// with `gen-wave-filters` and `gen-wave-demo` rather than editing them by hand.
describe('committed waveform files', () => {
  it.each(renderWaveFilters())('$file matches the enum of rtl/matmul_pkg.sv', ({ file, text }) => {
    expect(readFileSync(join(WAVE_DIR, file), 'utf8')).toBe(text);
  });

  it('covers the controller states and the error codes', () => {
    expect(WAVE_FILTER_FILES).toEqual(['ctrl_state.txt', 'error_code.txt']);
  });

  it('demo.in and demo.expected match gen-wave-demo', () => {
    const { input, expected } = renderWaveDemo();
    expect(readFileSync(join(WAVE_DIR, 'demo.in'), 'utf8')).toBe(input);
    expect(readFileSync(join(WAVE_DIR, 'demo.expected'), 'utf8')).toBe(expected);
  });
});
