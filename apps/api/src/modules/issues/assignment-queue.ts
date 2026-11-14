import { customField, db } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';

// A project opts in by creating this project-wide select field. Its options are
// owned by the project's scheduler; user assignments are then legacy data.
export async function usesAssignmentQueue(projectId: number): Promise<boolean> {
  const [field] = await db
    .select({ id: customField.id })
    .from(customField)
    .where(
      and(
        eq(customField.projectId, projectId),
        eq(customField.name, 'Assignment queue'),
        eq(customField.fieldType, 'select'),
        isNull(customField.issueTypeId),
      ),
    )
    .limit(1);
  return field !== undefined;
}
