import { describe, expect, it, vi } from 'vitest';
import type { NetRequestInit, NetResponse } from '@workbench/plugin-sdk';
import { DaemonError, ImageClient, START_COMMAND } from './client.js';

function make(answer: (url: string, init?: NetRequestInit) => Promise<NetResponse>, token = '') {
  const fetch = vi.fn(answer);
  return { fetch, client: new ImageClient({ net: { fetch } }, 'http://127.0.0.1:8077/', token) };
}

const ok = (body: unknown): NetResponse => ({ status: 200, ok: true, headers: {}, body: JSON.stringify(body) });

describe('ImageClient', () => {
  it('posts a generate request as JSON, with the token when one is set', async () => {
    const { fetch, client } = make(async () => ok({ id: 'j1', kind: 'image' }), 's3cret');
    await client.generate({ prompt: 'a gate', model: 'm/x' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8077/v1/generate/image');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body ?? '')).toEqual({ prompt: 'a gate', model: 'm/x' });
    expect(init?.headers?.['x-modelctl-token']).toBe('s3cret');
  });

  it('unwraps the models list', async () => {
    const row = {
      repo: 'm/x', family: 'z-image-turbo', role: 'generate', negative: false,
      defaults: { steps: 9, width: 1024, height: 1024 },
    };
    const { client } = make(async () => ok({ models: [row] }));
    expect(await client.models()).toEqual([row]);
  });

  it('names plugin.json when the host is not in the permissions', async () => {
    const { client } = make(async () => { throw new Error('net:fetch denied for http://127.0.0.1:9000'); });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).kind).toBe('denied');
    expect((err as DaemonError).hint).toContain('plugins/image-gen/plugin.json');
  });

  it('reports an unreachable daemon as offline, with the command that starts it', async () => {
    const { client } = make(async () => { throw new Error('ECONNREFUSED'); });
    const err = (await client.health().catch((e: unknown) => e)) as DaemonError;
    expect([err.kind, err.hint]).toEqual(['offline', START_COMMAND]);
  });

  it("passes the daemon's own error and hint through", async () => {
    const { client } = make(async () => ({
      status: 409, ok: false, headers: {},
      body: JSON.stringify({ error: 'another image job is running (m/x)', hint: 'poll /v1/jobs/abc' }),
    }));
    const err = (await client.generate({ prompt: 'x', model: 'm/x' }).catch((e: unknown) => e)) as DaemonError;
    expect([err.kind, err.message, err.hint]).toEqual(['api', 'another image job is running (m/x)', 'poll /v1/jobs/abc']);
  });

  it('calls a non-JSON answer a protocol error', async () => {
    const { client } = make(async () => ({ status: 200, ok: true, headers: {}, body: '<html>' }));
    expect(((await client.jobs().catch((e: unknown) => e)) as DaemonError).kind).toBe('protocol');
  });
});
