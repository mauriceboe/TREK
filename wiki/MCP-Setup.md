# MCP Setup

This page explains how to connect an AI assistant to your TREK instance. TREK supports two authentication methods: OAuth 2.1 (recommended) and static API tokens (deprecated).

<!-- TODO: screenshot: OAuth client registration form -->

![MCP Setup](assets/MCPConfig.png)

> **Cloudflare users:** If your TREK instance is proxied through Cloudflare, Bot Fight Mode and Super Bot Fight Mode will block MCP requests from ChatGPT. Claude.ai is not affected. See [Troubleshooting → MCP requests blocked by Cloudflare WAF](#mcp-requests-blocked-by-cloudflare-waf-bot-fight-mode) for the fix.

## Option A: OAuth 2.1 (recommended)

OAuth 2.1 is the preferred connection method. You grant specific scopes during the consent step and no token management is required afterward — TREK issues short-lived access tokens and automatically rotates refresh tokens.

### Claude.ai

Claude.ai (web) supports native MCP connections — no JSON config file required:

1. In TREK, go to **Settings → Integrations → MCP → OAuth Clients** and click **Create**.
2. Select the **Claude.ai** preset. This fills in the redirect URI (`https://claude.ai/api/mcp/auth_callback`) and a default scope set.
3. Give the client a name, adjust scopes if needed, and save. Copy the client ID and client secret (`trekcs_` prefix) — the secret is shown only once.
4. In Claude.ai, open the MCP settings and add a new server using your TREK URL (`https://<your-trek-instance>/mcp`). Claude.ai will open your browser to complete the OAuth consent flow.

### Claude Desktop

Claude Desktop connects via `mcp-remote`. After creating an OAuth client using the **Claude Desktop** preset (redirect URI: `http://localhost`), add the following to your Claude Desktop config:

```json
{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-trek-instance>/mcp",
        "--static-oauth-client-info",
        "{\"client_id\": \"<your_client_id>\", \"client_secret\": \"<your_client_secret>\"}"
      ]
    }
  }
}
```

When the client starts it opens your browser to the TREK consent screen to complete the OAuth flow.

### Cursor, VS Code, Windsurf, and Zed

Clients that support `mcp-remote` can connect in one of two ways.

**Option 1 — dynamic registration (no pre-created client needed):**

```json
{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-trek-instance>/mcp"
      ]
    }
  }
}
```

When the client starts, it fetches TREK's OAuth discovery document (`/.well-known/oauth-authorization-server`), registers itself automatically, and opens your browser to the TREK consent screen. You choose scopes there.

**Option 2 — pre-created OAuth client:**

Create a client in TREK using the appropriate preset (Cursor, VS Code, Windsurf, or Zed — all use `http://localhost` as redirect URI), then pass the credentials via `--static-oauth-client-info`:

```json
{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-trek-instance>/mcp",
        "--static-oauth-client-info",
        "{\"client_id\": \"<your_client_id>\", \"client_secret\": \"<your_client_secret>\"}"
      ]
    }
  }
}
```

> On Windows, `npx` may need a full path, for example `C:\PROGRA~1\nodejs\npx.cmd`.

> **Requirement:** `APP_URL` must be set on the server for OAuth discovery to work.

### Pre-created OAuth clients

**Settings → Integrations → MCP → OAuth Clients** lets you create named OAuth clients before connecting. This gives you:

- A fixed, named scope list defined up front
- A client secret (`trekcs_` prefix, shown once) for confidential client mode
- Preset buttons for Claude.ai, Claude Desktop, Cursor, VS Code, Windsurf, and Zed that fill in the correct redirect URIs and a sensible default scope set

Each user can have up to **10 OAuth clients**.

## Option B: Static API token (deprecated)

> **Deprecated:** Static tokens will stop working in a future version of TREK. Migrate to OAuth 2.1.

Static tokens grant full access to all tools and resources with no scope restrictions. Sessions using a static token will receive deprecation warnings in the AI client on every tool call.

1. Go to **Settings → Integrations → MCP**, open the **API Tokens** sub-tab, and click **Create New Token**.
2. Give the token a name and copy it immediately — it is shown only once. The token starts with `trek_`.
3. Pass the token as a header in your client config:

```json
{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-trek-instance>/mcp",
        "--header",
        "Authorization: Bearer trek_your_token_here"
      ]
    }
  }
}
```

Each user can create up to **10 static tokens**.

## Authentication reference

| Method | Token prefix | Access level | Expiry |
|---|---|---|---|
| OAuth 2.1 access token | `trekoa_` | Scoped (per-consent) | 1 hour; auto-refreshed via 30-day rolling refresh token (`trekrf_`) |
| OAuth client secret | `trekcs_` | Used during OAuth registration | No expiry (revoke via UI) |
| Static API token | `trek_` | Full access | No expiry — **deprecated** |

## Related

- [MCP-Overview](MCP-Overview)
- [MCP-Scopes](MCP-Scopes)
- [Admin-MCP-Tokens](Admin-MCP-Tokens)
- [Environment-Variables](Environment-Variables)
