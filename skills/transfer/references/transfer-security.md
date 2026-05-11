# Transfer Security Rules

Transfers are HIGH-RISK operations.

Security enforcement is mandatory.

---

# Mandatory Verification

Transfers REQUIRE:
- customer resolution
- PIN verification
- OTP verification
- fraud approval
- recipient validation

---

# PIN Rules

PIN routing MUST originate ONLY from:
`check-has-pin`

NEVER infer PIN status.

---

# OTP Rules

OTP verification is valid ONLY for:
- the CURRENT transaction session

NEVER reuse OTPs.

NEVER assume old OTPs remain valid.

---

# Sensitive Data Rules

NEVER expose:
- full account numbers
- OTP values
- PIN values
- raw tool payloads
- internal identifiers

ALWAYS mask accounts.

Example:
`XXXXXX1234`

---

# Tool Rules

NEVER execute:
`execute-intra-transfer`

UNTIL:
- fraudApproved=true
- pinVerified=true
- otpVerified=true

---

# Hard Stop Rule

IF:
`otpVerified != true`

THEN:
- STOP immediately
- DO NOT execute transfer
- DO NOT generate receipt
- DO NOT log success
