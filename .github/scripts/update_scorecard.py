#!/usr/bin/env python3
"""Replace the generated block in scorecard.md with Tasker's public scorecard.

Reads SCORECARD_URL and SCORECARD_TOKEN from the environment. Any surprise in
the response stops the run with an error and leaves the file untouched, so a
bad fetch can never publish a blank or malformed scorecard.
"""

import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BEGIN = "<!-- scorecard:begin -->"
END = "<!-- scorecard:end -->"
HEADER = "| # | Request | Kind, origin | Status |"
MAX_BYTES = 500_000


def validate(body: str) -> str:
    """Return the trimmed scorecard, or raise ValueError."""
    text = body.strip()
    if not text.startswith(HEADER):
        raise ValueError("response does not start with the scorecard table")
    if "\n- Requests: " not in text or "\n- Live: " not in text:
        raise ValueError("response is missing the running numbers")
    # Titles are HTML-escaped by the server, so a raw "<" means something is wrong.
    if "<" in text:
        raise ValueError("response contains raw HTML")
    return text


def replace_block(document: str, generated: str) -> str:
    if document.count(BEGIN) != 1 or document.count(END) != 1:
        raise ValueError("scorecard.md must contain each marker exactly once")
    start = document.index(BEGIN) + len(BEGIN)
    end = document.index(END)
    if start > end:
        raise ValueError("scorecard markers are out of order")
    return f"{document[:start]}\n{generated}\n{document[end:]}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib would resend the Authorization header to a redirect's target."""

    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url: str, token: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "User-Agent": "agent-change-requests-scorecard"},
    )
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        content_type = response.headers.get("Content-Type", "")
        if response.status != 200 or not content_type.startswith("text/markdown"):
            raise ValueError(f"unexpected response: {response.status} {content_type}")
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("response is too large")
    return raw.decode("utf-8")


def main() -> int:
    url = os.environ.get("SCORECARD_URL", "").strip()
    token = os.environ.get("SCORECARD_TOKEN", "").strip()
    if not url.startswith("https://") or not token:
        print("SCORECARD_URL (https) and SCORECARD_TOKEN must be set.", file=sys.stderr)
        return 1
    path = Path("scorecard.md")
    try:
        generated = validate(fetch(url, token))
        updated = replace_block(path.read_text(encoding="utf-8"), generated)
    except urllib.error.HTTPError as error:
        print(f"Scorecard fetch failed: HTTP {error.code}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError, ValueError) as error:
        # A URLError can quote the host, which is kept out of public logs.
        reason = "network error" if isinstance(error, urllib.error.URLError) else error
        print(f"Scorecard update failed: {reason}", file=sys.stderr)
        return 1
    path.write_text(updated, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
