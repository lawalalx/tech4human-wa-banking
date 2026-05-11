# OTP Rules

OTP verification is REQUIRED for ALL transfers.

---

# OTP Flow

1. Call:
`send-phone-verification-otp`

2. Ask customer for OTP.

3. Call:
`verify-phone-verification-otp`

ONLY continue if:
`verified=true`

---

# OTP Security

NEVER:
- display OTP values
- repeat OTP values
- reuse OTPs
- infer OTP success

OTP validity:
- current transaction session ONLY

Expired OTP:
- inform customer
- offer resend
