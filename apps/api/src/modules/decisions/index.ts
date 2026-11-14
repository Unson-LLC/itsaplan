import { Elysia, t } from 'elysia';
import { aiAgent, db } from '@repo/db';
import { eq } from 'drizzle-orm';
import { mcpTool } from '#mcp/generate';
import { noContent } from '#shared/http';
import { entityGuard, requiresPermission } from '#shared/guards';
import { authContext } from '#shared/auth-context';
import { readableProjectIds, requireUser } from '#shared/access';
import { boundProjectId, getMcpOAuthToken, isMcpRequest } from '#shared/mcp-request';
import { HttpError } from '#shared/lib';
import { paginate } from '#shared/pagination';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import { getIssueProjectId } from '#modules/issues/service';
import {
  DecisionQueuePageResponse,
  DecisionRequestResponse,
  DecisionResponse,
  IssueDecisionsResponse,
  decisionIssueParams,
  decisionParams,
  decisionQueueQuery,
  recordDecisionBody,
  requestDecisionBody,
} from './model';
import {
  cancelDecisionRequest,
  listDecisionQueue,
  listIssueDecisions,
  recordDecision,
  requestDecision,
  revokeDecision,
} from './service';

// A decision is the person's own act. An API key or an MCP token can be held by a bot
// acting for the person, so a write that carries one is refused; only the session
// cookie of a signed-in browser passes, and the CSRF guard in app.ts has already
// checked its origin.
async function assertSignedInPerson(request: Request, userId: string): Promise<void> {
  const headers = request.headers;
  const delegated =
    headers.has('x-api-key') ||
    headers.has('authorization') ||
    isMcpRequest(headers) ||
    getMcpOAuthToken(request) !== undefined;
  const [agent] = delegated
    ? []
    : await db.select({ id: aiAgent.id }).from(aiAgent).where(eq(aiAgent.userId, userId));
  if (delegated || agent)
    throw new HttpError(
      403,
      'A decision is recorded only by the person, signed in to the web app. API keys and MCP tokens cannot record one.',
      'DECISION_NEEDS_SIGNED_IN_PERSON',
    );
}

export const decisionRoutes = new Elysia({ name: 'decisions', detail: { tags: ['Decisions'] } })
  .use(authContext)
  .macro({
    workItem: entityGuard('work_items', 'Issue not found', (p) =>
      getIssueProjectId(Number(p.issueId)),
    ),
  })

  .get(
    '/decision-queue',
    async ({ user, query, request }) => {
      const me = requireUser(user).id;
      const ids = await readableProjectIds(me, [['work_items', 'read']], {
        mcpOnly: isMcpRequest(request.headers),
      });
      const bound = boundProjectId(request.headers);
      const projectIds = ids.filter((id) => bound == null || id === bound);
      return paginate(query, (window) => listDecisionQueue(me, projectIds, window));
    },
    {
      query: decisionQueueQuery,
      response: { 200: DecisionQueuePageResponse, ...errors(400, 401) },
      detail: {
        summary: 'List the decisions waiting for you',
        description:
          'The open decision requests addressed to you in every project you can read, oldest first.',
        ...requiresPermission(['work_items', 'read']),
      },
    },
  )

  .get('/issues/:issueId/decisions', async ({ params }) => listIssueDecisions(params.issueId), {
    params: decisionIssueParams,
    workItem: 'read',
    response: { 200: IssueDecisionsResponse, ...accessErrors },
    detail: {
      summary: "List an issue's decisions",
      description:
        "Get the open decision request on an issue and every decision recorded on it, newest first. A decision is written only by the person, signed in to the web app (via: 'session'); a comment, whoever its author, is not a decision.",
      ...mcpTool('list_issue_decisions'),
    },
  })

  .put(
    '/issues/:issueId/decision-request',
    async ({ params, body, user, projectId }) =>
      requestDecision({
        projectId,
        issueId: params.issueId,
        userId: body.userId,
        kind: body.kind,
        summary: body.summary,
        target: body.target,
        actorUserId: requireUser(user).id,
      }),
    {
      params: decisionIssueParams,
      body: requestDecisionBody,
      workItem: 'edit',
      response: { 200: DecisionRequestResponse, ...commonErrors },
      detail: {
        summary: 'Ask a member to decide',
        description:
          "Ask a member to approve or reject an issue ('approval'), or to do work only they can do ('owner_task'). The issue then appears on their decision page. A new request replaces the open one.",
        ...mcpTool('request_decision'),
      },
    },
  )

  .delete(
    '/issues/:issueId/decision-request',
    async ({ params, user }) => {
      const removed = await cancelDecisionRequest(params.issueId, requireUser(user).id);
      if (!removed) throw new HttpError(404, 'This issue has no open decision request');
      return noContent();
    },
    {
      params: decisionIssueParams,
      workItem: 'edit',
      response: { 204: t.Void(), ...accessErrors },
      detail: {
        summary: 'Withdraw a decision request',
        description: 'Withdraw the open decision request on an issue. Recorded decisions stay.',
        ...mcpTool('cancel_decision_request'),
      },
    },
  )

  // No MCP tool on purpose: see assertSignedInPerson.
  .post(
    '/issues/:issueId/decisions',
    async ({ params, body, user, request, set }) => {
      const me = requireUser(user).id;
      await assertSignedInPerson(request, me);
      const decision = await recordDecision({
        issueId: params.issueId,
        actorUserId: me,
        outcome: body.outcome,
        note: body.note,
      });
      set.status = 201;
      return decision;
    },
    {
      params: decisionIssueParams,
      body: recordDecisionBody,
      workItem: 'read',
      response: { 201: DecisionResponse, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'Record your decision',
        description:
          'Answer the open decision request addressed to you. Only a signed-in browser session may call this; an API key or an MCP token gets 403 DECISION_NEEDS_SIGNED_IN_PERSON.',
      },
    },
  )

  .post(
    '/issues/:issueId/decisions/:decisionId/revoke',
    async ({ params, user, request }) => {
      const me = requireUser(user).id;
      await assertSignedInPerson(request, me);
      return revokeDecision({
        issueId: params.issueId,
        decisionId: params.decisionId,
        actorUserId: me,
      });
    },
    {
      params: decisionParams,
      workItem: 'read',
      response: { 200: DecisionResponse, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'Revoke your approval',
        description:
          'Withdraw an approval you recorded. The decision stays in the record with revokedAt set. Only a signed-in browser session may call this.',
      },
    },
  );
