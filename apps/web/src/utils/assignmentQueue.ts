import type { CustomField } from '@/lib/api/endpoints/customFields';

export function assignmentQueueField(fields: CustomField[]): CustomField | undefined {
  return fields.find(
    (field) =>
      field.name === 'Assignment queue' &&
      field.fieldType === 'select' &&
      field.issueTypeId === null,
  );
}
