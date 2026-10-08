# @pipeworx/arquivo-pt

Full-text search of archived web pages in Arquivo.pt, the Portuguese web
archive run by FCCN (captures since 1996). Where the Internet Archive's
Wayback Machine (pack `wayback`) needs the URL, Arquivo.pt indexes the text
of what it captured, so a caller can find archived pages by phrase, then read
a capture's extracted text or list every preserved version of a URL.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1743+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `arquivo_search_pages(query, from?, to?, site?, type?, limit?, offset?, per_site?)`
  — full-text hits for terms or a quoted phrase: title, original URL, capture
  date, decoded snippet, archived replay URL, extracted-text and screenshot
  links, plus `estimated_total` and `next_offset`. Zero hits answer
  `found:false` with `reason:"no_match"` and a hint.
- `arquivo_url_history(url, from?, to?, limit?, offset?)` — every preserved
  capture of a domain, host or full URL, newest first, with capture timestamp,
  crawl HTTP status, MIME type, size, digest and replay links. Zero captures
  answer `found:false` with `reason:"no_captures"`.
- `arquivo_page_text(url, timestamp, max_chars?)` — the plain text Arquivo.pt
  extracted from one capture (`original_url` + `captured_at_ts` of a hit).
  A capture that does not exist answers `found:false, reason:"capture_not_found"`.

Every response carries `source` (the exact upstream URL) and `data_as_of`.
A transport failure, a non-JSON body or a changed response shape throws a loud
error naming Arquivo.pt and the HTTP status — never an empty list.

## Auth

Keyless.

## Coverage, honestly

- Centred on the Portuguese web (`.pt` sites and Portuguese-language pages),
  but international pages linked from them are captured too. Probed 2026-10-08:
  "climate change" ≈ 52-53M estimated hits (academia.edu, eea.europa.eu,
  ipcc.ch), "quantum computing" ≈ 0.8-1.1M (techtarget.com, microsoft.com,
  en.wikipedia.org), "Federal Reserve interest rates" ≈ 1.8-1.9M
  (federalreserve.gov, vox.com). The estimate varies by index node. English
  queries work; the top hits skew to pages Portuguese sites cite.
- **The full-text index lags the crawl by years.** Probed 2026-10-08, a
  search restricted to `from=2022` returns 0 hits on most calls, one node
  answered with 2023 captures, and `arquivo_url_history` lists captures from
  mid-2026. Use the URL history for anything recent.
- **Arquivo.pt load-balances across index nodes that disagree.** From a live
  Cloudflare Worker on 2026-10-08 the same URL returned, minutes apart: real
  hits in 30-37 s; real hits in 1-6 s with `FAWP*` collection ids and a
  `hostKey` field; `response_items: []` with `estimated_nr_results` 3.5M;
  and `response_items: [{}, {}, {}]` (429 bytes, every row empty) — the last
  one for every unquoted multi-word query for a stretch, while a laptop got
  real hits for the identical URL and a quoted phrase answered correctly from
  the Worker. The pack retries once with `maxItems` nudged and then throws an
  error naming the fault; rows with no URL/timestamp are never returned as
  hits (`dropped_malformed_rows` counts them). Some nodes also ignore
  `maxItems` (9 rows for 5); hits are capped at `limit`.
- The pack sends `to` only when you pass one. The upstream default (the
  previous calendar year) already covers the whole index, and forcing
  `to=<now>` made the same query return zero items from a live Worker while
  `estimated_nr_results` stayed at 3.8M (probed twice, 2026-10-08).
- Hits are deduplicated to 2 per site by default (`per_site`); raise it to see
  more captures of one site.

## Data sources

- <https://arquivo.pt/textsearch?q=…> — full-text search (`q`, `from`, `to`,
  `siteSearch`, `type`, `maxItems` ≤ 500, `offset`, `dedupValue`, `dedupField`).
- <https://arquivo.pt/textsearch?versionHistory=…> — URL version history.
- <https://arquivo.pt/textextracted?m=…> — extracted text
  of one capture. The `m` value is the original URL followed by `/` and the
  14-digit timestamp, so a URL ending in `/` yields `//` before the stamp —
  that is correct, do not "fix" it.
- API reference: <https://github.com/arquivo/pwa-technologies/wiki/Arquivo.pt-API>.
  A URL passed as `q` is an HTTP 400 upstream; the pack refuses it first and
  points at `arquivo_url_history`.
- Snippets come back HTML-escaped with Latin-1 named entities
  (`Intelig&ecirc;ncia`); the pack decodes them.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "arquivo-pt": {
      "url": "https://gateway.pipeworx.io/arquivo-pt/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/arquivo-pt/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1743+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/arquivo_search_pages \
  -H 'Content-Type: application/json' \
  -d '{"query":"\"inteligência artificial\"","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/arquivo_search_pages`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "arquivo-pt": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-arquivo-pt"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-arquivo-pt
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Arquivo Pt data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
