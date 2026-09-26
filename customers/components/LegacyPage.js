'use client';
/* ============================================================
   LegacyPage — mounts one of the hand-built static pages
   ------------------------------------------------------------
   The booking-intake pages (root + intake-a…d) are kept as the
   original imperative HTML/CSS/JS, verbatim, per the port plan:
   physics, canvas, drag-select calendars etc. stay exactly as
   they were rather than being rewritten in React. This component
   just reproduces what a plain <script>/<link>-tag static page
   does: render the original body markup, then load the same
   stylesheets and scripts, in the same order, relative to the
   page's own URL (so `../shared/api.js` etc. resolve exactly as
   they did as static files).

   These pages are only ever left via a full navigation (plain
   <a href>, never next/link — see design.md) so there's no
   in-page singleton (rAF loop, window-level listeners) that needs
   tearing down on route change; only the injected <link>/<script>
   tags themselves are cleaned up.
   ============================================================ */
import { useEffect } from 'react';

function addLink(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
  return l;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false; // preserve execution order (api.js -> offers.js -> page script.js)
    s.onload = () => resolve(s);
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.body.appendChild(s);
    return s;
  });
}

export default function LegacyPage({ html, css = [], scripts = [], onBeforeScripts }) {
  useEffect(() => {
    let cancelled = false;
    const links = css.map(addLink);
    const injected = [];

    (async () => {
      if (onBeforeScripts) onBeforeScripts();
      for (const src of scripts) {
        if (cancelled) return;
        try {
          const s = await loadScript(src);
          injected.push(s);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(e);
        }
      }
    })();

    return () => {
      cancelled = true;
      links.forEach(l => l.remove());
      injected.forEach(s => s.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
