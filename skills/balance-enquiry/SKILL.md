---
name: balance-enquiry
description: Handles secure customer balance enquiries with mandatory PIN validation, customer resolution, account resolution, and WhatsApp-safe response formatting. Use for requests involving account balance, available balance, wallet balance, account funds, or balance checks.
version: 1.0.0
tags:
  - banking
  - balance
  - account
  - security
  - whatsapp
---

# Balance Enquiry Skill

This skill handles secure balance enquiries.

THIS IS A SECURITY-CRITICAL FLOW.

Execution MUST follow the exact sequence defined below.

DO NOT:
- skip steps
- reorder steps
- fabricate balances
- bypass PIN validation
- assume verification success
- expose full account numbers
- expose internal identifiers
- execute future steps early

If any required step fails:
- STOP immediately
- explain the failure
- DO NOT continue execution

---

# ⚠️ PHONE NUMBER RULE (ABSOLUTE — READ FIRST)

The customer's phone is always present as: "Customer phone: +234XXXXXXXXXX"
This appears EITHER in the system context OR in the first line of the task/user message.
Scan ALL messages for a line starting with "Customer phone: " and extract the actual number.

ALWAYS extract this phone before calling ANY tool.
NEVER ask the customer to provide their phone number.
NEVER use a placeholder like "+234XXXXXXXXXX" — only use the real number from the message.
Pass this phone to: `check-has-pin`, `resolve-customer-account`, `get-balance`.

---

# Required References

Read these files BEFORE execution:

- `references/security-rules.md`
- `references/formatting.md`

DO NOT load unnecessary references.

---

# State Management Rules

Maintain transaction state internally.

Required state variables:
- contextPhone (extracted from system message "Customer phone: ...")
- customerResolved
- hasPin
- pinVerified
- accountResolved
- balanceRetrieved

NEVER invent state values.

State values MUST come from:
- tool outputs
- verified execution results

---

# Execution Workflow

## STEP 0 — Extract Phone from Context

Look through all messages in context for a line starting with "Customer phone: " followed by an actual phone number.
Extract that phone number and store it as contextPhone.

Example: "Customer phone: +2349013360717" → contextPhone = +2349013360717

CRITICAL: the placeholder "+234XXXXXXXXXX" in instruction templates is NOT a real phone.
Only use the actual phone number found in the actual message.
NEVER ask the customer for their phone.
NEVER proceed without contextPhone.

---

## STEP 1 — Check PIN Status

Call:
`check-has-pin`

Input:
- phone = contextPhone (from STEP 0)

Store:
- hasPin

---

## STEP 1 VALIDATION

IF:
- customer not found
- hasPin result is missing or error

THEN:
- STOP immediately
- Inform: "Your phone number is not registered with us."

DO NOT continue.

---

## STEP 2 VALIDATION

IF:
- hasPin is null
- hasPin is undefined

THEN:
- STOP immediately

DO NOT continue.

---

## STEP 3 — Route PIN Flow

PIN flow routing MUST be determined ONLY from the result of:
`check-has-pin`

---

IF:
`hasPin=false`

THEN:
- **PIN CREATION IS MANDATORY** before balance retrieval
- LOAD skill: `pin-management`
- Execute: `PIN CREATION FLOW` (customer must set up PIN first)
- ONLY after PIN creation completes (`created=true`): proceed to balance retrieval
- **DO NOT show balance without PIN creation**
- The phone for PIN creation = contextPhone (from STEP 0)

IMPORTANT:
- Newly created PIN counts as VERIFIED for the CURRENT transaction session ONLY
- DO NOT ask customer for PIN again after successful creation

After successful PIN creation:
- Set:
  - pinVerified=true

Continue immediately to STEP 4.

---

IF:
`hasPin=true`

THEN:
- LOAD skill: `pin-management`
- Execute: `PIN VERIFICATION FLOW`
- Use phone = contextPhone (from STEP 0)

ONLY continue if:
`verified=true`

After successful verification:
- Set:
  - pinVerified=true

OTHERWISE:
- STOP immediately

DO NOT continue after failed verification.

---

## STEP 4 VALIDATION

IF:
`pinVerified != true`

THEN:
- STOP immediately

DO NOT continue.

---

## STEP 5 — Resolve Customer Account

Call:
`resolve-customer-account`

Input:
- phone = contextPhone (from STEP 0)

Store:
- accountResolved = true (when status = "resolved")
- accountNumber

---

## STEP 6 VALIDATION

IF:
`accountResolved != true`

THEN:
- STOP immediately
- Inform customer account resolution failed

DO NOT continue.

---

## STEP 7 — Retrieve Balance

ONLY execute if:
- pinVerified=true
- accountResolved=true

Call:
`get-balance`

Input:
- phone = contextPhone (from STEP 0)

Store:
- balanceRetrieved=true

---

## STEP 8 VALIDATION

IF:
`balanceRetrieved != true`

THEN:
- STOP immediately

DO NOT continue.

---

## STEP 9 — Format Response

Read:
`references/formatting.md`

Format the balance response EXACTLY as specified.

Formatting requirements:
- WhatsApp-safe formatting only
- NEVER use markdown tables
- NEVER return JSON
- ALWAYS mask account numbers
- ALWAYS use ₦ currency formatting
- ALWAYS use comma separators
- ALWAYS show 2 decimal places

---

# Forbidden Actions

NEVER:
- call `get-balance` before account resolution
- continue after failed PIN verification
- expose sensitive customer data
- reveal internal system fields
- expose full account numbers
- ask for PIN again after successful PIN creation
- fabricate balances
- infer verification success without explicit confirmation
- ask the customer for their phone number

---

# Completion Criteria

This workflow is COMPLETE only when:
- contextPhone extracted from system message
- customer successfully verified
- account successfully resolved
- balance successfully retrieved
- response successfully formatted

Otherwise:
- workflow is FAILED
- execution MUST stop
