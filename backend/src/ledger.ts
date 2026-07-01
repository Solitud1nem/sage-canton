// Thin typed client for the Canton v2 JSON Ledger API.
import { config, HOLDING_INTERFACE } from './config.js';
import { getAdminToken, clearToken } from './jwt.js';
import type { ContractId, DisclosedContract, Party } from './types.js';

export interface CreatedEvent {
  contractId: ContractId;
  templateId: string;
  createArgument?: Record<string, unknown>;
  createdEventBlob?: string;
  interfaceViews?: { viewValue: Record<string, unknown> }[];
}
interface TxEvent { CreatedEvent?: CreatedEvent; ArchivedEvent?: unknown; ExercisedEvent?: { exerciseResult?: unknown } }
export interface Transaction { updateId: string; events: TxEvent[] }

export type Command =
  | { CreateCommand: { templateId: string; createArguments: Record<string, unknown> } }
  | { ExerciseCommand: { templateId: string; contractId: ContractId; choice: string; choiceArgument: Record<string, unknown> } };

async function http(method: string, url: string, body?: unknown, opts?: { token?: string; host?: string; raw?: Buffer }): Promise<{ status: number; json: any }> {
  const doFetch = async (token: string | undefined) => {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (opts?.host) headers['Host'] = opts.host;
    let payload: string | Uint8Array | undefined;
    if (opts?.raw) { headers['Content-Type'] = 'application/octet-stream'; payload = opts.raw; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: res.status, json };
  };

  // An explicit opts.token is caller-managed; an auto token can be refreshed on 401
  // (an 8h Seaport OIDC token may expire mid-session — clear the cache and retry once).
  if (opts?.token !== undefined) return doFetch(opts.token);
  const res = await doFetch(await getAdminToken());
  if (res.status !== 401) return res;
  clearToken();
  return doFetch(await getAdminToken());
}

export class LedgerClient {
  constructor(private base = config.ledgerApi) {}

  /** Submit commands and wait for the resulting transaction (with created-event blobs). */
  async submit(commands: Command[], actAs: Party[], disclosed?: DisclosedContract[]): Promise<Transaction> {
    const inner: Record<string, unknown> = { commands, commandId: `c-${crypto.randomUUID()}`, actAs };
    if (disclosed) inner['disclosedContracts'] = disclosed;
    const filtersByParty = Object.fromEntries(
      actAs.map((p) => [p, { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: true } } } }] }]),
    );
    const body = { commands: inner, transactionFormat: { eventFormat: { filtersByParty, verbose: true }, transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA' } };
    const { status, json } = await http('POST', `${this.base}/v2/commands/submit-and-wait-for-transaction`, body);
    if (status !== 200) throw new LedgerError('submit', status, json);
    return json.transaction as Transaction;
  }

  /** Active contracts of a template or interface, with their interface/payload views. */
  async activeContracts(party: Party, filter: { templateId?: string; interfaceId?: string }): Promise<CreatedEvent[]> {
    const end = await this.ledgerEnd();
    const idf = filter.interfaceId
      ? { InterfaceFilter: { value: { interfaceId: filter.interfaceId, includeInterfaceView: true, includeCreatedEventBlob: true } } }
      : { TemplateFilter: { value: { templateId: filter.templateId, includeCreatedEventBlob: true } } };
    const body = { filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: idf }] } } }, verbose: true, activeAtOffset: end };
    const { status, json } = await http('POST', `${this.base}/v2/state/active-contracts`, body);
    if (status !== 200) throw new LedgerError('activeContracts', status, json);
    const out: CreatedEvent[] = [];
    for (const item of Array.isArray(json) ? json : []) {
      const ce = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (ce) out.push(ce as CreatedEvent);
    }
    return out;
  }

  async ledgerEnd(): Promise<number> {
    const { status, json } = await http('GET', `${this.base}/v2/state/ledger-end`);
    if (status !== 200) throw new LedgerError('ledgerEnd', status, json);
    return json.offset as number;
  }

  /** Unlocked Amulet holdings of a party (cid + amount). */
  async amuletHoldings(party: Party): Promise<{ contractId: ContractId; amount: number }[]> {
    const evs = await this.activeContracts(party, { interfaceId: HOLDING_INTERFACE });
    const out: { contractId: ContractId; amount: number }[] = [];
    for (const ce of evs) {
      for (const iv of ce.interfaceViews ?? []) {
        const v = iv.viewValue as { instrumentId?: { id?: string }; owner?: string; amount?: string; lock?: unknown };
        if (v.instrumentId?.id === 'Amulet' && v.owner === party && !v.lock) {
          out.push({ contractId: ce.contractId, amount: Number(v.amount ?? '0') });
        }
      }
    }
    return out;
  }

  // --- admin operations (DAR upload, party allocation, rights) -------------
  async uploadDar(dar: Buffer): Promise<void> {
    const { status, json } = await http('POST', `${this.base}/v2/packages`, undefined, { raw: dar });
    if (status !== 200 && !(json?.code === 'KNOWN_PACKAGE_VERSION')) throw new LedgerError('uploadDar', status, json);
  }
  async allocateParty(hint: string): Promise<Party> {
    const { status, json } = await http('POST', `${this.base}/v2/parties`, { partyIdHint: hint, identityProviderId: '' });
    if (status !== 200) throw new LedgerError('allocateParty', status, json);
    return json.partyDetails.party as Party;
  }
  async grantActAs(user: string, parties: Party[]): Promise<void> {
    const rights = parties.map((party) => ({ kind: { CanActAs: { value: { party } } } }));
    const { status, json } = await http('POST', `${this.base}/v2/users/${user}/rights`, { userId: user, rights, identityProviderId: '' });
    if (status !== 200) throw new LedgerError('grantActAs', status, json);
  }
}

export class LedgerError extends Error {
  constructor(public op: string, public status: number, public detail: unknown) {
    super(`ledger ${op} failed (${status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`);
  }
}

/** First created event whose templateId ends with `suffix`. */
export function createdBySuffix(tx: Transaction, suffix: string): CreatedEvent | undefined {
  return tx.events.map((e) => e.CreatedEvent).find((ce): ce is CreatedEvent => !!ce && ce.templateId.endsWith(suffix));
}
