import { describe, it, expect, beforeEach } from 'bun:test';
import { db, issue } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { authedApi, createProject, type Api } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { pgErrorCode } from '#shared/lib';
import { withIssueLockTx, withMultiIssueLockTx, withSnapshotReadTx } from '../../tx';

// PostgreSQL 17 integration tests for atomic issue field/comment writes (FOR UPDATE)
// and single-snapshot REPEATABLE READ READ ONLY reads on GET /issues/:issueId.

interface WaitFixture {
  asOwner: Api;
  ownerUserId: string;
  columnId: number;
  issueId: number;
  nextTurnFieldId: number;
  reasonFieldId: number;
  noteFieldId: number;
  optMaintainer: number;
  optRunner: number;
  optDirector: number;
  optionNameById: Map<number, string>;
}

async function setupWaitFixture(): Promise<WaitFixture> {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await createProject(asOwner, { key: 'UNS', name: 'Unson' });
  const view = await asOwner.projects({ projectKey: 'UNS' }).get();
  const columnId = view.data!.columns[0].id;

  const customFields = asOwner.projects({ projectKey: 'UNS' })['custom-fields'];
  const nextTurnField = (
    await customFields.post({
      name: '次の番',
      fieldType: 'select',
      options: ['Maintainer', 'runner', 'Director'],
    })
  ).data!;
  const reasonField = (await customFields.post({ name: '待ち理由', fieldType: 'text' })).data!;
  const noteField = (await customFields.post({ name: '参照メモ', fieldType: 'text' })).data!;

  const optMaintainer = nextTurnField.options.find((o) => o.value === 'Maintainer')!.id;
  const optRunner = nextTurnField.options.find((o) => o.value === 'runner')!.id;
  const optDirector = nextTurnField.options.find((o) => o.value === 'Director')!.id;
  const optionNameById = new Map<number, string>(
    nextTurnField.options.map((option) => [option.id, option.value]),
  );

  const created = (
    await asOwner.projects({ projectKey: 'UNS' }).issues.post({
      columnId,
      title: 'Atomic wait snapshot test issue',
    })
  ).data!;

  return {
    asOwner,
    ownerUserId: owner.userId,
    columnId,
    issueId: created.id,
    nextTurnFieldId: nextTurnField.id,
    reasonFieldId: reasonField.id,
    noteFieldId: noteField.id,
    optMaintainer,
    optRunner,
    optDirector,
    optionNameById,
  };
}

describe('issue atomic writes and repeatable-read snapshot reads', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('serializes concurrent field/comment writes and serves consistent snapshots with zero transient blanks', async () => {
    const {
      asOwner,
      issueId,
      nextTurnFieldId,
      reasonFieldId,
      noteFieldId,
      optMaintainer,
      optRunner,
      optDirector,
    } = await setupWaitFixture();

    const init = await asOwner.issues({ issueId }).fields.put({
      fields: [
        { fieldId: nextTurnFieldId, optionIds: [optMaintainer] },
        { fieldId: reasonFieldId, value: 'initial-wait' },
      ],
    });
    expect(init.status).toBe(200);

    const optionCycle = [optMaintainer, optRunner, optDirector];
    const writeTasks: Promise<{ status: number }>[] = [];

    for (let i = 0; i < 6; i++) {
      const optId = optionCycle[i % optionCycle.length];
      writeTasks.push(
        asOwner
          .issues({ issueId })
          .fields({ fieldId: nextTurnFieldId })
          .put({ optionIds: [optId] }),
      );
      writeTasks.push(
        asOwner.issues({ issueId }).fields.put({
          fields: [
            { fieldId: nextTurnFieldId, optionIds: [optionCycle[(i + 1) % optionCycle.length]] },
            { fieldId: reasonFieldId, value: `batch-${i}` },
            { fieldId: noteFieldId, value: `note-${i}` },
          ],
          comment: { body: `WAIT_SIGN batch=${i}` },
        }),
      );
    }

    for (let i = 0; i < 4; i++) {
      writeTasks.push(asOwner.issues({ issueId }).comments.post({ body: `concurrent-note-${i}` }));
    }

    const readTasks = Array.from({ length: 16 }, async (_, index) => {
      if (index % 3 === 1) await Bun.sleep(2);
      if (index % 3 === 2) await Bun.sleep(5);
      return asOwner.issues({ issueId }).get({
        query: { includeActivity: 'true', activityLimit: 200 },
      });
    });

    const [writeResults, readResults] = await Promise.all([
      Promise.all(writeTasks),
      Promise.all(readTasks),
    ]);

    for (const res of writeResults) {
      expect([200, 201]).toContain(res.status);
    }

    const finalRead = await asOwner.issues({ issueId }).get({
      query: { includeActivity: 'true', activityLimit: 200 },
    });
    const allSnapshots = [...readResults, finalRead];

    for (const res of allSnapshots) {
      expect(res.status).toBe(200);
      const data = res.data!;
      const nextTurn = data.fields.find((f) => f.fieldId === nextTurnFieldId);
      expect(nextTurn).toBeDefined();
      // No reader may ever observe an intermediate DELETE-before-INSERT empty selection.
      expect(nextTurn!.optionIds).toHaveLength(1);

      expect(data.activity).toBeDefined();
      expect(data.activity!.truncated).toBe(false);
      const nextTurnEvents = data.activity!.items.filter(
        (item) =>
          item.kind === 'activity' &&
          item.action === 'field' &&
          item.payload.subject?.id === nextTurnFieldId,
      );
      expect(nextTurnEvents.length).toBeGreaterThan(0);

      const latestNextTurnEvent = nextTurnEvents.reduce((latest, item) =>
        item.id > latest.id ? item : latest,
      );
      expect(latestNextTurnEvent.payload.to?.id).toBe(nextTurn!.optionIds[0]);

      const maxItemId = Math.max(...data.activity!.items.map((item) => item.id));
      expect(data.activity!.latestActivityId).toBe(maxItemId);
    }
  });

  it('rolls back all field writes, activity rows, and comment on mid-transaction failure', async () => {
    const {
      asOwner,
      issueId,
      nextTurnFieldId,
      reasonFieldId,
      noteFieldId,
      optMaintainer,
      optRunner,
    } = await setupWaitFixture();

    const seed = await asOwner.issues({ issueId }).fields.put({
      fields: [
        { fieldId: nextTurnFieldId, optionIds: [optMaintainer] },
        { fieldId: reasonFieldId, value: 'before-reason' },
        { fieldId: noteFieldId, value: 'before-note' },
      ],
    });
    expect(seed.status).toBe(200);

    const before = (
      await asOwner.issues({ issueId }).get({
        query: { includeActivity: 'true', activityLimit: 200 },
      })
    ).data!;

    // Case 1: fields 1 and 2 are valid, field 3 carries an option id that does not belong to the field.
    const invalidOption = await asOwner.issues({ issueId }).fields.put({
      fields: [
        { fieldId: reasonFieldId, value: 'dirty-reason' },
        { fieldId: noteFieldId, value: 'dirty-note' },
        { fieldId: nextTurnFieldId, optionIds: [999999] },
      ],
      comment: { body: 'must-not-be-committed' },
    });
    expect(invalidOption.status).toBe(400);

    const afterInvalidOption = (
      await asOwner.issues({ issueId }).get({
        query: { includeActivity: 'true', activityLimit: 200 },
      })
    ).data!;
    expect(afterInvalidOption.fields).toEqual(before.fields);
    expect(afterInvalidOption.activity!.items.length).toBe(before.activity!.items.length);
    expect(afterInvalidOption.activity!.latestActivityId).toBe(before.activity!.latestActivityId);
    expect(
      afterInvalidOption.activity!.items.some((item) => item.body === 'must-not-be-committed'),
    ).toBe(false);

    // Case 2: all fields are valid, but the bundled comment points to a nonexistent replyToId.
    const invalidReply = await asOwner.issues({ issueId }).fields.put({
      fields: [
        { fieldId: nextTurnFieldId, optionIds: [optRunner] },
        { fieldId: reasonFieldId, value: 'dirty-after-reply-fail' },
      ],
      comment: { body: 'orphan-reply', replyToId: 999999 },
    });
    expect(invalidReply.status).toBe(400);

    const afterInvalidReply = (
      await asOwner.issues({ issueId }).get({
        query: { includeActivity: 'true', activityLimit: 200 },
      })
    ).data!;
    expect(afterInvalidReply.fields).toEqual(before.fields);
    expect(afterInvalidReply.activity!.items.length).toBe(before.activity!.items.length);
    expect(afterInvalidReply.activity!.latestActivityId).toBe(before.activity!.latestActivityId);
  });

  it('preserves strict ordering and monotonic latestActivityId across ABA handoffs (Maintainer -> runner -> Maintainer)', async () => {
    const {
      asOwner,
      issueId,
      nextTurnFieldId,
      reasonFieldId,
      optMaintainer,
      optRunner,
      optionNameById,
    } = await setupWaitFixture();

    const gen1 = await asOwner.issues({ issueId }).fields.put({
      fields: [
        { fieldId: nextTurnFieldId, optionIds: [optMaintainer] },
        { fieldId: reasonFieldId, value: 'wait-reason-1' },
      ],
      comment: { body: 'WAIT_SIGN gen=1' },
    });
    expect(gen1.status).toBe(200);
    expect(gen1.data!.comment?.body).toBe('WAIT_SIGN gen=1');

    const gen2 = await asOwner.issues({ issueId }).fields.put({
      fields: [
        { fieldId: nextTurnFieldId, optionIds: [optRunner] },
        { fieldId: reasonFieldId, value: null },
      ],
      comment: { body: 'LEAVE_SIGN gen=2' },
    });
    expect(gen2.status).toBe(200);
    expect(gen2.data!.comment?.body).toBe('LEAVE_SIGN gen=2');

    const gen3 = await asOwner.issues({ issueId }).fields.put({
      fields: [
        { fieldId: nextTurnFieldId, optionIds: [optMaintainer] },
        { fieldId: reasonFieldId, value: 'wait-reason-3' },
      ],
      comment: { body: 'WAIT_SIGN gen=3' },
    });
    expect(gen3.status).toBe(200);
    expect(gen3.data!.comment?.body).toBe('WAIT_SIGN gen=3');

    const id1 = gen1.data!.latestActivityId!;
    const id2 = gen2.data!.latestActivityId!;
    const id3 = gen3.data!.latestActivityId!;
    expect(id1).toBeLessThan(id2);
    expect(id2).toBeLessThan(id3);

    const snap = await asOwner.issues({ issueId }).get({
      query: { includeActivity: 'true', activityOrder: 'asc', activityLimit: 200 },
    });
    expect(snap.status).toBe(200);
    const data = snap.data!;

    expect(data.activity!.truncated).toBe(false);
    expect(data.activity!.latestActivityId).toBe(id3);

    const nextTurnChanges = data.activity!.items.filter(
      (item) =>
        item.kind === 'activity' &&
        item.action === 'field' &&
        item.payload.subject?.id === nextTurnFieldId,
    );
    expect(nextTurnChanges.map((item) => item.payload.to?.value)).toEqual([
      'Maintainer',
      'runner',
      'Maintainer',
    ]);
    expect(nextTurnChanges[0].id).toBeLessThan(nextTurnChanges[1].id);
    expect(nextTurnChanges[1].id).toBeLessThan(nextTurnChanges[2].id);

    const comments = data.activity!.items.filter((item) => item.kind === 'comment');
    expect(comments.map((c) => c.body)).toEqual([
      'WAIT_SIGN gen=1',
      'LEAVE_SIGN gen=2',
      'WAIT_SIGN gen=3',
    ]);
    // Each generation's field writes precede its bundled comment and precede the next generation.
    expect(nextTurnChanges[0].id).toBeLessThan(comments[0].id);
    expect(comments[0].id).toBeLessThan(nextTurnChanges[1].id);
    expect(nextTurnChanges[1].id).toBeLessThan(comments[1].id);
    expect(comments[1].id).toBeLessThan(nextTurnChanges[2].id);
    expect(nextTurnChanges[2].id).toBeLessThan(comments[2].id);

    const currentNextTurn = data.fields.find((f) => f.fieldId === nextTurnFieldId)!;
    const currentReason = data.fields.find((f) => f.fieldId === reasonFieldId)!;
    expect(currentNextTurn.optionIds).toEqual([optMaintainer]);
    expect(optionNameById.get(currentNextTurn.optionIds[0])).toBe('Maintainer');
    expect(currentReason.value).toBe('wait-reason-3');
  });

  it('stays backward-compatible for legacy single-field writes and reports truncated=true when activityLimit is exceeded', async () => {
    const { asOwner, issueId, nextTurnFieldId, optRunner } = await setupWaitFixture();

    // Direct stale-patrol style single-field write with no WAIT_SIGN comment.
    const setRes = await asOwner
      .issues({ issueId })
      .fields({ fieldId: nextTurnFieldId })
      .put({ optionIds: [optRunner] });
    expect(setRes.status).toBe(200);

    // Traditional GET /issues/:issueId without includeActivity omits the activity key.
    const legacyDefault = await asOwner.issues({ issueId }).get();
    expect(legacyDefault.status).toBe(200);
    expect('activity' in legacyDefault.data!).toBe(false);
    expect(
      legacyDefault.data!.fields.find((f) => f.fieldId === nextTurnFieldId)?.optionIds,
    ).toEqual([optRunner]);

    const legacyFalse = await asOwner
      .issues({ issueId })
      .get({ query: { includeActivity: 'false' } });
    expect(legacyFalse.status).toBe(200);
    expect('activity' in legacyFalse.data!).toBe(false);

    const withActivity = await asOwner
      .issues({ issueId })
      .get({ query: { includeActivity: 'true' } });
    expect(withActivity.status).toBe(200);
    expect(withActivity.data!.activity!.truncated).toBe(false);
    expect(withActivity.data!.activity!.items.some((item) => item.kind === 'comment')).toBe(false);
    const fieldEvent = withActivity.data!.activity!.items.find(
      (item) => item.kind === 'activity' && item.action === 'field',
    );
    expect(fieldEvent?.payload.to?.id).toBe(optRunner);
    expect(withActivity.data!.activity!.latestActivityId).toBe(fieldEvent?.id ?? null);

    // Add two comments so total top-level entries exceed activityLimit=2.
    await asOwner.issues({ issueId }).comments.post({ body: 'legacy-comment-1' });
    const latestComment = (
      await asOwner.issues({ issueId }).comments.post({ body: 'legacy-comment-2' })
    ).data!;

    const truncatedRes = await asOwner.issues({ issueId }).get({
      query: { includeActivity: 'true', activityLimit: 2 },
    });
    expect(truncatedRes.status).toBe(200);
    expect(truncatedRes.data!.activity!.items).toHaveLength(2);
    expect(truncatedRes.data!.activity!.nextCursor).not.toBeNull();
    expect(truncatedRes.data!.activity!.truncated).toBe(true);
    expect(truncatedRes.data!.activity!.latestActivityId).toBe(latestComment.id);
  });

  it('enforces SET LOCAL lock_timeout on contended FOR UPDATE rows while allowing non-blocking REPEATABLE READ READ ONLY snapshots', async () => {
    const { asOwner, columnId, issueId } = await setupWaitFixture();
    const secondIssue = (
      await asOwner.projects({ projectKey: 'UNS' }).issues.post({
        columnId,
        title: 'Second issue for multi-lock ordering check',
      })
    ).data!;

    let notifyLocked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issue.id }).from(issue).where(eq(issue.id, issueId)).for('update');
      notifyLocked();
      await holdLock;
    });

    try {
      await lockAcquired;

      // A contended write tx must abort with SQLSTATE 55P03 (lock_not_available)
      // instead of hanging indefinitely.
      let caught: unknown;
      try {
        await withIssueLockTx(
          issueId,
          async () => {
            throw new Error('expected lock timeout before callback');
          },
          { lockTimeoutMs: 150, statementTimeoutMs: 5000 },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(pgErrorCode(caught)).toBe('55P03');

      // A REPEATABLE READ READ ONLY snapshot must read without blocking on the
      // held FOR UPDATE row lock, and must run under the expected PG 17 settings.
      const snapshotMeta = await withSnapshotReadTx(async (tx) => {
        const [isolation] = (await tx.execute(sql`SHOW transaction_isolation`)) as unknown as {
          transaction_isolation: string;
        }[];
        const [readOnly] = (await tx.execute(sql`SHOW transaction_read_only`)) as unknown as {
          transaction_read_only: string;
        }[];
        const [stmtTimeout] = (await tx.execute(sql`SHOW statement_timeout`)) as unknown as {
          statement_timeout: string;
        }[];
        const [row] = await tx.select({ id: issue.id }).from(issue).where(eq(issue.id, issueId));
        return {
          isolation: isolation.transaction_isolation,
          readOnly: readOnly.transaction_read_only,
          stmtTimeout: stmtTimeout.statement_timeout,
          rowId: row?.id ?? null,
        };
      });

      expect(snapshotMeta.isolation).toBe('repeatable read');
      expect(snapshotMeta.readOnly).toBe('on');
      expect(snapshotMeta.stmtTimeout).toBe('10s');
      expect(snapshotMeta.rowId).toBe(issueId);
    } finally {
      releaseLock();
      await holder;
    }

    // Verify withMultiIssueLockTx deduplicates and locks in ascending id order.
    const lockedIds = await withMultiIssueLockTx(
      [secondIssue.id, issueId, secondIssue.id],
      async (_tx, ids) => ids,
    );
    expect(lockedIds).toEqual([
      Math.min(issueId, secondIssue.id),
      Math.max(issueId, secondIssue.id),
    ]);
  });
});
