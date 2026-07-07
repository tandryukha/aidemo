import { chromium } from "playwright";

/**
 * The classic arrow pointer, shared by both cursor render paths so they look
 * identical: the record-time BAKED cursor (cursorInitScript, injected into the
 * page) and the compose-time OVERLAY cursor (renderCursorPng, rasterized and
 * overlaid by compose when a storyboard opts into `cursor` control). 24x24
 * viewBox; the visual tip sits near (5,2). Fill white, dark stroke, soft shadow.
 */
export const CURSOR_ARROW_PATH = "M5 2 L5 20 L10 15 L13 22 L16 21 L13 14 L20 14 Z";
const CURSOR_FILL = "#ffffff";
const CURSOR_STROKE = "#111111";

/**
 * Rasterize the arrow pointer to a transparent PNG for the compose-time cursor
 * overlay (see src/cursor-overlay.ts). Same trick as the card/caption renderers:
 * headless Chrome screenshots an SVG so the overlay pointer matches the baked
 * one. The arrow is drawn in the top-left of a padded canvas (room for the drop
 * shadow) with its tip at ~(5,2) — the same anchor as the baked cursor, so the
 * overlay lands where the baked cursor would have. `sizePx` is the rendered
 * width/height in output pixels (24 logical units * pxScale * cursor scale).
 */
export async function renderCursorPng(
  outPath: string,
  sizePx: number
): Promise<void> {
  // Logical canvas is 32 units (24 arrow + shadow headroom); scale to sizePx.
  const LOGICAL = 32;
  const dsf = Math.max(1, sizePx / LOGICAL);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: LOGICAL, height: LOGICAL },
    deviceScaleFactor: dsf,
  });
  const page = await context.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;}
        svg{position:absolute;left:0;top:0;
          filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));}
      </style></head><body>
        <svg width="${LOGICAL}" height="${LOGICAL}" viewBox="0 0 ${LOGICAL} ${LOGICAL}"
             xmlns="http://www.w3.org/2000/svg">
          <path d="${CURSOR_ARROW_PATH}" fill="${CURSOR_FILL}"
            stroke="${CURSOR_STROKE}" stroke-width="1.3" stroke-linejoin="round"/>
        </svg>
      </body></html>`,
      { waitUntil: "load" }
    );
    await page.screenshot({ path: outPath, omitBackground: true });
  } finally {
    await browser.close();
  }
}

/**
 * Injected into every frame (main page + widget iframes) via addInitScript.
 * Playwright's built-in video does not capture the OS cursor and its mouse moves
 * teleport, so we render our own cursor: an SVG pointer that follows mousemove
 * events (which our eased player emits as many small steps) and pulses a ripple
 * on mousedown. Each frame renders its own cursor; only the one under the
 * pointer is visible at a time, so there is no double-cursor.
 *
 * This is the DEFAULT (baked) path. A storyboard with a `cursor` block skips
 * this injection and draws the cursor at compose time instead (renderCursorPng
 * + src/cursor-overlay.ts), so hide/resize is a recompose, not a re-record.
 */
export function cursorInitScript(): string {
  // Serialized as a string so it runs in the page context with no closure deps.
  return `(() => {
    if (window.__aidemoCursor) return;
    window.__aidemoCursor = true;

    const NS = 'http://www.w3.org/2000/svg';
    const style = document.createElement('style');
    style.textContent = \`
      .__aidemo-cursor{position:fixed;left:0;top:0;width:24px;height:24px;
        z-index:2147483647;pointer-events:none;opacity:0;
        transition:opacity .15s ease;will-change:transform;
        filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));}
      .__aidemo-ripple{position:fixed;left:0;top:0;width:14px;height:14px;
        margin:-7px 0 0 -7px;border-radius:50%;
        background:rgba(56,132,255,.45);z-index:2147483646;pointer-events:none;
        transform:scale(.2);opacity:.9;}
      @keyframes __aidemo-ripple-anim{
        from{transform:scale(.2);opacity:.9}
        to{transform:scale(2.6);opacity:0}}
    \`;
    const mount = () => {
      if (!document.documentElement) return;
      document.documentElement.appendChild(style);

      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', '__aidemo-cursor');
      svg.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS(NS, 'path');
      // Classic arrow pointer (shared with the compose-time overlay).
      path.setAttribute('d', '${CURSOR_ARROW_PATH}');
      path.setAttribute('fill', '${CURSOR_FILL}');
      path.setAttribute('stroke', '${CURSOR_STROKE}');
      path.setAttribute('stroke-width', '1.3');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      document.documentElement.appendChild(svg);

      let x = window.innerWidth / 2, y = window.innerHeight / 2;
      const place = () => { svg.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
      place();

      window.addEventListener('mousemove', (e) => {
        x = e.clientX; y = e.clientY;
        svg.style.opacity = '1';
        place();
      }, true);

      window.addEventListener('mousedown', (e) => {
        const r = document.createElement('div');
        r.className = '__aidemo-ripple';
        r.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px) scale(.2)';
        r.style.animation = '__aidemo-ripple-anim .5s ease-out forwards';
        // account for the -7px margin by translating to the point
        r.style.left = e.clientX + 'px';
        r.style.top = e.clientY + 'px';
        r.style.transform = 'scale(.2)';
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 550);
      }, true);
    };

    if (document.documentElement) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  })();`;
}
