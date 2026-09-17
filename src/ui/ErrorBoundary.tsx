import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { captureError } from '@/lib/sentry';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureError(error, {
      componentStack: info.componentStack,
    });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-base-950 px-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-error-700/20">
            <AlertTriangle size={32} className="text-error-500" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-base-100">Something went wrong</h1>
            <p className="mt-1 max-w-sm text-sm text-base-400">
              An unexpected error occurred. Reloading the page usually fixes it.
            </p>
          </div>
          {this.state.error && (
            <pre className="max-w-lg overflow-auto rounded-lg bg-base-900 p-3 text-left text-2xs text-base-500">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-500"
          >
            <RefreshCw size={16} />
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
