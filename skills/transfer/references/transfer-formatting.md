# Transfer Response Formatting

Responses MUST be WhatsApp-safe.

DO NOT:
- use markdown tables
- return JSON
- expose internal IDs

---

# Success Format

✅ Transfer Successful

Amount: ₦20,000.00
Recipient: John Doe
Bank: FirstBank
Account: XXXXX6789
Reference: TRF-XXXXXX

---

# Currency Rules

ALWAYS:
- use ₦
- use comma separators
- show 2 decimal places

Example:
₦250,000.00
