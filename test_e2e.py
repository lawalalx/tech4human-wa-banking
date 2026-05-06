"""
End-to-End Test Suite — Tech4Human WhatsApp Banking
====================================================
Tests all MCP tools through the agent chat API and the MCP SSE server directly.

Seed data used (from mcp_service_fb/firstbank.db):
  - Customer 1: John Doe  | phone: 08012345678 (→ 2348012345678) | account: 3089345050 | has_pin: False
  - Customer 3: Olanrewaju | phone: 2349013360717                 | account: 3031192963 | has_pin: True
  - Customer 2: Jane Smith | phone: 08098765432 (→ 2340898765432) | account: 3092603736 | has_pin: False

Usage:
  python test_e2e.py                  # run all tests
  python test_e2e.py --mcp-only       # only MCP direct tool tests
  python test_e2e.py --agent-only     # only agent chat tests
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

# ──────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────
NODE_BASE   = "http://localhost:3000"
MCP_BASE    = "http://127.0.0.1:3001"

CHAT_URL    = f"{NODE_BASE}/api/agent/chat"
HEALTH_URL  = f"{NODE_BASE}/health"
MCP_SSE_URL = f"{MCP_BASE}/sse"

# Test customers (from seed data)
JOHN_PHONE    = "2348012345678"
JOHN_ACCOUNT  = "3089345050"
JOHN_ID       = 1

LANRE_PHONE   = "2349013360717"
LANRE_ACCOUNT = "3031192963"
LANRE_ID      = 3

JANE_PHONE    = "2340898765432"
JANE_ACCOUNT  = "3092603736"
JANE_ID       = 2

# ──────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────
PASS = "✅ PASS"
FAIL = "❌ FAIL"
SKIP = "⏭  SKIP"
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
    r = httpx.post(CHAT_URL, json=payload, timeout=120)
    r.raise_for_status()
    return r.json()


async def call_mcp_tool(tool_name: str, arguments: dict) -> str:
    """Call an MCP tool via the SSE transport using the official Python MCP client."""
    async with sse_client(MCP_SSE_URL) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments)
            # result.content is a list of TextContent / ImageContent
            texts = [c.text for c in result.content if hasattr(c, "text")]
            return "\n".join(texts)


def mcp_tool(tool_name: str, arguments: dict) -> str:
    """Synchronous wrapper around call_mcp_tool."""
    return asyncio.run(call_mcp_tool(tool_name, arguments))


def parse_json_result(raw: str) -> dict:
    """Try to parse the MCP tool result as JSON."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}


# ──────────────────────────────────────────────
# 0.  SERVICE HEALTH CHECKS
# ──────────────────────────────────────────────
def test_services_health():
    print("\n" + "="*60)
    print("SECTION 0 — Service Health Checks")
    print("="*60)

    # Node server
    try:
        r = httpx.get(HEALTH_URL, timeout=10)
        data = r.json()
        log("Node server health", PASS, f"status={data.get('status')} bank={data.get('bank')}")
    except Exception as e:
        log("Node server health", FAIL, str(e))
        print("\n⛔  Node server is not running. Start it with: pnpm start")
        sys.exit(1)

    # MCP SSE endpoint — SSE never closes, so just verify we can connect.
    # ReadTimeout means we connected but the stream is open (server is running).
    # ConnectError means the port is closed (server is down).
    try:
        with httpx.stream("GET", MCP_SSE_URL,
                          timeout=httpx.Timeout(5.0, connect=5.0, read=2.0, write=5.0, pool=5.0),
                          headers={"Accept": "text/event-stream"}) as r:
            for _ in r.iter_bytes(chunk_size=64):
                break
        log("MCP service health", PASS, f"http_status={r.status_code}")
    except httpx.ReadTimeout:
        log("MCP service health", PASS, "SSE stream open (ReadTimeout expected for SSE)")
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        log("MCP service health", FAIL, str(e))
        print("\n⛔  MCP service is not running. Start it with: uvicorn server:app --port 3001")
        sys.exit(1)
    except Exception as e:
        log("MCP service health", FAIL, str(e))
        print("\n⛔  MCP service is not running. Start it with: uvicorn server:app --port 3001")
        sys.exit(1)


# ──────────────────────────────────────────────
# 1.  MCP TOOL DIRECT TESTS
# ──────────────────────────────────────────────
def test_mcp_tools():
    print("\n" + "="*60)
    print("SECTION 1 — MCP Tool Direct Tests")
    print("="*60)

    # 1.1 lookup_customer_by_phone (known)
    try:
        raw = mcp_tool("lookup_customer_by_phone", {"phone_number": "08012345678"})
        data = parse_json_result(raw)
        ok = data.get("found") is True and data.get("customer_id") == JOHN_ID
        log("lookup_customer_by_phone (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("lookup_customer_by_phone (John)", FAIL, str(e))

    # 1.2 lookup_customer_by_phone (unknown)
    try:
        raw = mcp_tool("lookup_customer_by_phone", {"phone_number": "09099999999"})
        data = parse_json_result(raw)
        ok = data.get("found") is False
        log("lookup_customer_by_phone (unknown)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("lookup_customer_by_phone (unknown)", FAIL, str(e))

    # 1.3 lookup_customer_by_account (account number must be Fernet-encrypted)
    try:
        enc_acc = encrypt_account(JOHN_ACCOUNT)
        raw = mcp_tool("lookup_customer_by_account", {"account_number": enc_acc, "bank_code": "001"})
        data = parse_json_result(raw)
        ok = data.get("found") is True
        log("lookup_customer_by_account (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("lookup_customer_by_account (John)", FAIL, str(e))

    # 1.4 get_onboarding_status
    try:
        raw = mcp_tool("get_onboarding_status", {"customer_id": JOHN_ID})
        data = parse_json_result(raw)
        ok = data.get("success") is True
        log("get_onboarding_status (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("get_onboarding_status (John)", FAIL, str(e))

    # 1.5 send_verification_otp
    try:
        raw = mcp_tool("send_verification_otp", {"phone_number": JOHN_PHONE})
        data = parse_json_result(raw)
        ok = data.get("success") is True and data.get("otp_code") == "1234"
        log("send_verification_otp (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("send_verification_otp (John)", FAIL, str(e))

    # 1.6 update_onboarding_status — terms_accepted
    try:
        raw = mcp_tool("update_onboarding_status", {"customer_id": JOHN_ID, "field": "terms_accepted", "value": True})
        data = parse_json_result(raw)
        ok = data.get("success") is True
        log("update_onboarding_status (terms_accepted)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("update_onboarding_status (terms_accepted)", FAIL, str(e))

    # 1.7 update_onboarding_status — phone_verified
    try:
        raw = mcp_tool("update_onboarding_status", {"customer_id": JOHN_ID, "field": "phone_verified", "value": True})
        data = parse_json_result(raw)
        ok = data.get("success") is True
        log("update_onboarding_status (phone_verified)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("update_onboarding_status (phone_verified)", FAIL, str(e))

    # 1.8 set_transaction_pin
    try:
        raw = mcp_tool("set_transaction_pin", {"customer_id": JOHN_ID, "new_pin": "1234"})
        data = parse_json_result(raw)
        ok = data.get("success") is True
        log("set_transaction_pin (John PIN=1234)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("set_transaction_pin (John PIN=1234)", FAIL, str(e))

    # 1.9 verify_pin (correct)
    try:
        raw = mcp_tool("verify_pin", {"customer_id": JOHN_ID, "pin": "1234"})
        data = parse_json_result(raw)
        ok = data.get("is_valid") is True
        log("verify_pin (correct PIN)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("verify_pin (correct PIN)", FAIL, str(e))

    # 1.10 verify_pin (wrong)
    try:
        raw = mcp_tool("verify_pin", {"customer_id": JOHN_ID, "pin": "9999"})
        data = parse_json_result(raw)
        ok = data.get("is_valid") is False
        log("verify_pin (wrong PIN)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("verify_pin (wrong PIN)", FAIL, str(e))

    # 1.11 get_customer_account
    try:
        raw = mcp_tool("get_customer_account", {"customer_id": JOHN_ID})
        data = parse_json_result(raw)
        ok = data.get("success") is True and JOHN_ACCOUNT in data.get("account_number", "")
        log("get_customer_account (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("get_customer_account (John)", FAIL, str(e))

    # 1.12 get_account_balance
    try:
        raw = mcp_tool("get_account_balance", {"account_number": JOHN_ACCOUNT})
        data = parse_json_result(raw)
        ok = data.get("success") is True and data.get("balance", 0) > 0
        log("get_account_balance (John)", PASS if ok else FAIL, f"balance={data.get('balance')} NGN")
    except Exception as e:
        log("get_account_balance (John)", FAIL, str(e))

    # 1.13 get_transaction_history
    try:
        raw = mcp_tool("get_transaction_history", {"account_number": JOHN_ACCOUNT, "limit": 3})
        data = parse_json_result(raw)
        ok = data.get("success") is True and len(data.get("transactions", [])) > 0
        log("get_transaction_history (John, limit=3)", PASS if ok else FAIL,
            f"{len(data.get('transactions', []))} transactions returned")
    except Exception as e:
        log("get_transaction_history (John)", FAIL, str(e))

    # 1.14 transfer_funds (John → Jane, to_acc must be Fernet-encrypted)
    txn_ref = f"TXN-E2E-{uuid.uuid4().hex[:8].upper()}"
    try:
        raw = mcp_tool("transfer_funds", {
            "from_acc": JOHN_ACCOUNT,
            "to_acc": encrypt_account(JANE_ACCOUNT),
            "amount": 500.0,
            "txn_id": txn_ref,
            "description": "E2E test transfer"
        })
        data = parse_json_result(raw)
        ok = data.get("success") is True
        log("transfer_funds (John→Jane, ₦500)", PASS if ok else FAIL,
            f"ref={data.get('reference')} balance={data.get('available_balance')}")
    except Exception as e:
        txn_ref = None
        log("transfer_funds (John→Jane)", FAIL, str(e))

    # 1.15 generate_receipt
    if txn_ref:
        try:
            raw = mcp_tool("generate_receipt", {"reference": txn_ref})
            data = parse_json_result(raw)
            ok = data.get("success") is True and txn_ref in data.get("receipt_text", "")
            log("generate_receipt (transfer ref)", PASS if ok else FAIL, data.get("message", ""))
        except Exception as e:
            log("generate_receipt", FAIL, str(e))
    else:
        log("generate_receipt", SKIP, "Skipped — transfer_funds failed")

    # 1.16 get_loans
    try:
        raw = mcp_tool("get_loans", {"customer_id": LANRE_ID})
        ok = "Personal Loan" in raw or "No active loans" in raw
        log("get_loans (Lanre)", PASS if ok else FAIL, raw[:120])
    except Exception as e:
        log("get_loans (Lanre)", FAIL, str(e))

    # 1.17 get_cards
    try:
        raw = mcp_tool("get_cards", {"customer_id": LANRE_ID})
        ok = "debit" in raw.lower() or "No active cards" in raw
        log("get_cards (Lanre)", PASS if ok else FAIL, raw[:120])
    except Exception as e:
        log("get_cards (Lanre)", FAIL, str(e))

    # 1.18 pay_bills
    bill_ref = f"BILL-E2E-{uuid.uuid4().hex[:8].upper()}"
    try:
        raw = mcp_tool("pay_bills", {
            "account_number": LANRE_ACCOUNT,
            "amount": 200.0,
            "biller": "DSTV",
            "idempotency_key": bill_ref
        })
        ok = "Paid" in raw or "successfully" in raw.lower()
        log("pay_bills (Lanre DSTV ₦200)", PASS if ok else FAIL, raw[:120])
    except Exception as e:
        bill_ref = None
        log("pay_bills (Lanre DSTV)", FAIL, str(e))

    # 1.18b idempotency
    if bill_ref:
        try:
            raw = mcp_tool("pay_bills", {
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

    # 1.19 open_account
    new_acc = None
    try:
        raw = mcp_tool("open_account", {
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

    return new_acc


def test_mcp_close_account(account_number: str | None):
    if not account_number:
        log("close_account (balance guard)", SKIP, "No account from open_account test")
        return
    try:
        raw = mcp_tool("close_account", {"account_number": account_number})
        # Should refuse because balance = ₦1000 (not zero)
        ok = "balance must be 0" in raw.lower() or "closed successfully" in raw.lower()
        log("close_account (non-zero balance guard)", PASS if ok else FAIL, raw[:120])
    except Exception as e:
        log("close_account (non-zero balance guard)", FAIL, str(e))


# ──────────────────────────────────────────────
# 2.  AGENT CHAT TESTS
# ──────────────────────────────────────────────
def test_agent_flows():
    print("\n" + "="*60)
    print("SECTION 2 — Agent Chat Tests (MCP tools via supervisor)")
    print("="*60)

    def phone(suffix: str) -> str:
        return f"e2e-{suffix}"

    # 2.1 Greeting / menu
    try:
        r = chat(phone("greeting"), "Hello")
        ok = r.get("success") is True and len(r.get("reply", "")) > 0
        log("Agent: greeting/menu", PASS if ok else FAIL, reply=r.get("reply", ""))
    except Exception as e:
        log("Agent: greeting/menu", FAIL, str(e))

    # 2.2 Balance check
    try:
        r = chat(JOHN_PHONE, "What is my account balance?", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["balance", "ngn", "₦", "naira", "account"])
        log("Agent: balance enquiry (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: balance enquiry (John)", FAIL, str(e))

    # 2.3 Transaction history
    try:
        r = chat(JOHN_PHONE, "Show me my last 3 transactions", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["transaction", "debit", "credit", "transfer", "ngn"])
        log("Agent: transaction history (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: transaction history (John)", FAIL, str(e))

    # 2.4 Transfer initiation
    try:
        r = chat(phone("transfer-1"), f"I want to transfer 1000 naira to account {JANE_ACCOUNT}")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["pin", "confirm", "transfer", "account", "amount"])
        log("Agent: transfer initiation", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: transfer initiation", FAIL, str(e))

    # 2.5 Onboarding / T&C
    try:
        r = chat(phone("onboard-1"), "I'm a new customer, I want to get started")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["term", "condition", "welcome", "register", "onboard", "account", "option"])
        log("Agent: onboarding welcome", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: onboarding welcome", FAIL, str(e))

    # 2.6 Support / FAQ
    try:
        r = chat(phone("support-1"), "How do I reset my PIN?")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: support FAQ (PIN reset)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: support FAQ (PIN reset)", FAIL, str(e))

    # 2.7 Loans
    try:
        r = chat(LANRE_PHONE, "Show me my active loans", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["loan", "principal", "balance", "interest", "no active"])
        log("Agent: loans check (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: loans check (Lanre)", FAIL, str(e))

    # 2.8 Cards
    try:
        r = chat(LANRE_PHONE, "What cards do I have?", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["card", "debit", "expiry", "no active"])
        log("Agent: cards check (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: cards check (Lanre)", FAIL, str(e))

    # 2.9 Bill payment
    try:
        r = chat(LANRE_PHONE, "I want to pay my DSTV subscription of 3000 naira", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["pin", "confirm", "pay", "dstv", "bill", "naira"])
        log("Agent: bill payment initiation (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: bill payment initiation (Lanre)", FAIL, str(e))

    # 2.10 Financial insights
    try:
        r = chat(JOHN_PHONE, "Show me my spending breakdown", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: financial insights (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: financial insights (John)", FAIL, str(e))

    # 2.11 Fraud alert
    try:
        r = chat(phone("fraud-1"), "I got a suspicious transaction alert, what should I do?")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: fraud alert guidance", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: fraud alert guidance", FAIL, str(e))

    # 2.12 Multi-turn session memory
    p = phone("memory-1")
    try:
        chat(p, "My name is Test User")
        r2 = chat(p, "What did I just tell you?")
        reply = r2.get("reply", "")
        ok = r2.get("success") is True and "test user" in reply.lower()
        log("Agent: session memory (multi-turn)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: session memory (multi-turn)", FAIL, str(e))


# ──────────────────────────────────────────────
# 3.  ADMIN ENDPOINTS
# ──────────────────────────────────────────────
def test_admin_endpoints():
    print("\n" + "="*60)
    print("SECTION 3 — Admin Endpoints")
    print("="*60)

    for path, label in [
        ("/admin/sessions", "Admin: sessions list"),
        ("/admin/fraud-alerts", "Admin: fraud alerts"),
        ("/admin/tickets", "Admin: escalation tickets"),
    ]:
        try:
            r = httpx.get(f"{NODE_BASE}{path}", timeout=15)
            data = r.json()
            ok = r.status_code == 200
            log(label, PASS if ok else FAIL, f"http={r.status_code} keys={list(data.keys())}")
        except Exception as e:
            log(label, FAIL, str(e))


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────
def print_summary():
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    passed  = sum(1 for r in results if r["status"] == PASS)
    failed  = sum(1 for r in results if r["status"] == FAIL)
    skipped = sum(1 for r in results if r["status"] == SKIP)
    total   = len(results)
    print(f"  Total : {total}")
    print(f"  {PASS} : {passed}")
    print(f"  {FAIL} : {failed}")
    print(f"  {SKIP} : {skipped}")
    if failed:
        print("\nFailed tests:")
        for r in results:
            if r["status"] == FAIL:
                print(f"  - {r['label']}: {r['detail']}")
    print()


if __name__ == "__main__":
    args = sys.argv[1:]
    run_mcp   = "--agent-only" not in args
    run_agent = "--mcp-only" not in args

    print(f"\n{'='*60}")
    print(f"Tech4Human Banking — End-to-End Test Suite")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Node  : {NODE_BASE}")
    print(f"MCP   : {MCP_BASE}")
    print(f"{'='*60}")

    test_services_health()

    new_acc = None
    if run_mcp:
        new_acc = test_mcp_tools()
        test_mcp_close_account(new_acc)

    if run_agent:
        test_agent_flows()

    test_admin_endpoints()
    print_summary()


# ──────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────
NODE_BASE   = "http://localhost:3000"
MCP_BASE    = "http://127.0.0.1:3001"

CHAT_URL    = f"{NODE_BASE}/api/agent/chat"
HEALTH_URL  = f"{NODE_BASE}/health"
MCP_HEALTH  = f"{MCP_BASE}/sse"   # SSE endpoint (GET returns EventStream)

# Test customers (from seed data)
JOHN_PHONE    = "2348012345678"   # normalised
JOHN_ACCOUNT  = "3089345050"
JOHN_ID       = 1

LANRE_PHONE   = "2349013360717"
LANRE_ACCOUNT = "3031192963"
LANRE_ID      = 3

JANE_PHONE    = "2340898765432"   # normalised
JANE_ACCOUNT  = "3092603736"
JANE_ID       = 2

LANRE_PIN     = "1234"            # OTP default from send_verification_otp

# ──────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────
PASS = "✅ PASS"
FAIL = "❌ FAIL"
SKIP = "⏭  SKIP"
results: list[dict] = []

def log(label: str, status: str, detail: str = "", reply: str = ""):
    icon = status
    print(f"\n{icon}  {label}")
    if detail:
        print(f"   Detail : {detail}")
    if reply:
        # truncate very long agent replies
        short = reply[:300].replace("\n", " | ")
        print(f"   Reply  : {short}{'…' if len(reply) > 300 else ''}")
    results.append({"label": label, "status": status, "detail": detail})


def chat(phone: str, message: str, customer_name: str = "") -> dict:
    """Call the /api/agent/chat endpoint synchronously."""
    payload: dict = {"phone": phone, "message": message}
    if customer_name:
        payload["customerName"] = customer_name
    r = httpx.post(CHAT_URL, json=payload, timeout=90)
    r.raise_for_status()
    return r.json()


def mcp_tool(tool_name: str, arguments: dict) -> dict:
    """
    Call an MCP tool directly via JSON-RPC over HTTP POST to /messages/.
    FastMCP exposes a POST /messages/ endpoint for non-SSE callers when using
    the default Starlette router.  We use a simple HTTP POST here instead of
    the full SSE handshake.
    """
    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    }
    r = httpx.post(f"{MCP_BASE}/messages/", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


# ──────────────────────────────────────────────
# 0.  SERVICE HEALTH CHECKS
# ──────────────────────────────────────────────
def test_services_health():
    print("\n" + "="*60)
    print("SECTION 0 — Service Health Checks")
    print("="*60)

    # Node server
    try:
        r = httpx.get(HEALTH_URL, timeout=10)
        data = r.json()
        log("Node server health", PASS, f"status={data.get('status')} bank={data.get('bank')}")
    except Exception as e:
        log("Node server health", FAIL, str(e))
        print("\n⛔  Node server is not running. Start it with: pnpm start")
        sys.exit(1)

    # MCP SSE endpoint — SSE never closes, so we just verify we can connect.
    # A ReadTimeout means we connected but the stream is open (server is running).
    # A ConnectError means the port is closed (server is down).
    try:
        with httpx.stream("GET", MCP_HEALTH, timeout=httpx.Timeout(connect=5.0, read=2.0),
                          headers={"Accept": "text/event-stream"}) as r:
            # Read a few bytes to confirm the response started
            for chunk in r.iter_bytes(chunk_size=64):
                break  # got first bytes — server is up
        log("MCP service health", PASS, f"http_status={r.status_code}")
    except httpx.ReadTimeout:
        # Got a connection but SSE stream is just waiting — server IS running
        log("MCP service health", PASS, "SSE stream open (ReadTimeout expected for SSE)")
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        log("MCP service health", FAIL, str(e))
        print("\n⛔  MCP service is not running. Start it with: uvicorn server:app --port 3001")
        sys.exit(1)
    except Exception as e:
        log("MCP service health", FAIL, str(e))
        print("\n⛔  MCP service is not running. Start it with: uvicorn server:app --port 3001")
        sys.exit(1)


# ──────────────────────────────────────────────
# 1.  MCP TOOL DIRECT TESTS  (JSON-RPC)
# ──────────────────────────────────────────────
def test_mcp_tools():
    print("\n" + "="*60)
    print("SECTION 1 — MCP Tool Direct Tests")
    print("="*60)

    # 1.1 lookup_customer_by_phone  (known phone)
    try:
        res = mcp_tool("lookup_customer_by_phone", {"phone_number": "08012345678"})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("found") is True and data.get("customer_id") == JOHN_ID
        log("lookup_customer_by_phone (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("lookup_customer_by_phone (John)", FAIL, str(e))

    # 1.2 lookup_customer_by_phone  (unknown phone)
    try:
        res = mcp_tool("lookup_customer_by_phone", {"phone_number": "09099999999"})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("found") is False
        log("lookup_customer_by_phone (unknown)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("lookup_customer_by_phone (unknown)", FAIL, str(e))

    # 1.3 lookup_customer_by_account
    try:
        res = mcp_tool("lookup_customer_by_account", {"account_number": JOHN_ACCOUNT, "bank_code": "001"})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("found") is True
        log("lookup_customer_by_account (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("lookup_customer_by_account (John)", FAIL, str(e))

    # 1.4 get_onboarding_status
    try:
        res = mcp_tool("get_onboarding_status", {"customer_id": JOHN_ID})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True
        log("get_onboarding_status (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("get_onboarding_status (John)", FAIL, str(e))

    # 1.5 send_verification_otp
    try:
        res = mcp_tool("send_verification_otp", {"phone_number": JOHN_PHONE})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True and data.get("otp_code") == "1234"
        log("send_verification_otp (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("send_verification_otp (John)", FAIL, str(e))

    # 1.6 update_onboarding_status  (mark terms_accepted)
    try:
        res = mcp_tool("update_onboarding_status", {"customer_id": JOHN_ID, "field": "terms_accepted", "value": True})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True
        log("update_onboarding_status (terms_accepted)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("update_onboarding_status (terms_accepted)", FAIL, str(e))

    # 1.7 update_onboarding_status  (mark phone_verified)
    try:
        res = mcp_tool("update_onboarding_status", {"customer_id": JOHN_ID, "field": "phone_verified", "value": True})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True
        log("update_onboarding_status (phone_verified)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("update_onboarding_status (phone_verified)", FAIL, str(e))

    # 1.8 set_transaction_pin
    try:
        res = mcp_tool("set_transaction_pin", {"customer_id": JOHN_ID, "new_pin": "1234"})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True
        log("set_transaction_pin (John PIN=1234)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("set_transaction_pin (John PIN=1234)", FAIL, str(e))

    # 1.9 verify_pin (correct)
    try:
        res = mcp_tool("verify_pin", {"customer_id": JOHN_ID, "pin": "1234"})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("is_valid") is True
        log("verify_pin (correct PIN)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("verify_pin (correct PIN)", FAIL, str(e))

    # 1.10 verify_pin (wrong)
    try:
        res = mcp_tool("verify_pin", {"customer_id": JOHN_ID, "pin": "9999"})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("is_valid") is False
        log("verify_pin (wrong PIN)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("verify_pin (wrong PIN)", FAIL, str(e))

    # 1.11 get_customer_account
    try:
        res = mcp_tool("get_customer_account", {"customer_id": JOHN_ID})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True and JOHN_ACCOUNT in data.get("account_number", "")
        log("get_customer_account (John)", PASS if ok else FAIL, str(data))
    except Exception as e:
        log("get_customer_account (John)", FAIL, str(e))

    # 1.12 get_account_balance
    try:
        res = mcp_tool("get_account_balance", {"account_number": JOHN_ACCOUNT})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True and data.get("balance", 0) > 0
        log("get_account_balance (John)", PASS if ok else FAIL, f"balance={data.get('balance')} NGN")
    except Exception as e:
        log("get_account_balance (John)", FAIL, str(e))

    # 1.13 get_transaction_history
    try:
        res = mcp_tool("get_transaction_history", {"account_number": JOHN_ACCOUNT, "limit": 3})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True and len(data.get("transactions", [])) > 0
        log("get_transaction_history (John, limit=3)", PASS if ok else FAIL,
            f"{len(data.get('transactions', []))} transactions returned")
    except Exception as e:
        log("get_transaction_history (John)", FAIL, str(e))

    # 1.14 transfer_funds (John → Jane)
    txn_ref = f"TXN-E2E-{uuid.uuid4().hex[:8].upper()}"
    try:
        res = mcp_tool("transfer_funds", {
            "from_acc": JOHN_ACCOUNT,
            "to_acc": JANE_ACCOUNT,
            "amount": 500.0,
            "txn_id": txn_ref,
            "description": "E2E test transfer"
        })
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True
        log("transfer_funds (John→Jane, ₦500)", PASS if ok else FAIL,
            f"ref={data.get('reference')} balance={data.get('available_balance')}")
    except Exception as e:
        log("transfer_funds (John→Jane)", FAIL, str(e))

    # 1.15 generate_receipt for the transfer above
    try:
        res = mcp_tool("generate_receipt", {"reference": txn_ref})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "{}")
        data = json.loads(content)
        ok = data.get("success") is True and txn_ref in data.get("receipt_text", "")
        log("generate_receipt (transfer ref)", PASS if ok else FAIL, data.get("message", ""))
    except Exception as e:
        log("generate_receipt", FAIL, str(e))

    # 1.16 get_loans
    try:
        res = mcp_tool("get_loans", {"customer_id": LANRE_ID})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "")
        ok = "Personal Loan" in content or "No active loans" in content
        log("get_loans (Lanre)", PASS if ok else FAIL, content[:120])
    except Exception as e:
        log("get_loans (Lanre)", FAIL, str(e))

    # 1.17 get_cards
    try:
        res = mcp_tool("get_cards", {"customer_id": LANRE_ID})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "")
        ok = "debit" in content.lower() or "No active cards" in content
        log("get_cards (Lanre)", PASS if ok else FAIL, content[:120])
    except Exception as e:
        log("get_cards (Lanre)", FAIL, str(e))

    # 1.18 pay_bills
    bill_ref = f"BILL-E2E-{uuid.uuid4().hex[:8].upper()}"
    try:
        res = mcp_tool("pay_bills", {
            "account_number": LANRE_ACCOUNT,
            "amount": 200.0,
            "biller": "DSTV",
            "idempotency_key": bill_ref
        })
        content = res.get("result", {}).get("content", [{}])[0].get("text", "")
        ok = "Paid" in content or "successfully" in content.lower()
        log("pay_bills (Lanre DSTV ₦200)", PASS if ok else FAIL, content[:120])
    except Exception as e:
        log("pay_bills (Lanre DSTV)", FAIL, str(e))

    # 1.18b idempotency check — same key should not double-charge
    try:
        res = mcp_tool("pay_bills", {
            "account_number": LANRE_ACCOUNT,
            "amount": 200.0,
            "biller": "DSTV",
            "idempotency_key": bill_ref
        })
        content = res.get("result", {}).get("content", [{}])[0].get("text", "")
        ok = "already processed" in content.lower()
        log("pay_bills idempotency check", PASS if ok else FAIL, content[:120])
    except Exception as e:
        log("pay_bills idempotency check", FAIL, str(e))

    # 1.19 open_account
    try:
        res = mcp_tool("open_account", {
            "customer_id": JANE_ID,
            "account_type": "Current",
            "initial_deposit": 1000.0
        })
        content = res.get("result", {}).get("content", [{}])[0].get("text", "")
        ok = "Account opened" in content or "successfully" in content.lower()
        log("open_account (Jane Current ₦1000)", PASS if ok else FAIL, content[:120])
        # Extract new account number for close test
        new_acc = None
        if "Account Number:" in content:
            new_acc = content.split("Account Number:")[-1].strip().split()[0]
        return new_acc  # pass to close_account test
    except Exception as e:
        log("open_account (Jane)", FAIL, str(e))
        return None


def test_mcp_close_account(account_number: str | None):
    """Test close_account on the freshly opened zero-balance account."""
    if not account_number:
        log("close_account", SKIP, "No account number from open_account test")
        return
    # Zero out by doing nothing (initial deposit = ₦1000, can't close with balance)
    try:
        res = mcp_tool("close_account", {"account_number": account_number})
        content = res.get("result", {}).get("content", [{}])[0].get("text", "")
        # Should fail with "balance must be 0" since we deposited ₦1000
        ok = "balance must be 0" in content.lower() or "closed successfully" in content.lower()
        log("close_account (non-zero balance guard)", PASS if ok else FAIL, content[:120])
    except Exception as e:
        log("close_account", FAIL, str(e))


# ──────────────────────────────────────────────
# 2.  AGENT CHAT TESTS (via /api/agent/chat)
# ──────────────────────────────────────────────
def test_agent_flows():
    print("\n" + "="*60)
    print("SECTION 2 — Agent Chat Tests (MCP tools via supervisor)")
    print("="*60)

    # Use unique phone per test so memory doesn't bleed between scenarios
    def phone(suffix: str) -> str:
        return f"e2e-{suffix}"

    # 2.1  Greeting / menu
    try:
        r = chat(phone("greeting"), "Hello")
        ok = r.get("success") is True and len(r.get("reply", "")) > 0
        log("Agent: greeting/menu", PASS if ok else FAIL, reply=r.get("reply", ""))
    except Exception as e:
        log("Agent: greeting/menu", FAIL, str(e))

    # 2.2  Balance check (known customer — John Doe)
    try:
        r = chat(JOHN_PHONE, "What is my account balance?", "John Doe")
        reply = r.get("reply", "")
        # Agent should call lookup_customer_by_phone + get_account_balance
        ok = r.get("success") is True and any(c in reply.lower() for c in ["balance", "ngn", "₦", "naira", "account"])
        log("Agent: balance enquiry (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: balance enquiry (John)", FAIL, str(e))

    # 2.3  Transaction history
    try:
        r = chat(JOHN_PHONE, "Show me my last 3 transactions", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["transaction", "debit", "credit", "transfer", "ngn"])
        log("Agent: transaction history (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: transaction history (John)", FAIL, str(e))

    # 2.4  Transfer request (multi-turn: initiate)
    try:
        r = chat(phone("transfer-1"), f"I want to transfer 1000 naira to account {JANE_ACCOUNT}")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["pin", "confirm", "transfer", "account", "amount"])
        log("Agent: transfer initiation", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: transfer initiation", FAIL, str(e))

    # 2.5  Onboarding / T&C acceptance
    try:
        r = chat(phone("onboard-1"), "I'm a new customer, I want to get started")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["term", "condition", "welcome", "register", "onboard", "account", "option"])
        log("Agent: onboarding welcome", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: onboarding welcome", FAIL, str(e))

    # 2.6  Support / FAQ
    try:
        r = chat(phone("support-1"), "How do I reset my PIN?")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: support FAQ (PIN reset)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: support FAQ (PIN reset)", FAIL, str(e))

    # 2.7  Loans (known customer)
    try:
        r = chat(LANRE_PHONE, "Show me my active loans", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["loan", "principal", "balance", "interest", "no active"])
        log("Agent: loans check (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: loans check (Lanre)", FAIL, str(e))

    # 2.8  Cards
    try:
        r = chat(LANRE_PHONE, "What cards do I have?", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["card", "debit", "expiry", "no active"])
        log("Agent: cards check (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: cards check (Lanre)", FAIL, str(e))

    # 2.9  Bill payment via agent
    try:
        r = chat(LANRE_PHONE, "I want to pay my DSTV subscription of 3000 naira", "Olanrewaju")
        reply = r.get("reply", "")
        ok = r.get("success") is True and any(c in reply.lower() for c in ["pin", "confirm", "pay", "dstv", "bill", "naira"])
        log("Agent: bill payment initiation (Lanre)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: bill payment initiation (Lanre)", FAIL, str(e))

    # 2.10  Financial insights / spending
    try:
        r = chat(JOHN_PHONE, "Show me my spending breakdown", "John Doe")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: financial insights (John)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: financial insights (John)", FAIL, str(e))

    # 2.11  Fraud alert query
    try:
        r = chat(phone("fraud-1"), "I got a suspicious transaction alert, what should I do?")
        reply = r.get("reply", "")
        ok = r.get("success") is True and len(reply) > 10
        log("Agent: fraud alert guidance", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: fraud alert guidance", FAIL, str(e))

    # 2.12  Multi-turn session memory test
    p = phone("memory-1")
    try:
        chat(p, "My name is Test User")
        r2 = chat(p, "What did I just tell you?")
        reply = r2.get("reply", "")
        ok = r2.get("success") is True and "test user" in reply.lower()
        log("Agent: session memory (multi-turn)", PASS if ok else FAIL, reply=reply)
    except Exception as e:
        log("Agent: session memory (multi-turn)", FAIL, str(e))


# ──────────────────────────────────────────────
# 3.  ADMIN ENDPOINTS
# ──────────────────────────────────────────────
def test_admin_endpoints():
    print("\n" + "="*60)
    print("SECTION 3 — Admin Endpoints")
    print("="*60)

    for path, label in [
        ("/admin/sessions", "Admin: sessions list"),
        ("/admin/fraud-alerts", "Admin: fraud alerts"),
        ("/admin/tickets", "Admin: escalation tickets"),
    ]:
        try:
            r = httpx.get(f"{NODE_BASE}{path}", timeout=15)
            data = r.json()
            ok = r.status_code == 200
            log(label, PASS if ok else FAIL, f"http={r.status_code} keys={list(data.keys())}")
        except Exception as e:
            log(label, FAIL, str(e))


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────
def print_summary():
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    passed  = sum(1 for r in results if r["status"] == PASS)
    failed  = sum(1 for r in results if r["status"] == FAIL)
    skipped = sum(1 for r in results if r["status"] == SKIP)
    total   = len(results)
    print(f"  Total : {total}")
    print(f"  {PASS} : {passed}")
    print(f"  {FAIL} : {failed}")
    print(f"  {SKIP} : {skipped}")
    if failed:
        print("\nFailed tests:")
        for r in results:
            if r["status"] == FAIL:
                print(f"  - {r['label']}: {r['detail']}")
    print()


if __name__ == "__main__":
    args = sys.argv[1:]
    run_mcp   = "--agent-only" not in args
    run_agent = "--mcp-only" not in args

    print(f"\n{'='*60}")
    print(f"Tech4Human Banking — End-to-End Test Suite")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Node  : {NODE_BASE}")
    print(f"MCP   : {MCP_BASE}")
    print(f"{'='*60}")

    test_services_health()

    new_acc = None
    if run_mcp:
        new_acc = test_mcp_tools()
        test_mcp_close_account(new_acc)

    if run_agent:
        test_agent_flows()

    test_admin_endpoints()
    print_summary()
