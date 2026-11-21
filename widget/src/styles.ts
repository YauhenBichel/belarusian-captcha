// The widget's styles, inside its Shadow DOM: the page's CSS cannot reach it and it cannot reach
// the page. Applied as a constructable stylesheet, so a strict CSP needs no 'unsafe-inline'.
// Themes: light, dark, and auto (prefers-color-scheme); prefers-reduced-motion stops the spinner;
// forced-colors uses the system colours.

export const CSS = `
:host{display:block;max-width:22rem;--bg:#fff;--fg:#1b1b1f;--muted:#5b5b66;--line:#c9c9d1;--accent:#0b57d0;--accent-bg:#e8f0fe;--ok:#146c2e;--err:#b3261e;color-scheme:light}
:host([data-theme="dark"]){--bg:#1e1f24;--fg:#ececf1;--muted:#a9a9b6;--line:#4a4b55;--accent:#a8c7fa;--accent-bg:#20324f;--ok:#7dd99a;--err:#f2b8b5;color-scheme:dark}
@media (prefers-color-scheme:dark){:host(:not([data-theme="light"]):not([data-theme="dark"])){--bg:#1e1f24;--fg:#ececf1;--muted:#a9a9b6;--line:#4a4b55;--accent:#a8c7fa;--accent-bg:#20324f;--ok:#7dd99a;--err:#f2b8b5;color-scheme:dark}}
.bc{box-sizing:border-box;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:.75rem}
.bc:focus{outline:none}
.title{font-weight:600;margin:0 0 .25rem}
.instr{margin:0 0 .5rem;color:var(--muted);font-size:.9em}
.q{margin:0 0 .5rem}
.prompt{margin:0 0 .35rem;font-weight:500}
.opt{display:flex;align-items:center;gap:.5rem;padding:.4rem .5rem;margin:.2rem 0;border:1px solid var(--line);border-radius:6px;cursor:pointer;user-select:none}
.opt::before{content:"";flex:none;width:.8rem;height:.8rem;border:2px solid var(--muted);border-radius:50%}
.opt[aria-checked="true"]{border-color:var(--accent);background:var(--accent-bg)}
.opt[aria-checked="true"]::before{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 2px var(--bg)}
.opt:hover{border-color:var(--accent)}
.opt:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.opt[aria-disabled="true"]{cursor:default;opacity:.7}
.status{min-height:1.4em;margin:.35rem 0 0;display:flex;align-items:center;gap:.4rem}
.status[data-kind="ok"]{color:var(--ok);font-weight:600}
.status[data-kind="error"]{color:var(--err)}
.spin{width:.9rem;height:.9rem;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:bc-spin .8s linear infinite}
@keyframes bc-spin{to{transform:rotate(360deg)}}
button{font:inherit;margin-top:.4rem;padding:.3rem .8rem;border:1px solid var(--accent);border-radius:6px;background:transparent;color:var(--accent);cursor:pointer}
button.alt{display:block;border:none;padding:.2rem 0;color:var(--muted);text-decoration:underline;font-size:.85em}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.spin{animation:none;border-top-color:var(--line)}}
@media (forced-colors:active){.bc,.opt{border-color:CanvasText}.opt[aria-checked="true"]{border:3px solid Highlight}.opt[aria-checked="true"]::before{background:Highlight;forced-color-adjust:none}}
`;

/** Constructable stylesheet where supported; a <style> element otherwise (old browsers). */
export function applyStyles(root: ShadowRoot): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.prepend(style);
  }
}
