import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const feed of ['agent-runs', 'agent-chats']) {
  for (const scenario of [
    { name: 'delta seconds', header: () => '1', waitMs: 1000, deadlineMs: 3000 },
    { name: 'a delay longer than the default', header: () => '6', waitMs: 6000, deadlineMs: 9000 },
    {
      name: 'an HTTP date',
      header: () => new Date(Date.now() + 2000).toUTCString(),
      waitMs: 0,
      deadlineMs: 4000,
    },
    { name: 'no header', header: () => undefined, waitMs: 5000, deadlineMs: 8000 },
    ...[
      '0',
      '1.5',
      '-3',
      '61',
      '86400',
      '2147484',
      '99999999999999999999',
      '2099-01-01T00:00:00.000Z',
      'Sun, 06 Nov 1994 08:49:37 GMT',
      'Wed, 32 Nov 2026 00:00:00 GMT',
    ].map((header) => ({
      name: `rejected header ${header}`,
      header: () => header,
      waitMs: 5000,
      deadlineMs: 8000,
    })),
    { name: 'an invalid header', header: () => 'invalid', waitMs: 5000, deadlineMs: 8000 },
  ]) {
    it(`retries ${feed}/claim after ${scenario.name}`, async () => {
      const claims: number[] = [];
      let notBefore = 0;
      let retried!: () => void;
      const retry = new Promise<void>((resolve) => (retried = resolve));
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === `/${feed}/claim`) {
            claims.push(Date.now());
            if (claims.length === 1) {
              const header = scenario.header();
              notBefore =
                scenario.name === 'an HTTP date'
                  ? Date.parse(header!)
                  : claims[0]! + scenario.waitMs;
              return Response.json(
                { error: 'Rate limit exceeded.' },
                { status: 429, headers: header === undefined ? {} : { 'Retry-After': header } },
              );
            }
            retried();
            return Response.json({ run: null, message: null });
          }
          return Response.json({ run: null, message: null });
        },
      });
      const dir = await mkdtemp(join(tmpdir(), 'claim-retry-'));
      const config = join(dir, 'runner.json');
      await writeFile(
        config,
        JSON.stringify({
          url: server.url.origin,
          apiKey: 'local-test-only',
          command: 'true',
          pollIntervalMs: 50,
        }),
      );
      const child = Bun.spawn(
        [process.execPath, new URL('../cli.ts', import.meta.url).pathname, config],
        {
          stdout: 'ignore',
          stderr: 'pipe',
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          retry,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`claim was not retried within ${scenario.deadlineMs}ms`)),
              scenario.deadlineMs,
            );
          }),
        ]);
        expect(claims[1]!).toBeGreaterThanOrEqual(notBefore);
      } finally {
        clearTimeout(timer);
        child.kill('SIGKILL');
        await child.exited;
        server.stop(true);
        await rm(dir, { recursive: true, force: true });
      }
    }, 12_000);
  }
}
