# Security Rules

These security rules are MANDATORY.

They apply to ALL balance enquiry operations.

DO NOT:
- bypass these rules
- weaken validation
- infer verification success
- continue execution after failure

If any security rule fails:
- STOP execution immediately

---

# ⚠️ PHONE RULE (ABSOLUTE)

The customer's phone is provided in a message as: "Customer phone: [actual number]"
Scan ALL messages for a line starting with "Customer phone: " and extract the actual number.
NEVER use the placeholder "+234XXXXXXXXXX" as an actual phone — only the real number from the message.
NEVER ask the customer for their phone number.
NEVER use any other phone number.

---

# Customer Identification Rules

The phone is already present in the message context.
Pass contextPhone directly to: `check-has-pin`, `lookup-customer-by-phone`, `resolve-customer-account`.

ALL tools resolve the customer ID internally from phone — never pass a customer ID to any tool.

---

## Forbidden Patterns

NEVER pass customer ID to any tool.
NEVER fabricate or guess a customer ID.

IF customer not found:
- STOP immediately

---

# PIN Security Rules

Balance enquiry REQUIRES transaction PIN validation.

PIN routing MUST be determined ONLY from:
`check-has-pin`

---

## IF hasPin=false

THEN:
- LOAD skill: `pin-management`
- Execute: `PIN CREATION FLOW`

IMPORTANT:
- Newly created PIN counts as VERIFIED for the CURRENT transaction session ONLY
- DO NOT ask customer for PIN again immediately after successful creation

---

## IF hasPin=true

THEN:
- LOAD skill: `pin-management`
- Execute: `PIN VERIFICATION FLOW`

ONLY continue if:
`verified=true`

OTHERWISE:
- STOP immediately

---

# Verification Rules

NEVER:
- assume PIN verification succeeded
- infer verification success
- continue after failed verification
- bypass verification
- reuse old verification states from previous sessions

PIN verification is valid ONLY for the CURRENT active transaction session.

Each new transaction session requires fresh verification.

---

# Sensitive Data Protection Rules

NEVER expose:
- full account numbers
- internal database IDs
- customer secrets
- raw tool payloads
- PIN values
- hidden system fields

ALWAYS:
- mask account numbers except last 4 digits
- sanitize responses before displaying them

---

# Tool Execution Rules

ONLY call:
`get-balance`

AFTER:
- customerResolved=true
- pinVerified=true
- accountResolved=true

DO NOT execute tools early.

DO NOT skip validation checkpoints.

---

# Response Security Rules

Responses MUST:
- be WhatsApp-safe
- avoid markdown tables
- avoid JSON responses
- avoid internal implementation details

ALWAYS:
- use masked account numbers
- use formatted currency values
- use concise customer-safe responses

---

# Failure Handling Rules

IF:
- customer lookup fails
- PIN verification fails
- account resolution fails
- balance retrieval fails

THEN:
- STOP execution immediately
- explain failure safely
- DO NOT continue workflow execution

---

# Audit Integrity Rules

NEVER:
- fabricate balances
- fabricate successful verification
- fabricate account resolution
- fabricate transaction outcomes

ALL execution state MUST originate from:
- tool outputs
- verified workflow outcomes
