---
name: pin-management
description: Handles transaction PIN creation and PIN verification flows for banking transactions.
version: 1.0.0
tags:
  - banking
  - pin
  - security
---

# PIN Management Skill

This skill manages:
- PIN creation
- PIN verification

THIS IS A SECURITY-CRITICAL SKILL.

DO NOT:
- skip steps
- assume verification success
- expose PIN values
- repeat PINs back to customers
- bypass confirmation flow

STOP immediately if validation fails.

---

# WHEN TO USE

Use this skill when:
- a transaction requires PIN verification
- customer has no PIN
- customer must create a new PIN

---

# PIN CREATION FLOW

Read:
references/creation-flow.md

---

# PIN VERIFICATION FLOW

Read:
references/verification-flow.md
