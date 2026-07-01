// OIDC client_credentials token provider for the Seaport DevNet shared validator.
//
// The 5n sandbox issues an 8h access token from Authentik; we cache it in memory and
// refresh 60s before expiry (and on a mid-flight 401 via `clearSeaportToken`). See
// docs/setup/seaport-devnet-integration.md §3.

export interface OidcConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  scope: string;
}

interface CachedToken { token: string; expiresAt: number; }
let cache: CachedToken | null = null;

/** Drop the cached token so the next call re-exchanges (call this on a 401). */
export function clearSeaportToken(): void {
  cache = null;
}

export async function getSeaportToken(cfg: OidcConfig): Promise<string> {
  const now = Date.now();
  // refresh 60s before actual expiry to avoid mid-request expiry
  if (cache && cache.expiresAt - 60_000 > now) return cache.token;

  if (!cfg.clientSecret) {
    throw new Error('SEAPORT_CLIENT_SECRET is empty — paste it into backend/.env (from the Seaport access PDF).');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    audience: cfg.audience,
    scope: cfg.scope,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cache = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return cache.token;
}
