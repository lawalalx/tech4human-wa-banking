import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import { runMigrations } from "./db/migrate.js";
import { handleIncomingMessage } from "./handlers/chat-handler.js";
import { mastra } from "./mastra/index.js";
import { TRANSACTION_UNKNOWN_REPLY, transactionWorkflow } from "./mastra/workflows/transaction-workflow.js";
import { INSIGHTS_UNKNOWN_REPLY, insightsWorkflow } from "./mastra/workflows/insights-workflow.js";
import { clearPendingFlow, getSessionState as loadSessionState } from "./utils/session-state.js";
import { sanitizeAgentReply } from "./utils/sanitize-agent-reply.js";
import { createKbDocsTable } from "./mastra/core/rag/db.js";
import { initVectorIndex } from "./mastra/core/rag/vector-store.js";
import kbUploadRoute from "./mastra/core/rag/routes/upload.route.js";
import kbDocsRoute from "./mastra/core/rag/routes/docs.route.js";
import { getBankingMcpToolsets } from "./mastra/core/mcp/banking-mcp-client.js";
import { warmUpEmbeddingModel } from "./mastra/core/llm/provider.js";

const app = express();
const args = process.argv;

const portIndex = args.indexOf("--port");

const PORT =
  portIndex !== -1 && args[portIndex + 1]
    ? Number(args[portIndex + 1])
    : Number(process.env.PORT || 3000);




const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "whatsapp_verify_2025";
const BANK_NAME = process.env.BANK_NAME || "First Bank Nigeria";
const URL = process.env.REMOTE_URL;

app.use(express.json());



// ─── OpenAPI / Swagger Document ────────────────────────────────
const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: `${BANK_NAME} — WhatsApp Banking API`,
    version: "1.0.0",
    description:
      "Full API documentation for the Tech4Human WhatsApp Banking Platform.\n\n" +
      "**Key endpoints:**\n" +
      "- `/webhook` — Meta WhatsApp Cloud API events (POST) + verification (GET)\n" +
      "- `/api/agent/chat` — Direct agent chat for testing without WhatsApp\n" +
      "- `/admin/*` — Operations dashboard endpoints\n\n" +
      "**Architecture:** Supervisor-Agent pattern via Mastra AI. " +
      "All conversations are persisted to PostgreSQL — customers can leave and resume seamlessly.",
    contact: { name: "Tech4Human Engineering" },
  },
  servers: [
    {
      url: URL,
      description: "Production",
    },
  ],
  tags: [
    { name: "Webhook", description: "Meta WhatsApp Cloud API integration" },
    { name: "Agent", description: "Direct agent chat for dev/test" },
    { name: "Admin", description: "Operations and monitoring endpoints" },
    { name: "Knowledge Base", description: "Document upload, indexing, and management for RAG" },
    { name: "Health", description: "Service health" },
  ],
  components: {
    schemas: {
      WhatsAppWebhookPayload: {
        type: "object",
        description: "Meta WhatsApp Cloud API webhook payload (standard format)",
        properties: {
          object: { type: "string", example: "whatsapp_business_account" },
          entry: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                changes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      value: {
                        type: "object",
                        properties: {
                          messaging_product: { type: "string", example: "whatsapp" },
                          metadata: {
                            type: "object",
                            properties: {
                              display_phone_number: { type: "string" },
                              phone_number_id: { type: "string" },
                            },
                          },
                          contacts: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                profile: {
                                  type: "object",
                                  properties: { name: { type: "string" } },
                                },
                                wa_id: { type: "string" },
                              },
                            },
                          },
                          messages: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                from: { type: "string", example: "2348012345678" },
                                id: { type: "string" },
                                timestamp: { type: "string" },
                                type: {
                                  type: "string",
                                  enum: ["text", "interactive", "image", "audio"],
                                },
                                text: {
                                  type: "object",
                                  properties: { body: { type: "string" } },
                                },
                              },
                            },
                          },
                        },
                      },
                      field: { type: "string", example: "messages" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      ChatRequest: {
        type: "object",
        required: ["message"],
        properties: {
          phone: {
            type: "string",
            description: "Customer phone number (E.164). Defaults to 'test-user' if omitted.",
            example: "+2348012345678",
          },
          message: {
            type: "string",
            description: "The customer's message to the banking supervisor agent.",
            example: "What is my account balance?",
          },
          customerName: {
            type: "string",
            description: "Optional customer name injected as system context.",
            example: "Adaeze Okonkwo",
          },
        },
      },
      ChatResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          reply: {
            type: "string",
            description: "Agent's reply text (may include <options>[...] tags for interactive elements)",
          },
          phone: { type: "string" },
          threadId: { type: "string", description: "Mastra memory thread ID used for this session" },
        },
      },
      Session: {
        type: "object",
        properties: {
          phone: { type: "string" },
          customer_name: { type: "string" },
          kyc_status: {
            type: "string",
            enum: ["unverified", "tier1", "tier2", "tier3"],
          },
          state: {
            type: "string",
            enum: ["idle", "awaiting_otp", "pending_transfer", "pending_kyc", "pending_fraud_review"],
          },
          last_active: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      FraudAlert: {
        type: "object",
        properties: {
          id: { type: "integer" },
          phone: { type: "string" },
          transaction_ref: { type: "string" },
          risk_score: { type: "number", format: "float", minimum: 0, maximum: 1 },
          risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
          risk_factors: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["open", "confirmed", "cleared"] },
          created_at: { type: "string", format: "date-time" },
        },
      },
      EscalationTicket: {
        type: "object",
        properties: {
          id: { type: "integer" },
          ticket_id: { type: "string", example: "T-A1B2C3D4" },
          phone: { type: "string" },
          issue_type: { type: "string" },
          status: { type: "string", enum: ["open", "in_progress", "assigned", "resolved", "closed"] },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Service health check",
        description: "Returns the running status of the WhatsApp banking service.",
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    service: { type: "string", example: "tech4human-wa-banking" },
                    bank: { type: "string" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/webhook": {
      get: {
        tags: ["Webhook"],
        summary: "Meta webhook verification",
        description:
          "Called by Meta during webhook setup. Verifies the `hub.verify_token` matches " +
          "`WHATSAPP_VERIFY_TOKEN` in your environment and echoes back `hub.challenge`.",
        parameters: [
          {
            name: "hub.mode",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["subscribe"] },
          },
          {
            name: "hub.verify_token",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Must match WHATSAPP_VERIFY_TOKEN env var",
          },
          {
            name: "hub.challenge",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Verification successful — returns challenge string" },
          "403": { description: "Invalid verify token" },
        },
      },
      post: {
        tags: ["Webhook"],
        summary: "Receive WhatsApp messages and events",
        description:
          "Primary endpoint for all inbound Meta WhatsApp Cloud API events.\n\n" +
          "**Processing flow:**\n" +
          "1. Immediately returns HTTP 200 (required to prevent Meta retries)\n" +
          "2. Ignores delivery/read status updates\n" +
          "3. Extracts message text (text, interactive button/list replies, image captions)\n" +
          "4. Checks PostgreSQL for any pending flow from a previous session (resumption logic)\n" +
          "5. Sends keep-alive typing indicator every 8 seconds\n" +
          "6. Calls the Banking Supervisor agent (Mastra AI)\n" +
          "7. Parses `<options>[...]` tags → WhatsApp interactive buttons or list messages\n" +
          "8. Sends final reply to customer via Meta Graph API",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WhatsAppWebhookPayload" },
            },
          },
        },
        responses: {
          "200": { description: "Event acknowledged (processing happens asynchronously)" },
        },
      },
    },

    "/api/agent/chat": {
      post: {
        tags: ["Agent"],
        summary: "Direct agent chat (dev/test)",
        description:
          "Send a message directly to the Banking Supervisor agent without going through WhatsApp.\n\n" +
          "**Use this for:**\n" +
          "- Testing agent responses and routing\n" +
          "- Debugging specific flows (transfer, KYC, fraud, etc.)\n" +
          "- Verifying session memory persistence\n\n" +
          "**Session memory:** Conversations are persisted per `phone` number in PostgreSQL. " +
          "Send multiple requests with the same `phone` value to test multi-turn conversations. " +
          "Change the `phone` to simulate a different customer.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChatRequest" },
              examples: {
                greeting: {
                  summary: "Initial greeting",
                  value: { phone: "+2348012345678", message: "Hello, I need help" },
                },
                balance: {
                  summary: "Balance enquiry",
                  value: { phone: "+2348012345678", message: "What is my account balance?" },
                },
                transfer: {
                  summary: "Initiate transfer",
                  value: {
                    phone: "+2348012345678",
                    message: "Send 50000 naira to 0123456789 GTBank",
                    customerName: "Adaeze Okonkwo",
                  },
                },
                kyc: {
                  summary: "New customer KYC",
                  value: { phone: "+2348099999999", message: "I want to open an account" },
                },
                spending: {
                  summary: "Financial insights",
                  value: {
                    phone: "+2348012345678",
                    message: "Show me my spending breakdown for this month",
                  },
                },
                fraudAlert: {
                  summary: "Fraud enquiry",
                  value: {
                    phone: "+2348012345678",
                    message: "I received a fraud alert, what should I do?",
                  },
                },
                resumption: {
                  summary: "Test session resumption",
                  value: {
                    phone: "+2348012345678",
                    message: "Hi I'm back",
                    customerName: "Returning Customer",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Agent reply",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatResponse" },
              },
            },
          },
          "400": {
            description: "Missing required fields",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
          "500": {
            description: "Agent processing error",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
        },
      },
    },

    "/admin/sessions": {
      get: {
        tags: ["Admin"],
        summary: "List active customer sessions",
        description:
          "Returns the most recent 100 customer sessions ordered by last activity. " +
          "Shows KYC status, session state, and last active timestamp.",
        responses: {
          "200": {
            description: "Session list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    count: { type: "integer" },
                    sessions: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Session" },
                    },
                  },
                },
              },
            },
          },
          "500": { description: "Database error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/admin/fraud-alerts": {
      get: {
        tags: ["Admin"],
        summary: "List open fraud alerts",
        description:
          "Returns all fraud alerts with status `open`. " +
          "These require customer acknowledgement (approve/block) or manual review.",
        responses: {
          "200": {
            description: "Open fraud alerts",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    count: { type: "integer" },
                    alerts: {
                      type: "array",
                      items: { $ref: "#/components/schemas/FraudAlert" },
                    },
                  },
                },
              },
            },
          },
          "500": { description: "Database error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/admin/tickets": {
      get: {
        tags: ["Admin"],
        summary: "List open escalation tickets",
        description:
          "Returns all support escalation tickets with status `open` or `in_progress`. " +
          "Tickets are created when customers request human support or raise complaints.",
        responses: {
          "200": {
            description: "Open tickets",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    count: { type: "integer" },
                    tickets: {
                      type: "array",
                      items: { $ref: "#/components/schemas/EscalationTicket" },
                    },
                  },
                },
              },
            },
          },
          "500": { description: "Database error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    "/api/kb/upload": {
      post: {
        tags: ["Knowledge Base"],
        summary: "Upload documents to the knowledge base",
        description:
          "Uploads one or more documents (or raw text) into the bank's knowledge base.\n\n" +
          "**Supported formats:** PDF, TXT, MD, CSV, DOCX, DOC, XLSX, XLS (max 25 MB per file)\n\n" +
          "**Processing pipeline:**\n" +
          "1. Text is extracted from the document\n" +
          "2. Text is chunked (recursive strategy, 512 tokens, 64 overlap)\n" +
          "3. Each chunk is embedded via OpenAI/FastEmbed\n" +
          "4. Vectors are upserted into the bank's isolated pgvector index\n" +
          "5. Metadata stored in `kb_docs` table for management\n\n" +
          "**Multi-tenant:** documents are scoped to `BANK_ID` — each bank has its own isolated index.\n\n" +
          "**Re-upload:** uploading a doc with the same `docId` replaces previous chunks (idempotent).",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  files: {
                    type: "array",
                    items: { type: "string", format: "binary" },
                    description: "One or more files to index",
                  },
                  text: {
                    type: "string",
                    description: "Raw text content (alternative to file upload)",
                  },
                  title: {
                    type: "string",
                    description: "Human-readable title for the document",
                    example: "First Bank Savings Account FAQ",
                  },
                  category: {
                    type: "string",
                    enum: ["faq", "product", "policy", "compliance", "fee_schedule", "general"],
                    default: "general",
                    description: "Document category — used for filtered retrieval",
                  },
                  language: {
                    type: "string",
                    default: "en",
                    example: "en",
                    description: "Language code (ISO 639-1)",
                  },
                },
              },
              examples: {
                faq_upload: {
                  summary: "Upload FAQ PDF",
                  value: { title: "Customer FAQ", category: "faq" },
                },
                policy_upload: {
                  summary: "Upload fee schedule",
                  value: { title: "Fee Schedule 2026", category: "fee_schedule" },
                },
                raw_text: {
                  summary: "Index raw text",
                  value: {
                    text: "Q: What is the daily transfer limit? A: ₦5,000,000 via NIP...",
                    title: "Transfer limits FAQ",
                    category: "faq",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Documents indexed successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    bankId: { type: "string" },
                    indexed: { type: "integer" },
                    failed: { type: "integer" },
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          docId: { type: "string", format: "uuid" },
                          filename: { type: "string" },
                          totalChunks: { type: "integer" },
                          bankId: { type: "string" },
                        },
                      },
                    },
                  },
                },
                example: {
                  success: true,
                  bankId: "fbn",
                  indexed: 2,
                  failed: 0,
                  results: [
                    { docId: "550e8400-e29b-41d4-a716-446655440000", filename: "faq.pdf", totalChunks: 18, bankId: "fbn" },
                    { docId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", filename: "fee_schedule.xlsx", totalChunks: 7, bankId: "fbn" },
                  ],
                },
              },
            },
          },
          "400": { description: "Invalid input or no files provided" },
          "500": { description: "Server error during ingestion" },
        },
      },
    },

    "/api/kb/docs": {
      get: {
        tags: ["Knowledge Base"],
        summary: "List all knowledge-base documents",
        description:
          "Returns metadata for all documents indexed for this bank tenant, " +
          "ordered by upload date (newest first). Includes a category summary.",
        responses: {
          "200": {
            description: "Document list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    bankId: { type: "string" },
                    count: { type: "integer" },
                    docs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          doc_id: { type: "string", format: "uuid" },
                          bank_id: { type: "string" },
                          title: { type: "string", nullable: true },
                          original_name: { type: "string" },
                          category: { type: "string" },
                          language: { type: "string" },
                          size: { type: "integer", nullable: true },
                          chunk_count: { type: "integer", nullable: true },
                          uploaded_at: { type: "string", format: "date-time" },
                        },
                      },
                    },
                    summary: {
                      type: "object",
                      properties: {
                        byCategory: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              category: { type: "string" },
                              count: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "500": { description: "Database error" },
        },
      },
    },

    "/api/kb/docs/{docId}": {
      get: {
        tags: ["Knowledge Base"],
        summary: "Get document metadata",
        parameters: [
          { name: "docId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Document metadata" },
          "404": { description: "Document not found" },
          "500": { description: "Server error" },
        },
      },
      delete: {
        tags: ["Knowledge Base"],
        summary: "Delete a document from the knowledge base",
        description:
          "Removes the document's vector chunks from pgvector, the file from disk, " +
          "and its metadata row from `kb_docs`. This is scoped to the current bank tenant.",
        parameters: [
          { name: "docId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": {
            description: "Document deleted successfully",
            content: {
              "application/json": {
                example: { success: true, message: "Document 550e8400-... deleted" },
              },
            },
          },
          "404": { description: "Document not found" },
          "500": { description: "Server error" },
        },
      },
    },
  },
};

// Mount Swagger UI at /docs
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customSiteTitle: `${BANK_NAME} — API Docs`,
  swaggerOptions: { persistAuthorization: true },
}));
// Serve raw OpenAPI JSON at /docs.json
app.get("/docs.json", (_req: Request, res: Response) => {
  res.json(swaggerDocument);
});

// ─── Knowledge Base Routes ──────────────────────────────────────
app.use("/api/kb/upload", kbUploadRoute);
app.use("/api/kb/docs", kbDocsRoute);

// ─── Health Check ──────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "tech4human-wa-banking",
    bank: process.env.BANK_NAME,
    bankId: process.env.BANK_ID || "default",
    timestamp: new Date().toISOString(),
  });
});

// ─── Meta Webhook Verification (GET) ───────────────────────────
app.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[Webhook] Verification successful");
    res.status(200).send(challenge);
  } else {
    console.warn("[Webhook] Verification failed — invalid token");
    res.sendStatus(403);
  }
});

// ─── Incoming WhatsApp Messages (POST) ─────────────────────────
app.post("/webhook", async (req: Request, res: Response) => {
  const body = req.body;

  // Always respond 200 immediately to prevent Meta retries
  res.sendStatus(200);

  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Ignore status updates (delivered, read, etc.)
    if (value?.statuses) return;

    const messages = value?.messages;
    if (!messages?.length) return;

    const message = messages[0];
    if (!message?.from) return;

    await handleIncomingMessage(message);
  } catch (error) {
    console.error("[Webhook] Error processing incoming webhook:", error);
  }
});

// ─── Admin: List Active Sessions ────────────────────────────────
app.get("/admin/sessions", async (_req: Request, res: Response) => {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT phone,
              customer_name,
              kyc_status,
              state,
              last_active,
              created_at,
              context->'pending_flow' AS pending_flow
       FROM customer_sessions
       ORDER BY last_active DESC
       LIMIT 100`
    );
    await pool.end();
    res.json({ count: rows.length, sessions: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// ─── Admin: Open Fraud Alerts ───────────────────────────────────
app.get("/admin/fraud-alerts", async (_req: Request, res: Response) => {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT id, phone, transaction_ref, risk_score, risk_factors, status, created_at
       FROM fraud_alerts
       WHERE status = 'open'
       ORDER BY created_at DESC`
    );
    await pool.end();
    res.json({ count: rows.length, alerts: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch fraud alerts" });
  }
});

// ─── Admin: Open Escalation Tickets ────────────────────────────
app.get("/admin/tickets", async (_req: Request, res: Response) => {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT id, ticket_id, phone, category, status, priority, created_at
       FROM escalation_tickets
       WHERE status IN ('open', 'in_progress')
       ORDER BY created_at DESC`
    );
    await pool.end();
    res.json({ count: rows.length, tickets: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// ─── Dev/Test: Direct Agent Chat ────────────────────────────────
// Test any banking flow without needing a real WhatsApp number.
// Conversations are fully persisted — use the same `phone` to test multi-turn memory.
app.post("/api/agent/chat", async (req: Request, res: Response) => {
  try {
    const { phone, message, customerName } = req.body as {
      phone?: string;
      message?: string;
      customerName?: string;
    };

    if (!message?.trim()) {
      return res.status(400).json({ success: false, error: '"message" is required' });
    }

    const phoneNorm = phone?.trim() || "test-user";
    const threadId = `thread_${phoneNorm}`;

    if (/^end$/i.test(message.trim())) {
      await clearPendingFlow(phoneNorm).catch(() => {});
    }

    const session = await loadSessionState(phoneNorm).catch(() => null);
    const pendingAction = session?.pending_flow?.action;
    const hasPendingTransactionFlow = ["balance", "mini_statement", "transfer", "bill_payment"].includes(
      String(pendingAction || "")
    );
    if (hasPendingTransactionFlow) {
      const run = await transactionWorkflow.createRun();
      const wf = await run.start({
        inputData: {
          phone: phoneNorm,
          action: pendingAction as any,
          message: message.trim(),
        },
      });

      if (wf.status === "success" && wf.result.handled) {
        return res.json({
          success: true,
          reply: sanitizeAgentReply(wf.result.reply),
          phone: phoneNorm,
          threadId,
        });
      }
    }

    // Try transaction workflow first for new incoming requests too.
    // If workflow cannot classify as transaction, it returns the unknown sentinel and we fall back to supervisor.
    {
      const run = await transactionWorkflow.createRun();
      const wf = await run.start({
        inputData: {
          phone: phoneNorm,
          message: message.trim(),
        },
      });

      if (wf.status === "success" && wf.result.handled && wf.result.reply !== TRANSACTION_UNKNOWN_REPLY) {
        return res.json({
          success: true,
          reply: sanitizeAgentReply(wf.result.reply),
          phone: phoneNorm,
          threadId,
        });
      }
    }

    // Run insights workflow before supervisor fallback to keep insights/chart behavior deterministic.
    {
      const run = await insightsWorkflow.createRun();
      const wf = await run.start({
        inputData: {
          phone: phoneNorm,
          message: message.trim(),
        },
      });

      if (wf.status === "success" && wf.result.handled && wf.result.reply !== INSIGHTS_UNKNOWN_REPLY) {
        return res.json({
          success: true,
          reply: sanitizeAgentReply(wf.result.reply),
          phone: phoneNorm,
          threadId,
        });
      }
    }

    const supervisor = mastra.getAgent("bankingSupervisor");

    const messages: Array<{ role: "user" | "system"; content: string }> = [];
    // Always inject phone so tools can auto-lookup accounts without asking the customer.
    messages.push({
      role: "system",
      content: `Customer phone: ${phoneNorm}. Use this phone number when calling account-lookup or balance tools — never ask the customer to provide their account number.`,
    });
    if (customerName) {
      messages.push({
        role: "system",
        content: `Customer name: ${customerName}. Address the customer by this name when appropriate.`,
      });
    }


    // ===============================

    const greetingPattern = /^(hi|hello|hey|start|menu|help|what|how|good\s)/i;
    const isGreeting = greetingPattern.test(message.trim());
    if (isGreeting) {
      messages.push({
        role: "system",
        content:
          `CRITICAL INSTRUCTION — DO THIS NOW:\n` +
          `The customer sent a greeting. You MUST output the main menu followed IMMEDIATELY by the options tag.\n` +
          `Your response MUST end with this EXACT block (no exceptions):\n` +
          `\n` +
          `<options>\n` +
          `1. Account & Transactions\n` +
          `2. Onboarding & KYC\n` +
          `3. Security\n` +
          `4. Financial Insights\n` +
          `5. Support & Help\n` +
          `</options>\n` +
          `\n` +
          `Do NOT omit the <options> block. It is REQUIRED for the WhatsApp UI to work.`,
      });
    }
    // =======================


    messages.push({ role: "user", content: message.trim() });

    // NOTE: toolsets are intentionally NOT injected here — supervisor must delegate
    // all banking operations to specialist sub-agents via agents{} delegation.
    const response = await supervisor.generate(messages, {
      memory: { 
        thread: threadId, 
        resource: phoneNorm,
        
      },
    });

    const reply = sanitizeAgentReply(response?.text?.trim() ?? "");


    // ============================
    // Server-side safety net: if greeting triggered but LLM omitted <options>, append it.
    const MAIN_MENU_OPTIONS =
      `\n<options>\n` +
      `1. Account & Transactions\n` +
      `2. Onboarding & KYC\n` +
      `3. Security\n` +
      `4. Financial Insights\n` +
      `5. Support & Help\n` +
      `</options>`;
    const finalReply = isGreeting && !/<options>/i.test(reply)
      ? `${reply}${MAIN_MENU_OPTIONS}`
      : reply;
    if (isGreeting && !/<options>/i.test(reply)) {
      console.log(`[/api/agent/chat] Greeting detected but LLM omitted <options> — appending main menu options tag.`);
    }
// ====================================


    return res.json({ success: true, reply: finalReply, phone: phoneNorm, threadId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal error";
    console.error("[/api/agent/chat] Error:", err);
    return res.status(500).json({ success: false, error: msg });
  }
});

// ─── 404 Handler ────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Global Error Handler ───────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Bootstrap ─────────────────────────────────────────────────
async function main() {
  console.log("[Server] Running database migrations...");
  await runMigrations().catch((err) => {
    console.error("Error running migrations:", err);
    process.exit(1);
  });

  console.log("[Server] Initialising knowledge-base tables...");
  await createKbDocsTable().catch((err) => {
    console.error("Error creating kb_docs table:", err);
    process.exit(1);
  });

  console.log("[Server] Initialising vector index...");
  await initVectorIndex().catch((err) => {
    console.error("Error initialising vector index:", err);
    process.exit(1);
  });

  console.log("[Server] Warming up embedding model...");
  await warmUpEmbeddingModel().catch((err) => {
    console.error("Error warming up embedding model:", err);
    process.exit(1);
  });


  // if (process.env.NODE_ENV !== "production") {
  //   warmUpEmbeddingModel().catch(console.error);
  // }


  app.listen(PORT, () => {
    const orgId = process.env.BANK_ID || "default";
    console.log(`\n🏦 Tech4Human WhatsApp Banking Server`);
    console.log(`📡 Listening on http://localhost:${PORT}`);
    console.log(`📬 Webhook:     http://localhost:${PORT}/webhook`);
    console.log(`📖 API Docs:    http://localhost:${PORT}/docs`);
    console.log(`💬 Test Chat:   http://localhost:${PORT}/api/agent/chat`);
    console.log(`📚 KB Upload:   http://localhost:${PORT}/api/kb/upload`);
    console.log(`📋 KB Docs:     http://localhost:${PORT}/api/kb/docs`);
    console.log(`💚 Health:      http://localhost:${PORT}/health`);
    console.log(`🏷️  ORG ID:     ${orgId}\n`);
  });
}

main().catch((err) => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});
