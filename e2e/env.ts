// Ports, URLs and the test site of the end-to-end run (see sites.e2e.yaml).
export const API_PORT = 18081;
export const DEMO_PORT = 4173;
export const API = `http://127.0.0.1:${API_PORT}`;
export const DEMO = `http://127.0.0.1:${DEMO_PORT}`;
export const SITEKEY = 'e2e-sitekey-0001';
/** Low-entropy test secret; its SHA-256 is in sites.e2e.yaml. Not a real secret. */
export const SECRET = 'e2e-test-secret-not-real';
