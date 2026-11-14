import { db, issue, issueDecision, issueDecisionRequest, project, team, user } from '@repo/db';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { HttpError, iso } from '#shared/lib';
import { recordActivity, recordActivityEntries, rowSide, textSide } from '#modules/issues/activity';
import { isEligibleIssueWatcher } from '#modules/issues/watchers';
import { OUTCOMES_BY_KIND, type DecisionKind, type DecisionOutcome } from './model';

export interface DecisionRequestDto {
  issueId: number;
  userId: string;
  userName: string | null;
  kind: DecisionKind;
  summary: string;
  target: Record<string, string>;
  requestedByUserId: string | null;
  requestedByName: string | null;
  createdAt: string;
}

export interface DecisionDto {
  id: number;
  issueId: number;
  actorUserId: string | null;
  actorName: string;
  kind: DecisionKind;
  outcome: DecisionOutcome;
  summary: string;
  target: Record<string, string>;
  note: string;
  via: 'session';
  createdAt: string;
  revokedAt: string | null;
}

export interface DecisionQueueItemDto extends DecisionRequestDto {
  identifier: string;
  title: string;
  projectKey: string;
  projectName: string;
  teamRef: string;
}

const decider = alias(user, 'decider');

const requestColumns = {
  issueId: issueDecisionRequest.issueId,
  userId: issueDecisionRequest.userId,
  userName: decider.name,
  kind: issueDecisionRequest.kind,
  summary: issueDecisionRequest.summary,
  target: issueDecisionRequest.target,
  requestedByUserId: issueDecisionRequest.requestedByUserId,
  requestedByName: issueDecisionRequest.requestedByName,
  createdAt: issueDecisionRequest.createdAt,
};

type RequestRow = {
  [K in keyof typeof requestColumns]: (typeof requestColumns)[K]['_']['data'] | null;
};

function toRequest(row: RequestRow): DecisionRequestDto {
  return {
    issueId: row.issueId!,
    userId: row.userId!,
    userName: row.userName,
    kind: row.kind as DecisionKind,
    summary: row.summary!,
    target: row.target ?? {},
    requestedByUserId: row.requestedByUserId,
    requestedByName: row.requestedByName,
    createdAt: iso(row.createdAt!),
  };
}

function toDecision(row: typeof issueDecision.$inferSelect): DecisionDto {
  return {
    id: row.id,
    issueId: row.issueId,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    kind: row.kind as DecisionKind,
    outcome: row.outcome as DecisionOutcome,
    summary: row.summary,
    target: row.target,
    note: row.note,
    via: 'session',
    createdAt: iso(row.createdAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
  };
}

async function getRequest(issueId: number): Promise<DecisionRequestDto | null> {
  const [row] = await db
    .select(requestColumns)
    .from(issueDecisionRequest)
    .leftJoin(decider, eq(decider.id, issueDecisionRequest.userId))
    .where(eq(issueDecisionRequest.issueId, issueId));
  return row ? toRequest(row) : null;
}

// The open request on an issue and every decision recorded on it, newest first.
export async function listIssueDecisions(issueId: number): Promise<{
  request: DecisionRequestDto | null;
  decisions: DecisionDto[];
}> {
  const [request, rows] = await Promise.all([
    getRequest(issueId),
    db
      .select()
      .from(issueDecision)
      .where(eq(issueDecision.issueId, issueId))
      .orderBy(desc(issueDecision.createdAt), desc(issueDecision.id)),
  ]);
  return { request, decisions: rows.map(toDecision) };
}

// Asks a member to decide on an issue. A second request replaces the open one, so the
// issue always names one person and one question.
export async function requestDecision(input: {
  projectId: number;
  issueId: number;
  userId: string;
  kind: DecisionKind;
  summary: string;
  target?: Record<string, string>;
  actorUserId: string;
}): Promise<DecisionRequestDto> {
  if (!(await isEligibleIssueWatcher(input.projectId, input.userId)))
    throw new HttpError(400, 'userId must be a member of this project who can read its issues');
  const [requester] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, input.actorUserId));
  const values = {
    userId: input.userId,
    kind: input.kind,
    summary: input.summary.trim(),
    target: input.target ?? {},
    requestedByUserId: input.actorUserId,
    requestedByName: requester?.name ?? null,
    createdAt: new Date(),
  };
  await db
    .insert(issueDecisionRequest)
    .values({ issueId: input.issueId, ...values })
    .onConflictDoUpdate({ target: issueDecisionRequest.issueId, set: values });
  const request = (await getRequest(input.issueId))!;
  await recordActivity(
    input.issueId,
    [
      {
        action: 'decision_requested',
        subject: textSide(input.kind),
        to: rowSide(request.userName, input.userId),
      },
    ],
    input.actorUserId,
  );
  return request;
}

// Withdraws the open request. False when there is none.
export async function cancelDecisionRequest(
  issueId: number,
  actorUserId: string,
): Promise<boolean> {
  const request = await getRequest(issueId);
  if (!request) return false;
  await db.delete(issueDecisionRequest).where(eq(issueDecisionRequest.issueId, issueId));
  await recordActivity(
    issueId,
    [
      {
        action: 'decision_request_cancelled',
        subject: textSide(request.kind),
        from: rowSide(request.userName, request.userId),
      },
    ],
    actorUserId,
  );
  return true;
}

// Records the caller's answer to the open request addressed to them and closes it. The
// route admits only a signed-in browser session; this function trusts that.
export async function recordDecision(input: {
  issueId: number;
  actorUserId: string;
  outcome: DecisionOutcome;
  note?: string;
}): Promise<DecisionDto> {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(issueDecisionRequest)
      .where(eq(issueDecisionRequest.issueId, input.issueId))
      .for('update');
    if (!request) throw new HttpError(409, 'This issue has no open decision request');
    if (request.userId !== input.actorUserId)
      throw new HttpError(403, 'This decision request is addressed to another member');
    const kind = request.kind as DecisionKind;
    if (!OUTCOMES_BY_KIND[kind].includes(input.outcome))
      throw new HttpError(400, `A ${kind} request takes ${OUTCOMES_BY_KIND[kind].join(' or ')}`);
    const [actor] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, input.actorUserId));
    const [row] = await tx
      .insert(issueDecision)
      .values({
        issueId: input.issueId,
        actorUserId: input.actorUserId,
        actorName: actor?.name ?? '',
        kind,
        outcome: input.outcome,
        summary: request.summary,
        target: request.target,
        note: input.note?.trim() ?? '',
      })
      .returning();
    await tx.delete(issueDecisionRequest).where(eq(issueDecisionRequest.issueId, input.issueId));
    await recordActivityEntries(
      [
        {
          issueId: input.issueId,
          event: { action: 'decided', subject: textSide(kind), to: textSide(input.outcome) },
        },
      ],
      input.actorUserId,
      tx,
    );
    return toDecision(row!);
  });
}

// The open requests addressed to a member, oldest first, in the projects given.
// Archived issues are left out.
export async function listDecisionQueue(
  userId: string,
  projectIds: number[],
  window: { limit: number; offset: number },
): Promise<{ items: DecisionQueueItemDto[]; total: number }> {
  if (!projectIds.length) return { items: [], total: 0 };
  const where = and(
    eq(issueDecisionRequest.userId, userId),
    inArray(issue.projectId, projectIds),
    isNull(issue.archivedAt),
  );
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        ...requestColumns,
        sequenceNumber: issue.sequenceNumber,
        title: issue.title,
        projectKey: project.key,
        projectName: project.name,
        teamId: team.id,
        teamSlug: team.slug,
      })
      .from(issueDecisionRequest)
      .innerJoin(issue, eq(issue.id, issueDecisionRequest.issueId))
      .innerJoin(project, eq(project.id, issue.projectId))
      .innerJoin(team, eq(team.id, project.teamId))
      .leftJoin(decider, eq(decider.id, issueDecisionRequest.userId))
      .where(where)
      .orderBy(issueDecisionRequest.createdAt, issueDecisionRequest.issueId)
      .limit(window.limit)
      .offset(window.offset),
    db
      .select({ total: count() })
      .from(issueDecisionRequest)
      .innerJoin(issue, eq(issue.id, issueDecisionRequest.issueId))
      .where(where),
  ]);
  return {
    items: rows.map((r) => ({
      ...toRequest(r),
      identifier: `${r.projectKey}-${r.sequenceNumber}`,
      title: r.title,
      projectKey: r.projectKey,
      projectName: r.projectName,
      teamRef: r.teamSlug ?? String(r.teamId),
    })),
    total: totalRow?.total ?? 0,
  };
}

// Withdraws the caller's own approval. The decision stays in the record with revokedAt
// set; a reader treats it as no approval from then on. Like recording, the route admits
// only a signed-in browser session.
export async function revokeDecision(input: {
  issueId: number;
  decisionId: number;
  actorUserId: string;
}): Promise<DecisionDto> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(issueDecision)
      .where(and(eq(issueDecision.id, input.decisionId), eq(issueDecision.issueId, input.issueId)))
      .for('update');
    if (!row) throw new HttpError(404, 'Decision not found');
    if (row.actorUserId !== input.actorUserId)
      throw new HttpError(403, 'Only the person who decided can revoke this decision');
    if (row.outcome !== 'approved') throw new HttpError(400, 'Only an approval can be revoked');
    if (row.revokedAt) throw new HttpError(409, 'This approval is already revoked');
    const [updated] = await tx
      .update(issueDecision)
      .set({ revokedAt: new Date() })
      .where(eq(issueDecision.id, row.id))
      .returning();
    await recordActivityEntries(
      [
        {
          issueId: input.issueId,
          event: {
            action: 'decision_revoked',
            subject: textSide(row.kind),
            from: textSide(row.outcome),
          },
        },
      ],
      input.actorUserId,
      tx,
    );
    return toDecision(updated!);
  });
}
