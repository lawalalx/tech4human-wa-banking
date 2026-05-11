# PIN Creation Flow

THIS IS A STRICT 2-STEP FLOW.

## ⚠️ PHONE RULE
The customer phone is in the system context: "Customer phone: +234XXXXXXXXXX"
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

1. Extract contextPhone from system message "Customer phone: ..."
2. Use the customerId already stored from check-has-pin in the parent flow.
   If customerId is missing, call: lookup-customer-by-phone(phone=contextPhone)
3. Extract valid customerId
4. Call: create-transaction-pin(customerId, pin=pending_pin)

---

# SUCCESS RULE

A newly created PIN counts as VERIFIED for the CURRENT transaction session ONLY.

DO NOT ask customer for PIN again immediately after successful creation.
