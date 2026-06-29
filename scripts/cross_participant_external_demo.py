#!/usr/bin/env python3
"""
sage-canton — the FULL institutional story: cross-participant privacy + external self-custody.

Combines both differentiators in one flow. The worker is an autonomous agent that:
  - is hosted on a DIFFERENT participant (App Provider) from the requester/provider (App User), and
  - is an EXTERNAL party whose Ed25519 key is generated client-side (self-custody) — the
    hosting participant never holds its key.

So the escrow's terms stay private to its stakeholders ACROSS organisations, and the worker
authorizes its own actions by signature — no operator can see the escrow it isn't party to,
and none can act for the worker.

Flow (all over the v2 JSON Ledger API):
  1. Onboard the worker as an external party ON App Provider (key client-side; party-id
     namespace == key fingerprint).
  2. Create the escrow on App User (signatories requester+provider) with the external worker
     as observer. Visibility: worker @ App Provider sees 1; outsiders on either participant 0.
  3. The worker exercises Accept from App Provider via interactive submission: prepare ->
     sign the prepared-tx hash with its own key -> execute. The escrow becomes Accepted,
     authorized cross-participant by the worker's signature alone.

PREREQUISITES
  - cn-quickstart LocalNet up; App User JSON API :2975, App Provider :3975, same synchronizer.
  - Package vetted on BOTH participants; pass PACKAGE_ID (use the `sage-canton-xc` stand-in on
    a tainted dev-node lineage — see ADR-0018 / the cross-participant runbook).

USAGE
  PACKAGE_ID=<id vetted on both> python3 scripts/cross_participant_external_demo.py
  # optional: APP_USER_API / APP_PROVIDER_API (defaults :2975 / :3975)
"""
import json, urllib.request, hmac, hashlib, base64, uuid, time, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

AU = os.environ.get("APP_USER_API", "http://localhost:2975")       # requester/provider home
AP = os.environ.get("APP_PROVIDER_API", "http://localhost:3975")   # external worker home
PKG = os.environ.get("PACKAGE_ID")
if not PKG:
    sys.exit("set PACKAGE_ID to a package vetted on BOTH participants (see the module docstring)")
TE = f"{PKG}:TaskEscrow:TaskEscrow"

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def jwt(sub):
    h = b64u(b'{"alg":"HS256","typ":"JWT"}'); p = b64u(json.dumps({"sub": sub, "aud": "https://canton.network.global"}).encode())
    return f"{h}.{p}." + b64u(hmac.new(b"unsafe", f"{h}.{p}".encode(), hashlib.sha256).digest())
TOK = jwt("ledger-api-user")

def req(base, path, data=None):
    r = urllib.request.Request(base + path, data=(json.dumps(data).encode() if data is not None else None), method="POST" if data is not None else "GET")
    r.add_header("Authorization", "Bearer " + TOK)
    if data is not None: r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp: return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, e.read().decode()[:400]

def die(m, x): print("FAIL:", m, json.dumps(x)[:400] if isinstance(x, (dict, list)) else x); sys.exit(1)
def sig_obj(sig_b64, fp): return {"format": "SIGNATURE_FORMAT_CONCAT", "signature": sig_b64, "signedBy": fp, "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}
def ed_sign(sk, b64hash): return base64.b64encode(sk.sign(base64.b64decode(b64hash))).decode()

def onboard_external(base, hint, sync):
    """Generate an Ed25519 key client-side and onboard `hint` as an external party hosted on `base`."""
    sk = Ed25519PrivateKey.generate()
    pub_b64 = base64.b64encode(sk.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).decode()
    st, g = req(base, "/v2/parties/external/generate-topology", {
        "synchronizer": sync, "partyHint": hint,
        "publicKey": {"format": "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", "keyData": pub_b64, "keySpec": "SIGNING_KEY_SPEC_EC_CURVE25519"},
        "otherConfirmingParticipantUids": []})
    if st != 200: die("generate-topology", g)
    st, a = req(base, "/v2/parties/external/allocate", {
        "synchronizer": sync, "onboardingTransactions": [{"transaction": t} for t in g["topologyTransactions"]],
        "multiHashSignatures": [sig_obj(ed_sign(sk, g["multiHash"]), g["publicKeyFingerprint"])]})
    if st != 200: die("external/allocate", a)
    return {"party": g["partyId"], "fp": g["publicKeyFingerprint"], "sk": sk}

def allocate(base, hint):
    st, r = req(base, "/v2/parties", {"partyIdHint": hint, "identityProviderId": ""})
    if st != 200: die("allocate " + hint, r)
    return r["partyDetails"]["party"]

def grant(base, rights):
    st, r = req(base, "/v2/users/ledger-api-user/rights", {"userId": "ledger-api-user", "rights": rights, "identityProviderId": ""})
    if st != 200: die("grant", r)

def count_escrows(base, party):
    st, le = req(base, "/v2/state/ledger-end")
    body = {"filter": {"filtersByParty": {party: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}}}, "verbose": False, "activeAtOffset": le["offset"]}
    st, r = req(base, "/v2/state/active-contracts", body)
    return sum(1 for it in (r if isinstance(r, list) else [])
               if (((it.get("contractEntry", {}).get("JsActiveContract") or {}).get("createdEvent") or {}).get("templateId", "").endswith(":TaskEscrow:TaskEscrow")))

def escrow_status(base, party, ref):
    st, le = req(base, "/v2/state/ledger-end")
    body = {"filter": {"filtersByParty": {party: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}}}, "verbose": True, "activeAtOffset": le["offset"]}
    st, acs = req(base, "/v2/state/active-contracts", body)
    for it in (acs if isinstance(acs, list) else []):
        ce = (it.get("contractEntry", {}).get("JsActiveContract") or {}).get("createdEvent") or {}
        arg = ce.get("createArgument", {})
        if ce.get("templateId", "").endswith(":TaskEscrow:TaskEscrow") and arg.get("taskRef") == ref: return arg.get("status")
    return None

def main():
    su = req(AU, "/v2/state/connected-synchronizers")[1]["connectedSynchronizers"][0]["synchronizerId"]
    sp = req(AP, "/v2/state/connected-synchronizers")[1]["connectedSynchronizers"][0]["synchronizerId"]
    if su != sp: die("participants share no synchronizer", {"au": su, "ap": sp})
    SYNC = su; sfx = uuid.uuid4().hex[:5]
    print("shared synchronizer:", SYNC, "\n")

    print("=== onboard the worker as an EXTERNAL party on App Provider (self-custody) ===")
    w = onboard_external(AP, f"extworker-{sfx}", SYNC)
    print("  worker party id:", w["party"])
    print("  key fingerprint:", w["fp"], "(== namespace: the key controls the party)\n")
    apOut = allocate(AP, f"apout-{sfx}")
    grant(AP, [{"kind": {"CanActAs": {"value": {"party": w["party"]}}}},   # App Provider may RELAY the worker's signed submissions
               {"kind": {"CanActAs": {"value": {"party": apOut}}}}])

    provider, requester, arbiter, auOut = (allocate(AU, f"prov-{sfx}"), allocate(AU, f"req-{sfx}"), allocate(AU, f"arb-{sfx}"), allocate(AU, f"auout-{sfx}"))
    grant(AU, [{"kind": {"CanActAs": {"value": {"party": p}}}} for p in (provider, requester, arbiter, auOut)])

    print("=== create the escrow on App User (signatories provider+requester; external worker observer) ===")
    ref = "xce-" + sfx
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()); dl = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
    ce = {"CreateCommand": {"templateId": TE, "createArguments": {"provider": provider, "requester": requester, "worker": w["party"], "arbiter": arbiter,
          "taskRef": ref, "amount": "100.0", "instrumentId": {"admin": "DSO::x", "id": "Amulet"}, "status": "Created", "createdAt": now, "deadline": dl, "resultRef": None}}}
    body = {"commands": {"commands": [ce], "commandId": "c-" + uuid.uuid4().hex, "actAs": [provider, requester]},
            "transactionFormat": {"eventFormat": {"filtersByParty": {p: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": True}}}}]} for p in (provider, requester)}, "verbose": True}, "transactionShape": "TRANSACTION_SHAPE_ACS_DELTA"}}
    st, r = req(AU, "/v2/commands/submit-and-wait-for-transaction", body)
    if st != 200: die("create (package vetted on both participants?)", r)
    esc = next(c["contractId"] for e in r["transaction"]["events"] for c in [e.get("CreatedEvent")] if c and c.get("templateId", "").endswith(":TaskEscrow:TaskEscrow"))
    print("  created escrow:", esc[:24], "\n")

    print("=== cross-participant privacy ===")
    time.sleep(3)
    checks = [("App User    / requester (stakeholder)", count_escrows(AU, requester), 1),
              ("App User    / outsider  (no stake)   ", count_escrows(AU, auOut), 0),
              ("App Provider/ worker    (external XC)", count_escrows(AP, w["party"]), 1),
              ("App Provider/ outsider  (no stake)   ", count_escrows(AP, apOut), 0)]
    okv = True
    for label, got, want in checks:
        okv = okv and got == want; print(f"  {label} sees {got} (expect {want}) {'OK' if got==want else '*** MISMATCH ***'}")

    print("\n=== worker Accepts from App Provider, authorized by ITS OWN key (prepare -> sign -> execute) ===")
    st, pr = req(AP, "/v2/interactive-submission/prepare", {
        "userId": "ledger-api-user", "commandId": "c-" + uuid.uuid4().hex, "synchronizerId": SYNC, "verboseHashing": False,
        "packageIdSelectionPreference": [], "actAs": [w["party"]],
        "commands": [{"ExerciseCommand": {"templateId": TE, "contractId": esc, "choice": "Accept", "choiceArgument": {}}}]})
    if st != 200: die("prepare", pr)
    print("  prepared on App Provider; hash:", pr["preparedTransactionHash"][:28], "...")
    st, er = req(AP, "/v2/interactive-submission/execute", {
        "preparedTransaction": pr["preparedTransaction"],
        "partySignatures": {"signatures": [{"party": w["party"], "signatures": [sig_obj(ed_sign(w["sk"], pr["preparedTransactionHash"]), w["fp"])]}]},
        "deduplicationPeriod": {"Empty": {}}, "submissionId": "s-" + uuid.uuid4().hex, "userId": "ledger-api-user", "hashingSchemeVersion": pr["hashingSchemeVersion"]})
    print("  execute (worker's signature):", st)
    if st != 200: die("execute", er)
    time.sleep(3)
    status = escrow_status(AU, provider, ref)
    print(f"  App User / provider sees status: {status} (expect Accepted)")

    ok = okv and status == "Accepted"
    print("\n*** CROSS-PARTICIPANT + SELF-CUSTODY", "VERIFIED ***" if ok else "— CHECKS FAILED ***")
    print("    A privately-shared escrow spanning two organisations, its worker an external")
    print("    self-custodied agent that authorized its own action across the participant boundary.")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
