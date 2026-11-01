import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@vcpu/experiment-runner', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@vcpu/experiment-runner');
  });
});
