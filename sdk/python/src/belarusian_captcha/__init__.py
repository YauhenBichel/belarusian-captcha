"""Verify a belarusian-captcha pass token from your backend (docs/DESIGN.md section 6.4).

Standard library only. One call, ``POST /api/v1/siteverify``; the same result shape and failure
rules as the Node SDK (``sdk/node``), checked by the cases both share in
``tests/fixtures/siteverify.json``.
"""

from ._verify import DEFAULT_TIMEOUT, VerifyResult, verify

__all__ = ["DEFAULT_TIMEOUT", "VerifyResult", "verify"]
__version__ = "0.0.0"
