const MAX_EVENTS = 500;
const SLOW_EVENT_MS = 8;

let enabled = false;
let events = [];
let sequence = 0;
let notifyTimer = 0;
const listeners = new Set();
const stats = {
  total: 0,
  slow: 0,
  maxMs: 0,
  byType: {}
};

function round(value) {
  return Math.round(value * 10) / 10;
}

function snapshot() {
  return {
    enabled,
    capturedAt: new Date().toISOString(),
    stats: { ...stats, byType: { ...stats.byType } },
    events: events.slice()
  };
}

function notifySoon() {
  if (notifyTimer) return;
  notifyTimer = window.setTimeout(() => {
    notifyTimer = 0;
    const current = snapshot();
    listeners.forEach(listener => listener(current));
  }, 120);
}

export function setPerformanceLogging(nextEnabled) {
  enabled = Boolean(nextEnabled);
  notifySoon();
}

export function isPerformanceLoggingEnabled() {
  return enabled;
}

export function recordPerfEvent(type, durationMs = 0, details = {}) {
  if (!enabled) return;
  const duration = Math.max(0, Number(durationMs) || 0);
  stats.total += 1;
  stats.maxMs = Math.max(stats.maxMs, duration);
  stats.byType[type] = (stats.byType[type] || 0) + 1;

  // Keep the hot path cheap: only retain slow operations and compact metadata.
  if (duration < SLOW_EVENT_MS && type !== 'scan.error') {
    notifySoon();
    return;
  }

  if (duration >= SLOW_EVENT_MS) stats.slow += 1;
  events.push({
    id: ++sequence,
    at: new Date().toISOString(),
    type,
    ms: round(duration),
    ...details
  });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  notifySoon();
}

export function recordPerfInstant(type, details = {}) {
  if (!enabled) return;
  events.push({ id: ++sequence, at: new Date().toISOString(), type, ...details });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  stats.byType[type] = (stats.byType[type] || 0) + 1;
  notifySoon();
}

export function clearPerformanceLogs() {
  events = [];
  sequence = 0;
  stats.total = 0;
  stats.slow = 0;
  stats.maxMs = 0;
  stats.byType = {};
  notifySoon();
}

export function getPerformanceSnapshot() {
  return snapshot();
}

export function subscribePerformanceLogs(listener) {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}
