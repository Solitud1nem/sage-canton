import { createHmac } from 'node:crypto';
import { config } from './config.js';

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64url');

// Mint an HS256 JWT for the LocalNet shared-secret auth (sub + aud only).
export function mintToken(sub: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub, aud: config.authAudience }));
  const sig = b64url(
    createHmac('sha256', config.authSecret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export const adminToken = (): string => mintToken(config.adminUser);
export const walletToken = (): string => mintToken(config.walletUser);
