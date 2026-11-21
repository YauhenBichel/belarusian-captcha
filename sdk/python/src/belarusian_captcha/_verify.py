"""verify(): one POST to /api/v1/siteverify with urllib.

The secret goes only into the request body. It is never logged, never put in an exception or a
result, and never sent after a redirect.
"""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Any, NoReturn

DEFAULT_TIMEOUT = 3.0
"""Seconds. The same 3 s default as the Node SDK."""

MAX_TOKEN_LENGTH = 4096
_MAX_BODY = 64 * 1024
_SITEVERIFY_PATH = "/api/v1/siteverify"


@dataclass(frozen=True)
class VerifyResult:
    """What :func:`verify` found.

    ``success`` is true only if the token is valid, unspent, for this site and at or above
    ``min_score`` - or, with ``fail_open=True``, when the API could not be asked
    (``unavailable`` is then true).

    ``error_codes`` holds the API's codes (``timeout-or-duplicate``, ``invalid-secret``,
    ``rate-limited``, ...) or one the SDK adds itself: ``captcha-unavailable`` (the API could not
    be reached, timed out, answered 5xx or something that is not a siteverify answer) and
    ``score-below-threshold``.

    ``score``, ``hostname``, ``action``, ``challenge_ts`` and ``fallback`` are ``None`` unless the
    API accepted the token. ``fallback`` is true when the visitor took the accessible way through
    ("I cannot do this challenge"): no question answered, only a harder proof-of-work, score 0.3.
    """

    success: bool
    error_codes: list[str] = field(default_factory=list)
    unavailable: bool = False
    score: float | None = None
    hostname: str | None = None
    action: str | None = None
    challenge_ts: str | None = None
    fallback: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        """The result as a dict with the absent fields left out (the Node SDK's shape)."""
        return {k: v for k, v in asdict(self).items() if v is not None}


def verify(
    token: str | None,
    *,
    secret: str,
    url: str,
    remoteip: str | None = None,
    sitekey: str | None = None,
    action: str | None = None,
    min_score: float | None = None,
    fail_open: bool = False,
    timeout: float = DEFAULT_TIMEOUT,
) -> VerifyResult:
    """Check a pass token (the ``bc-response`` form field) with the captcha API.

    :param token: the ``bc-response`` value posted with the form.
    :param secret: the site's secret key. Keep it in the environment, never in code.
    :param url: base URL of the captcha API, e.g. ``https://captcha.example.by`` (no ``/api/v1``).
    :param remoteip: the visitor's IP, forwarded to the API.
    :param sitekey: if given, the token must have been issued for this site key.
    :param action: if given, the token's action must equal it (checked by the API before the
        token is spent).
    :param min_score: lowest accepted score, 0..1; a lower score gives ``success=False``.
    :param fail_open: what to answer when the API is unavailable: ``False`` (the default) refuses
        the form; ``True`` lets it through with ``unavailable=True`` so the site can send it to
        moderation.
    :param timeout: seconds, default 3. It bounds connecting and every wait for data, and reading
        the answer stops once it has passed. Name resolution is not covered (urllib cannot bound
        it), and an API that sends its answer a few bytes at a time can take up to about twice
        as long.

    Never raises because of the visitor or the network: a bad token, a refusal, a timeout or a
    broken API all come back as a result. Raises ``ValueError`` only for wrong options (no secret,
    a URL that is not a plain http(s) base URL, ``min_score`` outside 0..1, a timeout that is not
    a positive number), which are bugs in the calling code.
    """
    endpoint = _check_options(secret, url, min_score, timeout)
    if not isinstance(token, str) or token == "" or len(token) > MAX_TOKEN_LENGTH:
        return _refused(["invalid-input-response"])

    body: dict[str, str] = {"secret": secret, "response": token}
    if remoteip is not None:
        body["remoteip"] = remoteip
    if sitekey is not None:
        body["sitekey"] = sitekey
    if action is not None:
        body["action"] = action

    try:
        status, data = _post(endpoint, json.dumps(body).encode(), timeout)
    except Exception:  # noqa: BLE001 - any failure to get an answer is "unavailable"
        # Not chained or logged: the exception could carry parts of the request.
        return _unavailable(fail_open)

    # 5xx (including 503 store-unavailable) means the API could not decide: the fail-open /
    # fail-closed case. 2xx and 4xx such as 429 carry a real siteverify answer.
    if status >= 500 or not _is_siteverify_answer(data):
        return _unavailable(fail_open)

    if data["success"] is not True:
        codes = [c for c in data["error-codes"] if isinstance(c, str)]
        return _refused(codes or ["invalid-input-response"])

    score = data.get("score")
    result = VerifyResult(
        success=True,
        score=score if _is_number(score) else None,
        hostname=_str_or_none(data.get("hostname")),
        action=_str_or_none(data.get("action")),
        challenge_ts=_str_or_none(data.get("challenge_ts")),
        fallback=data.get("fallback") is True,
    )
    if min_score is not None and (result.score if result.score is not None else 0) < min_score:
        return VerifyResult(
            success=False,
            error_codes=["score-below-threshold"],
            score=result.score,
            hostname=result.hostname,
            action=result.action,
            challenge_ts=result.challenge_ts,
            fallback=result.fallback,
        )
    return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the secret to a URL the site did not configure."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> NoReturn:
        raise urllib.error.URLError("redirects are refused")


_opener = urllib.request.build_opener(_NoRedirect())


def _post(endpoint: str, payload: bytes, timeout: float) -> tuple[int, Any]:
    """POSTs and returns (status, parsed JSON or None). Raises on any network failure."""
    deadline = time.monotonic() + timeout
    req = urllib.request.Request(  # noqa: S310 - _check_options allows http and https only
        endpoint,
        data=payload,
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    try:
        resp = _opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as err:
        # 4xx and 5xx arrive as HTTPError; the body is still the API's answer.
        resp = err
    with resp:
        status = resp.status if resp.status is not None else 0
        raw = _read(resp, deadline)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def _read(resp: Any, deadline: float) -> bytes:
    """Reads the body, at most _MAX_BODY bytes and not past the deadline."""
    chunks: list[bytes] = []
    size = 0
    while True:
        if time.monotonic() > deadline:
            raise TimeoutError("siteverify took longer than the timeout")
        chunk = resp.read(8192)
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > _MAX_BODY:
            raise ValueError("siteverify answer too large")
        chunks.append(chunk)


def _check_options(secret: object, url: object, min_score: object, timeout: object) -> str:
    if not isinstance(secret, str) or secret == "":
        raise ValueError("belarusian-captcha: secret is required")
    if not isinstance(url, str):
        raise ValueError("belarusian-captcha: url must be an absolute http(s) URL")
    try:
        parts = urllib.parse.urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError for a bad port
    except ValueError:
        raise ValueError("belarusian-captcha: url must be an absolute http(s) URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("belarusian-captcha: url must be an absolute http(s) URL")
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise ValueError("belarusian-captcha: url must be a plain base URL")
    if min_score is not None and not (_is_number(min_score) and 0 <= min_score <= 1):  # type: ignore[operator]
        raise ValueError("belarusian-captcha: min_score must be between 0 and 1")
    if not (_is_number(timeout) and timeout > 0):  # type: ignore[operator]
        raise ValueError("belarusian-captcha: timeout must be a positive number of seconds")
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}{_SITEVERIFY_PATH}"


def _is_siteverify_answer(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and isinstance(data.get("success"), bool)
        and isinstance(data.get("error-codes"), list)
    )


def _is_number(v: object) -> bool:
    # bool is an int in Python; JSON true is not a score.
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _str_or_none(v: object) -> str | None:
    return v if isinstance(v, str) else None


def _refused(codes: list[str]) -> VerifyResult:
    return VerifyResult(success=False, error_codes=codes)


def _unavailable(fail_open: bool) -> VerifyResult:
    return VerifyResult(
        success=fail_open is True, error_codes=["captcha-unavailable"], unavailable=True
    )
