import { agentRun, db, issue } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { recordActivityEntries, rowSide, textSide } from '#modules/issues/activity';
import { emitRunsCanceled } from '../core/run-finished';

export async function cancelQueuedRun(
  projectId: number,
  runId: number,
  actorUserId: string,
  reason?: string,
) {
  const canceled = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ issueId: agentRun.issueId })
      .from(agentRun)
      .where(and(eq(agentRun.id, runId), eq(agentRun.projectId, projectId)));
    if (!run) throw new HttpError(404, 'Run not found');
    if (run.issueId != null) {
      const [currentIssue] = await tx
        .select({ projectId: issue.projectId })
        .from(issue)
        .where(eq(issue.id, run.issueId))
        .for('update');
      if (!currentIssue || currentIssue.projectId !== projectId) {
        throw new HttpError(404, 'Run not found');
      }
    }
    const [ended] = await tx
      .update(agentRun)
      .set({ status: 'canceled', finishedAt: new Date(), lastError: reason?.trim() || null })
      .where(
        and(
          eq(agentRun.id, runId),
          eq(agentRun.status, 'pending'),
          isNull(agentRun.startedAt),
          isNull(agentRun.claimedAt),
        ),
      )
      .returning({ id: agentRun.id });
    if (!ended) throw new HttpError(409, 'Only a run that has never started can be canceled');
    if (run.issueId != null) {
      await recordActivityEntries(
        [
          {
            issueId: run.issueId,
            event: {
              action: 'agent_run_canceled',
              subject: rowSide(String(runId), runId),
              to: textSide(reason?.trim() || ''),
            },
          },
        ],
        actorUserId,
        tx,
      );
    }
    return { id: ended.id, status: 'canceled' as const };
  });
  await emitRunsCanceled([runId], actorUserId);
  return canceled;
}
