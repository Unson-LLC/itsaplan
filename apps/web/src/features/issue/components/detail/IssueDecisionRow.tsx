'use client';

import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { Decision } from '@/lib/api/endpoints/decisions';
import { useRevokeDecision } from '@/services/decisions.service';
import { formatDateTime } from '@/utils/dates';
import DecisionTargetList from '@/components/common/decisions/DecisionTargetList';
import { Button } from '@/components/ui/button';

// One recorded decision. Its author may revoke their own approval while it stands.
export default function IssueDecisionRow({
  decision,
  currentUserId,
}: {
  decision: Decision;
  currentUserId: string | null;
}) {
  const t = useTranslations('decisions.panel');
  const revoke = useRevokeDecision();
  const canRevoke =
    decision.outcome === 'approved' &&
    decision.revokedAt === null &&
    currentUserId !== null &&
    decision.actorUserId === currentUserId;

  const onRevoke = async () => {
    await revoke.mutateAsync({ issueId: decision.issueId, decisionId: decision.id });
    toast.success(t('revokedToast'));
  };

  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className={decision.revokedAt ? 'line-through' : 'font-medium'}>
          {t(`outcome.${decision.outcome}`)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('by', { name: decision.actorName, time: formatDateTime(decision.createdAt) })}
        </span>
        {canRevoke && (
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto h-7 text-muted-foreground hover:text-destructive"
            disabled={revoke.isPending}
            onClick={() => void onRevoke()}
          >
            {t('revoke')}
          </Button>
        )}
      </div>
      {decision.revokedAt && (
        <p className="text-xs text-muted-foreground">
          {t('revoked', { time: formatDateTime(decision.revokedAt) })}
        </p>
      )}
      <p className="text-xs text-muted-foreground" dir="auto">
        {decision.summary}
      </p>
      <DecisionTargetList target={decision.target} />
      {decision.note && (
        <p className="text-sm whitespace-pre-wrap" dir="auto">
          {decision.note}
        </p>
      )}
    </li>
  );
}
