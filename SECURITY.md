# Security

belarusian-captcha is in phase 1: the code exists but nothing is released yet. This policy applies
to the `main` branch now and to every release from the first on. What the captcha protects and what
it leaves to the site is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Reporting a problem

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on the
Security tab of this repository, rather than in a public issue. You can expect an acknowledgement
within a week.

## What counts

- A pass token accepted twice, accepted for another site key or hostname, or accepted after expiry.
- The right answer to a challenge recoverable from what the browser receives.
- A forged or altered sealed challenge or token accepted by the server.
- A way around the proof-of-work or the rate limits that does not cost the work they are meant to cost.
- Injection through content (an item, a translation or an image) into the widget or the host page.
- Personal data (IP addresses, user agents, answers) written to logs or storage.

## What does not

A bot, an OCR engine, a language model or a solving service passing a challenge is **expected and
documented** (see [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)). Report it as a normal issue with the solve
rate you measured; it is a vulnerability only if it beats the published benchmark by a wide margin
through a flaw in this project rather than through a better model.

A wrong, ambiguous or offensive question is a content bug: open a normal issue with the item id.
