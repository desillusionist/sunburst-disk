import React, { useEffect, useState } from 'react';
import { Activity, Clipboard, Download, Trash2 } from 'lucide-react';
import {
  clearPerformanceLogs,
  getPerformanceSnapshot,
  recordPerfEvent,
  setPerformanceLogging,
  subscribePerformanceLogs
} from '../debug/perfTelemetry';

function downloadSnapshot(snapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `disk-analyzer-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function DebugDownbar({ terminalOpen = false, onToggleTerminal }) {
  const [snapshot, setSnapshot] = useState(getPerformanceSnapshot);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribePerformanceLogs(setSnapshot);
    if (typeof PerformanceObserver === 'undefined') return unsubscribe;
    const observer = new PerformanceObserver(list => {
      list.getEntries().forEach(entry => {
        const startAt = Number.isFinite(entry.startTime) && Number.isFinite(performance.timeOrigin)
          ? new Date(performance.timeOrigin + entry.startTime).toISOString()
          : undefined;
        recordPerfEvent('browser.long-task', entry.duration, {
          name: entry.name || 'main-thread',
          ...(startAt ? { startAt } : {})
        });
      });
    });
    // Do not import long-task entries that happened before the user pressed
    // Collect logs; those buffered entries can arrive in one burst and distort
    // the capture (especially after a previous main-thread stall).
    try { observer.observe({ type: 'longtask', buffered: false }); } catch {}
    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, []);

  const toggleLogging = () => setPerformanceLogging(!snapshot.enabled);

  const copyLogs = async () => {
    const text = JSON.stringify(getPerformanceSnapshot(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="debug-downbar" role="region" aria-label="Performance diagnostics">
      <div className="debug-downbar-title">
        <Activity size={13} />
        <span>Debug</span>
        <span className={`debug-status-dot ${snapshot.enabled ? 'active' : ''}`} />
      </div>
      <div className="debug-downbar-stats">
        <span>{snapshot.stats.total} events</span>
        <span>{snapshot.stats.slow} slow</span>
        <span>max {snapshot.stats.maxMs.toFixed(1)} ms</span>
      </div>
      <div className="debug-downbar-actions">
        <button className={`debug-action-btn ${snapshot.enabled ? 'active' : ''}`} onClick={toggleLogging}>
          {snapshot.enabled ? 'Stop capture' : 'Collect logs'}
        </button>
        {onToggleTerminal && (
          <button className={`debug-action-btn terminal-debug-toggle ${terminalOpen ? 'active' : ''}`} onClick={onToggleTerminal}>
            Terminal
          </button>
        )}
        <button className="debug-icon-btn" title="Clear logs" aria-label="Clear logs" onClick={clearPerformanceLogs}>
          <Trash2 size={12} />
        </button>
        <button className="debug-icon-btn" title="Copy logs as JSON" aria-label="Copy logs as JSON" onClick={copyLogs}>
          <Clipboard size={12} />
        </button>
        <button className="debug-icon-btn" title="Export logs as JSON" aria-label="Export logs as JSON" onClick={() => downloadSnapshot(getPerformanceSnapshot())}>
          <Download size={12} />
        </button>
        {copied && <span className="debug-copied">Copied</span>}
      </div>
    </div>
  );
}
