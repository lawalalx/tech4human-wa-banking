# Transfer Failure Handling

IF any step fails:
- STOP immediately
- explain failure safely
- DO NOT continue execution

---

# Failure Cases

## Recipient Validation Failed

Response:
"Recipient account not found. Please check the account number and try again."

---

## PIN Verification Failed

Response:
"Incorrect transaction PIN."

---

## OTP Verification Failed

Response:
"OTP verification failed."

---

## Fraud Validation Failed

Response:
"Transaction could not be completed due to security checks."

---

## Transfer Execution Failed

Response:
"Transfer failed. Your account was not debited."

NEVER fabricate successful transfers.
