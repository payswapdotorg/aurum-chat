import type { Metadata } from 'next';
import Link from 'next/link';

// The branded 404 (W123 / B-TL-01): every unknown URL lands here instead of
// the default bare 404. Same quiet visual language as the (auth) layout —
// warm cream canvas, ink text, the gold tower mark — with a calm message
// and a way home. Display only: no logging, no behavior.

export const metadata: Metadata = {
  title: 'Page not found — Aurum',
};

export default function NotFound() {
  return (
    <div className="aurum-notfound">
      <style>{`
        .aurum-notfound {
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
        .aurum-notfound-mark {
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
        .aurum-notfound-title {
          margin: 6px 0 0;
          font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
          font-weight: 600;
          font-size: 28px;
          letter-spacing: -0.01em;
        }
        .aurum-notfound-text {
          margin: 0;
          max-width: 34em;
          color: #69625d;
          font-size: 15px;
          line-height: 1.6;
        }
        .aurum-notfound-home {
          display: inline-block;
          margin-top: 8px;
          padding: 10px 22px;
          border-radius: 999px;
          background: #d9952a;
          color: #fdfaf6;
          font-weight: 600;
          font-size: 14px;
          text-decoration: none;
        }
        .aurum-notfound-home:hover {
          background: #b87d20;
        }
        .aurum-notfound-home:focus-visible {
          outline: 2px solid #d9952a;
          outline-offset: 2px;
        }
      `}</style>
      <div className="aurum-notfound-mark" aria-hidden="true">
        A
      </div>
      <h1 className="aurum-notfound-title">This page doesn’t exist</h1>
      <p className="aurum-notfound-text">
        It may have moved, or the link that brought you here may be out of
        date. Everything else is where you left it.
      </p>
      <Link className="aurum-notfound-home" href="/">
        Back to Aurum
      </Link>
    </div>
  );
}
