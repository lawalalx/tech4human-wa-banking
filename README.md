# Tech4Human WhatsApp Banking Platform

Production-grade WhatsApp AI Banking Assistant for **First Bank Nigeria**, built on **Mastra AI** with a Supervisor-Agent architecture, persistent memory, 2FA, KYC, fraud detection, and full CBN/NDPR/PCI-DSS compliance audit trails.

---

## Architecture

```
Customer (WhatsApp)
        │
        ▼
  Meta Graph API
        │
        ▼
  Express Webhook (/webhook)
        │
        ▼
  Chat Handler
        │
        ▼
  ┌─────────────────────────────────┐
  │     Banking Supervisor Agent    │  ← Orchestrates via Mastra native agents: {}
  └─────────────────────────────────┘
       │         │         │         │         │
       ▼         ▼         ▼         ▼         ▼
  Onboarding  Transaction Security  Support  Insights
   Agent       Agent      Agent     Agent    Agent
       │         │         │         │         │
       └─────────┴─────────┴─────────┴─────────┘
                           │
                   ┌───────┴────────┐
                   │  Mastra Tools  │
                   └───────┬────────┘
                           │
                   ┌───────┴────────┐
                   │  PostgreSQL    │  ← Shared state, memory, audit log
                   └────────────────┘
```

### Specialist Agents

| Agent | Responsibility |
|---|---|
| `banking-supervisor` | Intent routing, session management, greeting |
| `onboarding-agent` | KYC, BVN/NIN verification, account activation |
| `transaction-agent` | Transfers, bill payments, balance, statements |
| `security-agent` | Fraud alerts, device management, card blocking |
| `support-agent` | FAQ, complaints, escalation tickets |
| `insights-agent` | Spending analysis, budgets, credit score |

### Mastra Skills (persistent domain knowledge)

| Skill | Path |
|---|---|
| Banking KYC | `skills/banking-kyc/SKILL.md` |
| Transaction Processing | `skills/transaction-processing/SKILL.md` |
| Fraud Detection | `skills/fraud-detection/SKILL.md` |
| Customer Support | `skills/customer-support/SKILL.md` |
| Financial Insights | `skills/financial-insights/SKILL.md` |
| Compliance & Audit | `skills/compliance-audit/SKILL.md` |

---

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 14+
- Meta Business Account with WhatsApp Business API access
- OpenAI API key (or Azure OpenAI)

### 1. Install dependencies

```bash
cd firstbank-mail/tech4human-wa-banking
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. Required:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `OPENAI_API_KEY` | OpenAI API key |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API access token |
| `WHATSAPP_BUSINESS_PHONE_NUMBER_ID` | Your WhatsApp phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token (you choose this) |
| `CORE_BANKING_API_URL` | Your core banking API endpoint |
| `CORE_BANKING_API_KEY` | Core banking API key |

### 3. Run database migrations

```bash
pnpm db:migrate
```

### 4. Start development server

```bash
pnpm dev
```

Or start the webhook server directly:

```bash
pnpm webhook
```

### 5. Expose webhook (local development)

```bash
npx ngrok http 3000
```

Set your ngrok URL as the webhook in Meta Developer Console:
`https://your-ngrok-url.ngrok.io/webhook`

---

## Database Schema

| Table | Purpose |
|---|---|
| `customer_sessions` | Customer profiles, KYC status, session state |
| `otp_records` | Hashed OTP storage with expiry and attempt tracking |
| `transactions` | Full transaction history with status |
| `fraud_alerts` | Risk-scored fraud alerts with resolution tracking |
| `escalation_tickets` | Customer support tickets |
| `audit_log` | Append-only compliance audit trail (7-year retention) |
| `device_registry` | Registered devices per customer |
| `beneficiaries` | Saved transfer beneficiaries |
| `notification_preferences` | Customer notification opt-in/out settings |

---

## Admin API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Service health check |
| `GET /admin/sessions` | List active customer sessions |
| `GET /admin/fraud-alerts` | Open fraud alerts |
| `GET /admin/tickets` | Open escalation tickets |

---

## Compliance

- **CBN**: KYC Tier-1/2/3, transaction limits enforced
- **NDPR**: PII masked in all logs, explicit consent on registration
- **PCI-DSS**: No card data stored; OTPs hashed (SHA-256 + salt)
- **Audit Trail**: Every interaction logged to `audit_log` with immutable append-only inserts

---

## Production Deployment

1. Set `NODE_ENV=production`
2. Use a proper PostgreSQL connection string with SSL
3. Configure Azure OpenAI for data residency (optional)
4. Set up ngrok/reverse proxy or use a cloud host
5. Configure Meta webhook with production URL
6. Enable PostgreSQL row-level security on sensitive tables

---

## Project Structure

```
src/
├── index.ts                    # Express server entry point
├── whatsapp-client.ts          # Meta Graph API client
├── db/
│   ├── schema.ts               # Database schema SQL
│   └── migrate.ts              # Migration runner
├── services/
│   └── core-banking.ts         # Core banking API integration
├── handlers/
│   └── chat-handler.ts         # Incoming WhatsApp message processor
├── utils/
│   ├── format-phone.ts         # Phone number normalization
│   └── send-agent-reply.ts     # Agent reply → WhatsApp message formatter
└── mastra/
    ├── index.ts                # Mastra instance registration
    ├── workspace.ts            # Mastra workspace with skills
    ├── core/
    │   ├── llm/provider.ts     # LLM provider (Azure/OpenAI)
    │   └── db/shared-pg-store.ts
    ├── agents/
    │   ├── banking-supervisor.ts
    │   ├── onboarding-agent.ts
    │   ├── transaction-agent.ts
    │   ├── security-agent.ts
    │   ├── support-agent.ts
    │   └── insights-agent.ts
    ├── tools/                  # All Mastra tools
    └── workflows/
        ├── onboarding-workflow.ts
        ├── transaction-workflow.ts
        └── fraud-alert-workflow.ts
skills/
    ├── banking-kyc/SKILL.md
    ├── transaction-processing/SKILL.md
    ├── fraud-detection/SKILL.md
    ├── customer-support/SKILL.md
    ├── financial-insights/SKILL.md
    └── compliance-audit/SKILL.md
```
