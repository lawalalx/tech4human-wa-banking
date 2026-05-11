# PIN Verification Flow

Ask customer:

"🔐 Please enter your 4-digit transaction PIN."

---

## VERIFY PIN

When customer sends PIN:

Call:
verify-transaction-pin

IF verified=true:
- continue transaction immediately

IF verified=false:
Respond:
"❌ Incorrect PIN."

IF attemptsRemaining > 0:
Inform customer of remaining attempts.

---

# SECURITY RULES

- NEVER expose PIN
- NEVER repeat PIN
- NEVER hint at correct PIN
- NEVER bypass verification
- NEVER continue after failed verification
