import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@vcpu/eda-adapters', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@vcpu/eda-adapters');
  });
});
