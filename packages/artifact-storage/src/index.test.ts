import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@vcpu/artifact-storage', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@vcpu/artifact-storage');
  });
});
