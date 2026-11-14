import { request } from '@/lib/api/core/client';
import { type Page, type PageParams, pageQuery } from '@/lib/api/core/paging';

// 'approval': the person approves or rejects. 'owner_task': work only that person can
// do, which they mark done.
export type DecisionKind = 'approval' | 'owner_task';
export type DecisionOutcome = 'approved' | 'rejected' | 'done';

// A member asked to decide on an issue. target names exactly what is decided on
// (repository, head, environment, …); it may be empty.
export interface DecisionRequest {
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

// What a member decided. Written only from a signed-in browser session.
export interface Decision {
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
  revokedAt: string | null;
  createdAt: string;
}

export interface IssueDecisions {
  request: DecisionRequest | null;
  decisions: Decision[];
}

export interface DecisionQueueItem extends DecisionRequest {
  identifier: string;
  title: string;
  projectKey: string;
  projectName: string;
  teamRef: string;
}

export const listDecisionQueue = (params: PageParams) =>
  request<Page<DecisionQueueItem>>(`/decision-queue${pageQuery(params)}`);

export const listIssueDecisions = (issueId: number) =>
  request<IssueDecisions>(`/issues/${issueId}/decisions`);

export const recordDecision = (
  issueId: number,
  input: { outcome: DecisionOutcome; note?: string },
) =>
  request<Decision>(`/issues/${issueId}/decisions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const revokeDecision = (issueId: number, decisionId: number) =>
  request<Decision>(`/issues/${issueId}/decisions/${decisionId}/revoke`, { method: 'POST' });
