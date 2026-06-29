#!/usr/bin/env python3
"""
sage-canton — live CIP-0056 Amulet settlement demo against cn-quickstart LocalNet.

Drives a TaskEscrow through its full lifecycle on a REAL running node and settles it in
REAL Canton Coin (Amulet), entirely over HTTP (JSON Ledger API + the Amulet token-standard
registry). Proves the M3 settlement end-to-end — the worker's on-ledger Amulet balance
actually increases by the task reward.

Verified working 2026-06-29 against cn-quickstart (Daml 3.4.11 / Splice 0.5.3).

PREREQUISITES (one-time, see docs/setup/toolchain-and-references.md §4):
  - LocalNet up (`make start` in cn-quickstart/quickstart), ~15 containers healthy.
  - This project built: `dpm build` -> .daml/dist/sage-canton-<ver>.dar
  - `python3 setup` below uploads the DAR, allocates the worker/provider/arbiter parties on
    the app-user participant, and grants the ledger-api-user `CanActAs` rights.

USAGE:
  python3 scripts/live_settlement_demo.py setup           # upload DAR + allocate parties + grant
  python3 scripts/live_settlement_demo.py run             # happy path: ... -> SettlePayment (worker paid)
  python3 scripts/live_settlement_demo.py dispute-refund  # fund -> dispute -> SettleResolveRefund (locked funds returned)
  python3 scripts/live_settlement_demo.py dispute-pay     # fund -> dispute -> SettleResolvePayWorker (worker paid)

Endpoints / auth (shared-secret LocalNet): HS256 JWT, secret 'unsafe',
aud 'https://canton.network.global'. App-user participant JSON API :2975, validator :2903,
SV-nginx (registry proxy, Host: scan.localhost) :4000.
"""
import json, urllib.request, hmac, hashlib, base64, datetime, uuid, sys, glob, os

AU   = "http://localhost:2975"   # app-user participant — JSON Ledger API
VAL  = "http://localhost:2903"   # app-user validator — wallet API (tap)
SVN  = "http://localhost:4000"   # SV nginx — proxies /registry to the Amulet registry
# the production DAR only — exclude the sibling sage-canton-tests-*.dar (Script tests, never uploaded)
DAR  = sorted(d for d in glob.glob(os.path.join(os.path.dirname(__file__), "..", ".daml", "dist", "sage-canton-*.dar"))
              if "-tests-" not in os.path.basename(d))[-1]
AINST= "275064aacfe99cea72ee0c80563936129563776f67415ef9f13e4297eecbc520"  # allocation-instruction-v1
HOLDING_IFACE = "718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding"
PARTYFILE = os.path.join(os.path.dirname(__file__), "..", ".daml", "live-parties.json")

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
def jwt(sub, aud="https://canton.network.global", secret="unsafe"):
    h=b64(b'{"alg":"HS256","typ":"JWT"}'); p=b64(json.dumps({"sub":sub,"aud":aud}).encode())
    return f"{h}.{p}."+b64(hmac.new(secret.encode(),f"{h}.{p}".encode(),hashlib.sha256).digest())
TOK = jwt("ledger-api-user")   # participant admin + (after setup) CanActAs the demo parties
WTOK= jwt("app-user")          # the wallet user (owns the requester party)

def _req(url, data=None, tok=TOK, host=None, method=None):
    r=urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"))
    if tok: r.add_header("Authorization", f"Bearer {tok}")
    if data is not None: r.add_header("Content-Type", "application/json")
    if host: r.add_header("Host", host)
    try:
        with urllib.request.urlopen(r) as resp: return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, e.read().decode()
def post(url, body, **kw): return _req(url, json.dumps(body).encode(), **kw)
def get(url, **kw): return _req(url, None, **kw)
def die(m, r): print("FAIL:", m); print(json.dumps(r, indent=2)[:2500] if isinstance(r,(dict,list)) else str(r)[:2500]); sys.exit(1)

def pkgid():
    import zipfile
    with zipfile.ZipFile(DAR) as z:
        for n in z.namelist():
            base=os.path.basename(n)
            if base.startswith("sage-canton-") and base.endswith(".dalf"):
                h=base.rsplit("-",1)[-1][:-5]
                if len(h)==64: return h
    die("pkgid", DAR)

def dso():
    st,info=get(f"{SVN}/registry/metadata/v1/info", tok=None, host="scan.localhost")
    if st!=200: die("registry info", info)
    return info["adminId"]

def requester():
    st,us=get(f"{VAL}/api/validator/v0/wallet/user-status", tok=WTOK)
    if st!=200: die("user-status", us)
    return us["party_id"]

def submit(commands, act, disclosed=None):
    inner={"commands":commands,"commandId":"c-"+uuid.uuid4().hex,"actAs":act}
    if disclosed is not None: inner["disclosedContracts"]=disclosed
    body={"commands":inner,"transactionFormat":{"eventFormat":{
        "filtersByParty":{p:{"cumulative":[{"identifierFilter":{"WildcardFilter":{"value":{"includeCreatedEventBlob":True}}}}]} for p in act},
        "verbose":True},"transactionShape":"TRANSACTION_SHAPE_ACS_DELTA"}}
    return post(f"{AU}/v2/commands/submit-and-wait-for-transaction", body)
def ev_created(r, suffix):
    for e in r["transaction"]["events"]:
        ce=e.get("CreatedEvent")
        if ce and ce.get("templateId","").endswith(suffix): return ce
    return None

def holdings(party, unlocked_only=True):
    st,le=get(f"{AU}/v2/state/ledger-end")
    body={"filter":{"filtersByParty":{party:{"cumulative":[{"identifierFilter":{"InterfaceFilter":{"value":{
        "interfaceId":HOLDING_IFACE,"includeInterfaceView":True,"includeCreatedEventBlob":True}}}}]}}},
        "verbose":True,"activeAtOffset":le["offset"]}
    st,acs=post(f"{AU}/v2/state/active-contracts", body)
    out=[]
    for item in (acs if isinstance(acs,list) else []):
        ce=(item.get("contractEntry",{}).get("JsActiveContract") or {}).get("createdEvent") or {}
        for iv in ce.get("interfaceViews") or []:
            v=iv.get("viewValue") or {}
            if v.get("instrumentId",{}).get("id")=="Amulet" and v.get("owner")==party:
                if unlocked_only and v.get("lock"): continue
                out.append((ce["contractId"], float(v.get("amount","0"))))
    return out

def now_iso(dsec=0):
    t=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=dsec)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")

# -------------------------------------------------------------------- setup
def setup():
    print("DAR:", os.path.basename(DAR))
    with open(DAR,"rb") as f: dar=f.read()
    st,_=_req(f"{AU}/v2/packages", dar, method="POST")  # octet-stream upload
    print("upload DAR:", st if st==200 else f"(already vetted / {st})")
    parties={"requester":requester()}
    for role in ("provider","worker","arbiter"):
        st,r=post(f"{AU}/v2/parties", {"partyIdHint":f"l{role}-{uuid.uuid4().hex[:6]}","identityProviderId":""})
        if st!=200: die("allocate "+role, r)
        parties[role]=r["partyDetails"]["party"]
    rights=[{"kind":{"CanActAs":{"value":{"party":p}}}} for p in parties.values()]
    st,r=post(f"{AU}/v2/users/ledger-api-user/rights", {"userId":"ledger-api-user","rights":rights,"identityProviderId":""})
    if st!=200: die("grant rights", r)
    json.dump(parties, open(PARTYFILE,"w"), indent=2)
    print("parties:", json.dumps(parties, indent=2)); print("saved ->", PARTYFILE)

# -------------------------------------------------------------------- shared flow helpers
def _ctx(): return REQ,PROV,WORK,ARB,TE,INST,DSO,CREATED,DEADLINE,SETTLEB

def _exercise(esc, choice, arg, act, disclosed=None):
    st,r=submit([{"ExerciseCommand":{"templateId":TE,"contractId":esc,"choice":choice,"choiceArgument":arg}}],act,disclosed=disclosed)
    st==200 or die(choice.lower(),r)
    return r

def create_completed(REF, REWARD):
    """create -> accept -> complete; returns the Completed escrow cid."""
    ce={"CreateCommand":{"templateId":TE,"createArguments":{"provider":PROV,"requester":REQ,"worker":WORK,
        "arbiter":ARB,"taskRef":REF,"amount":REWARD,"instrumentId":INST,"status":"Created",
        "createdAt":CREATED,"deadline":DEADLINE,"resultRef":None}}}
    st,r=submit([ce],[PROV,REQ]); st==200 or die("create",r); esc=ev_created(r,":TaskEscrow:TaskEscrow")["contractId"]
    esc=ev_created(_exercise(esc,"Accept",{},[WORK]),":TaskEscrow:TaskEscrow")["contractId"]
    esc=ev_created(_exercise(esc,"Complete",{"completionRef":"artifact-1"},[WORK]),":TaskEscrow:TaskEscrow")["contractId"]
    print("escrow Created->Accepted->Completed:", esc[:20])
    return esc

def fund_allocation(REF, REWARD):
    """Requester locks REWARD Amulet into the escrow's CIP-0056 allocation. Returns (alloc_cid, ace, sync)."""
    inputs=[c for c,_ in holdings(REQ)]
    settlement={"executor":PROV,"settlementRef":{"id":REF,"cid":None},"requestedAt":CREATED,
        "allocateBefore":DEADLINE,"settleBefore":SETTLEB,"meta":{"values":{}}}
    leg={"sender":REQ,"receiver":WORK,"amount":REWARD,"instrumentId":INST,"meta":{"values":{}}}
    args={"expectedAdmin":DSO,"allocation":{"settlement":settlement,"transferLegId":"taskPayment","transferLeg":leg},
        "requestedAt":CREATED,"inputHoldingCids":inputs,"extraArgs":{"context":{"values":{}},"meta":{"values":{}}}}
    st,fac=post(f"{SVN}/registry/allocation-instruction/v1/allocation-factory",
        {"choiceArguments":args,"excludeDebitedHoldings":False}, tok=None, host="scan.localhost"); st==200 or die("factory",fac)
    disc=[{k:d[k] for k in ("templateId","contractId","createdEventBlob","synchronizerId")} for d in fac["choiceContext"]["disclosedContracts"]]
    args["extraArgs"]["context"]=fac["choiceContext"]["choiceContextData"]
    st,r=submit([{"ExerciseCommand":{"templateId":f"{AINST}:Splice.Api.Token.AllocationInstructionV1:AllocationFactory",
        "contractId":fac["factoryId"],"choice":"AllocationFactory_Allocate","choiceArgument":args}}],[REQ],disclosed=disc); st==200 or die("allocate",r)
    ace=ev_created(r,":Splice.AmuletAllocation:AmuletAllocation"); ace or die("no allocation",r)
    print("Amulet allocation funded:", ace["contractId"][:20])
    return ace["contractId"], ace, disc[0]["synchronizerId"]

def settle_via(esc, choice, alloc, ace, sync, kind, act):
    """Fetch the registry choice-context for `kind`, disclose the allocation to `act`, and
    exercise a value-moving TaskEscrow `choice`. The scan/registry ingests asynchronously,
    so retry until it sees the allocation."""
    import time
    for _ in range(15):
        st,tc=post(f"{SVN}/registry/allocations/v1/{alloc}/choice-contexts/{kind}", {"meta":{}}, tok=None, host="scan.localhost")
        if st==200: break
        time.sleep(2)
    st==200 or die(f"{kind} ctx",tc)
    tdisc=[{k:d[k] for k in ("templateId","contractId","createdEventBlob","synchronizerId")} for d in tc["disclosedContracts"]]
    tdisc.append({"templateId":ace["templateId"],"contractId":alloc,"createdEventBlob":ace["createdEventBlob"],"synchronizerId":sync})
    return _exercise(esc, choice, {"allocationCid":alloc,"extraArgs":{"context":tc["choiceContextData"],"meta":{"values":{}}}}, act, disclosed=tdisc)

def _init(label):
    """Load parties + a single fixed time base, tap the requester, print a header."""
    global REQ,PROV,WORK,ARB,TE,INST,DSO,CREATED,DEADLINE,SETTLEB
    if not os.path.exists(PARTYFILE): die("run setup first", PARTYFILE)
    P=json.load(open(PARTYFILE)); REQ,PROV,WORK,ARB=P["requester"],P["provider"],P["worker"],P["arbiter"]
    PKG=pkgid(); DSO=dso(); TE=f"{PKG}:TaskEscrow:TaskEscrow"; INST={"admin":DSO,"id":"Amulet"}
    REF="live-"+uuid.uuid4().hex[:8]
    # ONE fixed time base: createdAt/deadline must be byte-identical between the escrow's stored
    # fields and the allocation spec (the Settle* choices assert SettlementInfo ==).
    _b=datetime.datetime.now(datetime.timezone.utc)
    iso=lambda d:(_b+datetime.timedelta(seconds=d)).strftime("%Y-%m-%dT%H:%M:%SZ")
    CREATED,DEADLINE,SETTLEB=iso(-120),iso(3600),iso(3600+86400)
    print(f"[{label}] REF",REF,"| pkg",PKG[:12],"| dso",DSO[:16])
    st,_=post(f"{VAL}/api/validator/v0/wallet/tap", {"amount":"1000.0"}, tok=WTOK); print("tap 1000 Amulet:", st)
    return REF

# -------------------------------------------------------------------- run (happy path: worker paid)
def run():
    REF=_init("happy"); REWARD="100.0"
    w0=sum(a for _,a in holdings(WORK))
    esc=create_completed(REF, REWARD)
    alloc,ace,sync=fund_allocation(REF, REWARD)
    # worker settles: SettlePayment -> Allocation_ExecuteTransfer -> Paid
    settle_via(esc, "SettlePayment", alloc, ace, sync, "execute-transfer", [WORK])
    w1=sum(a for _,a in holdings(WORK))
    print(f"\n*** SETTLED on the live node ***  worker Amulet: {w0} -> {w1}  (+{round(w1-w0,4)})  escrow -> Paid")

# -------------------------------------------------------------------- dispute -> real refund
def dispute_refund():
    """Funds are LOCKED, then a dispute resolves for the requester and the locked Amulet is
    actually returned (SettleResolveRefund -> Allocation_Withdraw). Worker paid nothing."""
    REF=_init("dispute-refund"); REWARD="100.0"
    r0=sum(a for _,a in holdings(REQ))
    esc=create_completed(REF, REWARD)
    alloc,ace,sync=fund_allocation(REF, REWARD)
    r1=sum(a for _,a in holdings(REQ)); print(f"requester Amulet after funding (locked): {r0} -> {r1}")
    # requester contests the result -> Disputed
    esc=ev_created(_exercise(esc,"Dispute",{"raisedBy":REQ},[REQ]),":TaskEscrow:TaskEscrow")["contractId"]
    print("escrow -> Disputed:", esc[:20])
    # arbiter rules for the requester and returns the locked funds for real
    settle_via(esc, "SettleResolveRefund", alloc, ace, sync, "withdraw", [ARB])
    r2=sum(a for _,a in holdings(REQ)); w=sum(a for _,a in holdings(WORK))
    print(f"\n*** DISPUTE REFUNDED on the live node ***  requester Amulet: {r1} (locked) -> {r2}  (returned ~{round(r2-r1,4)})")
    print(f"    worker Amulet: {w}  (paid nothing)  escrow -> Refunded")

# -------------------------------------------------------------------- dispute -> pay worker
def dispute_pay():
    """A dispute resolves for the worker, who is paid for real (SettleResolvePayWorker ->
    Allocation_ExecuteTransfer, jointly authorized by [arbiter, worker])."""
    REF=_init("dispute-pay"); REWARD="100.0"
    w0=sum(a for _,a in holdings(WORK))
    esc=create_completed(REF, REWARD)
    alloc,ace,sync=fund_allocation(REF, REWARD)
    # worker contests the lack of approval -> Disputed
    esc=ev_created(_exercise(esc,"Dispute",{"raisedBy":WORK},[WORK]),":TaskEscrow:TaskEscrow")["contractId"]
    print("escrow -> Disputed:", esc[:20])
    # arbiter rules for the worker; the worker claims (joint arbiter+worker authority)
    settle_via(esc, "SettleResolvePayWorker", alloc, ace, sync, "execute-transfer", [ARB,WORK])
    w1=sum(a for _,a in holdings(WORK))
    print(f"\n*** DISPUTE PAID on the live node ***  worker Amulet: {w0} -> {w1}  (+{round(w1-w0,4)})  escrow -> Paid")

if __name__ == "__main__":
    {"setup":setup,"run":run,"dispute-refund":dispute_refund,"dispute-pay":dispute_pay}.get(
        sys.argv[1] if len(sys.argv)>1 else "run", run)()
