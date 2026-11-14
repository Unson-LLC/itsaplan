import { describe, it, expect, beforeEach } from 'bun:test';
import { auth } from '@repo/auth';
import { apiKeyApi, app, authedApi, createProject, type Api } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { mcpAccessToken } from '#tests/helpers/mcp';
import { createAgent } from '#tests/helpers/agents';

// A member is asked to decide on an issue; they answer from the web app. The answer is
// recorded only from a signed-in browser session, so a bot that holds the member's API
// key can write comments as them but cannot write a decision.

interface Member {
  api: Api;
  cookie: string;
  userId: string;
}

async function setup(): Promise<{ owner: Member; decider: Member; issueId: number }> {
  const o = await signUpTestUser();
  const owner = { api: authedApi(o.cookie), cookie: o.cookie, userId: o.userId };
  await createProject(owner.api, { key: 'MKT', name: 'Marketing' });
  const view = await owner.api.projects({ projectKey: 'MKT' }).get();
  const d = await signUpTestUser();
  const invite = await owner.api
    .projects({ projectKey: 'MKT' })
    .invites.post({ email: d.email, role: 'member' });
  const decider = { api: authedApi(d.cookie), cookie: d.cookie, userId: d.userId };
  await decider.api.invites({ token: invite.data!.token }).accept.post();
  const issue = await owner.api
    .projects({ projectKey: 'MKT' })
    .issues.post({ columnId: view.data!.columns[0].id, title: 'Deploy to production' });
  return { owner, decider, issueId: issue.data!.id };
}

function askApproval(client: Api, issueId: number, userId: string) {
  return client
    .issues({ issueId })
    ['decision-request'].put({ userId, kind: 'approval', summary: 'Deploy v2 to production?' });
}

async function personalKey(userId: string): Promise<string> {
  return (await auth.api.createApiKey({ body: { userId, name: 'bot' } })).key;
}

describe('decisions', () => {
  beforeEach(resetDb);

  it('records the decider’s approval from the web app and closes the request', async () => {
    const { owner, decider, issueId } = await setup();
    const asked = await askApproval(owner.api, issueId, decider.userId);
    expect(asked.status).toBe(200);
    expect(asked.data).toMatchObject({ userId: decider.userId, kind: 'approval' });

    const queue = await decider.api['decision-queue'].get({ query: {} });
    expect(queue.data).toMatchObject({
      total: 1,
      items: [{ issueId, identifier: 'MKT-1', summary: 'Deploy v2 to production?' }],
    });

    const res = await decider.api
      .issues({ issueId })
      .decisions.post({ outcome: 'approved', note: 'Go ahead after 18:00' });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      actorUserId: decider.userId,
      kind: 'approval',
      outcome: 'approved',
      summary: 'Deploy v2 to production?',
      note: 'Go ahead after 18:00',
      via: 'session',
    });

    const read = await owner.api.issues({ issueId }).decisions.get();
    expect(read.data!.request).toBeNull();
    expect(read.data!.decisions).toHaveLength(1);
    expect((await decider.api['decision-queue'].get({ query: {} })).data!.total).toBe(0);

    const feed = await owner.api.issues({ issueId }).feed.get({ query: {} });
    const actions = feed.data!.items.map((i) => i.action);
    expect(actions).toContain('decision_requested');
    expect(actions).toContain('decided');
  });

  it('refuses a decision sent with the decider’s API key, while a comment with it passes', async () => {
    const { owner, decider, issueId } = await setup();
    await askApproval(owner.api, issueId, decider.userId);
    const bot = apiKeyApi(await personalKey(decider.userId));

    const comment = await bot
      .issues({ issueId })
      .comments.post({ body: 'Written by bot: approved' });
    expect(comment.status).toBe(201);
    expect(comment.data!.actorUserId).toBe(decider.userId);

    const res = await bot.issues({ issueId }).decisions.post({ outcome: 'approved' });
    expect(res.status).toBe(403);
    expect(res.error!.value).toMatchObject({ code: 'DECISION_NEEDS_SIGNED_IN_PERSON' });

    const read = await owner.api.issues({ issueId }).decisions.get();
    expect(read.data!.decisions).toHaveLength(0);
    expect(read.data!.request).not.toBeNull();
  });

  it('refuses a decision when the session cookie comes with an API key or a bearer token', async () => {
    const { owner, decider, issueId } = await setup();
    await askApproval(owner.api, issueId, decider.userId);
    const key = await personalKey(decider.userId);

    const withKey = authedApi(decider.cookie, { 'x-api-key': key });
    expect((await withKey.issues({ issueId }).decisions.post({ outcome: 'approved' })).status).toBe(
      403,
    );
    const withBearer = authedApi(decider.cookie, { authorization: `Bearer ${key}` });
    expect(
      (await withBearer.issues({ issueId }).decisions.post({ outcome: 'approved' })).status,
    ).toBe(403);
  });

  it('offers no MCP tool that records a decision', async () => {
    const { owner } = await setup();
    const token = await mcpAccessToken(owner.cookie);
    const res = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    const text = await res.text();
    const { tools } = JSON.parse(text.slice(text.indexOf('data: ') + 6)).result;
    const names: string[] = tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('list_issue_decisions');
    expect(names).toContain('request_decision');
    expect(names.filter((n) => n.includes('decision'))).toEqual(
      expect.arrayContaining([
        'list_issue_decisions',
        'request_decision',
        'cancel_decision_request',
      ]),
    );
    expect(names.filter((n) => n.includes('decision'))).toHaveLength(3);
    expect(names.some((n) => n.includes('revoke'))).toBe(false);
  });

  it('lets a bot with an API key ask for a decision and read the record', async () => {
    const { owner, decider, issueId } = await setup();
    const bot = apiKeyApi(await personalKey(owner.userId));
    expect((await askApproval(bot, issueId, decider.userId)).status).toBe(200);
    await decider.api.issues({ issueId }).decisions.post({ outcome: 'rejected' });

    const read = await bot.issues({ issueId }).decisions.get();
    expect(read.data!.decisions[0]).toMatchObject({ outcome: 'rejected', via: 'session' });
  });

  it('accepts only the outcomes of the request kind', async () => {
    const { owner, decider, issueId } = await setup();
    await owner.api.issues({ issueId })['decision-request'].put({
      userId: decider.userId,
      kind: 'owner_task',
      summary: 'Rotate the Stripe key',
    });

    const wrong = await decider.api.issues({ issueId }).decisions.post({ outcome: 'approved' });
    expect(wrong.status).toBe(400);
    const done = await decider.api.issues({ issueId }).decisions.post({ outcome: 'done' });
    expect(done.status).toBe(201);
    expect(done.data).toMatchObject({ kind: 'owner_task', outcome: 'done', note: '' });
  });

  it('refuses a decision from a member the request is not addressed to', async () => {
    const { owner, decider, issueId } = await setup();
    await askApproval(owner.api, issueId, decider.userId);

    const res = await owner.api.issues({ issueId }).decisions.post({ outcome: 'approved' });
    expect(res.status).toBe(403);
  });

  it('answers 409 when the issue has no open request', async () => {
    const { decider, issueId } = await setup();
    const res = await decider.api.issues({ issueId }).decisions.post({ outcome: 'approved' });
    expect(res.status).toBe(409);
  });

  it('refuses to address a request to an AI agent or a non-member', async () => {
    const { owner, issueId } = await setup();
    const agent = await createAgent(owner.api, 'MKT', {
      name: 'Helper',
      username: 'helper',
      kind: 'external',
    });
    const agentUserId = (agent.data as { agent: { userId: string } }).agent.userId;
    expect(agentUserId).toBeString();
    expect((await askApproval(owner.api, issueId, agentUserId)).status).toBe(400);
    const stranger = await signUpTestUser();
    expect((await askApproval(owner.api, issueId, stranger.userId)).status).toBe(400);
  });

  it('validates the summary length', async () => {
    const { owner, decider, issueId } = await setup();
    const put = (summary: string) =>
      owner.api
        .issues({ issueId })
        ['decision-request'].put({ userId: decider.userId, kind: 'approval', summary });
    expect((await put('')).status).toBe(400);
    expect((await put('x'.repeat(2000))).status).toBe(200);
    expect((await put('x'.repeat(2001))).status).toBe(400);
  });

  it('replaces the open request and withdraws it', async () => {
    const { owner, decider, issueId } = await setup();
    await askApproval(owner.api, issueId, decider.userId);
    await owner.api.issues({ issueId })['decision-request'].put({
      userId: decider.userId,
      kind: 'owner_task',
      summary: 'Sign in to Slack',
    });
    expect((await owner.api.issues({ issueId }).decisions.get()).data!.request).toMatchObject({
      kind: 'owner_task',
      summary: 'Sign in to Slack',
    });

    expect((await owner.api.issues({ issueId })['decision-request'].delete()).status).toBe(204);
    expect((await owner.api.issues({ issueId })['decision-request'].delete()).status).toBe(404);
    expect((await decider.api['decision-queue'].get({ query: {} })).data!.total).toBe(0);
  });

  it('copies the target onto the decision and lets only the decider revoke it, from the web app', async () => {
    const { owner, decider, issueId } = await setup();
    const target = { repository: 'Unson-LLC/example', head: 'a'.repeat(40), action: 'deploy' };
    await owner.api.issues({ issueId })['decision-request'].put({
      userId: decider.userId,
      kind: 'approval',
      summary: 'Deploy?',
      target,
    });
    const decided = await decider.api.issues({ issueId }).decisions.post({ outcome: 'approved' });
    expect(decided.data).toMatchObject({ target, revokedAt: null });
    const decisionId = decided.data!.id;

    const bot = apiKeyApi(await personalKey(decider.userId));
    const byKey = await bot.issues({ issueId }).decisions({ decisionId }).revoke.post();
    expect(byKey.status).toBe(403);
    const byOther = await owner.api.issues({ issueId }).decisions({ decisionId }).revoke.post();
    expect(byOther.status).toBe(403);

    const revoked = await decider.api.issues({ issueId }).decisions({ decisionId }).revoke.post();
    expect(revoked.status).toBe(200);
    expect(revoked.data!.revokedAt).toBeInstanceOf(Date);
    const again = await decider.api.issues({ issueId }).decisions({ decisionId }).revoke.post();
    expect(again.status).toBe(409);

    const read = await owner.api.issues({ issueId }).decisions.get();
    expect(read.data!.decisions[0]).toMatchObject({ outcome: 'approved', target });
    expect(read.data!.decisions[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it('revokes only an approval', async () => {
    const { owner, decider, issueId } = await setup();
    await askApproval(owner.api, issueId, decider.userId);
    const rejected = await decider.api.issues({ issueId }).decisions.post({ outcome: 'rejected' });
    const res = await decider.api
      .issues({ issueId })
      .decisions({ decisionId: rejected.data!.id })
      .revoke.post();
    expect(res.status).toBe(400);
  });

  it('limits the target to 20 entries', async () => {
    const { owner, decider, issueId } = await setup();
    const entries = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
    const put = (target: Record<string, string>) =>
      owner.api.issues({ issueId })['decision-request'].put({
        userId: decider.userId,
        kind: 'approval',
        summary: 'S',
        target,
      });
    expect((await put(entries(20))).status).toBe(200);
    expect((await put(entries(21))).status).toBe(400);
  });

  it('hides an issue from a non-member', async () => {
    const { issueId } = await setup();
    const stranger = await signUpTestUser();
    const res = await authedApi(stranger.cookie).issues({ issueId }).decisions.get();
    expect([403, 404]).toContain(res.status);
  });
});
