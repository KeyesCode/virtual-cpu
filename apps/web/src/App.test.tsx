import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('@vcpu/web', () => {
  it('renders the CPU name', () => {
    expect(renderToStaticMarkup(<App />)).toContain('VCPU-8');
  });
});
