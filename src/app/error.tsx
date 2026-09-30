'use client';

// The route-segment error boundary (W123 / B-TL-02): a runtime render error
// inside the app shell lands here instead of the default crash screen.
// Same quiet visual language as the (auth) layout; display only — no
// logging logic, just a calm message and a way to try again.

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // No telemetry is wired by design (display-only boundary); the digest
    // below is what a support conversation can reference.
    void error;
  }, [error]);

  return (
    <div className="aurum-oops" role="alert">
      <style>{`
        .aurum-oops {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 18px;
          padding: 32px 24px;
          background: #fdfaf6;
          color: #1f1915;
          font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
          text-align: center;
          box-sizing: border-box;
        }
        .aurum-oops-mark {
          width: 40px;
          height: 40px;
          border-radius: 10px;
          background: #d9952a;
          color: #fdfaf6;
          font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
          font-weight: 700;
          font-size: 22px;
          line-height: 40px;
        }
        .aurum-oops-title {
          margin: 6px 0 0;
          font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
          font-weight: 600;
          font-size: 28px;
          letter-spacing: -0.01em;
        }
        .aurum-oops-text {
          margin: 0;
          max-width: 34em;
          color: #69625d;
          font-size: 15px;
          line-height: 1.6;
        }
        .aurum-oops-retry {
          margin-top: 8px;
          padding: 10px 22px;
          border: 1px solid #d6d0c8;
          border-radius: 999px;
          background: #fffefc;
          color: #1f1915;
          font-weight: 600;
          font-size: 14px;
          cursor: pointer;
        }
        .aurum-oops-retry:hover {
          border-color: #d9952a;
          color: #6b4a1a;
        }
        .aurum-oops-retry:focus-visible {
          outline: 2px solid #d9952a;
          outline-offset: 2px;
        }
      `}</style>
      <div className="aurum-oops-mark" aria-hidden="true">
        A
      </div>
      <h1 className="aurum-oops-title">Something went wrong</h1>
      <p className="aurum-oops-text">
        This page couldn’t be shown right now. Nothing was lost — your
        records are untouched. Try again, or come back in a moment.
      </p>
      <button className="aurum-oops-retry" type="button" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
