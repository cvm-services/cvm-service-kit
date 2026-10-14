#!/usr/bin/env python3
"""capture_page.py -- the read-only browser leg of the jlc-quote service.

WHAT THIS REUSES, AND WHAT IT DELIBERATELY DOES NOT
---------------------------------------------------
The wrapped project (`jlcpcb-service`, pinned at 62c63c7) already solved the
expensive parts of this: launch the persistent Chrome profile with the right
`executable_path`, prove the session is authenticated, navigate the quote SPA,
attach the gerber zip, and poll until the quote renders. This script calls those
primitives -- `browser`, `_goto`, `AUTH_MARKER`, `_upload`, `_wait_for_quote`,
`_snapshot`, and the selectors module -- so the browser flow is NOT re-derived.

It deliberately does NOT let `parse_quote_text` decide anything. It reports the
raw evidence plus the wrapped client's own reading, and the caller
(`parse.ts`, in TypeScript, under test) decides:

  raw_text           the rendered page text, verbatim -- the evidence
  client_price_usd   the wrapped client's own price reading, or null
  url                where the capture came from

The client's reader takes "the first `$` after the `Calculated Price` label",
which on a real capture returned $4.00 for a board priced $32.30 and, on another,
$30.00 for a shipping row that rendered no amount at all. So its number is
reported as EVIDENCE for a cross-check, never as the answer.

Contract with the caller (stdout is one JSON object, always, exit 0):

  {"raw_text": str, "url": str, "authenticated": bool, "session_message": str,
   "client_price_usd": num|null, "client_error": str, "error": str}

A failure of the browser leg itself is reported in "error" and still exits 0,
because the caller's job is to turn that into a VISIBLE refusal -- a crash that
prints a traceback is a silent failure wearing a stack trace.

READ-ONLY: it uploads a gerber zip and reads the quote. It never places an order.
No credential value is ever printed, logged, or returned by this script.
"""

import json
import os
import sys


def main(argv):
    zip_path = os.path.abspath(argv[1]) if len(argv) > 1 else ""
    snapshot_dir = argv[2] if len(argv) > 2 and argv[2] else None

    out = {
        "raw_text": "",
        "url": "",
        "authenticated": False,
        "session_message": "",
        "client_price_usd": None,
        "client_error": "",
        "error": "",
    }

    try:
        from jlcpcb_client import selectors
        from jlcpcb_client.errors import JlcError, SessionError
        from jlcpcb_client.quote import _body_text, _snapshot, _upload, _wait_for_quote
        from jlcpcb_client.session import _goto, browser
    except Exception as e:  # the import environment is wrong, not the board
        out["error"] = "import failed: %s: %s" % (type(e).__name__, e)
        print(json.dumps(out))
        return 0

    if not zip_path or not os.path.isfile(zip_path):
        out["error"] = "gerber zip not found: %r" % (zip_path,)
        print(json.dumps(out))
        return 0

    try:
        with browser() as page:
            _goto(page, selectors.HOME_URL, settle=12.0)
            home_text = _body_text(page)
            out["url"] = getattr(page, "url", "")
            out["authenticated"] = selectors.AUTH_MARKER in home_text
            if not out["authenticated"]:
                # Keep the evidence that produced this verdict.
                out["raw_text"] = home_text
                out["session_message"] = (
                    "profile is not authenticated (header does not render "
                    "'%s')" % selectors.AUTH_MARKER
                )
                print(json.dumps(out))
                return 0

            _goto(page, selectors.QUOTE_URL, settle=18.0)
            out["url"] = getattr(page, "url", "")
            _upload(page, zip_path)
            text = _wait_for_quote(page)
            out["raw_text"] = text
            if snapshot_dir:
                try:
                    _snapshot(snapshot_dir, zip_path, text, page)
                except Exception:
                    pass
    except SessionError as e:
        out["session_message"] = str(e)
    except JlcError as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
    except Exception as e:  # a dead X server, a missing Chrome, a gone profile
        out["error"] = "%s: %s" % (type(e).__name__, e)

    # A second, independent reading of the SAME evidence: the wrapped client's
    # own parser. Reported for cross-check only (see the module docstring).
    if out["raw_text"]:
        try:
            from jlcpcb_client.parse import parse_quote_text

            out["client_price_usd"] = parse_quote_text(out["raw_text"]).pcb_price_usd
        except Exception as e:
            out["client_error"] = "%s: %s" % (type(e).__name__, e)

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
