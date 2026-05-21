// Motion primitives for the Test Lab page.
// No deps. All helpers are idempotent and safe to call after dynamic renders.

// 1. Reveal-on-scroll via IntersectionObserver. Elements with `.fx-rise-in`
//    start hidden; once they enter the viewport, `.is-visible` is added and
//    the CSS transition does the rest. We unobserve after each fire so a fast
//    scroll doesn't trigger a re-animation.
export function initReveal(root = document) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-visible');
      io.unobserve(e.target);
    }
  }, { threshold: 0.08 });
  root.querySelectorAll('.fx-rise-in').forEach((el) => io.observe(el));
  return io;
}

// 2. One-time stagger applier — sets each `.fx-rise-in` child's transition-delay
//    based on its sibling index. Useful after we innerHTML-render a list.
export function applyStagger(parent, stepMs = 40) {
  if (!parent) return;
  parent.querySelectorAll('.fx-rise-in').forEach((el, i) => {
    el.style.transitionDelay = `${i * stepMs}ms`;
  });
}

// 3. Count-roll — animates a numeric span from a starting value to a target.
//    `el` is the span receiving textContent updates. Skips silently if `to` is
//    NaN (so we can keep dashes for empty data).
export function countRoll(el, from, to, durationMs = 600, decimals = 1) {
  if (!el || !Number.isFinite(to)) return;
  const start = performance.now();
  const range = to - from;
  function tick(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);   // ease-out-expo
    el.textContent = (from + range * eased).toFixed(decimals);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// 4. SVG path draw-in — uses stroke-dasharray/dashoffset so the line appears
//    to "draw" from start to end. Pair with `pathLength` if you need every
//    path to animate over the same duration regardless of true length.
export function drawPath(pathEl, durationMs = 900, delayMs = 0) {
  if (!pathEl) return;
  const len = pathEl.getTotalLength();
  pathEl.style.strokeDasharray = String(len);
  pathEl.style.strokeDashoffset = String(len);
  pathEl.style.transition = 'none';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      pathEl.style.transition =
        `stroke-dashoffset ${durationMs}ms cubic-bezier(0.16, 1, 0.3, 1) ${delayMs}ms`;
      pathEl.style.strokeDashoffset = '0';
    });
  });
}

// 5. Scatter point stagger — fades and scales in each circle from its own
//    centre. Used after re-rendering the Results chart.
export function animateScatterPoints(svgEl, stepMs = 40) {
  if (!svgEl) return;
  svgEl.querySelectorAll('circle.tl-pt-dot').forEach((c, i) => {
    const cx = c.getAttribute('cx');
    const cy = c.getAttribute('cy');
    c.style.transformOrigin = `${cx}px ${cy}px`;
    c.style.transform = 'scale(0)';
    c.style.opacity = '0';
    c.style.transition =
      `opacity 220ms ease-out ${i * stepMs}ms, transform 240ms cubic-bezier(0.34,1.26,0.64,1) ${i * stepMs}ms`;
    requestAnimationFrame(() => {
      c.style.opacity = '1';
      c.style.transform = 'scale(1)';
    });
  });
}

// 6. Flash a container — used to briefly highlight a status line when its
//    textContent changes (e.g. import-state).
export function flash(el) {
  if (!el) return;
  el.classList.remove('fx-flash');
  // Force reflow so removing then re-adding triggers the keyframe again.
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.classList.add('fx-flash');
}
