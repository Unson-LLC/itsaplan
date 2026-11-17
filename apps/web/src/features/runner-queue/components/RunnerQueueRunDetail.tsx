import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import ConfirmDialog from '@/components/common/overlay/ConfirmDialog';
import { useCancelAgentRunMutation } from '@/services/runnerQueue.service';
import { useTranslations } from 'next-intl';
import type { RunnerQueueRun } from '@/lib/api/endpoints/runnerQueue';
import AgentRunExternalTrace from '@/components/common/agent-runs/AgentRunExternalTrace';
import AgentRunInternalTrace from '@/components/common/agent-runs/AgentRunInternalTrace';
import RunnerQueueRunHeader from './RunnerQueueRunHeader';
import RunnerQueueRunFacts from './RunnerQueueRunFacts';
import RunnerQueueRunResult from './RunnerQueueRunResult';
import RunnerQueueRunSection from './RunnerQueueRunSection';

export default function RunnerQueueRunDetail({ run }: { run: RunnerQueueRun }) {
  const t = useTranslations('issue.agentRuns');
  const cancel = useCancelAgentRunMutation();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const failing = run.executionState === 'failed' || run.executionState === 'queued';
  return (
    <article className="space-y-8">
      <div className="space-y-6">
        <RunnerQueueRunHeader run={run} />
        <RunnerQueueRunFacts run={run} />
        {run.canCancel && (
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            {t('cancelRun')}
          </Button>
        )}
        {confirming && (
          <ConfirmDialog
            title={t('cancelRun')}
            confirmLabel={t('cancelRun')}
            onClose={() => setConfirming(false)}
            onConfirm={async () => {
              await cancel.mutateAsync({ projectRef: run.projectRef, runId: run.id, reason });
              toast.success(t('runCanceled'));
              setConfirming(false);
              setReason('');
            }}
          >
            <p>{t('cancelRunConfirm')}</p>
            <label className="block space-y-2">
              <span>{t('cancelReason')}</span>
              <Textarea
                value={reason}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </ConfirmDialog>
        )}
      </div>
      {failing && run.lastError && (
        <RunnerQueueRunSection title={t('error')}>
          <p className="text-[15px] whitespace-pre-wrap text-destructive" dir="auto">
            {run.lastError}
          </p>
        </RunnerQueueRunSection>
      )}
      {run.output && <RunnerQueueRunResult output={run.output} />}
      <RunnerQueueRunSection title={t('task')}>
        <p className="text-sm whitespace-pre-wrap text-muted-foreground" dir="auto">
          {run.prompt}
        </p>
      </RunnerQueueRunSection>
      <RunnerQueueRunSection title={t('stepsSection')}>
        {run.kind === 'internal' ? (
          <AgentRunInternalTrace runId={run.id} />
        ) : (
          <AgentRunExternalTrace runId={run.id} />
        )}
      </RunnerQueueRunSection>
    </article>
  );
}
