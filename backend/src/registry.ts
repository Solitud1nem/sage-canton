// Client for the Amulet CIP-0056 token-standard registry (off-ledger choice contexts).
//
// Uses node:http (not fetch): the registry is reached through the SV nginx, which routes by
// a `Host: scan.localhost` header — and fetch/undici silently drops a custom Host header.
import http from 'node:http';
import { URL } from 'node:url';
import { config } from './config.js';
import { getAdminToken } from './jwt.js';
import type { DisclosedContract } from './types.js';

export interface ChoiceContextResult {
  factoryId?: string;                 // only for the allocation factory
  context: Record<string, unknown>;   // choiceContextData -> ExtraArgs.context
  disclosed: DisclosedContract[];
}

const pickDisclosed = (raw: any[]): DisclosedContract[] =>
  raw.map((d) => ({ templateId: d.templateId, contractId: d.contractId, createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId }));

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  // Seaport (no registryHost) → the validator scan-proxy over HTTPS with our Bearer token.
  if (!config.registryHost) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await getAdminToken()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${config.registry}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: res.status, json };
  }
  // LocalNet → SV nginx routed by a `Host: scan.localhost` header (fetch drops custom Host, so node:http).
  const u = new URL(`${config.registry}${path}`);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { Host: config.registryHost };
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(data)); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }); } catch { resolve({ status: res.statusCode ?? 0, json: text }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const reg = (path: string, body: unknown) => request('POST', path, body);

export class RegistryClient {
  /** The registry admin party (= DSO / Amulet instrument admin). */
  async adminParty(): Promise<string> {
    const { status, json } = await request('GET', '/registry/metadata/v1/info');
    if (status !== 200) throw new Error(`registry info ${status}`);
    return (json as { adminId: string }).adminId;
  }

  /** Resolve the allocation factory + choice context for an AllocationFactory_Allocate. */
  async allocationFactory(choiceArguments: unknown): Promise<ChoiceContextResult> {
    const { status, json } = await reg('/registry/allocation-instruction/v1/allocation-factory', { choiceArguments, excludeDebitedHoldings: false });
    if (status !== 200) throw new Error(`allocation-factory ${status}: ${JSON.stringify(json).slice(0, 300)}`);
    return { factoryId: json.factoryId, context: json.choiceContext.choiceContextData, disclosed: pickDisclosed(json.choiceContext.disclosedContracts) };
  }

  /** Choice context to execute (or withdraw) an allocation. Retries while scan ingests it. */
  async allocationChoiceContext(allocationId: string, kind: 'execute-transfer' | 'withdraw' | 'cancel'): Promise<ChoiceContextResult> {
    let last: unknown;
    for (let i = 0; i < 15; i++) {
      const { status, json } = await reg(`/registry/allocations/v1/${allocationId}/choice-contexts/${kind}`, { meta: {} });
      if (status === 200) return { context: json.choiceContextData, disclosed: pickDisclosed(json.disclosedContracts) };
      last = json;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${kind} context: ${JSON.stringify(last).slice(0, 300)}`);
  }
}
