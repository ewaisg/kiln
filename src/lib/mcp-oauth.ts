import type { McpServer } from "@/lib/types";
import { useKiln } from "@/lib/store";
import { disconnectMcp } from "@/lib/mcp";

const KEY = "kiln-mcp-oauth-request";
type Pending = { state: string; verifier: string; issuer: string; serverId: string; clientId: string; resource: string; tokenEndpoint: string; redirectUri: string; created: number };
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function pkceChallenge(verifier: string): Promise<string> { return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))); }
async function relay(body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch("/api/mcp-oauth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "OAuth authorization failed.");
  return value;
}
export async function startMcpOAuth(server: McpServer): Promise<void> {
  if (!server.oauthClientId?.trim()) throw new Error("Enter a public OAuth client ID registered with this server. Set its redirect URL to the callback shown below.");
  const metadata = await relay({ action: "discover", url: server.url });
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const redirectUri = `${window.location.origin}/mcp/callback`;
  const pending: Pending = { state, verifier, issuer: String(metadata.issuer), serverId: server.id, clientId: server.oauthClientId.trim(), resource: String(metadata.resource), tokenEndpoint: String(metadata.tokenEndpoint), redirectUri, created: Date.now() };
  sessionStorage.setItem(KEY, JSON.stringify(pending));
  const url = new URL(String(metadata.authorizationEndpoint));
  url.search = new URLSearchParams({ response_type: "code", client_id: pending.clientId, redirect_uri: redirectUri, state, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", resource: pending.resource,
    ...(Array.isArray(metadata.scopes) && metadata.scopes.length ? { scope: metadata.scopes.join(" ") } : {}) }).toString();
  window.location.assign(url);
}
export async function completeMcpOAuth(search: string): Promise<void> {
  const raw = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  if (!raw) throw new Error("No pending OAuth request. Start authorization again from Tools.");
  const pending = JSON.parse(raw) as Pending;
  const params = new URLSearchParams(search);
  if (params.get("state") !== pending.state || Date.now() - pending.created > 10 * 60_000) throw new Error("OAuth state expired or did not match. No token was saved.");
  if (params.get("iss") && params.get("iss") !== pending.issuer) throw new Error("OAuth response issuer mismatch.");
  if (params.get("error")) throw new Error(params.get("error_description") || params.get("error") || "Authorization rejected.");
  const code = params.get("code"); if (!code) throw new Error("The authorization server returned no code.");
  if (!useKiln.persist.hasHydrated()) await useKiln.persist.rehydrate();
  const server = useKiln.getState().mcpServers.find(item => item.id === pending.serverId);
  if (!server || server.oauthClientId?.trim() !== pending.clientId || new URL(server.url).toString() !== new URL(pending.resource).toString()) throw new Error("The MCP connection changed while authorizing. Start again.");
  const result = await relay({ action: "token", ...pending, code });
  if (typeof result.accessToken !== "string") throw new Error("No OAuth access token received.");
  disconnectMcp(server.id);
  useKiln.getState().upsertMcp({ ...server, token: result.accessToken });
}
