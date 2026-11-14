// Exactly what a decision is about (repository, head, environment, …), as the
// requester wrote it. Values are identifiers, not prose.
export default function DecisionTargetList({ target }: { target: Record<string, string> }) {
  const entries = Object.entries(target);
  if (entries.length === 0) return null;
  return (
    <dl dir="ltr" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="font-mono break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
