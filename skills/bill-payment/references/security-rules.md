# Bill Payment Security Rules

Bill payments are HIGH-RISK financial actions.

---

## Mandatory Controls

You MUST enforce:

- PIN verification (every session)
- OTP verification (every transaction)
- biller validation before execution
- explicit customer confirmation

---

## Forbidden Actions

NEVER:
- execute payment without OTP
- skip biller validation
- assume PIN success
- reuse old OTP sessions
- proceed after failed verification

---

## Data Protection

NEVER expose:
- customer identifiers
- full account numbers
- biller internal codes
- OTP values
- PIN values

Always mask sensitive data.
