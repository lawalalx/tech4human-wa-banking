---
name: transfer
description: Handles secure intra-bank and interbank transfers with mandatory fraud validation, PIN verification, OTP authentication, recipient validation, audit logging, receipt generation, and structured response formatting.
version: 1.0.0
tags:
  - banking
  - transfer
  - payments
  - nip
  - neft
  - security
  - otp
  - fraud
---

# 🔐 Transfer Skill (Unified)

This skill handles secure bank transfers including intra-bank and interbank (NIP/NEFT) transactions.

This is a SECURITY-CRITICAL financial workflow.

---

# ⚠️ PHONE NUMBER RULE (ABSOLUTE — READ FIRST)

The customer's WhatsApp phone is in the system context message:
  "Customer phone: +234XXXXXXXXXX"

ALWAYS extract this as contextPhone BEFORE any tool call.
NEVER ask the customer for their phone.
ALWAYS pass contextPhone to: `lookup_customer_by_phone`, `check-has-pin`, `resolve-customer-account`.

TOOL SEPARATION:
- `lookup_customer_by_phone` → for the SENDER (use contextPhone)
- `lookup-customer-by-account` → for the RECIPIENT ONLY (use account number given by customer)
NEVER call `lookup-customer-by-account` with a phone number.

---

# 🚨 STRICT SECURITY RULES

NEVER:
- skip steps
- reorder execution flow
- bypass PIN verification
- bypass OTP verification
- bypass fraud checks
- execute transfer before confirmation
- fabricate recipient, balance, or transaction results
- reuse old authentication sessions
- expose OTP, PIN, or internal system IDs

STOP immediately if any validation fails.

---

# 📚 Required References (Load Only When Needed)

- `references/transfer-security.md`
- `references/fraud-rules.md`
- `references/otp-rules.md`
- `references/transfer-confirmation.md`
- `references/transfer-formatting.md`
- `references/transfer-failure-handling.md`

---

# 🧠 STATE MANAGEMENT (STRICT)

Maintain state ONLY from verified tool outputs:

- customerResolved
- customerId
- senderAccountResolved
- recipientValidated
- recipientName
- customerConfirmed
- fraudApproved
- hasPin
- pinVerified
- otpVerified
- transferExecuted
- receiptGenerated

NEVER infer or fabricate state.

---

# ⚙️ EXECUTION FLOW

---

## STEP 1 — Extract Transfer Details

Extract:
- amount
- recipientAccount

Normalize informal values:
- 20k → 20000
- 1.5m → 1500000

IF missing required fields:
→ request missing information
→ STOP

---

## STEP 2 — Resolve Customer (Sender)

Extract contextPhone from system message: "Customer phone: +234XXXXXXXXXX"

Call:
`lookup_customer_by_phone`

Input:
- phone = contextPhone

Store:
- customerResolved = true
- customerId

IF invalid or missing:
→ STOP immediately

---

## STEP 3 — Resolve Sender Account

Call:
`resolve-customer-account`

Input:
- phone = contextPhone

Store:
- senderAccountResolved = true
- senderAccount (account number)

IF failed:
→ STOP immediately

---

## STEP 4 — Validate Recipient

Call:
`lookup-customer-by-account`

Purpose:
- recipient identity confirmation ONLY

Store:
- recipientValidated = true
- recipientName

IF recipient not found:
→ respond: "Recipient account not found. Please check the account number and try again."
→ STOP

---

## STEP 5 — Customer Confirmation

Display:
- recipientName
- masked account number
- bank name
- amount
- fees (if applicable)

Ask:
**"Should I proceed?"**

Accept ONLY:
- yes
- confirm
- proceed
- continue

Otherwise:
→ STOP

Store:
- customerConfirmed = true

---

## STEP 6 — Fraud Validation

Call:
`check-fraud-risk`

IF not approved:
→ STOP immediately

Store:
- fraudApproved = true

---

## STEP 7 — PIN VERIFICATION / CREATION

Call:
`check-has-pin`

IF hasPin = false:
- load `pin-management`
- execute PIN creation flow
- set pinVerified = true

IF hasPin = true:
- load `pin-management`
- execute PIN verification flow
- require verified = true

IF verification fails:
→ STOP

Store:
- pinVerified = true

---

## STEP 8 — OTP VERIFICATION

Load:
`otp-management`

Execute OTP flow

IF otpVerified != true:
→ STOP

Store:
- otpVerified = true

---

## STEP 9 — EXECUTE TRANSFER

ONLY proceed if ALL are true:
- customerResolved
- senderAccountResolved
- recipientValidated
- fraudApproved
- pinVerified
- otpVerified
- customerConfirmed

Call:
`execute-intra-transfer`

Store:
- transferExecuted = true

IF failed:
→ STOP

---

## STEP 10 — GENERATE RECEIPT

Call:
`generate-receipt`

Store:
- receiptGenerated = true

---

## STEP 11 — AUDIT LOGGING

Call:
`log-audit-event`

Event:
- transfer_completed

---

## STEP 12 — RESPONSE FORMATTING

Use:
`references/transfer-formatting.md`

Return customer-safe response:
- no PIN
- no OTP
- no internal IDs
- masked sensitive data only

---

# 🛑 GLOBAL FORBIDDEN ACTIONS

NEVER:
- execute transfer before OTP verification
- execute transfer before fraud approval
- proceed after failed validation
- assume tool success without confirmation
- expose sensitive banking credentials
- bypass any security gate

---

# ✅ COMPLETION CRITERIA

A transfer is ONLY successful if:

- customer resolved
- sender account resolved
- recipient validated
- fraud approved
- PIN verified
- OTP verified
- transfer executed
- receipt generated
- audit logged

Otherwise:
→ transaction MUST STOP and is FAILED
