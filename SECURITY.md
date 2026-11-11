# Security

## Threat model

The bridge is a local service that converts MCP tool calls into Adobe XD document operations.
Trust boundaries:

1. **OpenCode → bridge**: MCP stdio, same user, no network.
2. **XD plugin → bridge**: localhost WebSocket — the only network surface.
3. **MCP request → XD document**: validated whitelist operations.

## Controls

### Network
- WebSocket server binds **127.0.0.1 only** — never exposed to LAN or public interfaces.
- Single authenticated plugin connection; additional connections are refused (close code 4002).

### Authentication
- Random token: `xdbr-` + 32 bytes base64url, generated on first run.
- Stored at `bridge\.bridge-token` (user-profile ACL; default NTFS user-only permissions).
- Override via `XD_BRIDGE_TOKEN` environment variable (set in the MCP config if preferred;
  never hardcode tokens in source).
- Hello handshake must arrive within 3 seconds or the connection is closed (4001).
- Invalid token → close 4004. Non-hello first message → close 4001. Invalid JSON → close 4003.
- Token is persisted by the plugin in the plugin's own UXP data folder, never in source code.

### Input validation
- Every operation passes the 41-operation `src/operations.ts` whitelist and schema validation
  before reaching XD:
  - op must exist in the whitelist; unknown ops rejected.
  - numeric ranges (e.g. frame sizes 0.1–20000), hex color parsing, guid shape, string length
    caps, enum checks.
  - `execute_batch` limited to 100 validated operations.
- **No arbitrary code execution**: there is no op that evaluates code, spawns processes, or
  opens paths in XD.
- **No arbitrary filesystem paths** are accepted. Exports are written only into the bridge's own
  `exports/` directory with sanitized filenames. `xd_import_asset` is the sole import path and
  uses XD's native UXP file picker, requiring an explicit user-selected file; the MCP request
  cannot supply a path.

### Robustness
- Per-request timeouts (30s default, 60s exports) with structured `timeout` errors.
- Plugin disconnect fails all pending/queued requests immediately (`xd_disconnected`).
- Request queue is serial — XD edits never interleave.
- Logging to `bridge/bridge.log` (2 MB rolling) — contains operation metadata only, no tokens
  or document content.

## Reviewed third-party components

| Component | Review |
|---|---|
| `ws` 8.22.2 (pnpm, bridge-local) | Standard WebSocket server library; used only for the localhost listener. |
| ui-ux-pro-max skill (MIT, v2.15.0) | Data + Python scripts (stdlib only, no network). Installed via official installer through pnpm. Scripts require Python which is **not installed** — no scripts run until the user installs Python. |
| impeccable skill (v4.8.2) | Ships a launcher that downloads a version-pinned engine binary **on first explicit use**, verified via `certutil` against `engine-checksums.txt`, failing closed. Its detector **hooks are opt-in** (`$impeccable hooks on`) and are NOT enabled. No automatic code execution occurs unless the user invokes the launcher or enables hooks. |
| frontend-design skill | Static Markdown only (Anthropic, license preserved). |

## Known limitations

- The localhost port (27183) is bound first-come: if a user manually runs a second bridge
  instance before OpenCode's, the plugin could connect to that instance instead. Both accept the
  same token file; this is a single-user machine scenario. Change `XD_BRIDGE_PORT` to isolate.
- The token file is readable by any process running as the same Windows user — acceptable for a
  private, single-user integration; do not run the bridge under shared accounts.
