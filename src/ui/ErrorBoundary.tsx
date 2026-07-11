import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort catch for render/lifecycle errors, so an uncaught exception shows
 * a message instead of silently unmounting the whole app mid-game. The reset is
 * a full page reload, which lands back on song select.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The UI only shows the message; keep the component stack in the console.
    console.error('Uncaught error in UI:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '1.5rem',
          background: '#050506',
          color: '#ddd',
          fontFamily: 'monospace',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '1.125rem' }}>Something went wrong.</div>
        <div style={{ color: '#f77', maxWidth: '80ch', whiteSpace: 'pre-wrap' }}>
          {error.message || String(error)}
        </div>
        <button
          onClick={() => location.reload()}
          style={{
            background: '#1a1a1a',
            color: '#ddd',
            border: '1px solid #555',
            borderRadius: '4px',
            padding: '0.5rem 1rem',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          Reload (back to song select)
        </button>
      </div>
    );
  }
}
