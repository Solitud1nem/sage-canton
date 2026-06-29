// Splice validator wallet API — tap test Amulet + resolve the wallet party.
import { config } from './config.js';
import { walletToken } from './jwt.js';

async function wallet(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${config.validatorApi}${path}`, {
    method,
    headers: { Authorization: `Bearer ${walletToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`wallet ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

/** The party the validator wallet controls — used as the escrow requester / allocation sender. */
export async function walletParty(): Promise<string> {
  return (await wallet('GET', '/api/validator/v0/wallet/user-status')).party_id as string;
}

/** Mint `amount` of test Amulet (Canton Coin) into the wallet party. DevNet/LocalNet only. */
export async function tap(amount: string): Promise<void> {
  await wallet('POST', '/api/validator/v0/wallet/tap', { amount });
}
