// Runtime configuration for the sage-canton backend.
//
// Defaults target a local cn-quickstart LocalNet (Daml 3.4.x / Splice 0.5.x) in
// shared-secret auth mode. Override via env for other deployments.

export interface Config {
  ledgerApi: string;      // v2 JSON Ledger API base (app-user participant)
  validatorApi: string;   // Splice validator wallet API (tap, balances)
  registry: string;       // SV nginx that proxies the Amulet token-standard registry
  registryHost: string;   // Host header the registry proxy expects
  authSecret: string;     // HS256 shared secret
  authAudience: string;   // JWT audience the participant expects
  adminUser: string;      // participant admin / ledger-api user (acts as the demo parties)
  walletUser: string;     // the validator wallet user (owns the requester party)
  packageId: string;      // sage-canton main package id (the uploaded DAR)
  port: number;           // REST API port
}

const env = (k: string, d: string): string => process.env[k] ?? d;

export const config: Config = {
  ledgerApi: env('LEDGER_API', 'http://localhost:2975'),
  validatorApi: env('VALIDATOR_API', 'http://localhost:2903'),
  registry: env('REGISTRY_API', 'http://localhost:4000'),
  registryHost: env('REGISTRY_HOST', 'scan.localhost'),
  authSecret: env('AUTH_SECRET', 'unsafe'),
  authAudience: env('AUTH_AUDIENCE', 'https://canton.network.global'),
  adminUser: env('ADMIN_USER', 'ledger-api-user'),
  walletUser: env('WALLET_USER', 'app-user'),
  // sage-canton 0.1.2 main package (rebuild + update if the contract changes; or set via env)
  packageId: env('PACKAGE_ID', '8ca20596e9704ccff991ae8a4f5d4aacf333c7b28dbe79f08ba8d870fed140d6'),
  port: Number(env('PORT', '8088')),
};

// CIP-0056 token-standard package ids (allocation-instruction interface) — stable 1.0.0.
export const ALLOCATION_INSTRUCTION_PKG =
  '275064aacfe99cea72ee0c80563936129563776f67415ef9f13e4297eecbc520';
export const HOLDING_INTERFACE =
  '718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding';
