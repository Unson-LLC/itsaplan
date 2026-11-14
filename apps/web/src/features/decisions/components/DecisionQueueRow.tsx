'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { DecisionOutcome, DecisionQueueItem } from '@/lib/api/endpoints/decisions';
import { useRecordDecision } from '@/services/decisions.service';
import { formatDateTime } from '@/utils/dates';
import DecisionTargetList from '@/components/common/decisions/DecisionTargetList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

// One request waiting for the caller, with the buttons that answer it. The note is kept
// with the decision as the caller's own words.
export default function DecisionQueueRow({ item }: { item: DecisionQueueItem }) {
  const t = useTranslations('decisions');
  const [note, setNote] = useState('');
  const record = useRecordDecision();

  const decide = async (outcome: DecisionOutcome) => {
    await record.mutateAsync({ issueId: item.issueId, outcome, note: note.trim() || undefined });
    toast.success(t(`recorded.${outcome}`));
  };

  const outcomes: { outcome: DecisionOutcome; variant: 'default' | 'outline' }[] =
    item.kind === 'approval'
      ? [
          { outcome: 'approved', variant: 'default' },
          { outcome: 'rejected', variant: 'outline' },
        ]
      : [{ outcome: 'done', variant: 'default' }];

  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="shrink-0 font-normal">
          {t(`kind.${item.kind}`)}
        </Badge>
        <Link
          href={`/${item.teamRef}/issue/${item.identifier}`}
          className="min-w-0 truncate text-sm font-medium hover:underline"
        >
          <span dir="ltr" className="me-2 text-muted-foreground">
            {item.identifier}
          </span>
          <span dir="auto">{item.title}</span>
        </Link>
        <span className="ms-auto shrink-0 text-xs text-muted-foreground" dir="auto">
          {item.projectName}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap" dir="auto">
        {item.summary}
      </p>
      <DecisionTargetList target={item.target} />
      <p className="text-xs text-muted-foreground">
        {t('requestedBy', {
          name: item.requestedByName ?? t('someone'),
          time: formatDateTime(item.createdAt),
        })}
      </p>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t('notePlaceholder')}
        maxLength={5000}
        rows={2}
        dir="auto"
      />
      <div className="flex gap-2">
        {outcomes.map(({ outcome, variant }) => (
          <Button
            key={outcome}
            size="sm"
            variant={variant}
            disabled={record.isPending}
            onClick={() => void decide(outcome)}
          >
            {t(`action.${outcome}`)}
          </Button>
        ))}
      </div>
    </li>
  );
}
