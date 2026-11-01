import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@vcpu/research-agents', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@vcpu/research-agents');
  });
});
