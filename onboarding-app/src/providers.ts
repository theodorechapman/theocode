import type { ProviderConfig } from "./types";

// Grok Build CLI's public OAuth client (authorization code + PKCE on a
// loopback redirect, per RFC 8252 — same client the CLI itself uses).
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_ISSUER = "https://auth.x.ai";

export const PROVIDERS: ProviderConfig[] = [
  {
    id: "grok",
    name: "Grok CLI",
    description:
      "Signs in the grok CLI on this machine; the credential is written to ~/.grok/auth.json.",
    issuer: GROK_ISSUER,
    clientId: GROK_CLIENT_ID,
    // The exact scope set the grok CLI requests for itself.
    scopes:
      "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  },
  {
    id: "supabase",
    name: "Supabase MCP",
    description:
      "Authorizes theocode to reach your Supabase projects through the Supabase MCP server.",
    resourceMetadataUrl:
      "https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp",
  },
  {
    id: "vercel",
    name: "Vercel MCP",
    description:
      "Authorizes theocode to reach your Vercel teams and deployments through the Vercel MCP server.",
    resourceMetadataUrl:
      "https://mcp.vercel.com/.well-known/oauth-protected-resource",
    scopes: "openid email profile offline_access",
  },
];

/** Providers exposed to the grok CLI through the loopback MCP proxy. */
export const MCP_PROVIDERS = ["supabase", "vercel"] as const;

export function getProvider(id: string): ProviderConfig {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}
