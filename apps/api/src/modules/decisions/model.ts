import { t } from 'elysia';
import { pageQueryFields, pageResponse } from '#shared/pagination';

export const DECISION_KINDS = ['approval', 'owner_task'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_OUTCOMES = ['approved', 'rejected', 'done'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

// The outcomes each kind of request takes.
export const OUTCOMES_BY_KIND: Record<DecisionKind, readonly DecisionOutcome[]> = {
  approval: ['approved', 'rejected'],
  owner_task: ['done'],
};

const decisionKind = t.Union([t.Literal('approval'), t.Literal('owner_task')], {
  description:
    "'approval': the person approves or rejects. 'owner_task': work only that person can do, which they mark done.",
});

export const decisionIssueParams = t.Object({ issueId: t.Numeric() });
export const decisionParams = t.Object({ issueId: t.Numeric(), decisionId: t.Numeric() });

const decisionTarget = t.Record(
  t.String({ minLength: 1, maxLength: 64 }),
  t.String({ maxLength: 500 }),
  {
    maxProperties: 20,
    description:
      'Exactly what is to be approved, as key/value pairs, such as repository, head, environment and action. Shown to the person and copied onto the decision.',
  },
);

export const requestDecisionBody = t.Object({
  userId: t.String({ minLength: 1, description: 'The member who decides. Not an AI agent.' }),
  kind: decisionKind,
  summary: t.String({
    minLength: 1,
    maxLength: 2000,
    description: 'What to decide or do, in one or two sentences.',
  }),
  target: t.Optional(decisionTarget),
});

export const recordDecisionBody = t.Object({
  outcome: t.Union([t.Literal('approved'), t.Literal('rejected'), t.Literal('done')]),
  note: t.Optional(t.String({ maxLength: 5000 })),
});

export const decisionQueueQuery = t.Object({ ...pageQueryFields });

export const DecisionRequestResponse = t.Object({
  issueId: t.Number(),
  userId: t.String(),
  userName: t.Nullable(t.String()),
  kind: decisionKind,
  summary: t.String(),
  target: t.Record(t.String(), t.String()),
  requestedByUserId: t.Nullable(t.String()),
  requestedByName: t.Nullable(t.String()),
  createdAt: t.String(),
});

export const DecisionResponse = t.Object({
  id: t.Number(),
  issueId: t.Number(),
  actorUserId: t.Nullable(t.String()),
  actorName: t.String(),
  kind: decisionKind,
  outcome: t.Union([t.Literal('approved'), t.Literal('rejected'), t.Literal('done')]),
  summary: t.String(),
  target: t.Record(t.String(), t.String()),
  note: t.String(),
  // Every row was written from a signed-in browser session. Stated so a reader of the
  // record needs no knowledge of the route to rely on it.
  via: t.Literal('session'),
  createdAt: t.String(),
  revokedAt: t.Nullable(t.String()),
});

export const IssueDecisionsResponse = t.Object({
  request: t.Nullable(DecisionRequestResponse),
  decisions: t.Array(DecisionResponse),
});

export const DecisionQueueItemResponse = t.Object({
  ...DecisionRequestResponse.properties,
  identifier: t.String(),
  title: t.String(),
  projectKey: t.String(),
  projectName: t.String(),
  teamRef: t.String(),
});

export const DecisionQueuePageResponse = pageResponse(DecisionQueueItemResponse);
