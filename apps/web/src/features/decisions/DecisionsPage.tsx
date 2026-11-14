'use client';

import { useTranslations } from 'next-intl';
import { usePaging } from '@/hooks/usePaging';
import { useDecisionQueueQuery } from '@/services/decisions.service';
import SectionPageView from '@/components/common/page/SectionPageView';
import ListSkeleton from '@/components/common/skeleton/ListSkeleton';
import ListPager from '@/components/common/ListPager';
import { Button } from '@/components/ui/button';
import DecisionQueueRow from './components/DecisionQueueRow';

// The approvals and the tasks only the caller can do, from every project they can read
// (/:team/:projectKey/decisions). Each is answered here, by the caller in person.
export default function DecisionsPage() {
  const t = useTranslations('decisions');
  const paging = usePaging();
  const query = useDecisionQueueQuery(paging.params);

  let content;
  if (query.isPending) {
    content = <ListSkeleton rows={3} rowClassName="h-24" />;
  } else if (query.isError) {
    content = (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-destructive">{t('loadFailed')}</p>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  } else if (query.data.total === 0) {
    content = <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  } else {
    content = (
      <div className="space-y-6">
        <ul className="divide-y rounded-md border">
          {query.data.items.map((item) => (
            <DecisionQueueRow key={item.issueId} item={item} />
          ))}
        </ul>
        <ListPager paging={paging} total={query.data.total} />
      </div>
    );
  }

  return (
    <SectionPageView title={t('title')} description={t('description')}>
      {content}
    </SectionPageView>
  );
}
