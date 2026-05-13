---
name: bill-payment
description: Handles secure bill payments (electricity, DSTV, airtime, data, subscriptions) with mandatory biller validation, PIN verification, OTP authentication, and fraud checks.
version: 1.0.0
tags:
  - banking
  - bills
  - payments
  - security
  - otp
---

# Bill Payment Skill

This skill handles all customer bill payments.

This is a security-critical flow. Each step must complete before the next begins.
Always validate the biller, verify the customer PIN, and verify the OTP before executing payment.
Stop immediately if any step fails.

---

# Required References

Read BEFORE execution:

- `references/security-rules.md`
- `references/biller-rules.md`
- `references/bill-formatting.md`
- `references/otp-rules.md`

---

# STEP 1 — Collect Payment Details

Extract from customer message:
- billerName / biller type (DSTV, electricity, airtime, data, etc.)
- smart card / meter / phone number / reference
- amount

If any required field is missing, ask for it. Do NOT proceed until all are provided.

---

# STEP 2 — Validate Biller

Call `validate-biller`(billerName).

Display the biller details for confirmation:
─────────────────────────
*Bill Payment Details*
📺 Biller:    {billerName}
🆔 ID/Number: {smartCardOrMeterNumber}
👤 Name:      {customerName}
💰 Amount:    ₦{amount}
─────────────────────────
Reply *YES* to confirm or *NO* to cancel.

⚠️ END YOUR RESPONSE. Wait for customer reply.

If NO: "Payment cancelled." STOP.
If YES: continue.

---

# STEP 3 — PIN GATE (⚠️ This step ends your turn)

Call `check-has-pin`(phone=contextPhone).

IF hasPin=false:
→ Start PIN CREATION FLOW. After created=true: continue to STEP 4.

IF hasPin=true:
→ Send EXACTLY: "🔐 Please enter your 4-digit transaction PIN to authorize this payment."
→ END YOUR RESPONSE. Wait for the customer's next message.

[NEXT TURN — customer has sent PIN digits]
Extract digits from customer's last message.
Call `verify-transaction-pin`(phone=contextPhone, pin=thosePINDigits).
- verified=true → pinVerified=true. Continue to STEP 4.
- verified=false → "❌ Incorrect PIN. [N] attempt(s) remaining." STOP. Do NOT go to OTP.
- blocked=true → "🔒 Account locked. Contact support." STOP.

---

# STEP 4 — OTP GATE (⚠️ This step ends your turn)

Call `send-phone-verification-otp`(phone=contextPhone).
Send EXACTLY: "📲 An OTP has been sent to your registered phone number. Please enter it to authorize the payment."
END YOUR RESPONSE. Wait for the customer's next message.

[NEXT TURN — customer has sent OTP digits]
Extract OTP from customer's last message.
Call `verify-phone-verification-otp`(phone=contextPhone, otp=theOTPFromCustomer).
- verified=true → otpVerified=true. Continue to STEP 5.
- verified=false → "❌ Incorrect OTP. Please enter it again, or type *RESEND* for a new one." STOP.
  ⚠️ Do NOT re-ask for PIN. Stay in OTP loop.
- expired=true → "⏱️ OTP expired. Type *RESEND* for a new one." STOP.
- Customer says RESEND → Resend OTP, re-prompt. STOP.

---

# STEP 5 — Final Confirmation (⚠️ This step ends your turn)

─────────────────────────
*Please confirm your payment:*
📺 Biller:    {billerName}
🆔 ID/Number: {smartCardOrMeterNumber}
👤 Name:      {customerName}
💰 Amount:    ₦{amount}
─────────────────────────
Reply *CONFIRM* to proceed or *CANCEL* to abort.

END YOUR RESPONSE. Wait for customer reply.

If CANCEL: "Payment cancelled." STOP.
If CONFIRM: continue to STEP 6.

---

# STEP 6 — Execute Payment

Call `execute-bill-payment`.

On success: show receipt.
On failure: "Payment failed. Please try again or contact support." STOP.

---

# STEP 7 — Receipt + Audit

Call `generate-receipt`.
Call `log-audit-event`(event="transaction_initiated").

---

# RESPONSE RULES

Read:
`references/bill-formatting.md`

NEVER:
- use tables
- expose internal IDs
- expose raw biller data
- return JSON
