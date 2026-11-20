# widget

The browser widget (docs/DESIGN.md section 6): vanilla TypeScript, no runtime dependencies,
Shadow DOM, the ALTCHA-compatible proof-of-work in a Web Worker.

```bash
npm run build:widget      # from the root: esbuild + the size budget check
```

| File | What |
| --- | --- |
| `dist/widget.js` | classic script (IIFE): sets `window.belarusianCaptcha`, renders every `.belarusian-captcha[data-sitekey]` |
| `dist/widget.mjs` | ES module for bundlers: `render`, `renderAll`, `reset`, `getResponse`, `remove`, `CaptchaWidget` |
| `dist/widget.worker.js` | the PoW worker |
| `dist/sri.json` | sizes and `sha384` SRI hashes of the three files |

Size (measured on this branch, esbuild 0.28.2, gzip level 9): `widget.js` 13.9 kB raw,
**5.7 kB gzipped**; the worker 0.8 kB raw, 0.5 kB gzipped. The build fails over 25 kB gzipped for
the widget or 5 kB for the worker.

## Embed

```html
<script src="https://captcha.example.org/widget.js" async defer
        integrity="sha384-…" crossorigin="anonymous"></script>
<form method="post" action="/comment">
  <div class="belarusian-captcha" data-sitekey="your-site-key" data-lang="en"></div>
  <button>Send</button>
</form>
```

The widget adds `<input type="hidden" name="bc-response">` to the form; the site's backend sends
its value to `POST /api/v1/siteverify` with the secret.

| Attribute | Option | Default |
| --- | --- | --- |
| `data-sitekey` | `sitekey` | required |
| `data-api` | `api` | the origin `widget.js` was loaded from |
| `data-lang` | `lang`: `be`, `be-Latn`, `ru`, `en` (interface only) | `be` |
| `data-script` | `script` | the site's (server side) |
| `data-theme` | `theme`: `light`, `dark`, `auto` | `auto` |
| `data-action` | `action`, bound into the token | none |
| `data-types` | `types` | the site's |
| `data-callback` | `callback(token)` | none |
| `data-expired-callback` | `expiredCallback()` | none |
| `data-error-callback` | `errorCallback(code)` | none |
| `data-worker` | `workerUrl` | `widget.worker.js` next to the script |

`data-*-callback` name global functions. Error codes are the API's (`invalid-sitekey`,
`rate-limited`, `hostname-mismatch`, ...) plus `network-error` (the API cannot be reached),
`bad-response` and `pow-failed`. The host element also receives `bc-challenge`, `bc-solved`,
`bc-rejected`, `bc-error` and `bc-expired` events (`CustomEvent`, not bubbling).

## The worker and the page's origin

A Web Worker script must be **same-origin with the page**. When `widget.js` is served from the
captcha API's origin and the site is elsewhere, `new Worker()` throws, so the widget runs the same
search on the main thread in slices of 500 hashes (yielding between slices). The same fallback
covers a worker that fails to load (404, a CSP without `worker-src`). To keep the work off the
main thread, serve `widget.js` and `widget.worker.js` from the site's own origin, or set
`data-worker` to a same-origin copy.

## Accessibility

- A labelled `group`; each question is a `radiogroup` named by its prompt (`lang="be"`).
- Keyboard: Tab enters the group, arrow keys, Home and End move, Space or Enter picks. A pick
  submits once every question has one.
- One `role="status"` `aria-live="polite"` region for loading, checking, done, wrong and errors;
  nothing is announced on page load, and focus never moves on load.
- Focus stays inside the widget when the options it was on are replaced.
- `prefers-reduced-motion` stops the spinner; `forced-colors` uses system colours.
- Interface strings missing in a language fall back to English with `lang="en"` on that element.

**Non-visual alternative (section 6.3, D3).** The proverb challenge is plain text and works with a
screen reader as is (option C). **TODO (D3 option B):** the "I cannot do this challenge" link for
a PoW-only, low-score pass needs `GET /api/v1/fallback` and `fallback: true` in `siteverify`,
which the server does not have yet; the widget adds the link together with that endpoint.

## Strings

`src/i18n/*.json`. `en` is complete. `be` holds only the three status strings quoted in the
design (section 6.2), copied verbatim; `be-Latn` and `ru` are empty. Native-speaker strings are
reviewed like content (D5); until then every missing key shows the English string.
