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

The customer's phone is always provided in a message as: "Customer phone: [actual number]"
This appears EITHER in the system context OR in the first line of the task message.
Scan ALL messages for a line starting with "Customer phone: " and extract the actual number.

ALWAYS extract this as contextPhone BEFORE any tool call.
NEVER ask the customer for their phone.
NEVER use the placeholder "+234XXXXXXXXXX" — only use the real number from the message.
ALWAYS pass contextPhone to: `lookup_customer_by_phone`, `check-has-pin`, `resolve-customer-account`.

TOOL SEPARATION:
- `lookup_customer_by_phone` → for the SENDER (use contextPhone)
- `lookup-customer-by-account` → for the RECIPIENT ONLY (use account number given by customer)
NEVER call `lookup-customer-by-account` with a phone number.

---

# 🚨 STRICT SECURITY RULES

Always follow the steps in order. Each step must complete successfully before moving to the next.
- PIN must be verified before OTP is triggered.
- OTP must be verified before executing any transfer.
- Fraud check must pass before proceeding.
- Customer must confirm recipient details before security steps.
- Tool results must be confirmed before proceeding.
- Sensitive values (PIN, OTP, internal IDs) must never appear in responses.

Stop immediately if any step returns an error or fails validation.

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

Extract contextPhone from system message: look for "Customer phone:" followed by the actual phone number.

Call:
`lookup_customer_by_phone`

Input:
- phone = contextPhone

Store:
- customerResolved = true

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

Display EXACTLY (substitute real values):

─────────────────────────
*Transfer Details*
💰 Amount:    ₦{amount}
👤 Recipient: {recipientName}
🏦 Account:   {maskedAccount} — {bankName}
─────────────────────────
Reply *YES* to confirm or *NO* to cancel.

⚠️ END YOUR RESPONSE HERE. Wait for customer reply.

Accept: yes / confirm / proceed / continue
Otherwise → "Transfer cancelled." STOP.

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

## STEP 7 — PIN GATE (⚠️ This step ends your turn)

Call `check-has-pin`(phone=contextPhone).

IF hasPin = false:
→ Start PIN CREATION FLOW. After created=true: continue to STEP 8.

IF hasPin = true:
→ Send EXACTLY: "🔐 Please enter your 4-digit transaction PIN to authorize this transfer."
→ END YOUR RESPONSE. Wait for the customer's next message.

[NEXT TURN — customer has sent PIN digits]
Extract the digits from the customer's last message.
Call `verify-transaction-pin`(phone=contextPhone, pin=thosePINDigits).
- verified=true → pinVerified=true. Continue to STEP 8.
- verified=false → "❌ Incorrect PIN. [N] attempt(s) remaining. Please try again." STOP.
  Do NOT proceed to OTP on wrong PIN.
- blocked=true → "🔒 Your account is locked. Please contact support." STOP.

NEVER re-ask for PIN based on OTP failure.

---

## STEP 8 — OTP GATE (⚠️ This step ends your turn)

Call `send-phone-verification-otp`(phone=contextPhone).
Send EXACTLY: "📲 An OTP has been sent to your registered phone number. Please enter it to authorize the transfer."
END YOUR RESPONSE. Wait for the customer's next message.

[NEXT TURN — customer has sent OTP digits]
Extract the OTP from the customer's last message.
Call `verify-phone-verification-otp`(phone=contextPhone, otp=theOTPFromCustomer).
- verified=true → otpVerified=true. Continue to STEP 8.5.
- verified=false → "❌ Incorrect OTP. Please enter it again, or type *RESEND* for a new one." STOP.
  ⚠️ Do NOT re-ask for PIN. Stay in OTP loop.
- expired=true → "⏱️ OTP expired. Type *RESEND* for a new one." STOP.
- Customer says RESEND → Call `send-phone-verification-otp` again, resend prompt. STOP.

Store:
- otpVerified = true

---

## STEP 8.5 — Final Confirmation (⚠️ This step ends your turn)

Display EXACTLY (substitute real values):

─────────────────────────
*Please confirm your transfer:*
💰 Amount:    ₦{amount}
👤 Recipient: {recipientName}
🏦 Account:   {maskedAccount} — {bankName}
─────────────────────────
Reply *CONFIRM* to proceed or *CANCEL* to abort.

END YOUR RESPONSE. Wait for customer reply.

If CANCEL → "Transfer cancelled." STOP.
If CONFIRM → continue to STEP 9.

---

## STEP 9 — EXECUTE TRANSFER

ONLY proceed if ALL are true:
- customerResolved
- senderAccountResolved
- recipientValidated
- fraudApproved
- pinVerified
- otpVerified
- customerConfirmed (from STEP 5)
- finalConfirmed (from STEP 8.5)

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

# ✅ SECURITY REQUIREMENTS

All of the following must be confirmed true before executing a transfer:
- Customer identity resolved
- Recipient account verified
- Fraud check passed
- PIN verified
- OTP verified
- Customer gave final confirmation

If any check fails, stop and inform the customer.

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
