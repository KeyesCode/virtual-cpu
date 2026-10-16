import { render, screen } from '@testing-library/react';
import { FLAG_MASKS } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { FlagLights } from './FlagLights';

const lit = (): string[] =>
  ['Z', 'C', 'N', 'V'].filter((flag) => screen.getByTestId(`flag-${flag}`).dataset.on === 'true');

describe('FlagLights', () => {
  it('lights nothing when FLAGS is 0', () => {
    render(<FlagLights flags={0} />);
    expect(lit()).toEqual([]);
  });

  it('lights each set FLAGS bit and only those', () => {
    render(<FlagLights flags={FLAG_MASKS.Z | FLAG_MASKS.N} />);
    expect(lit()).toEqual(['Z', 'N']);
    expect(screen.getByLabelText('ZERO flag set')).toBeTruthy();
    expect(screen.getByLabelText('CARRY flag clear')).toBeTruthy();
  });
});
