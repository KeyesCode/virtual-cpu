import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RegisterCard, RegisterGrid } from './RegisterGrid';

describe('RegisterCard', () => {
  it('shows hex, unsigned, signed and binary readings', () => {
    render(<RegisterCard name="R2" value={0x86} changed={false} />);
    const card = screen.getByTestId('register-R2');
    expect(card.textContent).toContain('0x86');
    expect(card.textContent).toContain('134 · −122');
    expect(card.textContent).toContain('1000 0110');
  });

  it('gives non-negative values a plus sign', () => {
    render(<RegisterCard name="R1" value={0x0d} changed={false} />);
    expect(screen.getByTestId('register-R1').textContent).toContain('13 · +13');
  });
});

describe('RegisterGrid', () => {
  it('outlines only the registers the last instruction changed', () => {
    render(
      <RegisterGrid registers={[8, 13, 0x86, 4, 0, 0, 0, 0xff]} changed={new Set(['R0', 'R2'])} />,
    );
    expect(screen.getByTestId('register-R0').dataset.changed).toBe('true');
    expect(screen.getByTestId('register-R1').dataset.changed).toBe('false');
    expect(screen.getByTestId('register-R2').dataset.changed).toBe('true');
    expect(screen.getByTestId('register-R7').textContent).toContain('255 · −1');
  });
});
