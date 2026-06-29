#!/usr/bin/env python3
"""
sage-canton — EXTERNAL-PARTY SIGNING (self-custody) demo on cn-quickstart LocalNet.

An autonomous agent shouldn't have to trust a participant operator to hold its keys. Canton's
*external parties* let a party self-custody its signing key off the participant: the party's
on-ledger namespace IS the fingerprint of its public key, and every action it authorizes must
carry a signature from that key — produced via the v2 JSON Ledger API interactive submission
flow (`prepare` -> sign the transaction hash client-side -> `execute`).

This drives `TaskEscrow` with the WORKER as an external party:
  1. Generate an Ed25519 keypair client-side (the private key never leaves this process).
  2. Onboard the worker as an external party (`/v2/parties/external/generate-topology` ->
     sign the multi-hash -> `/v2/parties/external/allocate`). Its party id namespace equals
     the key fingerprint — proof the key, not the participant, controls the party.
  3. Positive: the worker exercises `Accept` via `prepare` -> sign the prepared-transaction
     hash with its key -> `execute`. Escrow -> Accepted.
  4. Negative (the self-custody proof): repeat `prepare`, but `execute` with a TAMPERED
     signature. The participant holds `CanActAs` for the worker at the API layer (it merely
     RELAYS the submission) yet the ledger REJECTS it — without the real key's signature no
     one, not even the hosting participant, can act as the party.

PREREQUISITES
  - cn-quickstart LocalNet up; App User JSON API :2975 (override via APP_USER_API).
  - The contract package vetted on the participant; pass its id via PACKAGE_ID (on a tainted
    dev-node lineage, use the `sage-canton-xc` stand-in — see ADR-0018 / the cross-participant
    runbook).

USAGE
  PACKAGE_ID=<id vetted on the participant> python3 scripts/external_signing_demo.py
"""
import json, urllib.request, hmac, hashlib, base64, uuid, time, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

AU = os.environ.get("APP_USER_API", "http://localhost:2975")
PKG = os.environ.get("PACKAGE_ID")
if not PKG:
    sys.exit("set PACKAGE_ID to a package vetted on the participant (see the module docstring)")
TE = f"{PKG}:TaskEscrow:TaskEscrow"

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def jwt(sub):
    h = b64u(b'{"alg":"HS256","typ":"JWT"}'); p = b64u(json.dumps({"sub": sub, "aud": "https://canton.network.global"}).encode())
    return f"{h}.{p}." + b64u(hmac.new(b"unsafe", f"{h}.{p}".encode(), hashlib.sha256).digest())
TOK = jwt("ledger-api-user")

def req(url, data=None):
    r = urllib.request.Request(url, data=(json.dumps(data).encode() if data is not None else None), method="POST" if data is not None else "GET")
    r.add_header("Authorization", "Bearer " + TOK)
    if data is not None: r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp: return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, e.read().decode()[:400]

def die(m, x): print("FAIL:", m, json.dumps(x)[:400] if isinstance(x, (dict, list)) else x); sys.exit(1)
def ed25519_sig(sk, b64hash): return base64.b64encode(sk.sign(base64.b64decode(b64hash))).decode()
def sig_obj(sig_b64, fp): return {"format": "SIGNATURE_FORMAT_CONCAT", "signature": sig_b64, "signedBy": fp, "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}

def onboard_external_party(hint):
    """Generate an Ed25519 key client-side and onboard `hint` as an external (self-custodied) party."""
    st, sy = req(f"{AU}/v2/state/connected-synchronizers")
    sync = sy["connectedSynchronizers"][0]["synchronizerId"]
    sk = Ed25519PrivateKey.generate()
    pub_b64 = base64.b64encode(sk.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).decode()
    st, g = req(f"{AU}/v2/parties/external/generate-topology", {
        "synchronizer": sync, "partyHint": hint,
        "publicKey": {"format": "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", "keyData": pub_b64, "keySpec": "SIGNING_KEY_SPEC_EC_CURVE25519"},
        "otherConfirmingParticipantUids": []})
    if st != 200: die("generate-topology", g)
    party, fp, txs, multihash = g["partyId"], g["publicKeyFingerprint"], g["topologyTransactions"], g["multiHash"]
    st, a = req(f"{AU}/v2/parties/external/allocate", {
        "synchronizer": sync, "onboardingTransactions": [{"transaction": t} for t in txs],
        "multiHashSignatures": [sig_obj(ed25519_sig(sk, multihash), fp)]})
    if st != 200: die("external/allocate", a)
    return {"party": party, "fp": fp, "sk": sk, "sync": sync}

def allocate(hint):
    st, r = req(f"{AU}/v2/parties", {"partyIdHint": hint, "identityProviderId": ""})
    if st != 200: die("allocate " + hint, r)
    return r["partyDetails"]["party"]

def grant(rights):
    st, r = req(f"{AU}/v2/users/ledger-api-user/rights", {"userId": "ledger-api-user", "rights": rights, "identityProviderId": ""})
    if st != 200: die("grant", r)

def create_escrow(provider, requester, worker, arbiter, ref):
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()); dl = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
    ce = {"CreateCommand": {"templateId": TE, "createArguments": {"provider": provider, "requester": requester, "worker": worker, "arbiter": arbiter,
          "taskRef": ref, "amount": "100.0", "instrumentId": {"admin": "DSO::x", "id": "Amulet"}, "status": "Created", "createdAt": now, "deadline": dl, "resultRef": None}}}
    body = {"commands": {"commands": [ce], "commandId": "c-" + uuid.uuid4().hex, "actAs": [provider, requester]},
            "transactionFormat": {"eventFormat": {"filtersByParty": {p: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": True}}}}]} for p in (provider, requester)}, "verbose": True}, "transactionShape": "TRANSACTION_SHAPE_ACS_DELTA"}}
    st, r = req(f"{AU}/v2/commands/submit-and-wait-for-transaction", body)
    if st != 200: die("create escrow", r)
    return next(c["contractId"] for e in r["transaction"]["events"] for c in [e.get("CreatedEvent")] if c and c.get("templateId", "").endswith(":TaskEscrow:TaskEscrow"))

def prepare_accept(worker, esc):
    st, pr = req(f"{AU}/v2/interactive-submission/prepare", {
        "userId": "ledger-api-user", "commandId": "c-" + uuid.uuid4().hex, "synchronizerId": SYNC, "verboseHashing": False,
        "packageIdSelectionPreference": [], "actAs": [worker],
        "commands": [{"ExerciseCommand": {"templateId": TE, "contractId": esc, "choice": "Accept", "choiceArgument": {}}}]})
    if st != 200: die("prepare", pr)
    return pr["preparedTransaction"], pr["preparedTransactionHash"], pr["hashingSchemeVersion"]

def execute(worker, prepared, signature_b64, fp, hsv):
    return req(f"{AU}/v2/interactive-submission/execute", {
        "preparedTransaction": prepared,
        "partySignatures": {"signatures": [{"party": worker, "signatures": [sig_obj(signature_b64, fp)]}]},
        "deduplicationPeriod": {"Empty": {}}, "submissionId": "s-" + uuid.uuid4().hex, "userId": "ledger-api-user", "hashingSchemeVersion": hsv})

def escrow_status(party, ref):
    # match by taskRef, not contractId: a consuming choice (Accept) archives the old contract
    # and creates a new one with the SAME taskRef but a different contractId.
    st, le = req(f"{AU}/v2/state/ledger-end")
    body = {"filter": {"filtersByParty": {party: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}}}, "verbose": True, "activeAtOffset": le["offset"]}
    st, acs = req(f"{AU}/v2/state/active-contracts", body)
    for it in (acs if isinstance(acs, list) else []):
        ce = (it.get("contractEntry", {}).get("JsActiveContract") or {}).get("createdEvent") or {}
        arg = ce.get("createArgument", {})
        if ce.get("templateId", "").endswith(":TaskEscrow:TaskEscrow") and arg.get("taskRef") == ref: return arg.get("status")
    return None

def main():
    global SYNC
    print("=== onboard the WORKER as an external (self-custodied) party ===")
    sfx = uuid.uuid4().hex[:5]
    w = onboard_external_party(f"extworker-{sfx}"); SYNC = w["sync"]
    print("  worker party id:", w["party"])
    print("  key fingerprint:", w["fp"])
    print("  -> the party-id namespace EQUALS the key fingerprint: the key controls the party\n")

    provider, requester, arbiter = allocate(f"prov-{sfx}"), allocate(f"req-{sfx}"), allocate(f"arb-{sfx}")
    # the participant gets CanActAs for its own parties AND for the external worker — but holding
    # CanActAs only lets it RELAY the worker's submissions; it has no key, so it cannot authorize one.
    grant([{"kind": {"CanActAs": {"value": {"party": p}}}} for p in (provider, requester, arbiter, w["party"])])

    print("=== POSITIVE: worker authorizes Accept with its own key (prepare -> sign -> execute) ===")
    ref1 = "ext-pos-" + sfx
    esc1 = create_escrow(provider, requester, w["party"], arbiter, ref1)
    prepared, phash, hsv = prepare_accept(w["party"], esc1)
    print("  prepared; hash:", phash[:28], "... scheme", hsv)
    st, r = execute(w["party"], prepared, ed25519_sig(w["sk"], phash), w["fp"], hsv)
    print("  execute (valid signature):", st)
    if st != 200: die("execute valid", r)
    time.sleep(3)
    s1 = escrow_status(provider, ref1)
    print("  escrow status:", s1, "(expect Accepted)\n")

    print("=== NEGATIVE: same flow but a TAMPERED signature — the participant cannot forge ===")
    ref2 = "ext-neg-" + sfx
    esc2 = create_escrow(provider, requester, w["party"], arbiter, ref2)
    prepared2, phash2, hsv2 = prepare_accept(w["party"], esc2)
    bad_sig = base64.b64encode(Ed25519PrivateKey.generate().sign(base64.b64decode(phash2))).decode()  # signed by the WRONG key
    st, r = execute(w["party"], prepared2, bad_sig, w["fp"], hsv2)
    print("  execute (tampered signature):", st, "(expect NOT 200 — rejected)")
    time.sleep(2)
    s2 = escrow_status(provider, ref2)
    print("  escrow #2 status:", s2, "(expect Created — the bad-signature Accept did NOT commit)\n")

    ok = (s1 == "Accepted") and (st != 200) and (s2 == "Created")
    print("*** EXTERNAL-PARTY SELF-CUSTODY", "VERIFIED ***" if ok else "— CHECKS FAILED ***")
    print("    valid key signature -> committed; wrong signature -> rejected; the hosting")
    print("    participant relays but cannot authorize without the worker's own key.")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
