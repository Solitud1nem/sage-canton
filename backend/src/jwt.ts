import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { getSeaportToken, clearSeaportToken } from './auth.js';

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64url');

// Mint an HS256 JWT for the LocalNet shared-secret auth (sub + aud only).
export function mintToken(sub: string): string {
  if (config.auth.mode !== 'self-mint') throw new Error('mintToken is only valid for self-mint (LocalNet) auth');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub, aud: config.auth.audience }));
  const sig = b64url(
    createHmac('sha256', config.auth.secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

// Obtain a ledger API bearer token, dispatching on the target's auth mode:
//   self-mint (LocalNet) → HS256 for `sub`; oidc (Seaport) → cached client_credentials token.
// The `sub` is ignored under OIDC (the m2m credential is a single fixed identity).
export async function getToken(sub: string): Promise<string> {
  if (config.auth.mode === 'oidc') return getSeaportToken(config.auth);
  return mintToken(sub);
}

export const getAdminToken = (): Promise<string> => getToken(config.adminUser);
export const getWalletToken = (): Promise<string> => getToken(config.walletUser);

// The ledger-API user id whose rights authorize our submissions. Under OIDC the
// participant keys the user off the token's `sub` claim (NOT the OAuth client_id), so we
// decode it; under self-mint it's the configured admin user. Used for grantActAs targeting.
export async function currentUserId(): Promise<string> {
  if (config.auth.mode !== 'oidc') return config.adminUser;
  const token = await getSeaportToken(config.auth);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { sub?: string };
  if (!payload.sub) throw new Error('OIDC token has no sub claim');
  return payload.sub;
}

/** Invalidate any cached bearer token (call on a 401). No-op for self-mint. */
export function clearToken(): void {
  if (config.auth.mode === 'oidc') clearSeaportToken();
}

// --- Backwards-compatible sync helpers (LocalNet self-mint only) -------------
// Existing LocalNet call sites use these synchronously. They throw under OIDC —
// those paths (wallet/tap) are LocalNet-only anyway.
export const adminToken = (): string => mintToken(config.adminUser);
export const walletToken = (): string => mintToken(config.walletUser);
