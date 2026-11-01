import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@vcpu/research-core', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@vcpu/research-core');
  });
});
