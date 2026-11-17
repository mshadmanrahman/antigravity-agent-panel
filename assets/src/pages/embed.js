// Embeds the real HUD or panel and optionally clicks its controls once data has rendered.
// Usage: embed(iframe, {click: ['hud-expand'], ready: fn})
// Polls the frame instead of waiting for 'load', which can fire before this script runs.
window.embed = (frame, opts = {}) => {
  const wait = () => {
    const doc = frame.contentDocument;
    const ready = doc && doc.querySelector('.hud-crew .hero-sprite, .agent-row');
    if (!ready) return setTimeout(wait, 50);
    (opts.click || []).forEach((id) => doc.getElementById(id)?.click());
    setTimeout(() => {
      opts.ready?.(doc);
      document.body.dataset.ready = '1';
    }, 200);
  };
  wait();
};
