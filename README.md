> Made @ Shopify

# Figma Remote MCP — OMP Desktop

Connect OMP Desktop to Figma's official remote MCP server at `https://mcp.figma.com/mcp`, using the existing OAuth2/PKCE login and dynamically discovered native tools. This fork carries the installed OMP Node adaptation; it does not launch another model client or CLI server.

## Build and install

Requires Node.js 22 or later. Build from the repository checkout, not the precompiled installed package. The OMP SDK and runtime TypeBox facade remain external and are supplied by the host.

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm test
```

Install or link this package through OMP's plugin manager. Its native entry is `dist/index.js`; the OAuth callback is `dist/oauth-callback.js`. The package includes both compiled files. The build transpiles the TypeScript entry points; the Node tests exercise the real extension factory against isolated HTTP fixtures, not the live account.

Existing loaded runtimes retain their plugin factory. Updating files or refreshing skills does not reload that factory. Use a safely unloaded/new runtime after saving its checkpoint; do not force-stop retained resources or restart unrelated sessions.

## Authentication and tools

- `/figma-remote`: show the cached tool-discovery result. This is **not** a current file-access or connection-health check.
- `/figma-remote-auth`: start OAuth. Open the URL displayed in OMP's notification.
- `/figma-remote-auth cancel`: cancel this runtime's authorization wait.

Existing credentials continue to use the plugin's normal loader at `~/.pi/figma-remote-mcp-token.json`. Do not copy tokens into chat, source, diagnostics, or ordinary configuration. The callback listens on loopback port 9876, validates PKCE/state, and closes its listener on completion, cancellation, refusal, or timeout. The existing OAuth client name is preserved for upstream registration compatibility.

Each factory owns its request, session and authorization state. Runtime shutdown aborts its requests and authorization wait. Tool discovery excludes the remote `generate_image` so it does not shadow OMP's native image generator; the other Figma tools remain available.

## Distinguishing failures

A bare `fetch failed` cannot tell whether the local HTTP request failed or Figma returned that message in a JSON-RPC error. Failed tool results now preserve a safe classification in `details.figmaFailure`:

- `stage: "http-request"`: a bounded error-name/code cause chain, such as `TypeError <- Error[ECONNRESET]`. Request arguments, authorization headers, URLs and arbitrary cause messages are not included.
- `stage: "json-rpc"`: the remote JSON-RPC error code, distinct from local transport failure.

Explicit cancellation remains cancellation. Existing HTTP 401 authentication handling is preserved. Network failure does not clear the saved login or replay a potentially mutating request. A cached tool catalogue must not be presented as proof that a later file operation will succeed.

A successful build and fixture test do not establish live Figma access. Verify the changed factory in the actual host with a read-only call before resuming canvas work. Never repeat an unknown-outcome mutation to test connectivity.

## 1.0.1 verification

- Four factory-level regression tests passed: safe transport causes/no replay/no credential leakage, distinct remote RPC errors, explicit cancellation, and genuine HTTP 401 handling.
- After a non-forced reload of the same OMP design runtime, native `whoami`, a fresh `create_session`, and a read-only Plugin API baseline all succeeded. No canvas write was needed for this verification, and no account details were published.
- The existing deployed Node factory, callable-schema adaptation, scoped OAuth callback and native-image-tool exclusion are included in this fork alongside the error-boundary fix.

## Sources

Derived from [voloshink/pi-figma-remote-mcp](https://github.com/voloshink/pi-figma-remote-mcp), previously referenced as `mkaralevich/pi-figma-remote-mcp`. Existing OMP callable-schema and Node callback adaptations are retained.

Protocol and error-handling references:
- [Node.js error causes](https://nodejs.org/api/errors.html#errorcause)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
