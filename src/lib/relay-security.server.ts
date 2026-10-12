import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Reject non-global addresses, including IPv4 mapped IPv6 and metadata ranges. */
export function isPublicAddress(address: string): boolean {
  let host = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.startsWith("::ffff:")) {
    const suffix = host.slice(7);
    if (isIP(suffix) === 4) host = suffix;
    else {
      const parts = suffix.split(":");
      if (parts.length !== 2) return false;
      const high = parseInt(parts[0], 16), low = parseInt(parts[1], 16);
      host = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  if (isIP(host) === 4) {
    const [a, b, c] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  // Global unicast only. Exclude transition/tunnel and documentation ranges.
  return isIP(host) === 6 && /^[23]/.test(host) && !host.startsWith("2001:db8")
    && !host.startsWith("2001:0:") && !host.startsWith("2002:");
}

/** DNS is validated then pinned to the request socket; redirects never carry keys. */
export async function validatePublicEndpoint(input: string | URL): Promise<{ url: URL; address: { address: string; family: number } }> {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("The relay requires a public HTTPS endpoint on port 443 without URL credentials.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("That endpoint resolves to a private or reserved address. Connect to it directly from your device.");
  }
  return { url, address: addresses[0] };
}

export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const { url, address: pinned } = await validatePublicEndpoint(input);
  const headers = new Headers(init.headers);
  headers.set("accept-encoding", "identity");
  const method = init.method ?? "GET";
  let body: Uint8Array | undefined;
  if (init.body != null) {
    const encoded = new Request(url, { method, headers, body: init.body });
    body = new Uint8Array(await encoded.arrayBuffer());
    encoded.headers.forEach((value, name) => headers.set(name, value));
    if (body.byteLength > 32_000_000) throw new Error("The provider request exceeds 32 MB.");
    headers.set("content-length", String(body.byteLength));
  }
  const signal = AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)]);
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method, headers: Object.fromEntries(headers), signal,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, (upstream) => {
      const status = upstream.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstream.resume();
        reject(new Error("The provider redirected. Update its endpoint; Kiln does not forward credentials across redirects."));
        return;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const noBody = method === "HEAD" || [204, 205, 304].includes(status);
      resolve(new Response(noBody ? null : Readable.toWeb(upstream) as ReadableStream<Uint8Array>, {
        status, headers: responseHeaders,
      }));
    });
    req.once("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
