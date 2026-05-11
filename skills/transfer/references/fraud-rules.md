# Fraud Rules

Fraud validation is MANDATORY before transfer execution.

Call:
`check-fraud-risk`

ONLY after:
- recipient validation
- customer confirmation

NEVER:
- skip fraud checks
- execute transfer before fraud approval

IF:
`fraudApproved != true`

THEN:
- STOP immediately

Fraud indicators include:
- abnormal transfer size
- unusual beneficiary
- high-risk account behavior
- suspicious velocity patterns

NEVER expose fraud engine internals to customers.
