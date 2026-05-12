import { useState, useEffect } from 'react';
import { FolderView } from './components/FolderView';
import { RegistryBrowser } from './components/RegistryBrowser';
import { RegistrySettings } from './components/RegistrySettings';
import { LogsView } from './components/LogsView';
import { PushProgress } from './components/PushProgress';
import { getPushStatus, type PushStatus } from './api';

type Tab = 'folder' | 'registry' | 'settings' | 'logs';

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('folder');
  const [showProgress, setShowProgress] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [dismissedError, setDismissedError] = useState(false);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const s = await getPushStatus();
        setPushStatus(s);
        if (s.status === 'idle' && s.progress?.stage !== 'error') {
          setShowProgress(false);
        }
      } catch {
        // ignore
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const isPushing = pushStatus?.status === 'pushing';
  const isError = pushStatus?.status === 'idle' && pushStatus?.progress?.stage === 'error';
  const showIndicator = isPushing || (isError && !dismissedError);

  const handlePushStart = () => {
    setDismissedError(false);
    setShowProgress(true);
  };

  const handleCloseProgress = () => {
    setShowProgress(false);
    if (isError) setDismissedError(true);
  };

  const handleMinimizeProgress = () => {
    setShowProgress(false);
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-surface-800 bg-surface-900/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-white">FS Repo Manager</h1>
              <nav className="mt-3 flex items-center gap-2">
                <TabButton active={tab === 'folder'} onClick={() => setTab('folder')}>
                  Folder
                </TabButton>
                <TabButton active={tab === 'registry'} onClick={() => setTab('registry')}>
                  Registry Browser
                </TabButton>
                <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
                  Settings
                </TabButton>
                <TabButton active={tab === 'logs'} onClick={() => setTab('logs')}>
                  Logs
                </TabButton>
              </nav>
            </div>
            {showIndicator && (
              <button
                onClick={() => setShowProgress(true)}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
                  isError
                    ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                    : 'bg-accent-500/20 text-accent-300 hover:bg-accent-500/30'
                }`}
              >
                {isError ? (
                  <>✕ Push failed</>
                ) : (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-400" />
                    {pushStatus?.progress?.queueTotal
                      ? `Pushing ${(pushStatus.progress.queueIndex ?? 0) + 1}/${pushStatus.progress.queueTotal}`
                      : 'Pushing…'}
                    {pushStatus?.current && (
                      <span className="max-w-32 truncate font-mono text-surface-400">
                        {basename(pushStatus.current)}
                      </span>
                    )}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {tab === 'folder' && <FolderView onPushStart={handlePushStart} />}
        {tab === 'registry' && <RegistryBrowser />}
        {tab === 'settings' && <RegistrySettings />}
        {tab === 'logs' && <LogsView />}
      </main>

      {showProgress && (
        <PushProgress
          status={pushStatus}
          onClose={handleCloseProgress}
          onMinimize={handleMinimizeProgress}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'bg-accent-600 text-white'
          : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200'
      }`}
    >
      {children}
    </button>
  );
}
