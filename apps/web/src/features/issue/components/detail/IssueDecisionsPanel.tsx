'use client';

import { useTranslations } from 'next-intl';
import { useSession } from '@/lib/auth-client';
import { usePersistedOpen } from '@/hooks/usePersistedOpen';
import { useIssueDecisionsQuery } from '@/services/decisions.service';
import DecisionTargetList from '@/components/common/decisions/DecisionTargetList';
import IssueSectionHeading from './IssueSectionHeading';
import IssueDecisionRow from './IssueDecisionRow';

// The open decision request on the issue and the decisions recorded on it. Hidden
// while the issue has neither. The person answers on their decisions page.
export default function IssueDecisionsPanel({ issueId }: { issueId: number }) {
  const t = useTranslations('decisions');
  const currentUserId = useSession().data?.user.id ?? null;
  const { open, toggle } = usePersistedOpen('issue-decisions-open');
  const data = useIssueDecisionsQuery(issueId).data;
  if (!data || (!data.request && data.decisions.length === 0)) return null;
  const { request, decisions } = data;

  return (
    <div className={`mt-6 border-t pt-5 ${open ? '' : '-mb-2'}`}>
      <div className={`flex h-7 items-center ${open ? 'mb-3' : ''}`}>
        <IssueSectionHeading
          label={t('panel.title')}
          open={open}
          onToggle={toggle}
          tally={decisions.length > 0 ? String(decisions.length) : undefined}
        />
      </div>
      {open && (
        <>
          {request && (
            <div className="mb-2 flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
              <p className="text-sm font-medium">
                {t('panel.waiting', {
                  kind: t(`kind.${request.kind}`),
                  name: request.userName ?? t('someone'),
                })}
              </p>
              <p className="text-sm whitespace-pre-wrap" dir="auto">
                {request.summary}
              </p>
              <DecisionTargetList target={request.target} />
            </div>
          )}
          {decisions.length > 0 && (
            <ul className="divide-y">
              {decisions.map((decision) => (
                <IssueDecisionRow
                  key={decision.id}
                  decision={decision}
                  currentUserId={currentUserId}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
