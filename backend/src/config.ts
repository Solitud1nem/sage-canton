// Runtime configuration for the sage-canton backend.
//
// Two deployment targets, selected by `LEDGER_TARGET`:
//   - `localnet`       (default) — cn-quickstart LocalNet (Daml 3.4.x / Splice 0.5.x),
//                        HS256 shared-secret auth, Splice wallet + Amulet registry present.
//   - `seaport-devnet` — the hosted 5n sandbox shared validator, OIDC client_credentials
//                        auth (8h token → auto-refresh), single participant. See
//                        docs/setup/seaport-devnet-integration.md.
// Override any field via env for other deployments.
import './dotenv.js'; // load backend/.env into process.env before we read it

export type Target = 'localnet' | 'seaport-devnet';

// Discriminated auth config: LocalNet mints its own HS256 token; Seaport exchanges an
// OIDC client_credentials token against Authentik.
export type AuthConfig =
  | { mode: 'self-mint'; secret: string; audience: string }
  | { mode: 'oidc'; tokenUrl: string; clientId: string; clientSecret: string; audience: string; scope: string };

export interface Config {
  target: Target;
  ledgerApi: string;      // v2 JSON Ledger API base
  validatorApi: string;   // Splice validator wallet API (tap, balances) — LocalNet only
  registry: string;       // SV nginx that proxies the Amulet token-standard registry
  registryHost: string;   // Host header the registry proxy expects
  auth: AuthConfig;        // how to obtain the ledger API bearer token
  adminUser: string;      // participant admin / ledger-api user (acts as the demo parties)
  walletUser: string;     // the validator wallet user (owns the requester party) — LocalNet only
  packageId: string;      // sage-canton main package id (used to qualify create/exercise commands)
  packageName: string;    // sage-canton package NAME (used to qualify ACS/query template filters)
  port: number;           // REST API port
  // Pre-provisioned party ids (Seaport: filled after the party model is decided; §5).
  parties: { provider: string; requester: string; worker: string; arbiter: string };
}

// Treat an unset OR empty-string env var as absent, so a blank line copied from
// .env.example (e.g. `SEAPORT_OIDC_TOKEN_URL=`) falls back to the baked-in default
// instead of overriding it with "".
const env = (k: string, d: string): string => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const target = env('LEDGER_TARGET', 'localnet') as Target;

const parties = {
  provider: env('SAGE_PROVIDER_PARTY', ''),
  requester: env('SAGE_REQUESTER_PARTY', ''),
  worker: env('SAGE_WORKER_PARTY', ''),
  arbiter: env('SAGE_ARBITER_PARTY', ''),
};

const localnet: Config = {
  target: 'localnet',
  ledgerApi: env('LEDGER_API', 'http://localhost:2975'),
  validatorApi: env('VALIDATOR_API', 'http://localhost:2903'),
  registry: env('REGISTRY_API', 'http://localhost:4000'),
  registryHost: env('REGISTRY_HOST', 'scan.localhost'),
  auth: { mode: 'self-mint', secret: env('AUTH_SECRET', 'unsafe'), audience: env('AUTH_AUDIENCE', 'https://canton.network.global') },
  adminUser: env('ADMIN_USER', 'ledger-api-user'),
  walletUser: env('WALLET_USER', 'app-user'),
  // sage-canton 0.1.4 main package (rebuild + update if the contract changes; or set via env)
  packageId: env('PACKAGE_ID', '46b3e0f3c32331a880b566250dd33036d5b33ede0b0c80b1f672aa94f2296412'),
  packageName: env('PACKAGE_NAME', 'sage-canton'),
  port: Number(env('PORT', '8088')),
  parties,
};

const seaport: Config = {
  target: 'seaport-devnet',
  ledgerApi: env('SEAPORT_LEDGER_URL', 'https://ledger-api.validator.devnet.sandbox.fivenorth.io'),
  // No Splice wallet / scan.localhost proxy on the shared validator; guarded at call sites.
  validatorApi: env('VALIDATOR_API', ''),
  registry: env('REGISTRY_API', ''),
  registryHost: env('REGISTRY_HOST', ''),
  auth: {
    mode: 'oidc',
    tokenUrl: env('SEAPORT_OIDC_TOKEN_URL', 'https://auth.sandbox.fivenorth.io/application/o/token/'),
    clientId: env('SEAPORT_CLIENT_ID', 'validator-devnet-m2m'),
    clientSecret: env('SEAPORT_CLIENT_SECRET', ''),
    audience: env('SEAPORT_AUDIENCE', 'validator-devnet-m2m'),
    scope: env('SEAPORT_SCOPE', 'daml_ledger_api'),
  },
  // The m2m user acts as our parties; override if the shared validator uses a different user id.
  adminUser: env('ADMIN_USER', 'validator-devnet-m2m'),
  walletUser: env('WALLET_USER', ''),
  packageId: env('PACKAGE_ID', '46b3e0f3c32331a880b566250dd33036d5b33ede0b0c80b1f672aa94f2296412'),
  packageName: env('PACKAGE_NAME', 'sage-canton'),
  port: Number(env('PORT', '8088')),
  parties,
};

export const config: Config = target === 'seaport-devnet' ? seaport : localnet;

// CIP-0056 token-standard package ids (allocation-instruction interface) — stable 1.0.0.
export const ALLOCATION_INSTRUCTION_PKG =
  '275064aacfe99cea72ee0c80563936129563776f67415ef9f13e4297eecbc520';
export const HOLDING_INTERFACE =
  '718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding';
