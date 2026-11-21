import { beforeEach, expect, it } from 'bun:test';
import { apikey, db } from '@repo/db';
import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { APIError } from 'better-auth/api';
import { planner } from '../../planner';
import { app, authedApi, createProject } from '#tests/helpers/app';
import { createAgent } from '#tests/helpers/agents';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

beforeEach(resetDb);

for (const feed of ['agent-runs', 'agent-chats']) {
  it(`returns 429 from ${feed}/claim when authentication is rate limited`, async () => {
    const owner = await signUpTestUser();
    const asOwner = authedApi(owner.cookie);
    await createProject(asOwner, { key: 'RATE', name: 'Rate limit test' });
    const created = await createAgent(asOwner, 'RATE', {
      name: 'Rate Bot',
      username: 'ratebot',
      kind: 'external',
    });
    const { agent, apiKey } = created.data!;
    await db
      .update(apikey)
      .set({
        rateLimitEnabled: true,
        rateLimitMax: 1,
        rateLimitTimeWindow: 60_000,
        requestCount: 1,
        lastRequest: new Date(),
      })
      .where(eq(apikey.referenceId, agent.userId));

    const response = await app.handle(
      new Request(`http://localhost/${feed}/claim`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey! },
      }),
    );
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(59);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await response.json()).toMatchObject({
      error: 'Rate limit exceeded.',
      code: 'RATE_LIMITED',
    });
  });
}

it('preserves upstream Retry-After through the planner error handler', async () => {
  const limited = new Elysia();
  limited.use(planner);
  limited.get('/rate-limit-test', () => {
    throw new APIError(
      'TOO_MANY_REQUESTS',
      { message: 'Rate limit exceeded.', code: 'RATE_LIMITED' },
      { 'Retry-After': '17', 'Set-Cookie': 'private=value' },
    );
  });
  const response = await limited.handle(new Request('http://localhost/rate-limit-test'));
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('17');
  expect(response.headers.get('Set-Cookie')).toBeNull();
  expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
});
