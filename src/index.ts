interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Arquivo.pt MCP — full-text search over the Portuguese web archive.
 *
 * Keyless proxy over the Arquivo.pt text-search API (https://arquivo.pt/textsearch).
 * Arquivo.pt (run by FCCN, the Portuguese NREN) has preserved the Portuguese
 * web since 1996 and, unlike the Internet Archive's Wayback Machine, indexes
 * the FULL TEXT of what it captured — so a caller who does not know the URL
 * can find archived pages by phrase. Three tools:
 *
 *   arquivo_search_pages  — full-text search by terms/phrase → archived pages
 *   arquivo_url_history   — every preserved capture of a URL, newest first
 *   arquivo_page_text     — the extracted plain text of one archived capture
 *
 * Every response carries `data_as_of` (when we asked) and `source` (the exact
 * upstream URL). A transport or parse failure throws a LOUD error naming the
 * upstream and its HTTP status; a genuine zero-hit search answers
 * `found:false` with the estimated count and a hint, never a bare empty list.
 *
 * API reference: https://github.com/arquivo/pwa-technologies/wiki/Arquivo.pt-API
 */


const UA = 'pipeworx-mcp-arquivo-pt/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Arquivo.pt';
const TEXTSEARCH = 'https://arquivo.pt/textsearch';
const TEXTEXTRACTED = 'https://arquivo.pt/textextracted';

/** Full-text hits are capped by the upstream at 500 per query (wiki). */
const MAX_ITEMS = 200;

// Measured 2026-10-08 (laptop and a live Worker): a full-text query or a
// text-extract takes 30-35 s at Arquivo.pt end to end, regardless of query
// size; the URL-history lookup takes ~6 s. 25 s (the shared default) timed
// out two of three smoke calls, so the bound is 60 s — the same shape as
// bioportal/bindingdb (45 s), sized to what the upstream actually does.
const FETCH_TIMEOUT_MS = 60_000;

// Plain `application/json`. Arquivo.pt answered the same query from two
// visibly different backends on 2026-10-08 — one at 30-37 s per call (older
// `AWP*` collection ids, occasional 500 after 61 s, and the empty-items 200
// that getJson() guards against) and one at 1-6 s (`FAWP*` ids, a `hostKey`
// field). The switch did not track any request header we sent — the same
// headers got both behaviours minutes apart — so the bound above and the
// guard below are what carry the pack, not this header.
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM, FETCH_TIMEOUT_MS);
}

/* ───────────────────────── tool definitions ───────────────────────── */

const tools: McpToolExport['tools'] = [
  {
    name: 'arquivo_search_pages',
    description:
      'Full-text search of archived web pages in Arquivo.pt, the Portuguese web archive (captures since 1996), when the URL is unknown. Finds pages whose TEXT contains the given terms or a quoted phrase and returns, per hit, the page title, original URL, capture date, a text snippet with the matching terms, the archived (replay) URL, and links to the extracted text and a screenshot. Coverage: centred on the Portuguese web (.pt sites and Portuguese-language pages) but international English-language sites that Portuguese pages link to are captured too — probes for "climate change", "quantum computing" and "Federal Reserve interest rates" return roughly 50M, 1M and 2M estimated hits, with ipcc.ch, microsoft.com and federalreserve.gov among the top results. The full-text index lags the crawl by years (probed 2026-10: most hits end in 2020, a few reach 2023) while arquivo_url_history carries current captures, so use that for anything recent at a known URL. Supports a date window (YYYY or YYYYMMDD), restricting to one site, restricting to a file type (pdf, html, doc), exclusion with a leading minus (Albert -Einstein), and paging by offset. Do not pass a URL as the query; use arquivo_url_history for that.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Search terms. Quote a phrase for an exact match ("inteligência artificial"); prefix a term with - to exclude it. Portuguese or English both work. Must not be a URL.',
        },
        from: { type: 'string', description: 'Earliest capture date, as YYYY, YYYYMMDD or YYYYMMDDhhmmss. Default 1996.' },
        to: { type: 'string', description: 'Latest capture date, as YYYY, YYYYMMDD or YYYYMMDDhhmmss. Omit it unless you need a window; the full-text index lags the crawl by years.' },
        site: { type: 'string', description: 'Restrict hits to one site, e.g. "publico.pt" or "http://www.publico.pt".' },
        type: { type: 'string', description: 'Restrict to a file type by MIME subtype: pdf, html, doc, xls, ppt, rtf, ps.' },
        limit: { type: 'number', description: `Hits to return (default 10, max ${MAX_ITEMS}).` },
        offset: { type: 'number', description: 'Hit offset for paging (default 0). The response carries next_offset when more hits exist.' },
        per_site: {
          type: 'number',
          description: 'Maximum hits per site, to spread results across sources (default 2 — the upstream default). Raise it to see more captures of the same site.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'arquivo_url_history',
    description:
      'List every preserved capture of a specific URL in Arquivo.pt, the Portuguese web archive, newest first — the version history of a page or domain from 1996 to the current crawl. Each capture carries the capture timestamp (UTC), the archived replay URL, the crawl HTTP status, MIME type, content length and content digest, plus links to the extracted text, the raw original file and a screenshot. Accepts a bare domain (publico.pt), a host (www.publico.pt) or a full URL with path and query. Use this to see how a Portuguese page changed over time or to find the capture timestamp to pass to arquivo_page_text; use arquivo_search_pages when you only know words from the page, not its address.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL whose captures to list: "publico.pt", "www.sapo.pt" or "https://www.publico.pt/politica".' },
        from: { type: 'string', description: 'Earliest capture date, as YYYY, YYYYMMDD or YYYYMMDDhhmmss.' },
        to: { type: 'string', description: 'Latest capture date, as YYYY, YYYYMMDD or YYYYMMDDhhmmss.' },
        limit: { type: 'number', description: `Captures to return (default 20, max ${MAX_ITEMS}).` },
        offset: { type: 'number', description: 'Capture offset for paging (default 0).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'arquivo_page_text',
    description:
      'Read the extracted plain text of one archived page capture held by Arquivo.pt, the Portuguese web archive — the page content with HTML stripped, as the archive indexed it. Takes the original URL and the capture timestamp (YYYYMMDDhhmmss) that arquivo_search_pages or arquivo_url_history returned, and returns the text (optionally truncated to max_chars) with the archived replay URL. Use it to quote or summarise what a Portuguese page said on a given date without fetching the archived HTML.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The original URL exactly as returned in original_url, e.g. "http://www.appia.pt/".' },
        timestamp: { type: 'string', description: 'Capture timestamp as YYYYMMDDhhmmss, e.g. "20120121210152" (the captured_at_ts of a hit).' },
        max_chars: { type: 'number', description: 'Truncate the text to this many characters (default 20000, max 200000).' },
      },
      required: ['url', 'timestamp'],
    },
  },
];

/* ───────────────────────── upstream shapes ───────────────────────── */

interface ArquivoItem {
  title?: string;
  originalURL?: string;
  linkToArchive?: string;
  tstamp?: string;
  contentLength?: number | string;
  digest?: string;
  mimeType?: string;
  encoding?: string;
  date?: string;
  linkToScreenshot?: string;
  linkToNoFrame?: string;
  linkToExtractedText?: string;
  linkToMetadata?: string;
  linkToOriginalFile?: string;
  snippet?: string;
  collection?: string;
  statusCode?: number | string;
}

interface ArquivoResponse {
  serviceName?: string;
  next_page?: string;
  previous_page?: string;
  estimated_nr_results?: number | string;
  total_items?: number | string;
  request_parameters?: Record<string, unknown>;
  response_items?: ArquivoItem[];
}

/* ───────────────────────── helpers ───────────────────────── */

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} is required and must be a non-empty string`);
  return v.trim();
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function optInt(args: Record<string, unknown>, key: string, dflt: number, min: number, max: number): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Arquivo.pt dates are YYYY, YYYYMM, YYYYMMDD or YYYYMMDDhhmmss (digits only). */
function normDate(v: string | undefined, key: string): string | undefined {
  if (v === undefined) return undefined;
  const d = v.replace(/[-:T\s]/g, '');
  if (!/^\d{4}(\d{2}(\d{2}(\d{2}(\d{2}(\d{2})?)?)?)?)?$/.test(d)) {
    throw new Error(`${key} must be a date as YYYY, YYYYMMDD or YYYYMMDDhhmmss, got "${v}"`);
  }
  return d;
}

/** 20120121210152 → 2012-01-21T21:01:52Z. Non-14-digit stamps are returned unchanged. */
function stampToIso(ts: string | undefined): string | null {
  if (!ts) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return ts;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

function num(v: number | string | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Latin-1 named entities — snippets come back as `Intelig&ecirc;ncia`, and
 *  the handful of entities the shared stripper knows about are not enough
 *  for Portuguese. Numeric references are decoded generically. */
const LATIN1: Record<string, string> = {
  nbsp: ' ', iexcl: '¡', cent: '¢', pound: '£', curren: '¤', yen: '¥', brvbar: '¦', sect: '§', uml: '¨', copy: '©',
  ordf: 'ª', laquo: '«', not: '¬', shy: '', reg: '®', macr: '¯', deg: '°', plusmn: '±', sup2: '²', sup3: '³',
  acute: '´', micro: 'µ', para: '¶', middot: '·', cedil: '¸', sup1: '¹', ordm: 'º', raquo: '»', frac14: '¼',
  frac12: '½', frac34: '¾', iquest: '¿', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î',
  Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', times: '×',
  Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ', szlig: 'ß', agrave: 'à',
  aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é',
  ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò',
  oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', divide: '÷', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û',
  uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', euro: '€', trade: '™', bull: '•',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name: string) => (name in LATIN1 ? LATIN1[name] : m));
}

function safeChar(cp: number): string {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

/** Snippet HTML → plain text; `<em>` highlights are kept as the terms themselves. */
export function snippetToText(html: string | undefined): string | null {
  if (!html) return null;
  const text = decodeEntities(html.replace(/<span class="ellipsis">\s*\.\.\.\s*<\/span>/g, ' … ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/**
 * GET the text-search endpoint and parse it; LOUD on anything but a JSON 2xx.
 *
 * Also LOUD on the two silent failures this upstream actually produces, both
 * measured from a live Cloudflare Worker on 2026-10-08 while a laptop got
 * real hits for the identical URL:
 *
 *   1. a 200 whose `estimated_nr_results` is in the millions but whose
 *      `response_items` is `[]`;
 *   2. a 200 whose `response_items` is `[{}, {}, {}]` — the right COUNT of
 *      rows, every one an empty object (429-439 bytes; `request_parameters`
 *      carries `titleMaxLength`/`snippetMaxLength`, which the healthy
 *      responses do not — a different index node). Cache-busting params,
 *      an explicit `fields` list and the `www.` host all returned the same
 *      empties; a quoted phrase for the same words answered correctly.
 *
 * Arquivo.pt load-balances across index nodes that disagree, so the call is
 * retried once with `maxItems` nudged (a different request, possibly a
 * different node); if it repeats, the caller gets an error that names the
 * fault rather than a page of `null` hits that reads as "nothing found".
 */
async function getJson(url: URL): Promise<ArquivoResponse> {
  const first = await getJsonOnce(url);
  const why1 = silentFault(first);
  if (!why1) return first;
  const retry = new URL(url);
  const n = Number(retry.searchParams.get('maxItems') ?? '0');
  if (n > 0) retry.searchParams.set('maxItems', String(Math.min(n + 1, 500)));
  const second = await getJsonOnce(retry);
  const why2 = silentFault(second);
  if (!why2) return second;
  throw new Error(
    `${UPSTREAM} answered HTTP 200 twice with ${why2} (estimated_nr_results=${second.estimated_nr_results}) — an index-node fault upstream, not a no-match. Retry shortly; a quoted phrase ("…") often reaches a healthy node.`,
  );
}

/** A row that carries neither a URL nor an archive link is not a hit. */
function malformedItem(it: ArquivoItem): boolean {
  return !it || typeof it !== 'object' || (!it.originalURL && !it.linkToArchive && !it.tstamp);
}

/** Names the silent-fault class a response falls in, or null when it is sound. */
function silentFault(d: ArquivoResponse): string | null {
  const items = d.response_items ?? [];
  const est = num(d.estimated_nr_results) ?? 0;
  const offset = num(d.request_parameters?.offset as number | string | undefined) ?? 0;
  if (items.length === 0) return est > 0 && offset < est ? 'an empty response_items list' : null;
  if (items.every(malformedItem)) return `${items.length} response_items rows that are empty objects (no title, URL or timestamp)`;
  return null;
}

async function getJsonOnce(url: URL): Promise<ArquivoResponse> {
  const res = await pwFetch(url);
  const body = await res.text();
  if (!res.ok) {
    const detail = upstreamMessage(body);
    throw new Error(`${UPSTREAM} returned HTTP ${res.status} for ${url.pathname}${detail ? `: ${detail}` : ''}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `${UPSTREAM} returned HTTP ${res.status} but the body is not JSON (${body.length} bytes, starts "${body.slice(0, 80).replace(/\s+/g, ' ')}")`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ArquivoResponse).response_items)) {
    throw new Error(`${UPSTREAM} returned HTTP ${res.status} JSON without a response_items array — the API shape changed`);
  }
  return parsed as ArquivoResponse;
}

function upstreamMessage(body: string): string | null {
  try {
    const j = JSON.parse(body) as { message?: unknown };
    if (typeof j.message === 'string') return j.message;
  } catch {
    /* not JSON */
  }
  const t = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 160) : null;
}

function shapeHit(it: ArquivoItem) {
  return {
    title: it.title ?? null,
    original_url: it.originalURL ?? null,
    captured_at: stampToIso(it.tstamp),
    captured_at_ts: it.tstamp ?? null,
    archived_url: it.linkToArchive ?? null,
    archived_url_noframe: it.linkToNoFrame ?? null,
    original_file_url: it.linkToOriginalFile ?? null,
    extracted_text_url: it.linkToExtractedText ?? null,
    screenshot_url: it.linkToScreenshot ?? null,
    mime_type: it.mimeType ?? null,
    content_length: num(it.contentLength),
    digest: it.digest ?? null,
    collection: it.collection ?? null,
  };
}

/* ───────────────────────── tools ───────────────────────── */

async function searchPages(args: Record<string, unknown>) {
  const query = reqStr(args, 'query');
  if (/^(https?:\/\/|www\.)/i.test(query)) {
    throw new Error('query looks like a URL — Arquivo.pt rejects URLs in a text search (HTTP 400); use arquivo_url_history for a URL');
  }
  const limit = optInt(args, 'limit', 10, 1, MAX_ITEMS);
  const offset = optInt(args, 'offset', 0, 0, 100_000);
  const perSite = optInt(args, 'per_site', 2, 1, MAX_ITEMS);
  const from = normDate(optStr(args, 'from'), 'from');
  // `to` is only sent when the caller gives one. The upstream default is the
  // previous calendar year, which already covers the whole full-text index
  // (it ends in 2020-12, probed 2026-10-08) — and a `to` at "now" made the
  // same query return ZERO items from a live Worker while the estimated count
  // stayed at 3.8M (probed twice, 2026-10-08), so forcing it is a silent loss.
  const to = normDate(optStr(args, 'to'), 'to');
  const site = optStr(args, 'site');
  const type = optStr(args, 'type');

  const url = new URL(TEXTSEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('maxItems', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('dedupValue', String(perSite));
  url.searchParams.set('dedupField', 'site');
  url.searchParams.set('prettyPrint', 'false');
  if (from) url.searchParams.set('from', from);
  if (to) url.searchParams.set('to', to);
  if (site) url.searchParams.set('siteSearch', site);
  if (type) url.searchParams.set('type', type.replace(/^\./, '').toLowerCase());

  const data = await getJson(url);
  const all = data.response_items ?? [];
  // Some index nodes ignore maxItems (9 rows for maxItems=5, measured
  // 2026-10-08) and the retry above asks for one extra on purpose; cap here.
  const sound = all.filter((it) => !malformedItem(it));
  const dropped = all.length - sound.length;
  const items = sound.slice(0, limit);
  const estimated = num(data.estimated_nr_results) ?? items.length;
  const hits = items.map((it) => ({ ...shapeHit(it), snippet: snippetToText(it.snippet) }));
  const base = {
    source: url.toString(),
    data_as_of: new Date().toISOString(),
    archive: 'Arquivo.pt — the Portuguese web archive (FCCN), captures since 1996',
    query,
    from: from ?? '1996',
    to: to ?? null,
    site: site ?? null,
    type: type ?? null,
    estimated_total: estimated,
    offset,
    limit,
  };
  if (hits.length === 0) {
    return {
      ...base,
      found: false,
      count: 0,
      hits: [],
      reason: 'no_match',
      hint:
        'No indexed page text matched. The full-text index lags the crawl by years and is centred on the Portuguese web: try fewer or Portuguese terms, quote the phrase, drop the site/type filter, widen from/to, or use arquivo_url_history if you know the URL.',
    };
  }
  return {
    ...base,
    found: true,
    count: hits.length,
    next_offset: data.next_page ? offset + hits.length : null,
    ...(dropped > 0 ? { dropped_malformed_rows: dropped } : {}),
    hits,
  };
}

async function urlHistory(args: Record<string, unknown>) {
  const target = reqStr(args, 'url');
  const limit = optInt(args, 'limit', 20, 1, MAX_ITEMS);
  const offset = optInt(args, 'offset', 0, 0, 100_000);
  const from = normDate(optStr(args, 'from'), 'from');
  const to = normDate(optStr(args, 'to'), 'to');

  const url = new URL(TEXTSEARCH);
  url.searchParams.set('versionHistory', target);
  url.searchParams.set('maxItems', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('prettyPrint', 'false');
  if (from) url.searchParams.set('from', from);
  if (to) url.searchParams.set('to', to);

  const data = await getJson(url);
  const items = (data.response_items ?? []).filter((it) => !malformedItem(it)).slice(0, limit);
  const total = num(data.total_items) ?? num(data.estimated_nr_results) ?? items.length;
  const captures = items.map((it) => ({ ...shapeHit(it), crawl_status: num(it.statusCode) }));
  const base = {
    source: url.toString(),
    data_as_of: new Date().toISOString(),
    archive: 'Arquivo.pt — the Portuguese web archive (FCCN), captures since 1996',
    url: target,
    from: from ?? null,
    to: to ?? null,
    total_captures: total,
    offset,
    limit,
  };
  if (captures.length === 0) {
    return {
      ...base,
      found: false,
      count: 0,
      captures: [],
      reason: 'no_captures',
      hint: 'Arquivo.pt holds no capture of that URL in the window. Try the bare domain, add or drop "www.", or widen from/to. The Internet Archive (pack wayback) may hold it instead.',
    };
  }
  return {
    ...base,
    found: true,
    count: captures.length,
    newest: captures[0].captured_at,
    oldest: captures[captures.length - 1].captured_at,
    next_offset: data.next_page ? offset + captures.length : null,
    captures,
  };
}

async function pageText(args: Record<string, unknown>) {
  const target = reqStr(args, 'url');
  const ts = reqStr(args, 'timestamp').replace(/\D/g, '');
  if (!/^\d{14}$/.test(ts)) throw new Error(`timestamp must be a 14-digit capture stamp (YYYYMMDDhhmmss), got "${args.timestamp}"`);
  const maxChars = optInt(args, 'max_chars', 20_000, 200, 200_000);

  const url = new URL(TEXTEXTRACTED);
  url.searchParams.set('m', `${target}/${ts}`);
  const res = await pwFetch(url);
  const body = await res.text();
  if (res.status === 404) {
    return {
      source: url.toString(),
      data_as_of: new Date().toISOString(),
      url: target,
      timestamp: ts,
      found: false,
      reason: 'capture_not_found',
      hint: `Arquivo.pt has no capture of exactly that URL at ${ts}. Pass original_url and captured_at_ts from an arquivo_url_history or arquivo_search_pages hit verbatim (the URL must match byte-for-byte, including the trailing slash).`,
      upstream_message: upstreamMessage(body),
    };
  }
  if (!res.ok) {
    const detail = upstreamMessage(body);
    throw new Error(`${UPSTREAM} returned HTTP ${res.status} for /textextracted${detail ? `: ${detail}` : ''}`);
  }
  const text = body.replace(/\s+/g, ' ').trim();
  const truncated = text.length > maxChars;
  return {
    source: url.toString(),
    data_as_of: new Date().toISOString(),
    url: target,
    timestamp: ts,
    captured_at: stampToIso(ts),
    archived_url: `https://arquivo.pt/wayback/${ts}/${target}`,
    found: text.length > 0,
    chars: text.length,
    truncated,
    text: truncated ? text.slice(0, maxChars) : text,
    ...(text.length === 0
      ? { reason: 'empty_text', hint: 'The capture exists but Arquivo.pt extracted no text from it (binary or empty page). Read archived_url instead.' }
      : {}),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'arquivo_search_pages':
      return searchPages(args);
    case 'arquivo_url_history':
      return urlHistory(args);
    case 'arquivo_page_text':
      return pageText(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
