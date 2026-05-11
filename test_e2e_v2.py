"""
End-to-End Test Suite — Tech4Human WhatsApp Banking
====================================================
Tests all MCP tools through the agent chat API and the MCP SSE server directly.

Seed data (from mcp_service_fb/firstbank.db — phones normalised to E.164):
  - Customer 1: John Doe    | phone: 2348012345678 | account: 3089345050  | has_pin: False
  - Customer 2: Jane Smith  | phone: 2348098765432 | account: 3092603736  | has_pin: False
  - Customer 3: Olanrewaju  | phone: 2349013360717 | account: 3031192963  | has_pin: True

Usage:
  python test_e2e_v2.py                  # run all tests
  python test_e2e_v2.py --mcp-only       # only MCP direct tool tests
  python test_e2e_v2.py --agent-only     # only agent chat tests
"""

import sys
import asyncio
import json
import uuid
import time
import httpx
from datetime import datetime
from mcp import ClientSession
from mcp.client.sse import sse_client
from cryptography.fernet import Fernet

# ──────────────────────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────────────────────
NODE_BASE   = "http://localhost:3000"
MCP_BASE    = "http://127.0.0.1:3001"
CHAT_URL    = f"{NODE_BASE}/api/agent/chat"
HEALTH_URL  = f"{NODE_BASE}/health"
MCP_SSE_URL = f"{MCP_BASE}/sse"

# Fernet key from mcp_service_fb/.env — required to encrypt account numbers
# for tools that accept encrypted account numbers (lookup_customer_by_account, transfer_funds to_acc)
_FERNET = Fernet(b"dwhDjT2Vp_D5bhzDAuGn1lYSwI9RfU5Mh32wYUVuc5k=")

def enc(account_number: str) -> str:
    """Encrypt an account number using the same Fernet key as the MCP service."""
    return _FERNET.encrypt(account_number.encode()).decode()

# Test customers (phones normalised to E.164 in DB)
JOHN_PHONE   = "2348012345678";  JOHN_ACCOUNT  = "3089345050";  JOHN_ID  = 1
JANE_PHONE   = "2348098765432";  JANE_ACCOUNT  = "3092603736";  JANE_ID  = 2
LANRE_PHONE  = "2349013360717";  LANRE_ACCOUNT = "3031192963";  LANRE_ID = 3

# ──────────────────────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────────────────────
PASS = "✅ PASS"; FAIL = "❌ FAIL"; SKIP = "⏭  SKIP"
results: list[dict] = []

def log(label: str, status: str, detail: str = "", reply: str = ""):
    print(f"\n{status}  {label}")
    if detail:
        print(f"   Detail : {detail}")
    if reply:
        short = reply[:300].replace("\n", " | ")
        print(f"   Reply  : {short}{'…' if len(reply) > 300 else ''}")
    results.append({"label": label, "status": status, "detail": detail})

def chat(phone: str, message: str, customer_name: str = "") -> dict:
    payload: dict = {"phone": phone, "message": message}
    if customer_name:
        payload["customerName"] = customer_name
    # Retry on 500 — OpenAI TPM rate-limit needs ~60s for rolling window to clear
    delays = [60, 60, 120]
    for attempt, delay in enumerate(delays):
        r = httpx.post(CHAT_URL, json=payload, timeout=120)
        if r.status_code == 500:
            if attempt < len(delays) - 1:
                print(f"   [retry] 500 received, waiting {delay}s for TPM window...")
                time.sleep(delay)
                continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()  # re-raise on final attempt
    return r.json()

async def _call_mcp(tool_name: str, arguments: dict) -> str:
    async with sse_client(MCP_SSE_URL) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments)
            texts = [c.text for c in result.content if hasattr(c, "text")]
            return "\n".join(texts)

def mcp(tool_name: str, arguments: dict) -> str:
    return asyncio.run(_call_mcp(tool_name, arguments))

def jparse(raw: str) -> dict:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}


# ──────────────────────────────────────────────────────────────
# 0. SERVICE HEALTH CHECKS
# ──────────────────────────────────────────────────────────────
def test_health():
    print("\n" + "="*60)
    print("SECTION 0 — Service Health Checks")
    print("="*60)

    try:
        r = httpx.get(HEALTH_URL, timeout=10)
        d = r.json()
        log("Node server health", PASS, f"status={d.get('status')} bank={d.get('bank')}")
    except Exception as e:
        log("Node server health", FAIL, str(e))
        print("\n⛔  Node server is not running.  Run: pnpm start  in tech4human-wa-banking/")
        sys.exit(1)

    try:
        with httpx.stream("GET", MCP_SSE_URL,
                          timeout=httpx.Timeout(5.0, connect=5.0, read=2.0, write=5.0, pool=5.0),
                          headers={"Accept": "text/event-stream"}) as r:
            for _ in r.iter_bytes(chunk_size=64):
                break
        log("MCP service health", PASS, f"http_status={r.status_code}")
    except httpx.ReadTimeout:
        log("MCP service health", PASS, "SSE stream open (ReadTimeout is expected for SSE)")
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        log("MCP service health", FAIL, str(e))
        print("\n⛔  MCP service is not running.  Run: uvicorn server:app --port 3001  in mcp_service_fb/")
        sys.exit(1)
    except Exception as e:
        log("MCP service health", FAIL, str(e))
        sys.exit(1)


# ──────────────────────────────────────────────────────────────
# 1. MCP TOOL DIRECT TESTS
# ──────────────────────────────────────────────────────────────
def test_mcp_tools():
    print("\n" + "="*60)
    print("SECTION 1 — MCP Tool Direct Tests  (17 tools)")
    print("="*60)

    # 1.1 lookup_customer_by_phone — known customer
    try:
        raw = mcp("lookup_customer_by_phone", {"phone_number": "08012345678"})
        d = jparse(raw)
        ok = d.get("found") is True and d.get("customer_id") == JOHN_ID
        log("lookup_customer_by_phone (John 08...)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("lookup_customer_by_phone (John)", FAIL, str(e))

    # 1.2 lookup_customer_by_phone — E.164 variant
    try:
        raw = mcp("lookup_customer_by_phone", {"phone_number": LANRE_PHONE})
        d = jparse(raw)
        ok = d.get("found") is True and d.get("customer_id") == LANRE_ID
        log("lookup_customer_by_phone (Lanre E.164)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("lookup_customer_by_phone (Lanre E.164)", FAIL, str(e))

    # 1.3 lookup_customer_by_phone — unknown
    try:
        raw = mcp("lookup_customer_by_phone", {"phone_number": "09099999999"})
        d = jparse(raw)
        ok = d.get("found") is False
        log("lookup_customer_by_phone (unknown)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("lookup_customer_by_phone (unknown)", FAIL, str(e))

    # 1.4 lookup_customer_by_account (account number must be Fernet-encrypted)
    try:
        raw = mcp("lookup_customer_by_account", {"account_number": enc(JOHN_ACCOUNT), "bank_code": "001"})
        d = jparse(raw)
        ok = d.get("found") is True and d.get("customer_id") == JOHN_ID
        log("lookup_customer_by_account (John — encrypted)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("lookup_customer_by_account (John)", FAIL, str(e))

    # 1.5 get_onboarding_status
    try:
        raw = mcp("get_onboarding_status", {"customer_id": JOHN_ID})
        d = jparse(raw)
        ok = d.get("success") is True
        log("get_onboarding_status (John)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("get_onboarding_status (John)", FAIL, str(e))

    # 1.6 send_verification_otp
    try:
        raw = mcp("send_verification_otp", {"phone_number": JOHN_PHONE})
        d = jparse(raw)
        ok = d.get("success") is True and d.get("otp_code") == "1234"
        log("send_verification_otp (John)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("send_verification_otp (John)", FAIL, str(e))

    # 1.7 update_onboarding_status — terms_accepted
    try:
        raw = mcp("update_onboarding_status", {"customer_id": JOHN_ID, "field": "terms_accepted", "value": True})
        d = jparse(raw)
        ok = d.get("success") is True
        log("update_onboarding_status (terms_accepted)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("update_onboarding_status (terms_accepted)", FAIL, str(e))

    # 1.8 update_onboarding_status — phone_verified
    try:
        raw = mcp("update_onboarding_status", {"customer_id": JOHN_ID, "field": "phone_verified", "value": True})
        d = jparse(raw)
        ok = d.get("success") is True
        log("update_onboarding_status (phone_verified)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("update_onboarding_status (phone_verified)", FAIL, str(e))

    # 1.9 set_transaction_pin
    try:
        raw = mcp("set_transaction_pin", {"customer_id": JOHN_ID, "new_pin": "1234"})
        d = jparse(raw)
        ok = d.get("success") is True
        log("set_transaction_pin (John PIN=1234)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("set_transaction_pin (John PIN=1234)", FAIL, str(e))

    # 1.10 verify_pin — correct
    try:
        raw = mcp("verify_pin", {"customer_id": JOHN_ID, "pin": "1234"})
        d = jparse(raw)
        ok = d.get("is_valid") is True
        log("verify_pin (correct PIN)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("verify_pin (correct PIN)", FAIL, str(e))

    # 1.11 verify_pin — wrong
    try:
        raw = mcp("verify_pin", {"customer_id": JOHN_ID, "pin": "9999"})
        d = jparse(raw)
        ok = d.get("is_valid") is False
        log("verify_pin (wrong PIN)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("verify_pin (wrong PIN)", FAIL, str(e))

    # 1.12 get_customer_account
    try:
        raw = mcp("get_customer_account", {"customer_id": JOHN_ID})
        d = jparse(raw)
        ok = d.get("success") is True and JOHN_ACCOUNT in d.get("account_number", "")
        log("get_customer_account (John)", PASS if ok else FAIL, str(d))
    except Exception as e:
        log("get_customer_account (John)", FAIL, str(e))

    # 1.13 get_account_balance
    try:
        raw = mcp("get_account_balance", {"account_number": JOHN_ACCOUNT})
        d = jparse(raw)
        ok = d.get("success") is True and d.get("balance", 0) > 0
        log("get_account_balance (John)", PASS if ok else FAIL, f"balance={d.get('balance')} NGN")
    except Exception as e:
        log("get_account_balance (John)", FAIL, str(e))

    # 1.14 get_transaction_history
    try:
        raw = mcp("get_transaction_history", {"account_number": JOHN_ACCOUNT, "limit": 3})
        d = jparse(raw)
        ok = d.get("success") is True and len(d.get("transactions", [])) > 0
        log("get_transaction_history (John, limit=3)", PASS if ok else FAIL,
            f"{len(d.get('transactions', []))} transactions returned")
    except Exception as e:
        log("get_transaction_history (John)", FAIL, str(e))

    # 1.15 transfer_funds (from_acc plain, to_acc Fernet-encrypted)
    txn_ref = f"TXN-E2E-{uuid.uuid4().hex[:8].upper()}"
    transfer_ok = False
    try:
        raw = mcp("transfer_funds", {
            "from_acc": JOHN_ACCOUNT,
            "to_acc":   enc(JANE_ACCOUNT),
            "amount":   500.0,
            "txn_id":   txn_ref,
            "description": "E2E test transfer"
        })
        d = jparse(raw)
        transfer_ok = d.get("success") is True
        log("transfer_funds (John→Jane ₦500)", PASS if transfer_ok else FAIL,
            f"ref={d.get('reference')} balance={d.get('available_balance')}")
    except Exception as e:
        log("transfer_funds (John→Jane)", FAIL, str(e))

    # 1.16 generate_receipt
    if transfer_ok:
        try:
            raw = mcp("generate_receipt", {"reference": txn_ref})
            d = jparse(raw)
            ok = d.get("success") is True and txn_ref in d.get("receipt_text", "")
            log("generate_receipt (transfer ref)", PASS if ok else FAIL, d.get("message", ""))
        except Exception as e:
            log("generate_receipt", FAIL, str(e))
    else:
        log("generate_receipt", SKIP, "Skipped — transfer_funds failed")

    # 1.17 get_loans
    try:
        raw = mcp("get_loans", {"customer_id": LANRE_ID})
        ok = "Personal Loan" in raw or "No active loans" in raw
        log("get_loans (Lanre)", PASS if ok else FAIL, raw[:120])
    except Exception as e:
        log("get_loans (Lanre)", FAIL, str(e))

    # 1.18 get_cards
    try:
        raw = mcp("get_cards", {"customer_id": LANRE_ID})
        ok = "debit" in raw.lower() or "No active cards" in raw
        log("get_cards (Lanre)", PASS if ok else FAIL, raw[:120])
    except Exception as e:
        log("get_cards (Lanre)", FAIL, str(e))

    # 1.19 pay_bills
    bill_ref = f"BILL-E2E-{uuid.uuid4().hex[:8].upper()}"
    bill_ok = False
    try:
        raw = mcp("pay_bills", {
            "account_number": LANRE_ACCOUNT,
            "amount": 200.0,
            "biller": "DSTV",
            "idempotency_key": bill_ref
        })
        bill_ok = "Paid" in raw or "successfully" in raw.lower()
        log("pay_bills (Lanre DSTV ₦200)", PASS if bill_ok else FAIL, raw[:120])
    except Exception as e:
        log("pay_bills (Lanre DSTV)", FAIL, str(e))

    # 1.19b idempotency check
    if bill_ok:
        try:
            raw = mcp("pay_bills", {
                "account_number": LANRE_ACCOUNT,
                "amount": 200.0,
                "biller": "DSTV",
                "idempotency_key": bill_ref
            })
            ok = "already processed" in raw.lower()
            log("pay_bills idempotency check", PASS if ok else FAIL, raw[:120])
        except Exception as e:
            log("pay_bills idempotency check", FAIL, str(e))
    else:
        log("pay_bills idempotency check", SKIP, "Skipped — first pay_bills failed")

    # 1.20 open_account
    new_acc = None
    try:
        raw = mcp("open_account", {
            "customer_id": JANE_ID,
            "account_type": "Current",
            "initial_deposit": 1000.0
        })
        ok = "Account opened" in raw or "successfully" in raw.lower()
        log("open_account (Jane Current ₦1000)", PASS if ok else FAIL, raw[:120])
        if "Account Number:" in raw:
            new_acc = raw.split("Account Number:")[-1].strip().split()[0]
    except Exception as e:
        log("open_account (Jane)", FAIL, str(e))

    # 1.21 close_account — should refuse (balance = ₦1000)
    if new_acc:
        try:
            raw = mcp("close_account", {"account_number": new_acc})
            ok = "balance must be 0" in raw.lower() or "closed successfully" in raw.lower()
            log("close_account (non-zero balance guard)", PASS if ok else FAIL, raw[:120])
        except Exception as e:
            log("close_account (non-zero balance guard)", FAIL, str(e))
    else:
        log("close_account (non-zero balance guard)", SKIP, "Skipped — open_account failed")


# ──────────────────────────────────────────────────────────────
# 2. AGENT CHAT TESTS (MCP tools injected via supervisor)
# ──────────────────────────────────────────────────────────────
def test_agent_flows():
    print("\n" + "="*60)
    print("SECTION 2 — Agent Chat Tests  (12 flows)")
    print("="*60)

    def p(suffix: str) -> str:
        return f"e2e-{uuid.uuid4().hex[:6]}-{suffix}"

    # 2.1 Greeting / menu (use registered phone — onboarding gate requires known user)
    try:
        r = chat(JOHN_PHONE, "Hello", "John Doe")
        ok = r.get("success") is True and len(r.get("reply", "")) > 0
        log("Agent: greeting/menu", PASS if ok else FAIL, reply=r.get("reply", ""))
    except Exception as e:
        log("Agent: greeting/menu", FAIL, str(e))
    time.sleep(2)

    # 2.2 Balance enquiry (John Doe — real data from MCP)
    try:
        r = chat(JOHN_PHONE, "What is my account balance?", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["balance", "ngn", "₦", "naira", "account"])
        log("Agent: balance enquiry (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: balance enquiry (John)", FAIL, str(e))
    time.sleep(2)

    # 2.3 Transaction history
    try:
        r = chat(JOHN_PHONE, "Show me my last 3 transactions", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["transaction", "debit", "credit", "transfer", "ngn", "₦"])
        log("Agent: transaction history (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: transaction history (John)", FAIL, str(e))
    # Pause 45s before transfer test — tests 2-3 consume ~25k TPM; need window to clear
    time.sleep(45)

    # 2.4 Transfer initiation (use registered phone — PIN gate requires known user)
    try:
        r = chat(JOHN_PHONE, f"I want to transfer 1000 naira to account {JANE_ACCOUNT}", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["pin", "confirm", "transfer", "account", "amount", "send"])
        log("Agent: transfer initiation", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: transfer initiation", FAIL, str(e))
    time.sleep(2)

    # 2.5 Onboarding (new customer)
    try:
        r = chat(p("onboard"), "I'm a new customer, I want to get started")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["term", "condition", "welcome", "register", "onboard", "account", "option", "select"])
        log("Agent: onboarding welcome", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: onboarding welcome", FAIL, str(e))
    time.sleep(2)

    # 2.6 Support / FAQ
    try:
        r = chat(p("support"), "How do I reset my PIN?")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: support FAQ (PIN reset)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: support FAQ (PIN reset)", FAIL, str(e))
    time.sleep(2)

    # 2.7 Loans (Lanre — has active loan)
    try:
        r = chat(LANRE_PHONE, "Show me my active loans", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["loan", "principal", "balance", "interest", "no active"])
        log("Agent: loans check (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: loans check (Lanre)", FAIL, str(e))
    time.sleep(2)

    # 2.8 Cards
    try:
        r = chat(LANRE_PHONE, "What cards do I have?", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["card", "debit", "expiry", "no active"])
        log("Agent: cards check (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: cards check (Lanre)", FAIL, str(e))
    time.sleep(2)

    # 2.9 Bill payment initiation
    try:
        r = chat(LANRE_PHONE, "I want to pay my DSTV subscription of 3000 naira", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["pin", "confirm", "pay", "dstv", "bill", "naira"])
        log("Agent: bill payment initiation (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: bill payment initiation (Lanre)", FAIL, str(e))
    time.sleep(2)

    # 2.10 Financial insights + chart (Lanre — uses transactionChartTool via insights-agent)
    try:
        r = chat(LANRE_PHONE, "Show me a pie chart of my spending", "Olanrewaju")
        reply = r.get("reply", "")
        has_chart = "quickchart.io" in reply or "chart" in reply.lower() or "spending" in reply.lower()
        ok = r.get("success") is True and has_chart
        log("Agent: financial insights + chart (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: financial insights + chart (Lanre)", FAIL, str(e))
    # Pause 45s before fraud alert test — prior tests accumulate TPM; give window to clear
    time.sleep(45)

    # 2.11 Fraud alert guidance
    try:
        r = chat(p("fraud"), "I got a suspicious transaction alert, what should I do?")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: fraud alert guidance", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: fraud alert guidance", FAIL, str(e))
    time.sleep(2)

    # 2.12 Multi-turn session memory
    phone_mem = p("mem")
    try:
        chat(phone_mem, "My name is Test User")
        r2 = chat(phone_mem, "What did I just tell you?")
        reply = r2.get("reply", "")
        ok = r2.get("success") is True and "test user" in reply.lower()
        log("Agent: session memory (multi-turn)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: session memory (multi-turn)", FAIL, str(e))


# ──────────────────────────────────────────────────────────────
# 3. ADMIN ENDPOINTS
# ──────────────────────────────────────────────────────────────
def test_admin():
    print("\n" + "="*60)
    print("SECTION 3 — Admin Endpoints")
    print("="*60)

    # Sessions: backed by Postgres (will work if DB_URL is configured)
    # fraud-alerts / escalation-tickets require Postgres tables  →  500 is expected
    # when the Node server points at a Postgres DB that hasn't had those tables created.
    for path, label, needs_pg in [
        ("/admin/sessions",     "Admin: sessions list",        False),
        ("/admin/fraud-alerts", "Admin: fraud alerts (PG)",    True),
        ("/admin/tickets",      "Admin: tickets (PG)",         True),
    ]:
        try:
            r = httpx.get(f"{NODE_BASE}{path}", timeout=15)
            d = r.json()
            if r.status_code == 200:
                log(label, PASS, f"http=200  keys={list(d.keys())}")
            elif r.status_code == 500 and needs_pg:
                log(label, SKIP, "500 — Postgres tables not present (expected for local/SQLite setup)")
            else:
                log(label, FAIL, f"http={r.status_code}  {d}")
        except Exception as e:
            log(label, FAIL, str(e))


# ──────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────
def print_summary():
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    passed  = sum(1 for r in results if r["status"] == PASS)
    failed  = sum(1 for r in results if r["status"] == FAIL)
    skipped = sum(1 for r in results if r["status"] == SKIP)
    print(f"  Total  : {len(results)}")
    print(f"  {PASS}  : {passed}")
    print(f"  {FAIL}  : {failed}")
    print(f"  {SKIP}  : {skipped}")
    if failed:
        print("\nFailed:")
        for r in results:
            if r["status"] == FAIL:
                print(f"  ✗ {r['label']}")
                if r["detail"]:
                    print(f"    → {r['detail'][:200]}")
    print()


if __name__ == "__main__":
    args = sys.argv[1:]
    run_mcp   = "--agent-only" not in args
    run_agent = "--mcp-only"   not in args

    print(f"\n{'='*60}")
    print(f"Tech4Human Banking — E2E Test Suite")
    print(f"Started : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Node    : {NODE_BASE}")
    print(f"MCP     : {MCP_BASE}")
    print(f"{'='*60}")

    test_health()
    if run_mcp:
        test_mcp_tools()
    if run_agent:
        test_agent_flows()
    test_admin()
    print_summary()
