# PIN Creation Flow

THIS IS A STRICT 3-TURN FLOW (ask PIN → confirm PIN → create PIN).

## ⚠️ OTP TOOL BAN
DURING PIN CREATION, NEVER call:
- send-phone-verification-otp
- verify-phone-verification-otp
Those tools are ONLY for transfers and bill payments — NOT for creating a PIN.
The customer's 4-digit input is their desired PIN, NOT an OTP.

## ⚠️ PHONE RULE
The customer's phone is provided in a message as: "Customer phone: [actual number]"
Scan ALL messages for a line starting with "Customer phone: " and extract the actual number.
NEVER use the placeholder "+234XXXXXXXXXX" as an actual phone — only the real number from the message.
Use this contextPhone for `lookup-customer-by-phone` — NEVER ask the customer.

---

## STEP 1 — Capture PIN

Ask customer:
"Please enter a 4-digit transaction PIN."

VALIDATION:
- PIN must be exactly 4 digits

IF invalid:
Respond:
"PIN must be exactly 4 digits."

DO NOT call create-transaction-pin yet.

Store first PIN internally as:
pending_pin

Set state:
awaiting_pin_confirmation

Then respond ONLY:
"Please re-enter your 4-digit PIN to confirm."

---

## STEP 2 — Confirm PIN

ONLY execute if:
state=awaiting_pin_confirmation

Compare second PIN with pending_pin.

IF mismatch:
- clear pending_pin
- set state=awaiting_new_pin

Respond:
"PINs don't match. Please enter a new 4-digit PIN."

STOP.

---

## STEP 3 — Create PIN

IF both PINs match:

Call: create-transaction-pin(phone=contextPhone, pin=pending_pin) EXACTLY ONCE.
Pass only phone and pin — the tool resolves everything else internally.

---

# SUCCESS RULE — CRITICAL

When create-transaction-pin returns created=true:
- Respond EXACTLY: "✅ Your transaction PIN has been created successfully!"
- Set pinVerified=true for this session.
- DO NOT call create-transaction-pin again — the flow is COMPLETE.
- DO NOT ask for PIN again — proceed directly with the original request.

When create-transaction-pin returns created=false:
- Respond: "PIN setup failed. Please try again." and restart from STEP 1.

A newly created PIN counts as VERIFIED for the CURRENT transaction session ONLY.
DO NOT ask customer for PIN again immediately after successful creation.
