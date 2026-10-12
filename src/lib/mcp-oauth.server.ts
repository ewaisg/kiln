import { safeFetch, validatePublicEndpoint } from "@/lib/relay-security.server";
import { readMcpResponse } from "@/lib/mcp";

async function metadata(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await safeFetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OAuth metadata request failed (${response.status}).`);
  const text = await readMcpResponse(response);
  if (text.length > 100_000) throw new Error("OAuth metadata is too large.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OAuth metadata.");
  return value as Record<string, unknown>;
}

export async function relayMcpOAuth(raw: string, signal: AbortSignal): Promise<Response> {
  if (raw.length > 16_000) throw new Error("OAuth request exceeds limits.");
  const input = JSON.parse(raw) as Record<string, unknown>;
  if (input.action === "discover") {
    if (typeof input.url !== "string") throw new Error("Missing MCP URL.");
    const { url } = await validatePublicEndpoint(input.url);
    url.hash = "";
    // RFC 9728 path-specific metadata, with the challenge URI preferred when published.
    let resourceUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`;
    const probe = await safeFetch(url, { signal, headers: { accept: "application/json, text/event-stream" } });
    const challenge = probe.headers.get("www-authenticate")?.match(/resource_metadata="([^"\r\n]+)"/i)?.[1];
    await probe.body?.cancel();
    if (challenge) resourceUrl = challenge;
    let resource;
    try { resource = await metadata(resourceUrl, signal); }
    catch (error) { if (challenge) throw error; resource = await metadata(`${url.origin}/.well-known/oauth-protected-resource`, signal); }
    if (typeof resource.resource !== "string" || new URL(resource.resource).toString() !== url.toString()) throw new Error("OAuth resource metadata does not match this MCP endpoint.");
    if (!Array.isArray(resource.authorization_servers) || typeof resource.authorization_servers[0] !== "string") throw new Error("The MCP server published no authorization server.");
    const issuer = resource.authorization_servers[0];
    const issuerUrl = (await validatePublicEndpoint(issuer)).url;
    let auth;
    try { auth = await metadata(`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "")}`, signal); }
    catch { auth = await metadata(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, signal); }
    if (auth.issuer !== issuer) throw new Error("OAuth issuer mismatch. Authorization was stopped.");
    if (!Array.isArray(auth.code_challenge_methods_supported) || !auth.code_challenge_methods_supported.includes("S256")) throw new Error("This authorization server does not advertise required S256 PKCE support.");
    if (typeof auth.authorization_endpoint !== "string" || typeof auth.token_endpoint !== "string") throw new Error("Missing OAuth endpoints.");
    await Promise.all([validatePublicEndpoint(auth.authorization_endpoint), validatePublicEndpoint(auth.token_endpoint)]);
    return Response.json({ issuer, resource: resource.resource, authorizationEndpoint: auth.authorization_endpoint, tokenEndpoint: auth.token_endpoint,
      scopes: Array.isArray(resource.scopes_supported) ? resource.scopes_supported.filter(scope => typeof scope === "string").slice(0, 20) : [] }, { headers: { "cache-control": "no-store" } });
  }
  if (input.action === "token") {
    for (const key of ["tokenEndpoint", "code", "verifier", "clientId", "redirectUri", "resource"] as const) if (typeof input[key] !== "string" || (input[key] as string).length > 2000) throw new Error(`Missing or invalid ${key}.`);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier as string)) throw new Error("Invalid PKCE verifier.");
    const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code as string, code_verifier: input.verifier as string,
      client_id: input.clientId as string, redirect_uri: input.redirectUri as string, resource: input.resource as string });
    const response = await safeFetch(input.tokenEndpoint as string, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form, signal });
    const payload = JSON.parse(await readMcpResponse(response)) as { access_token?: string; token_type?: string; expires_in?: number; error_description?: string; error?: string };
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token || payload.access_token.length > 8192 || /[\r\n]/.test(payload.access_token) || payload.token_type?.toLowerCase() !== "bearer") throw new Error(payload.error_description?.slice(0, 300) || payload.error || "OAuth token exchange failed.");
    // Never return refresh tokens/client secrets and never log the response.
    return Response.json({ accessToken: payload.access_token, expiresIn: payload.expires_in }, { headers: { "cache-control": "no-store" } });
  }
  throw new Error("Unsupported OAuth operation.");
}
