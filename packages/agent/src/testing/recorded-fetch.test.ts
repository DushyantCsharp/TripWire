import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { recordFetch, replayFetch, requestKey } from './recorded-fetch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tripwire-recordings-'));
  dirs.push(dir);
  return dir;
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'sk-secret' },
  body: JSON.stringify(body),
});

describe('record/replay fetch', () => {
  it('keys a request by method, path and canonical body, ignoring key order and headers', () => {
    const key = requestKey({ method: 'POST', path: '/v1/messages', body: { a: 1, b: { c: 2 } } });
    expect(key).toBe(
      requestKey({ method: 'POST', path: '/v1/messages', body: { b: { c: 2 }, a: 1 } }),
    );
    expect(key).not.toBe(
      requestKey({ method: 'POST', path: '/v1/messages', body: { a: 2, b: { c: 2 } } }),
    );
    expect(key).not.toBe(
      requestKey({ method: 'POST', path: '/v1/other', body: { a: 1, b: { c: 2 } } }),
    );
  });

  it('records what upstream answers, then replays it without upstream', async () => {
    const dir = tempDir();
    const upstream = () =>
      Promise.resolve(
        new Response('{"answer":42}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '3',
            'request-id': 'req_1',
          },
        }),
      );
    const recorder = recordFetch(dir, upstream);
    const recorded = await recorder.fetch('https://api.example.com/v1/messages', post({ q: 1 }));
    expect(recorded.status).toBe(429);
    expect(await recorded.json()).toEqual({ answer: 42 });

    const replayer = replayFetch(dir);
    const replayed = await replayer.fetch('https://api.example.com/v1/messages', post({ q: 1 }));
    expect(replayed.status).toBe(429);
    expect(replayed.headers.get('retry-after')).toBe('3');
    expect(await replayed.json()).toEqual({ answer: 42 });
    expect(replayer.unused()).toEqual([]);
  });

  it('never writes request headers (the API key) or unneeded response headers', async () => {
    const dir = tempDir();
    const upstream = () =>
      Promise.resolve(new Response('{}', { headers: { 'request-id': 'req_1' } }));
    await recordFetch(dir, upstream).fetch('https://api.example.com/v1/messages', post({}));
    const [file] = readdirSync(dir);
    const written = readFileSync(join(dir, file ?? ''), 'utf8');
    expect(written).not.toContain('sk-secret');
    expect(written).not.toContain('req_1');
  });

  it('fails a request it has no recording for, naming its key', async () => {
    const replayer = replayFetch(tempDir());
    const key = requestKey({ method: 'POST', path: '/v1/messages', body: { q: 2 } });
    await expect(
      replayer.fetch('https://api.example.com/v1/messages', post({ q: 2 })),
    ).rejects.toThrow(key);
    expect(replayer.missing).toEqual([key]);
  });

  it('reports recordings nothing asked for', async () => {
    const dir = tempDir();
    await recordFetch(dir, () => Promise.resolve(new Response('not json'))).fetch(
      'https://api.example.com/v1/messages',
      post({ q: 3 }),
    );
    const replayer = replayFetch(dir);
    expect(replayer.unused()).toHaveLength(1);
    expect(
      await (await replayer.fetch('https://api.example.com/v1/messages', post({ q: 3 }))).text(),
    ).toBe('not json');
    expect(replayer.unused()).toEqual([]);
  });
});
