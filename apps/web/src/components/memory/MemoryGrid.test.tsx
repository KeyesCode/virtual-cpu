import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardStore } from '../../state/dashboardStore';
import { cellHighlights, type MemoryLayers, MemoryGrid } from './MemoryGrid';

const layers: MemoryLayers = {
  pc: new Set([0x0c, 0x0d]),
  write: new Set([0x85]),
  sp: 0xff,
  breakpoints: new Set([0x1a]),
  goto: null,
};

describe('cellHighlights', () => {
  it('marks the current instruction, last write, SP and breakpoints', () => {
    expect(cellHighlights(0x0c, layers)).toEqual(['pc']);
    expect(cellHighlights(0x0d, layers)).toEqual(['pc']);
    expect(cellHighlights(0x85, layers)).toEqual(['write']);
    expect(cellHighlights(0x1a, layers)).toEqual(['breakpoint']);
    expect(cellHighlights(0x00, layers)).toEqual([]);
  });

  it('shades the ISA stack region 0xC0–0xFF', () => {
    expect(cellHighlights(0xbf, layers)).toEqual([]);
    expect(cellHighlights(0xc0, layers)).toEqual(['stack']);
    expect(cellHighlights(0xff, layers)).toEqual(['stack', 'sp']);
  });
});

describe('MemoryGrid', () => {
  it('renders all 256 bytes with highlight layers from the CPU', () => {
    const store = new DashboardStore({ example: 'fibonacci' });
    store.toggleBreakpoint(26); // JNZ loop, at 0x1A
    store.step(); // LDI R0, 0 → PC 0x03
    const { container } = render(<MemoryGrid snapshot={store.getSnapshot()} />);
    const cells = container.querySelectorAll('td[data-address]');
    expect(cells).toHaveLength(256);
    const highlights = (address: number): string =>
      container
        .querySelector(`td[data-address="${String(address)}"]`)
        ?.getAttribute('data-highlights') ?? '';
    expect(highlights(0x03)).toBe('pc');
    expect(highlights(0x05)).toBe('pc');
    expect(highlights(0x06)).toBe('');
    expect(highlights(0x1a)).toBe('breakpoint');
    expect(highlights(0xff)).toBe('stack sp');
  });
});
