import React from 'react';

// Self-contained on purpose: inline styles only, no app CSS or hooks, so it can
// still render when the failure is in styling, a provider, or a shared module.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Caught by ErrorBoundary:', error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <h2 style={S.title}>Something went wrong</h2>
          <p style={S.subtitle}>
            The app hit an unexpected error and stopped rendering. The details below
            show what threw — a common cause is a wallet/network state change.
          </p>
          <pre style={S.message}>{error.message || String(error)}</pre>
          {error.stack && <pre style={S.stack}>{error.stack}</pre>}
          <div style={S.actions}>
            <button style={S.btnPrimary} onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button style={S.btn} onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

const S = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f0f2f5', fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
  card: { maxWidth: 640, width: '100%', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,.07)' },
  title: { margin: '0 0 8px', color: '#dc2626', fontSize: 20 },
  subtitle: { margin: '0 0 16px', color: '#64748b', fontSize: 14, lineHeight: 1.5 },
  message: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: 12, margin: '0 0 8px', fontSize: 13, color: '#dc2626' },
  stack: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: 12, margin: 0, fontSize: 11, color: '#94a3b8', maxHeight: 200, overflowY: 'auto' },
  actions: { display: 'flex', gap: 8, marginTop: 16 },
  btnPrimary: { padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  btn: { padding: '8px 16px', background: '#fff', color: '#1e293b', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
};
