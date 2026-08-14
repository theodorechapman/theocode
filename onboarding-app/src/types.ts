export type ProviderId = "grok" | "supabase" | "vercel";

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  description: string;
  /** MCP protected-resource metadata URL (drives issuer discovery + RFC 8707 resource). */
  resourceMetadataUrl?: string;
  /** Fixed authorization-server issuer when there is no resource metadata. */
  issuer?: string;
  /** Fixed public client id. When absent, dynamic client registration is used. */
  clientId?: string;
  /** Fixed scope string. When absent, scopes come from resource metadata. */
  scopes?: string;
}

export type ConnectionPhase =
  | "discovering"
  | "registering"
  | "waiting_for_browser"
  | "exchanging"
  | "verifying";

export interface ConnectionInfo {
  providerId: ProviderId;
  connectedAt: string;
  account?: string;
  scopes?: string;
  expiresAt?: string;
}

export interface ConnectResult {
  ok: boolean;
  connection?: ConnectionInfo;
  error?: string;
}

export interface OnboardingApi {
  getConnections(): Promise<Partial<Record<ProviderId, ConnectionInfo>>>;
  connect(providerId: ProviderId): Promise<ConnectResult>;
  disconnect(providerId: ProviderId): Promise<void>;
  onProgress(
    cb: (update: { providerId: ProviderId; phase: ConnectionPhase }) => void,
  ): void;
}
