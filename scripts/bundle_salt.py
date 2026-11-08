"""
scripts/bundle_salt.py  -  the one place the bundle HMAC salt is read and checked.

generate_bundle_manifest.py and watermark_pdf.py both sign with ASSET_SALT. Both import this module, so
the refusal rule cannot drift between them. It fails closed: a missing, blank, or short salt would make
the provenance signature forgeable.
"""

import os

MIN_SALT_CHARS = 32


def fingerprint_salt() -> bytes:
    """Returns the bundle HMAC salt from ASSET_SALT. Raises RuntimeError unless it is non-blank, at least MIN_SALT_CHARS
    long, and encodable as UTF-8. Every failure is a RuntimeError: callers map it to one usage error, never a traceback."""
    salt = os.environ.get("ASSET_SALT", "")
    if not salt.strip() or len(salt) < MIN_SALT_CHARS:
        raise RuntimeError(
            f"ASSET_SALT is not set, blank, or shorter than {MIN_SALT_CHARS} characters; refusing to sign with a weak salt"
        )
    try:
        return salt.encode("utf-8")
    except UnicodeEncodeError:
        # os.environ keeps undecodable bytes as surrogates, which UTF-8 cannot encode.
        raise RuntimeError("ASSET_SALT contains bytes that are not valid UTF-8; refusing to sign with a weak salt") from None
