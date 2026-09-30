'use client';

// The global error boundary (W123 / B-TL-02): when the ROOT layout itself
// fails, Next replaces the whole document with this component — so it must
// render its own <html>/<body>. Minimal branded shell, one retry control,
// display only.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  void error; // no telemetry by design — display only

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          padding: '32px 24px',
          background: '#fdfaf6',
          color: '#1f1915',
          fontFamily:
            "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          textAlign: 'center',
          boxSizing: 'border-box',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: '#d9952a',
            color: '#fdfaf6',
            fontFamily: "'Fraunces', Georgia, 'Times New Roman', serif",
            fontWeight: 700,
            fontSize: 22,
            lineHeight: '40px',
          }}
        >
          A
        </div>
        <h1
          style={{
            margin: '6px 0 0',
            fontFamily: "'Fraunces', Georgia, 'Times New Roman', serif",
            fontWeight: 600,
            fontSize: 28,
            letterSpacing: '-0.01em',
          }}
        >
          Something went wrong
        </h1>
        <p style={{ margin: 0, maxWidth: '34em', color: '#69625d', fontSize: 15, lineHeight: 1.6 }}>
          Aurum couldn’t be loaded right now. Nothing was lost — your records
          are untouched. Try again, or come back in a moment.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            marginTop: 8,
            padding: '10px 22px',
            border: '1px solid #d6d0c8',
            borderRadius: 999,
            background: '#fffefc',
            color: '#1f1915',
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
