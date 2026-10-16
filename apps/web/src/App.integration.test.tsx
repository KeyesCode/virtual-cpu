import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { DashboardStore, type FrameScheduler } from './state/dashboardStore';

/** A scheduler the test advances by hand, one animation frame at a time. */
function manualScheduler() {
  let time = 0;
  let pending: ((time: number) => void) | null = null;
  const scheduler: FrameScheduler = {
    request: (callback) => {
      pending = callback;
      return 1;
    },
    cancel: () => {
      pending = null;
    },
    now: () => time,
  };
  const frame = (ms: number): void => {
    time += ms;
    const callback = pending;
    pending = null;
    act(() => {
      callback?.(time);
    });
  };
  return { scheduler, frame, isRunning: () => pending !== null };
}

function renderDashboard() {
  const clock = manualScheduler();
  render(<App createStore={() => new DashboardStore({ scheduler: clock.scheduler })} />);
  return clock;
}

const button = (name: string): HTMLButtonElement =>
  screen.getByRole('button', { name: new RegExp(`^\\W*${name}$`) });
const kv = (label: string): string =>
  screen.getByTestId(`kv-${label}`).querySelector('b')?.textContent ?? '';
const register = (name: string): string =>
  screen.getByTestId(`register-${name}`).querySelector('.text-xl')?.textContent ?? '';

describe('dashboard on fibonacci', () => {
  it('assembles, loads and steps the program on the real debugger', () => {
    renderDashboard();
    fireEvent.change(screen.getByLabelText('Example program'), {
      target: { value: '14-fibonacci' },
    });
    fireEvent.click(button('Assemble'));
    expect(screen.getByTestId('assembly-status').textContent).toMatch(/29 bytes .* 0 errors/);
    fireEvent.click(button('Load into CPU'));
    expect(screen.getByRole('status', { name: 'CPU status' }).textContent).toBe('READY');

    for (let i = 0; i < 5; i += 1) fireEvent.click(button('Step'));
    // Four LDIs, then STORE [R2], R0 wrote F(0) = 0 to 0x80.
    expect(kv('PC')).toBe('0x0E');
    expect(kv('INSTR')).toBe('5');
    expect(kv('IR')).toBe('STORE [R2], R0');
    expect(register('R1')).toBe('0x01');
    expect(register('R2')).toBe('0x80');
    expect(register('R3')).toBe('0x0A');
    const lastWrite = document.querySelector('td[data-address="128"]');
    expect(lastWrite?.getAttribute('data-highlights')).toBe('write');
    const strip = within(screen.getByRole('list', { name: 'Instruction cycle' }));
    expect(strip.getByText('mem[0x80] ← 00')).toBeTruthy();

    fireEvent.click(button('Step back'));
    expect(kv('PC')).toBe('0x0C');
    expect(kv('INSTR')).toBe('4');
  });

  it('runs at a paced speed and pauses before the breakpoint on JNZ loop', () => {
    const clock = renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: 'Add breakpoint on line 26' }));
    fireEvent.click(button('Run'));
    expect(screen.getByRole('status', { name: 'CPU status' }).textContent).toBe('RUNNING');
    // 4 instr/s: one instruction now, then one per 250 ms of frames.
    clock.frame(16);
    expect(kv('INSTR')).toBe('1');
    for (let i = 0; i < 40 && clock.isRunning(); i += 1) clock.frame(250);
    expect(screen.getByRole('status', { name: 'CPU status' }).textContent).toBe('PAUSED');
    expect(kv('PC')).toBe('0x1A');
    expect(kv('INSTR')).toBe('11');

    // Run again: it resumes past the breakpoint and stops there on the next pass.
    fireEvent.click(button('Run'));
    for (let i = 0; i < 40 && clock.isRunning(); i += 1) clock.frame(250);
    expect(kv('PC')).toBe('0x1A');
    expect(kv('INSTR')).toBe('19');
  });

  it('flags an assembler error at its line and column and disables Load', () => {
    renderDashboard();
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Assembly source');
    fireEvent.change(editor, { target: { value: 'LDI R0, 0\nLDX R0, 1\nHLT\n' } });
    const squiggles = document.querySelectorAll('[data-error="true"]');
    expect(squiggles).toHaveLength(1);
    expect(squiggles[0]?.textContent).toBe('LDX');
    expect(squiggles[0]?.closest('[data-line]')?.getAttribute('data-line')).toBe('2');
    expect(screen.getByTestId('assembly-status').textContent).toContain(
      'line 2, col 1: unknown mnemonic "LDX"',
    );
    expect(button('Load into CPU').disabled).toBe(true);
  });
});
