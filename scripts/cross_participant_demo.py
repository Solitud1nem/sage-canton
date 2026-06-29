#!/usr/bin/env python3
"""
sage-canton — CROSS-PARTICIPANT privacy demo on cn-quickstart LocalNet.

The headline differentiator. A `TaskEscrow` whose stakeholders live on DIFFERENT Canton
participants — `requester` + `provider` on the **App User** participant, `worker` on the
**App Provider** participant — and yet Canton's sub-transaction privacy still holds: the
escrow replicates only to the participants hosting its stakeholders, scoped per party.

What it proves, end-to-end on a real two-participant node (all over the v2 JSON Ledger API):
  1. Create on App User (signatories requester+provider) with `worker` as an observer whose
     home participant is App Provider.
  2. Visibility:  requester @ App User -> sees 1 ;  outsider @ App User -> sees 0
                  worker    @ App Provider -> sees 1 (CROSS-PARTICIPANT) ;  outsider @ App Provider -> 0
  3. The worker exercises `Accept` from App Provider (its home participant authorizes for it —
     no shared custody, no `CanActAs` held by the other participant), and the state change
     propagates back so the App User provider sees status `Accepted`.

No external-party signing is needed here: each participant hosts and signs for ITS OWN
parties. (External signing / self-custody — `prepare`/`execute` interactive submission — is
the next layer; see ADR-0018.)

PREREQUISITES
  - cn-quickstart LocalNet up; App User JSON API :2975, App Provider :3975, both connected to
    the same global synchronizer (this script asserts that).
  - The contract package must be VETTED ON BOTH participants. On a fresh participant just
    upload the DAR to :2975 and :3975. On a dev node whose `sage-canton` package lineage is
    already tainted (a prior, different v0.1.x was vetted), build the package under a fresh
    NAME (e.g. `sage-canton-xc`) so it vets cleanly on both, and pass its id below.

USAGE
  PACKAGE_ID=<id vetted on BOTH participants> python3 scripts/cross_participant_demo.py
  # optional overrides: APP_USER_API / APP_PROVIDER_API (defaults :2975 / :3975)
"""
import json, urllib.request, hmac, hashlib, base64, uuid, time, os, sys

AU = os.environ.get("APP_USER_API", "http://localhost:2975")       # requester/provider home
AP = os.environ.get("APP_PROVIDER_API", "http://localhost:3975")   # worker home
PKG = os.environ.get("PACKAGE_ID")
if not PKG:
    sys.exit("set PACKAGE_ID to a package vetted on BOTH participants (see the module docstring)")
TE = f"{PKG}:TaskEscrow:TaskEscrow"

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def jwt(sub, aud="https://canton.network.global", secret="unsafe"):
    h = b64(b'{"alg":"HS256","typ":"JWT"}'); p = b64(json.dumps({"sub": sub, "aud": aud}).encode())
    return f"{h}.{p}." + b64(hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
TOK = jwt("ledger-api-user")

def req(url, data=None, method=None):
    r = urllib.request.Request(url, data=(json.dumps(data).encode() if data is not None else None),
                               method=method or ("POST" if data is not None else "GET"))
    r.add_header("Authorization", "Bearer " + TOK)
    if data is not None: r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp: return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, e.read().decode()[:300]

def die(m, x): print("FAIL:", m, json.dumps(x)[:400] if isinstance(x, (dict, list)) else x); sys.exit(1)

def synchronizers(base):
    st, r = req(f"{base}/v2/state/connected-synchronizers")
    return [s.get("synchronizerId") for s in r.get("connectedSynchronizers", [])] if isinstance(r, dict) else []

def allocate(base, hint):
    st, r = req(f"{base}/v2/parties", {"partyIdHint": hint, "identityProviderId": ""})
    if st != 200: die("allocate " + hint, r)
    return r["partyDetails"]["party"]

def grant(base, parties):
    rights = [{"kind": {"CanActAs": {"value": {"party": p}}}} for p in parties]
    st, r = req(f"{base}/v2/users/ledger-api-user/rights", {"userId": "ledger-api-user", "rights": rights, "identityProviderId": ""})
    if st != 200: die("grant rights", r)

def count_escrows(base, party):
    st, le = req(f"{base}/v2/state/ledger-end")
    body = {"filter": {"filtersByParty": {party: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}}},
            "verbose": False, "activeAtOffset": le["offset"]}
    st, r = req(f"{base}/v2/state/active-contracts", body)
    return sum(1 for it in (r if isinstance(r, list) else [])
               if (((it.get("contractEntry", {}).get("JsActiveContract") or {}).get("createdEvent") or {}).get("templateId", "").endswith(":TaskEscrow:TaskEscrow")))

def escrow_status(base, party):
    st, le = req(f"{base}/v2/state/ledger-end")
    body = {"filter": {"filtersByParty": {party: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}}},
            "verbose": True, "activeAtOffset": le["offset"]}
    st, r = req(f"{base}/v2/state/active-contracts", body)
    for it in (r if isinstance(r, list) else []):
        ce = (it.get("contractEntry", {}).get("JsActiveContract") or {}).get("createdEvent") or {}
        if ce.get("templateId", "").endswith(":TaskEscrow:TaskEscrow"):
            return ce.get("createArgument", {}).get("status")
    return None

def submit(base, cmds, act):
    body = {"commands": {"commands": cmds, "commandId": "c-" + uuid.uuid4().hex, "actAs": act},
            "transactionFormat": {"eventFormat": {"filtersByParty": {p: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": True}}}}]} for p in act}, "verbose": True}, "transactionShape": "TRANSACTION_SHAPE_ACS_DELTA"}}
    return req(f"{base}/v2/commands/submit-and-wait-for-transaction", body)

def main():
    # 0. both participants must share a synchronizer for cross-participant contracts to flow
    su, sp = synchronizers(AU), synchronizers(AP)
    print("App User synchronizers:    ", su)
    print("App Provider synchronizers:", sp)
    if not (set(su) & set(sp)): die("participants share no synchronizer", {"au": su, "ap": sp})
    print("shared synchronizer: OK\n")

    sfx = uuid.uuid4().hex[:5]
    print("=== allocate parties on their HOME participants ===")
    worker = allocate(AP, f"xworker-{sfx}"); grant(AP, [worker]);   print("  worker     @ App Provider:", worker)
    apOut  = allocate(AP, f"xapout-{sfx}");  grant(AP, [apOut])
    provider  = allocate(AU, f"xprov-{sfx}")
    requester = allocate(AU, f"xreq-{sfx}")
    arbiter   = allocate(AU, f"xarb-{sfx}")
    auOut     = allocate(AU, f"xauout-{sfx}")
    grant(AU, [provider, requester, arbiter, auOut]);               print("  prov/req/arb/outsider @ App User")

    print("\n=== create TaskEscrow on App User (signatories provider+requester; worker is observer) ===")
    inst = {"admin": "DSO::placeholder", "id": "Amulet"}   # instrument isn't exercised in this privacy-only demo
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    dl  = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
    ce = {"CreateCommand": {"templateId": TE, "createArguments": {"provider": provider, "requester": requester, "worker": worker,
          "arbiter": arbiter, "taskRef": "xc-" + sfx, "amount": "100.0", "instrumentId": inst, "status": "Created", "createdAt": now, "deadline": dl, "resultRef": None}}}
    st, r = submit(AU, [ce], [provider, requester])
    if st != 200: die("create (is the package vetted on BOTH participants?)", r)
    esc = next((c["contractId"] for e in r["transaction"]["events"] for c in [e.get("CreatedEvent")] if c and c.get("templateId", "").endswith(":TaskEscrow:TaskEscrow")), None)
    print("  created escrow:", esc[:24])

    print("\n=== visibility (cross-participant privacy) ===")
    time.sleep(3)
    checks = [
        ("App User    / requester (stakeholder)", count_escrows(AU, requester), 1),
        ("App User    / outsider  (no stake)   ", count_escrows(AU, auOut), 0),
        ("App Provider/ worker    (observer XC)", count_escrows(AP, worker), 1),
        ("App Provider/ outsider  (no stake)   ", count_escrows(AP, apOut), 0),
    ]
    ok = True
    for label, got, want in checks:
        flag = "OK" if got == want else "*** MISMATCH ***"; ok = ok and got == want
        print(f"  {label} sees {got}  (expect {want})  {flag}")

    print("\n=== worker Accepts from App Provider (its home participant authorizes; no shared custody) ===")
    st, r = submit(AP, [{"ExerciseCommand": {"templateId": TE, "contractId": esc, "choice": "Accept", "choiceArgument": {}}}], [worker])
    if st != 200: die("cross-participant Accept", r)
    time.sleep(3)
    status = escrow_status(AU, provider)
    print(f"  App User / provider now sees status: {status}  (expect Accepted)")
    ok = ok and status == "Accepted"

    print("\n*** CROSS-PARTICIPANT PRIVACY", "VERIFIED ***" if ok else "— CHECKS FAILED ***")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
