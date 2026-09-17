import * as Sentry from '@sentry/react';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.PROD ? 'prod' : 'dev',
      tracesSampleRate: 0,
      profilesSampleRate: 0,
    });
    initialized = true;
  } catch {
    // non-fatal: fall back to console
  }
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : new Error(String(error));
  if (!initialized) {
    initSentry();
  }
  if (initialized) {
    Sentry.captureException(err, { extra: context });
  } else {
    console.error('[captureError]', err, context ?? '');
  }
}

export function addBreadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    Sentry.addBreadcrumb({
      category: 'calibration',
      level: 'info',
      message,
      data,
    });
  } catch {
    // non-fatal
  }
}
