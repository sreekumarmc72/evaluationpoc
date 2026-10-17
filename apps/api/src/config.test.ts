import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Hosted application origin', () => {
  async function origin(explicit: string, render: string, railway: string) {
    vi.resetModules();
    vi.stubEnv('APP_ORIGIN', explicit);
    vi.stubEnv('RENDER_EXTERNAL_URL', render);
    vi.stubEnv('RAILWAY_PUBLIC_DOMAIN', railway);
    return (await import('./config.js')).config.appOrigin;
  }
  it('automatically permits the Render public URL', async () => {
    expect(await origin('', 'https://paperwise.onrender.com', '')).toBe('https://paperwise.onrender.com');
  });
  it('preserves the explicit override for custom domains', async () => {
    expect(await origin('https://exam.example.com', 'https://paperwise.onrender.com', '')).toBe('https://exam.example.com');
  });
  it('preserves Railway and local-development defaults', async () => {
    expect(await origin('', '', 'paperwise.up.railway.app')).toBe('https://paperwise.up.railway.app');
    expect(await origin('', '', '')).toBe('');
  });
});
