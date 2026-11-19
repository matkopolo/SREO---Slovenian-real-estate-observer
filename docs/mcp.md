# MCP server

`sreo-mcp` exposes the read-only SREO API to agents over the Model Context Protocol: Claude
Desktop, Claude Code and any other MCP client can ask about the Slovenian property market
with typed tools instead of scraping pages. It is a thin layer: every tool is one or two GET
requests to the API, whose JSON answer is returned as the tool's structured content together
with the `source` notice (GURS ETN and the other registers, CC BY 4.0). Nothing is stored and
nothing can be written.

The server is a second binary in the API image (`apps/real-estate-api/cmd/sreo-mcp`, package
`internal/mcpserver`), built on the official Go SDK
(`github.com/modelcontextprotocol/go-sdk`). It supports both transports of the protocol:

- **stdio** for a client that starts the server itself (Claude Desktop, Claude Code);
- **streamable HTTP** as the Compose service `sreo-mcp` on `127.0.0.1:8090` (host port
  `MCP_PORT`), proxied by the observer at exactly `/mcp` with the same per-client rate limit
  as the API.

One service (API client, the ten-minute caches of the area lists and the data status, the tool
schemas) is shared by every session; each HTTP session gets its own small MCP server. The
server pings a session every 30 s and closes one that has been idle for 30 minutes, so clients
that disconnect without ending their session leave nothing behind. On SIGTERM the open event
streams are ended and the server drains within 10 s.

## Tools

| Tool | What it answers | API behind it |
|---|---|---|
| `find_areas` | Official areas by name (regions, municipalities, districts, communities, settlements) and their ids; diacritics are ignored, exact names first; at most 25, with a hint to narrow when more match | `/geographies` (cached 10 min) |
| `search_addresses` | Buildings by address text (at least 3 characters) with their cadastral key and agreement counts; at most 20 | `/buildings/search` |
| `building` | Sales and rentals recorded in one building (cadastral code and a digits-only building number) | `/buildings/{ko}/{st}/statistics` |
| `sale` | One sale with its parts, parcels, quality and the register facts (energy certificate, cadastre, GURS generalised value, flood class); with `includeContext` the benchmarks, comparables and the current-market estimate | `/sales/transactions/{id}` and `/context` |
| `rental` | One rental agreement | `/rentals/transactions/{id}` |
| `market_overview` | Sale statistics of an area, period and type, plus the rental overview of the same type (or `rentalsUnavailable` with the reason) | `/statistics/overview`, `/rentals/statistics/overview` |
| `price_trend` | Median price per m² over time; ten years by default | `/statistics/timeseries` |
| `price_distribution` | Histogram of prices per m² or total prices | `/statistics/distribution` |
| `recent_sales` | The latest sales or rentals in an area, pageable (default 20, at most 100 per page) | `/transactions/recent` |
| `affordability` | Lending limits applied to the median price for a given or median income | `/affordability` |
| `municipality_affordability` | Every municipality's median price and years of salary | `/affordability/municipalities` |
| `price_index` | The national hedonic index; says so when none is published for the type | `/indices` |
| `demographics` | SURS population, migration and housing context | `/demographics` |
| `property_history` | Earlier sales of the same property | `/sales/transactions/{id}/history` |
| `flood_zones` | DRSV flood classes in a view of at most 0.26°: the classes present, whether a hydraulic study covers part of the view, whether the counts are partial; optionally up to 200 polygons | `/hazards/floods` |
| `data_status` | The live release, the dates the statistics run to, the default periods | `/data-status`, `/meta` |

Periods default to what the site shows: sales for the twelve months to the end of the last
quarter that is at least three months behind the analytics cutoff (GURS records sales with a
lag), rentals for the last calendar year mostly reported. When only one of `from` and `to` is
given, the other is a year away from it (ten years for `price_trend`), never past the end of
the published data; `from` after `to` is an error. Every tool is annotated read-only and
idempotent; its input schema carries the allowed values and bounds, so a client can check a
call before making it. Errors from the API (unknown id, invalid bbox) come back as tool errors
with the API's code and message.

## Resources

- `sreo://about`: what the data is, how areas and ids work, publication thresholds, licence
  and attribution (embedded, always available).
- `sreo://docs/methodology`, `sreo://docs/licensing`, `sreo://docs/api`,
  `sreo://docs/property-history`: the repository's documents, served with their sizes when
  `MCP_DOCS_DIR` points at `docs/` (Compose mounts it read-only; a stdio run has to mount it
  itself, see below).

## Configuration

| Variable (flag) | Default | Meaning |
|---|---|---|
| `SREO_API_URL` (`-api`) | `http://localhost:8080` | base URL of the SREO API |
| `MCP_TRANSPORT` (`-transport`) | `stdio` | `stdio` or `http` |
| `MCP_ADDRESS` (`-address`) | `:8090` | listen address for the HTTP transport |
| `MCP_DOCS_DIR` (`-docs`) | empty | directory with the documentation resources |
| `MCP_SITE_URL` (`-site`) | `https://sreo.si` | public site used in the `link` of each answer |

Logs go to standard error in both modes, because standard output is the stdio channel.
`GET /health/live` answers on the HTTP transport for container health checks.

The SDK's DNS-rebinding protection is on: a request that arrives on a loopback address
(`127.0.0.1`, `[::1]`) with a `Host` header that is not loopback is refused with 403. This
never affects the Compose service, which receives the proxied requests on its container
address, nor a client that calls `http://localhost:8090/` directly. It does affect a binary run
natively on `127.0.0.1:8090` behind a reverse proxy that forwards the public host name: bind
such a server to a non-loopback address or let the proxy send `Host: localhost`.

## Connecting a client

Claude Desktop or Claude Code over stdio, running the published image against a local stack
(the container reaches the API through the Compose network). The documentation resources are
only served when the repository's `docs/` directory is mounted:

```json
{
  "mcpServers": {
    "sreo": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "--network", "real_estate_default",
               "-e", "SREO_API_URL=http://real-estate-api:8080",
               "-e", "MCP_DOCS_DIR=/docs", "-v", "/path/to/real_estate/docs:/docs:ro",
               "--entrypoint", "/usr/local/bin/sreo-mcp", "real-estate-api:development"]
    }
  }
}
```

Over streamable HTTP against the running stack: the endpoint is `http://localhost:8090/`
directly (host port `MCP_PORT`) or `http://localhost:3000/mcp` through the observer. In
Claude Code:

```bash
claude mcp add --transport http sreo http://localhost:3000/mcp
```

Codex CLI reads its MCP servers from `~/.codex/config.toml`; either transport works. Over
streamable HTTP against the running stack:

```toml
[mcp_servers.sreo]
url = "http://localhost:3000/mcp"
```

Or over stdio, starting the server from the image:

```toml
[mcp_servers.sreo]
command = "docker"
args = ["run", "--rm", "-i", "--network", "real_estate_default",
        "-e", "SREO_API_URL=http://real-estate-api:8080",
        "-e", "MCP_DOCS_DIR=/docs", "-v", "/path/to/real_estate/docs:/docs:ro",
        "--entrypoint", "/usr/local/bin/sreo-mcp", "real-estate-api:development"]
```

Any other MCP client connects the same way: a `url` for streamable HTTP, or the `docker run`
command for stdio. A public deployment serves the endpoint at `https://<site>/mcp`; set
`MCP_SITE_URL` so the links in the answers point at the site.

## Licence and privacy

The answers carry the same attribution as the site, and the tools expose exactly what the
public API serves: aggregate statistics and recorded agreements with addresses and prices, no
owner or contracting-party data. See [data licensing and privacy](data-licensing-privacy.md).
