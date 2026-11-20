// The demo page: renders the widget against a configurable API, says plainly whether that API
// can be reached, and shows the widget's events ("what the server sees"). No dependencies, no
// cookies, no third-party requests. Settings come from the address (?api=&sitekey=&lang=&theme=)
// or, by default, from the <meta name="bc-demo-*"> tags written by demo/build.mjs.

(() => {
  const $ = (id) => document.getElementById(id);
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? '';
  const params = new URLSearchParams(location.search);
  const LANGS = ['en', 'be', 'be-Latn', 'ru'];
  const THEMES = ['auto', 'light', 'dark'];

  /** An http(s) URL without a trailing slash, or the fallback. */
  function cleanUrl(value, fallback) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return fallback;
      return u.href.replace(/\/+$/, '');
    } catch {
      return fallback;
    }
  }

  const settings = {
    api: cleanUrl(params.get('api') ?? '', cleanUrl(meta('bc-demo-api'), '')),
    sitekey: params.get('sitekey') || meta('bc-demo-sitekey'),
    lang: LANGS.includes(params.get('lang')) ? params.get('lang') : 'en',
    theme: THEMES.includes(params.get('theme')) ? params.get('theme') : 'auto',
  };

  $('set-api').value = settings.api;
  $('set-sitekey').value = settings.sitekey;
  $('set-lang').value = settings.lang;
  $('set-theme').value = settings.theme;
  $('api-url').textContent = settings.api || '(none)';

  // --- API reachability -------------------------------------------------------------------
  // /healthz sends no CORS headers, so the probe is a no-cors request: it resolves (opaquely)
  // when the server answers at all and rejects when it cannot be reached.
  const banner = $('api-status');
  const bannerText = $('api-status-text');
  let apiDown = false;

  function showDown(reason) {
    if (apiDown) return;
    apiDown = true;
    banner.dataset.state = 'down';
    banner.setAttribute('role', 'alert');
    bannerText.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = 'The demo API cannot be reached. ';
    const code = document.createElement('code');
    code.textContent = settings.api || '(no API URL set)';
    bannerText.append(
      strong,
      code,
      ` ${reason} The widget below cannot load a question until an API is running there. ` +
        'The public demo API may not be deployed yet: set another API base URL in Settings.',
    );
  }

  function showUp() {
    if (apiDown) return;
    banner.dataset.state = 'ok';
    bannerText.textContent = '';
    const code = document.createElement('code');
    code.textContent = settings.api;
    bannerText.append('Connected to ', code, '.');
  }

  async function probe() {
    if (!settings.api) return showDown('No API base URL is configured.');
    try {
      await fetch(`${settings.api}/healthz`, {
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(8000),
      });
      return true;
    } catch {
      showDown('It did not answer.');
      return false;
    }
  }

  // --- events panel -------------------------------------------------------------------------
  const events = $('events');
  function log(title, detail) {
    const li = document.createElement('li');
    const b = document.createElement('strong');
    b.textContent = `${new Date().toLocaleTimeString()} ${title}: `;
    li.append(b, detail);
    events.prepend(li);
    while (events.children.length > 20) events.lastElementChild.remove();
  }

  /** The pass token's payload (kid.payload.mac; the payload is base64url JSON, signed, not encrypted). */
  function tokenPayload(token) {
    try {
      const b64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return '(not readable)';
    }
  }

  // --- the widget ---------------------------------------------------------------------------
  const host = $('captcha');
  host.dataset.theme = settings.theme;
  host.addEventListener('bc-challenge', (e) => {
    const d = e.detail;
    showUp();
    log(
      'challenge',
      `${d.type}, ${d.questions} question(s), PoW maxnumber ${d.maxnumber}, sealed ${d.sealed.length} characters (${d.sealed.slice(0, 24)}…), expires ${new Date(d.expires).toLocaleTimeString()}`,
    );
  });
  host.addEventListener('bc-solved', (e) => {
    log('solved', `PoW took ${e.detail.powMs} ms; token payload ${tokenPayload(e.detail.token)}`);
  });
  host.addEventListener('bc-rejected', (e) => log('rejected', e.detail.error));
  host.addEventListener('bc-error', (e) => {
    log('error', e.detail.error);
    if (e.detail.error === 'network-error') showDown('A request from the widget failed.');
  });

  probe().then((up) => {
    if (!up || !window.belarusianCaptcha) return;
    window.belarusianCaptcha.render(host, {
      sitekey: settings.sitekey,
      api: settings.api,
      lang: settings.lang,
      theme: settings.theme,
      action: 'demo',
    });
  });

  // --- the demo form ------------------------------------------------------------------------
  $('demo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const out = $('submit-result');
    const token = new FormData(e.currentTarget).get('bc-response');
    out.textContent = token
      ? `The form would post bc-response = ${token.slice(0, 32)}… Your backend now calls siteverify with its secret; the token works once, within its lifetime.`
      : 'No pass token yet: answer the question first.';
  });
})();
