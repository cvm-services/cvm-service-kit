# Deploying cvm-jlc-quote

## T-classification: T2, paid/reseller — but for a different reason than money

This service holds no treasury and no payment rail. What it holds is a **live
authenticated session against a third-party account** (the persistent Chrome
profile with the JLCPCB login) and it drives a **headed browser** — i.e. it runs
code that can reach out and touch a remote SPA with someone's credentials. So it
belongs on its own host with a per-service sandbox, and **no interactive agent
session should run on that host**. The reusable CVM-host rule applies unchanged.

Per `cvm-service-development`: isolation fixes no code defect, and it does not
make an expired session quote honestly — the honesty invariants in `src/` do that.

## The non-obvious requirements

The `cvm_service` role installs a unit and `/etc/<name>/{config,secret}.env`; it
does not know about browsers. Three things must be provisioned on the host
**before** the service can honestly fulfil, or the tool will refuse
`adapter_error` (which is the correct, visible outcome — not a fabricated price):

1. **An X server.** The quote drives **headed** Chrome:
   `Xvfb :99 -screen 0 1400x1100x24`. Make it a unit with `WantedBy=multi-user.target`
   so the quote service can depend on it, and give the quote unit
   `After=`/`Requires=` it.
2. **Chrome, and the executable path.** Playwright's bundled Chromium is **not
   installed** for the venv used here; the launch must carry
   `executable_path=/usr/bin/google-chrome`. Set `JLC_CHROME` — this is not
   optional and the failure message names a `ms-playwright/chromium-*` path that
   does not exist.
3. **A persistent profile directory holding the JLCPCB session** (writable by the
   service user) and a way to re-login when it expires. The profile is a
   **credential-adjacent artifact**: `0700`, owned by the service user, never
   copied into the repo, never archived into CI logs. Expiry is *expected*, and
   the tool refuses `session_expired` when it happens.

Also: the wrapped client checkout (`jlcpcb-service` @ `62c63c7`, or a pinned
successor) must be present with its Playwright venv — this service's
`tools/capture_page.py` **imports its primitives** (`jlcpcb_client.session`,
`jlcpcb_client.quote`, `jlcpcb_client.selectors`). Pin the ref; do not track a
branch.

## Bringing it up

```bash
# 1. the kit's role installs the unit + env files (non-secret config in config.env)
ansible-playbook deploy/ansible/playbook-wrappers.yml -e cvm_service_name=cvm-jlc-quote \
  -e cvm_service_script=services/jlc-quote/src/server.ts \
  -e '{"cvm_service_config":{"JLC_DISPLAY":":99","JLC_CHROME":"/usr/bin/google-chrome","JLC_INPUT_DIR":"/srv/jlc-quote-inputs","JLC_PROFILE":"/var/lib/cvm-jlc-quote/chrome-profile","JLC_SNAPSHOT_DIR":"/var/lib/cvm-jlc-quote/snapshots","ANNOUNCE":"false","ANNOUNCE_D":"cvm-jlc-quote-01"}}'

# 2. prove the browser leg BEFORE announcing. A running service that cannot
#    quote must be invisible, not advertised.
curl -s localhost:<HEALTH_PORT>/health | jq .browser_leg

# 3. one real quote through the tool surface, and READ THE REFUSAL or the price.
#    An announced service that returns session_expired to everyone is a service
#    nobody can use; fix the profile first.

# 4. flip ANNOUNCE=true and restart; then verify the tags ACTUALLY on the relays
nak req -k 11316 -d cvm-jlc-quote-01 <relay> | jq '.tags'
```

## Announce-time checklist

- The published tag set must equal `ASSERTED_TAGS` in `src/announce.ts` — the
  emitter and the publisher are the same call, and `server.ts` re-validates with
  `assertAnnouncementTags` and **fails closed** before publishing. Read the tags
  back off a relay; do not trust the log line.
- **No `cvm:tier:*` tag, no `cap` tag, no `pmi` tag.** If one appears, the
  emitter was changed and invariant 4's counter-tests must have been weakened.
- `ANNOUNCE=false` is the default on purpose: advertising a tool that will refuse
  for everyone is worse than being invisible.

## What must never be in any tracked file, log line or tool response

The JLCPCB password, any session cookie, the profile's `Cookies` DB, or the
account email. The service passes the profile **path** only; a previously
recorded incident in this fleet was caused by echoing a credentials file into a
chat transcript, so print LENGTHS, never values.
