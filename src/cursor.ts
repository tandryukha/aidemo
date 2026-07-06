/**
 * Injected into every frame (main page + widget iframes) via addInitScript.
 * Playwright's built-in video does not capture the OS cursor and its mouse moves
 * teleport, so we render our own cursor: an SVG pointer that follows mousemove
 * events (which our eased player emits as many small steps) and pulses a ripple
 * on mousedown. Each frame renders its own cursor; only the one under the
 * pointer is visible at a time, so there is no double-cursor.
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
      // Classic arrow pointer.
      path.setAttribute('d', 'M5 2 L5 20 L10 15 L13 22 L16 21 L13 14 L20 14 Z');
      path.setAttribute('fill', '#ffffff');
      path.setAttribute('stroke', '#111111');
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
