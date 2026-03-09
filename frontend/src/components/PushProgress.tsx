import { type PushStatus } from '../api';

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function PushProgress({
  status,
  onClose,
  onMinimize,
}: {
  status: PushStatus | null;
  onClose: () => void;
  onMinimize: () => void;
}) {
  const p = status?.progress;
  const isError = p?.stage === 'error';
  const queueTotal = p?.queueTotal ?? 1;
  const queueIndex = p?.queueIndex ?? 0;
  const isQueue = queueTotal > 1;
  const isPushing = status?.status === 'pushing';

  // Overall progress: for queue, blend queue position with per-image progress
  const overallProgress = isQueue
    ? (queueIndex / queueTotal) * 100 + (p?.progress ?? 0) / queueTotal
    : (p?.progress ?? 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-surface-800 bg-surface-900 p-6 shadow-2xl">
        <h3 className="text-lg font-semibold text-white">
          {isError ? 'Push failed' : 'Pushing image' + (isQueue ? 's' : '')}
        </h3>
        {isQueue && (
          <p className="mt-1 text-sm text-surface-400">
            Image {queueIndex + 1} of {queueTotal}
          </p>
        )}
        {status?.current && (
          <p className="mt-1 truncate font-mono text-sm text-surface-500" title={status.current}>
            {basename(status.current)}
          </p>
        )}
        {p && (
          <div className="mt-4">
            <div className="mb-2 flex justify-between text-sm">
              <span className="text-surface-400">{p.message}</span>
              <span className="font-mono text-surface-500">{formatElapsed(p.elapsed)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-800">
              <div
                className="h-full bg-accent-500 transition-all duration-300"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>
        )}
        {isQueue && status?.queue && status.queue.length > 0 && (
          <div className="mt-4 max-h-32 overflow-y-auto rounded-lg border border-surface-800 bg-surface-950 p-2">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-surface-500">
              Queue
            </p>
            <ul className="space-y-1 text-sm">
              {status.queue.map((item, i) => {
                const filename = basename(item.filePath);
                const isCurrent = i === queueIndex && status.status === 'pushing';
                const isDone = i < queueIndex;
                return (
                  <li
                    key={`${item.filePath}-${i}`}
                    className={`flex items-center gap-2 truncate ${
                      isCurrent ? 'text-accent-400' : isDone ? 'text-surface-500' : 'text-surface-400'
                    }`}
                  >
                    <span className="w-5 shrink-0">
                      {isDone ? '✓' : isCurrent ? '→' : '—'}
                    </span>
                    <span className="truncate font-mono">{filename}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {isError && <p className="mt-3 text-sm text-red-400">{p?.message}</p>}
        <div className="mt-6 flex justify-end gap-2">
          {isPushing && (
            <button
              onClick={onMinimize}
              className="rounded-lg bg-surface-700 px-4 py-2 text-sm font-medium text-surface-200 hover:bg-surface-600"
            >
              Minimize
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg bg-surface-800 px-4 py-2 text-sm font-medium text-surface-200 hover:bg-surface-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
