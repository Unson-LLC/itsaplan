import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type DecisionOutcome,
  listDecisionQueue,
  listIssueDecisions,
  recordDecision,
  revokeDecision,
} from '@/lib/api/endpoints/decisions';
import type { PageParams } from '@/lib/api/core/paging';
import { qk } from '@/services/queryKeys';

// Read by the decisions page and the issue's decision panel. A write moves the queue,
// the issue's record and its feed.

export function useDecisionQueueQuery(params: PageParams) {
  return useQuery({
    queryKey: qk.decisionQueuePage(params),
    queryFn: () => listDecisionQueue(params),
  });
}

export function useIssueDecisionsQuery(issueId: number) {
  return useQuery({
    queryKey: qk.issueDecisions(issueId),
    queryFn: () => listIssueDecisions(issueId),
  });
}

function useDecisionMutation<TVars extends { issueId: number }>(
  run: (vars: TVars) => Promise<unknown>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (_data, { issueId }) => {
      void qc.invalidateQueries({ queryKey: qk.decisionQueue });
      void qc.invalidateQueries({ queryKey: qk.issueDecisions(issueId) });
      void qc.invalidateQueries({ queryKey: qk.feed(issueId) });
    },
  });
}

export function useRecordDecision() {
  return useDecisionMutation((vars: { issueId: number; outcome: DecisionOutcome; note?: string }) =>
    recordDecision(vars.issueId, { outcome: vars.outcome, note: vars.note }),
  );
}

export function useRevokeDecision() {
  return useDecisionMutation((vars: { issueId: number; decisionId: number }) =>
    revokeDecision(vars.issueId, vars.decisionId),
  );
}
