import { beforeEach, expect, it } from 'bun:test';
import { authedApi, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';

beforeEach(resetDb);

it('rejects user assignments after queue opt-in and preserves existing issues', async () => {
  const owner = await signUpTestUser();
  const client = authedApi(owner.cookie);
  await createProject(client, { key: 'QUEUE', name: 'Queue' });
  const project = (await client.projects({ projectKey: 'QUEUE' }).get()).data!;
  const columnId = project.columns[0].id;
  const issues = client.projects({ projectKey: 'QUEUE' }).issues;
  const legacy = await issues.post({ columnId, title: 'Legacy', assigneeUserId: owner.userId });
  expect(legacy.status).toBe(201);
  const field = await client.projects({ projectKey: 'QUEUE' })['custom-fields'].post({
    name: 'Assignment queue',
    fieldType: 'select',
    options: ['runnerのキュー', '承認待ち', '佐藤さん本人の作業'],
  });
  expect(field.status).toBe(201);
  expect((await client.issues({ issueId: legacy.data!.id }).get()).data!.assigneeUserId).toBe(
    owner.userId,
  );
  expect(
    (await issues.post({ columnId, title: 'Invalid', assigneeUserId: owner.userId })).status,
  ).toBe(400);
  expect(
    (await client.issues({ issueId: legacy.data!.id }).patch({ assigneeUserId: owner.userId }))
      .status,
  ).toBe(400);
  expect(
    (await client.issues({ issueId: legacy.data!.id }).patch({ assigneeUserId: null })).status,
  ).toBe(200);
  const created = await issues.post({ columnId, title: 'Queued' });
  expect(created.status).toBe(201);
  expect(created.data!.assigneeUserId).toBeNull();
  for (const option of field.data!.options) {
    expect(
      (
        await client
          .issues({ issueId: created.data!.id })
          .fields({ fieldId: field.data!.id })
          .put({ optionIds: [option.id] })
      ).status,
    ).toBe(200);
  }
});
