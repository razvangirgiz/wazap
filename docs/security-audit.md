# Security audit: client isolation and network boundaries

This is a scoped source review and local regression test effort, not a complete
security audit or a production penetration test. WhatsApp is stubbed; no messages
were sent to the linked account, and no public listener was exposed.

## 1. HTTP session ownership — fixed

Previously each request was authenticated, but its `mcp-session-id` selected a
transport without checking the credential that initialized it. A read token,
another write token, or an anonymous reader (when enabled) could use a write
session if it obtained its id. GET and DELETE were affected too. The tests do
not demonstrate a way to steal a session id.

Sessions now bind to a SHA-256 fingerprint of the exact bearer credential and
its effective read/write permission. Foreign credentials receive 404 and cannot
touch the session's idle timeout or transport. Every request still authenticates:
expired/revoked tokens receive 401. OAuth token rotation requires reinitializing.
The session registry and lifecycle live in `src/http-sessions.ts`.

Regression tests: `test/session-isolation.test.mjs`, `test/oauth.test.mjs`, and
existing lifecycle tests in `test/daemon.test.mjs`. Ten of the eleven initial
static-token regression cases failed before the fix.

## 2. Cross-client draft confirmation — fixed

Previously any write client could confirm an account's draft given its id,
even from its own independently authenticated session. The same flaw reproduced
through two actual stdio bridge processes attached to a stub daemon. All ten
initial draft isolation regression cases failed before the fix.

Each `registerTools` invocation now creates an opaque symbol, kept server-side.
Every outgoing draft records that owner and its resolved account. Before account
resolution or send-policy lookup, `confirm_send` checks ownership and rejects a
conflicting explicit account. Foreign and unknown draft ids return
`DRAFT_NOT_FOUND` without revealing the recipient/policy or consuming the draft.
An owned draft is resolved through its recorded account, not caller-provided
routing hints. Existing live allow/deny checks still run before sending.

The scope is deliberately **MCP session**, not bearer credential:

- Text, media, polls, locations and forwards all use the same ownership path.
- Each stdio server and each bridge upstream session has a distinct owner.
- A resumed authenticated session keeps its drafts.
- A new initialize, session eviction, or OAuth token rotation requires a new
  draft and fresh user approval. Drafts are not transferred to the new session.
- Failed sends remain retryable by the owner according to the existing service
  behavior. Ownership does not extend the service's 15-minute expiry.
- Successful confirmation removes the owner metadata; replay is rejected.

`src/tool-runtime.ts` now owns tool registration/execution, annotations, account
routing, error conversion and process-wide per-tool rate buckets. It is created
once for the tool catalogue; reinitializing does not reset the rate budget.
`src/tools.ts` retains the schemas and handlers, exporting the existing public
registration and error helper names for compatibility.

Tests in `test/draft-isolation.test.mjs` exercise all five draft kinds, explicit
account overrides, service-created unowned drafts, retries, expiry, replay,
independent HTTP sessions (same and different tokens), new versus resumed
sessions, two real stdio bridge subprocesses, and shared rate budgets. All use
local fixtures; outbound WhatsApp operations are stubbed.

## 3. HTTP/OAuth logs and media errors — hardened

The first HTTP regression run reproduced query-string logging and arbitrary
filesystem access (seven of eight initial cases failed). `req.originalUrl`
previously exposed OAuth state/query values; raw RPC/Accept fields could inject
log text. Express's default error handler could also print malformed JSON body
excerpts. These are now handled by `src/http-log.ts`: allowlisted route/RPC names,
normalized Accept formats, bounded printable labels, and generic parser errors.
The same rules apply when a client closes before a response. Arbitrary route
paths are logged as `/other`; their contents never enter the log.

OAuth registration/consent labels are sanitized, and unreadable OAuth state no
longer prints JSON parser excerpts. Media-fetch failures no longer include signed
URLs or arbitrary resolver/request error details. HTTP status and timeout remain
useful diagnostics. User-Agent and OAuth client labels remain diagnostic metadata:
control-character filtering does not remove secrets deliberately placed in them.
This is not a guarantee that every third-party dependency or proxy log is safe.

## 4. Remote filesystem access — restricted

An HTTP write token previously allowed selecting any local file as outgoing
media or a profile/group picture; even read clients could choose an arbitrary
`download_media.save_to` directory. Tests use a synthetic private file and stub
WhatsApp operations to demonstrate access without transmitting anything.

HTTP sessions now reject `file_path` and `save_to` before account lookup or any
filesystem call. This applies to static tokens and OAuth, even when the peer is
loopback. Public URLs, forwarding, and default-directory downloads remain
available. Remote tools advertise this restriction. No public setting or tool
argument overrides it.

Local stdio retains intentional file access. The generated private daemon token
is explicitly marked with a local-files capability so stdio bridges keep working;
public read/write tokens and OAuth grants never inherit it. This private token
must not be distributed to remote clients. Its file capability participates in
session ownership along with read/write permission and credential identity.

The existing SSRF protections passed added tests for alternate loopback forms,
mixed public/private DNS answers, pinned socket lookup and chunked size caps.
Existing redirect/private-peer tests also pass. Untrusted MIME subtypes are now
restricted to a short alphanumeric download extension; previously backslashes
could enter generated filenames (path separators on Windows). Tests reproduce
that filename issue, not a live Windows exploit.

## 5. Cross-account write preflight — hardened

A write-enabled account makes write tools visible for the session. The final
WhatsApp write gate already rejected a read-only target account, but draft
creation and some media preflight work ran before that check. This pass does
**not** demonstrate unauthorized WhatsApp transmission from a read-only account.

`src/tool-runtime.ts` now checks the resolved account's configured/effective
read-only policy before executing any write handler. An implicit chat match
cannot borrow another account's write permission. An owned draft is not consumed
while its account is read-only. Existing account resolution, disabled-account
checks, and service-level write gates remain in place. This does not implement
live policy reload or per-client account ACLs.

Tests cover all non-confirm write registrations with operation traps, actual
stub-backed service preflight, implicit routing, retained reads and owned draft
confirmation. The effective-policy change in the confirmation test is a test
fixture, not a promise that editing config on disk is applied without restart.

## 6. OAuth proxy identity and audience — hardened

Previously all loopback, link-local and private peers were treated as trusted
proxies. A separate `CF-Connecting-IP` fallback could also select the password
lockout identity independently of Express's rate limiter. Header-only tests
reproduced rotating lockout identities; no live tunnel was attacked.

`WAZAP_TRUST_PROXY` now names only trusted proxy IPs/CIDRs (default loopback;
`none` disables forwarded identity). Broad automatic private-network trust and
the CF-header fallback are removed. All limiters derive identity from Express's
configured X-Forwarded-For chain. Tests cover ignored headers with no trusted
proxy, CF-only spoofing, a chain ending in an untrusted private client, and a
legitimate local proxy separating two public callers. Input validation is in
`src/proxy-trust.ts` and the setting is documented in `.env.example`.

Deployment requirement: the trusted ingress must sanitize or replace untrusted
forwarded headers and name its actual peer. Trusting a loopback proxy does not
magically make a client-provided header truthful. Docker proxies not on loopback
need their explicit address; CF-only deployments must provide a trusted XFF
chain or accept a shared proxy identity. No deployed configuration was changed.

OAuth now rejects a supplied resource different from its configured `/mcp` URL
at authorization, code exchange and refresh; omission stays compatible with
older clients. Refresh requests with any ungranted scope are rejected rather
than silently intersected (the previous behavior did not elevate scopes).
Access tokens now expire at, rather than just after, the exact expiry instant.

Additional tests confirm existing client binding for codes/refresh tokens,
redirect mismatch rejection without consuming the valid code, revocation by a
foreign client leaving the grant intact, and metadata independent of forwarded
Host/scheme. Nine initial regression tests failed before this step's fixes.

## 7. Webhooks and transcription endpoints — hardened

A local two-listener regression reproduced OpenAI-compatible transcription
following 301/302/303/307/308 redirects to another endpoint. In particular,
307/308 preserve the multipart upload; cross-origin fetch normally strips
Authorization, so this is not a claim that every redirect leaks the API key.
Transcription now refuses all redirects, including same-origin ones. Operators
must configure the final base endpoint. These URLs are trusted operator
configuration, not arbitrary media URLs supplied by MCP clients, and intentionally
support local/private providers. The public-media SSRF policy is not applied to
them.

Provider error excerpts and transport exception messages could carry private
content or secret-bearing URLs even after literal API-key redaction. Errors now
retain only status/category/fix. Successful JSON is bounded to 1 MiB of actual
streamed bytes, independently of Content-Length, and malformed/absent text is a
typed, generic failure. Null JSON previously escaped as a TypeError. Response
reading/cancellation is isolated in `src/http-response.ts`; ignored error bodies
are cancelled rather than buffered. Existing one-retry behavior and request
timeouts remain in place.

Webhook redirects were already refused. Webhook responses are now cancelled on
success as well as failure to release unread streams; retries, HMAC signing and
queue limits remain unchanged. Generic transport/build failures no longer echo
raw exception text into logs, status or persisted failure counters. Host/status
remain available for diagnosis. URL validators no longer quote invalid input;
userinfo credentials and fragments are rejected. Webhook query tokens remain
supported, whereas transcription base URLs reject queries because appending the
API path to a query-bearing base is ambiguous. Transcription readiness shows the
host rather than the full potentially secret-bearing path.

## 8. Automatic previews and decoder subprocesses — hardened

Baileys implicitly fetches a page and potentially its thumbnail when generating
text messages, even with `generateHighQualityLinkPreview: false`. This bypasses
wazap's `safe-media` path and uses dependency-specific network/logging behavior.
A stub callback in the real Baileys message generator reproduced invocation for
send, confirm and edit, without making external requests. The initial fix passed
`linkPreview: null`, disabling new previews. The controlled implementation below
now supplies an explicit card or null instead; the dependency's fetcher remains
disabled in both cases. Forwarding may retain an already embedded preview without
a new page fetch. This test proves an implicit network-capable code path, not a
live SSRF exploit.

`src/media-process.ts` centralizes ffmpeg input restrictions for video previews,
GIF conversion and local transcription: only the file protocol and an explicit
media-demuxer allowlist, excluding playlists/image sequences. GIF conversion
forces the GIF demuxer. Raw decoder stderr/JSON-parser excerpts are omitted from
errors. Outgoing video thumbnails use the same restricted preview path and
explicitly suppress Baileys's shell-spawned, unrestricted ffmpeg fallback, even
when no frame can be made.

Tests inspect actual child-process arguments using synthetic executables and
exercise real ffmpeg on generated video/audio and malicious playlist fixtures.
Those playlist fixtures were already rejected by this machine's ffmpeg before
the change; this restriction is defense in depth, not a demonstrated local-file
exfiltration fix. The allowlist is not an OS-level sandbox or a guarantee against
codec vulnerabilities, all secondary local-file references, or resource abuse.
Photo decoding remains local with its existing resolution/memory limits.

Twenty-four of the initial thirty-one network/preview regression cases failed
before the fixes. Additional tests cover understated Content-Length, real regular
media compatibility and the no-thumbnail fallback through Baileys's actual media
preparation with a stub uploader. No audio, messages or credentials from the real
account were used. Model downloads were inspected as a separate CLI-operated
path with curated upstream URLs and no account payload/API credential; their
CDN redirects remain intentionally enabled.

## 9. Controlled link previews — restored

`src/link-preview.ts` fetches only the first explicit HTTP(S) link in sent/edited
text, never during MCP draft creation or before the service's write gate. It
uses `publicMedia` independently for the page and optional thumbnail. Both paths
validate every DNS answer, pin the socket lookup and check the connected peer;
redirects are revalidated, limited to three per resource, and cannot downgrade
HTTPS. The shared media helper now also rejects non-success final HTTP statuses.

Limits: 256 KiB HTML, 2 MiB image, one shared four-second network budget and four
concurrent previews without a queue. A bounded metadata scanner reads common
OG/Twitter/title fields, ignoring scripts, styles, embeds and base/canonical hints.
Relative images resolve against the validated final page URL. There is no browser,
JavaScript, cookie jar, credential header, Referer, URL logging or cross-message
cache. The configured sites can observe requests and the server's public IP.

Only JPEG thumbnails are currently decoded, with 4 MP/32 MiB decoder limits and
a 200-pixel maximum edge. Other formats, decoder failures, unsafe images or image
timeouts leave a text-only card. Failure to obtain valid page metadata leaves the
message without a card. The dependency receives bytes, never an image URL to fetch.
These are bounded best-effort previews, not a full HTML renderer or codec sandbox.

`test/link-preview.test.mjs` uses synthetic DNS/HTTP streams and JPEG fixtures for
success, metadata precedence, private/mixed DNS, pinned lookup, private socket
peers, page/image redirects, downgrade refusals, resource caps, JPEG pixel bombs,
timeouts, a shared deadline and concurrency overflow. Service tests confirm both
explicit card/null behavior through Baileys's real generator, no preview during
drafting, and no preview on a refused read-only write. No live sites or WhatsApp
accounts were queried for this feature.

## 10. Model download streams and write lifecycle — hardened

The shared model downloader previously checked size only after consuming and
writing the entire response. Synthetic oversized streams reproduced unbounded
progress beyond the pinned model size. Injected disk failures under backpressure
could terminate the process with an unhandled stream error or leave it waiting
for a drain that would never arrive. A final write error could also be swallowed
by the completion handler. No real disk was filled and no model was downloaded
from an external service for these reproducers.

The implementation now lives in `src/model-download.ts`. Whisper's model table
keeps compatibility exports; embedding downloads import the shared helper
without loading transcription providers and retain their `RECALL_FAILED` code
and command-specific fix. The model tables, URLs and pinned digests are unchanged.

- A transform checks each chunk against the remaining expected bytes before
  forwarding it to the file writer; progress cannot exceed that size.
- Oversized/invalid Content-Length is rejected early, but actual streamed bytes
  are always counted independently. Identity encoding is requested; compressed
  responses are refused. A 206 must match the complete expected range, including
  start, end and total, even on an unsolicited partial response.
- `pipeline` owns backpressure, stream errors and closure. Publication by rename
  occurs only after pipeline success, exact byte count and SHA-256 verification.
- The network/write phase has a 30-minute total deadline and a 30-second idle
  deadline, including response-header waits. Caller cancellation also applies
  during local prefix/cache hashing. Timers and abort listeners are cleaned up.
- Interruptions/timeouts keep a bounded prefix; invalid ranges, 416, overflow
  and verification mismatches remove the partial file. A server ignoring Range
  restarts cleanly. Unused responses are cancelled on failure.
- Errors retain HTTP status, controlled categories and allowlisted disk error
  codes, never raw reason phrases, Content-Range values, signed URL exceptions
  or caller abort reasons. Invalid options/pre-aborted calls fail before changing
  files or making requests; directories are not mistaken for absent files.

All 20 initial regression cases failed on the old implementation; additional
coverage brings this step to 34 tests in `test/model-download.test.mjs`. They cover
fresh/resumed overflow, dishonest lengths/ranges, prefix reuse after cancellation,
header/body/active-transfer timeouts, child-isolated ENOSPC/EACCES/final EIO
injection, encoding refusal, callbacks, CDN redirect compatibility, and embedding
error mapping. Existing verification/cache/resume tests also pass.

Scope: this bounds each invocation's writes and coordinates its streams. The
cross-process follow-up is below. Filesystem crash durability and protection from
hostile-local file replacement remain outside this pass. Local hashing before
the transfer uses caller cancellation, not the network timer.

## 11. Concurrent model downloads — coordinated

`src/model-download-lock.ts` acquires an atomic, per-destination lock directory
before reading a cache hit, deleting an invalid model, hashing/resuming a partial
file or making HTTP requests. The downloader uses the canonical parent directory
for both the lock and model I/O, so relative and directory-symlink aliases cannot
bypass exclusion. Another caller fails promptly rather than joining an unbounded
queue. Different destination files remain independent.

The directory contains one uniquely named ownership record, with a PID, start
time and host/PID scope but no request URL or credentials. Linux scope includes
the PID namespace; unavailable namespace identity disables automatic reclamation.
Directory/file creation modes are 0700/0600. Release is idempotent and happens
after stream cancellation/closure and invalid-part cleanup, including cached
hits, errors and caller cancellation. Embedding error mapping preserves lock
recovery instructions rather than replacing them with a generic retry command.

There is no age-based lease expiry. A live or inconclusively probed PID (including
EPERM) is never evicted. For a known dead owner in the same scope, successful
unlink of that generation's unique ownership filename grants the right to remove
the now-empty directory. Among competing reclaimers, only one unlink can succeed;
losers never remove the directory. An old releaser also cannot unlink a successor's
record. Cleanup is never recursive and a symlink at the lock path is not followed.

Unknown/empty/malformed/foreign-scope claims fail closed. A crash between lock
creation and record writing, or between record removal and directory removal,
can require manual recovery. Operators must confirm no downloader is using the
model before removing only its lock directory. PID reuse may conservatively
require a retry/manual check. These are cooperative, same-host locks, not a
distributed-filesystem protocol or protection against another local process that
can maliciously alter the data directory; pre-upgrade downloaders must be stopped.

Nine of eleven initial lock regression cases failed before implementation.
`test/model-download-lock.test.mjs` now has 19 cases, including real child-process
contention, killed-owner recovery with multiple contenders, distinct destinations,
path aliases, stale timestamps, private records, ambiguous owners, inconclusive
PID probes, idempotent/foreign cleanup, and embedding error guidance. The workers
use synthetic IPC-controlled fetch streams, not live HTTP or model services.
Existing downloader tests also assert lock removal across success/error paths.
The lock suite passed five additional consecutive runs after the full gate.

## Limits and next review areas

- A shared static token is a shared identity. A caller with both the owner's
  credential and session id can impersonate that session. Session-scoped drafts
  do not turn shared credentials into a hostile-client security boundary.
- Account data and account-wide policies remain shared. There are no per-client
  account ACLs; do not describe this server as multi-tenant isolation.
- Draft/confirm is not independent proof of human consent. An agent authorized
  to call both tools can perform both; stronger approval requires a trusted UI
  or harness outside incoming message content.
- Validate real proxy/tunnel deployments and sanitized header chains separately.
  Continue reviewing request/session abuse limits, refresh-token lifecycle,
  policy-file corruption/removal behavior and retention of deleted/disappearing
  messages.
- Local stdio and private bridges are trusted with the filesystem. This pass does
  not sandbox them or address all local file replacement/symlink races.
- This pass covers the identified webhook, preview and transcription paths, not
  every dependency, reverse-proxy log or decoder resource budget. Local embedding
  service traffic needs its own review. Model downloads now have byte/time bounds
  and cooperative same-host exclusion, but hostile-local filesystem races and
  distributed coordination remain outside the guarantees.
  Existing historical logs/persisted diagnostics are not retroactively scrubbed.
- Further decomposition of `src/whatsapp.ts` should follow lifecycle, history and
  outgoing-operation boundaries, after characterization tests, not a wholesale
  rewrite.

## Verification

`npm run check` passed on the pulled 0.20.2 base after the model-download changes:
lint, typecheck and all 1,219 tests (none skipped on this machine), including the
controlled-preview and concurrent-download follow-ups. New coverage lives in
`test/model-download-lock.test.mjs`, `test/model-download.test.mjs`,
`test/link-preview.test.mjs`,
`test/network-sinks.test.mjs` and `test/preview-security.test.mjs`, alongside
the previous account, OAuth, proxy, log, media and session tests. Real ffmpeg
fixtures are conditional on its availability in other environments.
These tests do not validate the real WhatsApp network, live public DNS behavior,
every hosted MCP client's reconnection behavior or a Windows deployment.

No release or deployment has been performed. The pre-existing `.gitignore`
change is untouched. This report is under `docs/` because `tickets/` is ignored
in this working tree; the first-pass ticket remains only a local artifact.
