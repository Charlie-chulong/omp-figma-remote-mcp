/**
 * pi-figma-remote-mcp — pi extension
 *
 * Connects pi to the Figma remote MCP server (https://mcp.figma.com/mcp).
 * Requires OAuth2 authentication. Provides full feature set including
 * use_figma, generate_figma_design, create_new_file, and search_design_system.
 *
 * Use this when you need remote-only features or don't have the Figma desktop app.
 * For desktop-based workflows, use pi-figma-mcp instead.
 *
 * Tools are discovered dynamically from the server on session start.
 * Commands:
 *   /figma-remote       — show connection status and available tools
 *   /figma-remote-auth  — run OAuth authentication
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { startOAuthCallback } from "./oauth-callback.js";
import { randomBytes, createHash } from "node:crypto";

// ## Config

const MCP_URL = "https://mcp.figma.com/mcp";
const MAX_OUTPUT_BYTES = 50 * 1024;
const TOKEN_PATH = join(homedir(), ".pi", "figma-remote-mcp-token.json");

const OAUTH_AUTHORIZATION_URL = "https://www.figma.com/oauth/mcp";
const OAUTH_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const OAUTH_CALLBACK_PORT = 9876;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
const OAUTH_REGISTRATION_URL = "https://api.figma.com/v1/oauth/mcp/register";

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<
      string,
      {
        type: string;
        description?: string;
        enum?: string[];
        items?: unknown;
        default?: unknown;
      }
    >;
    required?: string[];
  };
}
export function buildSchema(inputSchema: McpTool["inputSchema"]): TSchema {
  const props = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);
  const fields: Record<string, TSchema> = {};

  for (const [key, prop] of Object.entries(props)) {
    let schema: TSchema;
    // Constructor metadata works with both TypeBox and OMP's callable facade.
    const options = prop.description ? { description: prop.description } : undefined;

    if (prop.enum) {
      schema = Type.Union(prop.enum.map((v) => Type.Literal(v)), options);
    } else if (prop.type === "boolean") {
      schema = Type.Boolean(options);
    } else if (prop.type === "number" || prop.type === "integer") {
      schema = Type.Number(options);
    } else if (prop.type === "array") {
      schema = Type.Array(Type.Any(), options);
    } else {
      schema = Type.String(options);
    }

    fields[key] = required.has(key) ? schema : Type.Optional(schema);
  }

  return Type.Object(fields);
}

function networkFailureSummary(error: unknown): string {
  const parts: string[] = [];
  let cause = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    const name = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(cause.name) ? cause.name : "Error";
    const code = "code" in cause && typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code) ? cause.code : undefined;
    parts.push(code ? `${name}[${code}]` : name);
    cause = cause.cause;
  }
  return parts.join(" <- ") || typeof error;
}

type McpFailureDetails =
  | { stage: "http-request"; causes: string }
  | { stage: "json-rpc"; code: number | undefined };

class McpFailure extends Error {
  constructor(message: string, readonly details: McpFailureDetails, cause: unknown) {
    super(message, { cause });
  }
}

export default function (pi: ExtensionAPI) {
const lifecycle = new AbortController();
let authPending = false;
let authController: AbortController | undefined;
let sessionId: string | undefined;
let requestId = 1;
let connected = false;
let availableTools: Array<{ name: string; description: string }> = [];
let accessToken: string | undefined;
let refreshToken: string | undefined;
let clientId: string | undefined;
let clientSecret: string | undefined;
let tokenExpiresAt = 0;

async function fetch(input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) {
  const signals = [lifecycle.signal];
  if (init.signal) signals.push(init.signal);
  try {
    return await globalThis.fetch(input, { ...init, signal: AbortSignal.any(signals) });
  } catch (error) {
    if (lifecycle.signal.aborted || init.signal?.aborted) throw error;
    const causes = networkFailureSummary(error);
    throw new McpFailure(`HTTP request failed: ${causes}`, { stage: "http-request", causes }, error);
  }
}
// ## Token persistence

interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
}

function loadToken(): boolean {
  try {
    if (!existsSync(TOKEN_PATH)) return false;
    const data: TokenData = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    tokenExpiresAt = data.expiresAt ?? 0;
    clientId = data.clientId;
    clientSecret = data.clientSecret;
    return !!accessToken;
  } catch {
    return false;
  }
}

function saveToken(): void {
  try {
    mkdirSync(join(homedir(), ".pi"), { recursive: true });
    const data: TokenData = {
      accessToken: accessToken!,
      refreshToken,
      expiresAt: tokenExpiresAt,
      clientId,
      clientSecret,
    };
    writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Non-fatal
  }
}

// ## PKCE helpers

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ## OAuth 2.0 dynamic client registration + PKCE

async function registerOAuthClient(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const res = await fetch(OAUTH_REGISTRATION_URL, {
    method: "POST",
    signal: authController?.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code",
      redirect_uris: [OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:connect",
    }),
  });
  if (!res.ok) {
    throw new Error(`Client registration failed (${res.status})`);
  }
  const data = (await res.json()) as {
    client_id: string;
    client_secret?: string;
  };
  return { clientId: data.client_id, clientSecret: data.client_secret ?? "" };
}


async function exchangeCodeForToken(
  code: string,
  codeVerifier: string
): Promise<void> {
  const params: Record<string, string> = {
    client_id: clientId!,
    redirect_uri: OAUTH_REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
  };
  if (clientSecret) params.client_secret = clientSecret;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    signal: authController?.signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status})`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  accessToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiresAt = data.expires_in
    ? Date.now() + data.expires_in * 1000
    : 0;
  saveToken();
}

async function refreshAccessToken(signal?: AbortSignal): Promise<boolean> {
  if (!refreshToken || !clientId) return false;

  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret ?? "",
      }).toString(),
    });

    if (!res.ok) return false;

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    accessToken = data.access_token;
    if (data.refresh_token) refreshToken = data.refresh_token;
    tokenExpiresAt = data.expires_in
      ? Date.now() + data.expires_in * 1000
      : 0;
    saveToken();
    return true;
  } catch {
    return false;
  }
}

async function runFullOAuthFlow(ctx: {
  ui: { notify: (msg: string, level: string) => void };
}): Promise<boolean> {
  ctx.ui.notify("正在注册 Figma 授权客户端…", "info");
  const reg = await registerOAuthClient();
  clientId = reg.clientId;
  clientSecret = reg.clientSecret;
  const codeVerifier = generateCodeVerifier();
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL(OAUTH_AUTHORIZATION_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "mcp:connect");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", generateCodeChallenge(codeVerifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  const callback = await startOAuthCallback(state, OAUTH_CALLBACK_PORT, AbortSignal.any([lifecycle.signal, authController!.signal]));
  try {
    ctx.ui.notify(`请在浏览器打开以下 Figma 授权链接：\n${authUrl}\n\n取消：/figma-remote-auth cancel`, "info");
    const { code } = await callback.code;
    await exchangeCodeForToken(code, codeVerifier);
    return true;
  } finally {
    callback.close();
  }
}

// ## MCP HTTP client

async function mcpPost(
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  if (tokenExpiresAt > 0 && Date.now() > tokenExpiresAt - 60_000) {
    await refreshAccessToken(signal);
  }

  const id = requestId++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal,
  });

  const newSid = response.headers.get("mcp-session-id");
  if (newSid) sessionId = newSid;

  if (!response.ok) {
    if (response.status === 401) {
      const refreshed = await refreshAccessToken(signal);
      if (refreshed) {
        const retryHeaders = {
          ...headers,
          Authorization: `Bearer ${accessToken}`,
        };
        const retry = await fetch(MCP_URL, {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId++,
            method,
            params,
          }),
          signal,
        });
        const retrySid = retry.headers.get("mcp-session-id");
        if (retrySid) sessionId = retrySid;
        if (!retry.ok) throw new Error("AUTH_REQUIRED");

        const ct = retry.headers.get("content-type") ?? "";
        const txt = await retry.text();
        let j: { result?: unknown; error?: { message: string; code?: number } };
        if (ct.includes("text/event-stream")) {
          const dl = txt.split("\n").find((l) => l.startsWith("data: "));
          if (!dl) throw new Error("No data in SSE response");
          j = JSON.parse(dl.slice(6));
        } else {
          j = JSON.parse(txt);
        }
        if (j.error) {
          const code = typeof j.error.code === "number" ? j.error.code : undefined;
          throw new McpFailure(`JSON-RPC error${code !== undefined ? ` (${code})` : ""}: ${j.error.message}`, { stage: "json-rpc", code }, j.error);
        }
        return j.result;
      }
      throw new Error("AUTH_REQUIRED");
    }
    throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  let json: { result?: unknown; error?: { message: string; code?: number } };

  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error("No data in SSE response");
    json = JSON.parse(dataLine.slice(6));
  } else {
    json = JSON.parse(text);
  }

  if (json.error) {
    const code = typeof json.error.code === "number" ? json.error.code : undefined;
    throw new McpFailure(`JSON-RPC error${code !== undefined ? ` (${code})` : ""}: ${json.error.message}`, { stage: "json-rpc", code }, json.error);
  }
  return json.result;
}

// ## Session

async function initializeSession(signal?: AbortSignal): Promise<boolean> {
  try {
    sessionId = undefined;
    await mcpPost(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-figma-remote-mcp", version: "1.0" },
      },
      signal
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "AUTH_REQUIRED") return false;
    throw err;
  }
}

// ## Tool discovery


interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

async function listTools(signal?: AbortSignal): Promise<McpTool[]> {
  const result = (await mcpPost("tools/list", undefined, signal)) as {
    tools: McpTool[];
  };
  // Keep OMP's native image tool; the unused Figma tool shadows the same name.
  return (result.tools ?? []).filter((tool) => tool.name !== "generate_image");
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<McpToolResult> {
  return (await mcpPost(
    "tools/call",
    { name, arguments: args },
    signal
  )) as McpToolResult;
}

// ## Content conversion

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  return (
    Buffer.from(text, "utf8").slice(0, MAX_OUTPUT_BYTES).toString("utf8") +
    "\n\n[Output truncated — use a more specific nodeId or break the design into smaller sections.]"
  );
}

function convertContent(
  mcpContent: McpContent[]
): Array<
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
> {
  const out: ReturnType<typeof convertContent> = [];
  for (const c of mcpContent) {
    if (c.type === "text" && c.text) {
      out.push({ type: "text", text: truncate(c.text) });
    } else if (c.type === "image" && c.data && c.mimeType) {
      out.push({ type: "image", mimeType: c.mimeType, data: c.data });
    } else if (c.type === "resource" && c.uri) {
      out.push({ type: "text", text: `[Resource: ${c.uri}]` });
    }
  }
  return out;
}

// ## Schema builder


// ## Tool registration

function formatLabel(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function registerMcpTools(pi: ExtensionAPI, tools: McpTool[]) {
  availableTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
  }));

  for (const tool of tools) {
    const schema = buildSchema(tool.inputSchema);

    pi.registerTool({
      name: tool.name,
      label: formatLabel(tool.name),
      description: tool.description,
      parameters: schema,

      async execute(_id, params, signal) {
        let initializing = false;
        try {
          if (!sessionId) {
            initializing = true;
            const ok = await initializeSession(signal);
            initializing = false;
            if (!ok) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Figma remote MCP session expired. Run /figma-remote-auth to re-authenticate.",
                  },
                ],
                isError: true,
              };
            }
          }

          const result = await callTool(
            tool.name,
            params as Record<string, unknown>,
            signal
          );
          return {
            content: convertContent(result.content),
            isError: result.isError ?? false,
          };
        } catch (err: unknown) {
          if (initializing && (signal?.aborted || lifecycle.signal.aborted)) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "AUTH_REQUIRED") {
            accessToken = undefined;
            sessionId = undefined;
            return {
              content: [
                {
                  type: "text",
                  text: "Figma remote MCP authentication expired. Run /figma-remote-auth to re-authenticate.",
                },
              ],
              isError: true,
            };
          }
          if (msg.includes("404") || msg.includes("session"))
            sessionId = undefined;
          return {
            content: [
              { type: "text", text: `Figma remote MCP error: ${msg}` },
            ],
            isError: true,
            details: err instanceof McpFailure ? { figmaFailure: err.details } : undefined,
          };
        }
      },
    });
  }
}

// ## Extension

  // ## Lifecycle

  pi.on("session_shutdown", () => {
    authController?.abort();
    lifecycle.abort();
    connected = false;
    sessionId = undefined;
  });
  async function reconnect(_event, ctx) {
    const signal = AbortSignal.timeout(10_000);
    connected = false;
    sessionId = undefined;
    if (!loadToken()) return;
    try {
      const ok = await initializeSession(signal);
      if (!ok) {
        ctx.ui.notify("Figma 登录已过期，请运行 /figma-remote-auth 重新授权。", "warning");
        return;
      }
      const tools = await listTools(signal);
      connected = true;
      registerMcpTools(pi, tools);
    } catch (error) {
      if (!lifecycle.signal.aborted) ctx.ui.notify(`Figma 连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  pi.on("session_start", reconnect);
  pi.on("session_switch", reconnect);

  // ## System prompt

  pi.on("before_agent_start", async (event) => {
    if (!connected) return;

    return {
      systemPrompt: [
        ...event.systemPrompt,
        `

## Figma Remote MCP Server

Figma remote MCP tools were discovered during initialization. Tool discovery is not a current health check; file access and operations must be confirmed by their actual tool responses.

The \`use_figma\` tool can **create, edit, and delete** content on the Figma canvas by executing Plugin API JavaScript. Use it for all canvas mutations. The \`search_design_system\` tool finds existing components and variables in connected libraries.

**nodeId format:** Use \`123:456\` or \`123-456\`. Extract from Figma URLs: \`?node-id=1-2\` → \`1:2\`. If no nodeId is given, the tool uses whatever is currently selected in Figma.

**Design-to-code workflow:** call \`get_screenshot\` first for visual reference, then \`get_design_context\` for layout and structure. If the response is too large, use \`get_metadata\` to get an overview, then \`get_design_context\` on specific child nodes.
`, ],
    };
  });

  // ## Commands

  pi.registerCommand("figma-remote", {
    description:
      "Show Figma remote MCP server connection status and available tools",
    handler: async (_args, ctx) => {
      if (!connected) {
        ctx.ui.notify(
          "Figma remote MCP server is not connected.\n\nRun /figma-remote-auth to authenticate.",
          "error"
        );
        return;
      }
      ctx.ui.notify(
        `Figma remote MCP tools discovered\nURL: ${MCP_URL}\nCurrent access is determined by actual tool responses, not this cached discovery state.\n\nAvailable tools (${availableTools.length}):\n${availableTools.map((t) => `  • ${t.name}`).join("\n")}`,
        "info"
      );
    },
  });

  pi.registerCommand("figma-remote-auth", {
    description: "Authenticate with the Figma remote MCP server via OAuth",
    handler: async (args, ctx) => {
      if (args.trim() === "cancel") {
        authController?.abort();
        ctx.ui.notify("已取消本会话的 Figma 授权等待。", "info");
        return;
      }
      if (authPending) {
        ctx.ui.notify("Figma 授权已在进行；可使用 /figma-remote-auth cancel 取消。", "warning");
        return;
      }
      authPending = true;
      authController = new AbortController();
      try {
        await runFullOAuthFlow(ctx);

        const signal = AbortSignal.any([AbortSignal.timeout(15_000), authController.signal]);
        const ok = await initializeSession(signal);
        if (!ok) {
          ctx.ui.notify(
            "OAuth completed but could not initialize MCP session.",
            "error"
          );
          return;
        }
        const tools = await listTools(signal);
        connected = true;
        ctx.ui.setStatus("figma-remote", "figma-remote ✓");
        registerMcpTools(pi, tools);
        ctx.ui.notify(
          `Authenticated ✓\n\nAvailable tools (${tools.length}):\n${tools.map((t) => `  • ${t.name}`).join("\n")}`,
          "info"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Authentication error: ${msg}`, "error");
      } finally {
        authPending = false;
        authController = undefined;
      }
    },
  });
}
