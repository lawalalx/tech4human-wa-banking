import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import fs from 'fs';
import path from 'path';
import swaggerUi from "swagger-ui-express";
import { runMigrations } from "./db/migrate.js";
import { handleIncomingMessage, isFlowDonePhrase } from "./handlers/chat-handler.js";
import { mastra } from "./mastra/index.js";
import { sanitizeAgentReply } from "./utils/sanitize-agent-reply.js";
import { createKbDocsTable } from "./mastra/core/rag/db.js";
import { initVectorIndex } from "./mastra/core/rag/vector-store.js";
import kbUploadRoute from "./mastra/core/rag/routes/upload.route.js";
import kbDocsRoute from "./mastra/core/rag/routes/docs.route.js";
import { warmUpEmbeddingModel } from "./mastra/core/llm/provider.js";
import { stateManager } from "./core/index.js";
import {
  buildSystemPrompt,
  buildUserContextPrompt,
} from "./services/conversation-context.js";
import { analyzePersonalMemoryTurn, renderProfileMemoryReply } from "./services/personal-memory.js";
import { runWithRequestContext } from "./utils/request-context.js";

import crypto from "crypto";
import { bankingService } from "./services/banking-service.js";
import { validateBankAccount, verifyOtp } from "./bank-api/external/register.js";
import { saveTransactionPin } from "./utils/pin-store.js";
import {
  saveFlowResponse,
  getPhoneByFlowToken,
  getTokenMap,
} from "@/meta/meta-services/services.js";
import {
  setLinkedAccount,
  popAwaitingResume,
  markFlowAutoResumed,
  setAutoResumeNote,
  setServiceTermsAccepted,
} from "./utils/session-state.js";
import { buildAutoResumeNote } from "./handlers/chat-handler.js";

import { 
  botName, 
  businessName, 
  supportPhone,
  supportEmail 
} from "@/utils/identity.js";

import { 
  createMetaFlow, 
  uploadFlowJsonBuffer, 
  publishFlow 
} from './meta/meta-services/services.js';

import { 
  buildAccountVerificationFlowJson, 
  buildSetTransactionPinFlowJson 
} from './meta/meta-flow-builder';


const app = express();
const args = process.argv;

const portIndex = args.indexOf("--port");

const PORT =
  portIndex !== -1 && args[portIndex + 1]
    ? Number(args[portIndex + 1])
    : Number(process.env.PORT || 3000);




const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "whatsapp_verify_2025";
const BANK_NAME = process.env.BANK_NAME || "First Bank Nigeria";
const BOT_NAME = process.env.BOT_NAME || "FBN Banking Assistant";
const URL = process.env.LOCAL_URL;

/** Mask an account number to "********1234". */
function maskAccountNumber(account: string): string {
  return account.length > 4
    ? `********${account.slice(-4)}`
    : account;
}

/**
 * Flow-completion auto-resumer fallback.
 *
 * When a customer completes a Meta Flow (link account / set PIN), Meta sends an
 * `nfm_reply` interactive webhook that our chat handler uses to auto-resume the
 * customer's original request — no need for them to type "Done". HOWEVER the
 * `nfm_reply` can occasionally be delayed or dropped. This fallback is invoked
 * straight from the flow's data_exchange success callback so that, even if the
 * nfm_reply never arrives, the pending request still resumes automatically.
 *
 * It is idempotent: if the nfm_reply already popped the awaiting-resume marker,
 * this does nothing. It also records `last_flow_resume_at` so a later nfm_reply
 * event won't emit a duplicate confirmation.
 */
async function autoResumeAfterFlow(phone: string, kind: "link" | "pin"): Promise<void> {
  if (!phone) return;
  const resume = await popAwaitingResume(phone).catch(() => null);
  if (!resume) {
    console.log(`[autoResume] No awaiting_resume for ${phone} — nfm_reply already handled it or nothing pending.`);
    return;
  }
  if ((resume.kind === "pin" ? "pin" : "link") !== kind) {
    console.log(`[autoResume] Skipping — stored resume is for ${resume.kind}, this flow was ${kind}.`);
    return;
  }
  if (await isFlowDonePhrase(resume.originalRequest)) {
    console.log(`[autoResume] Skipping non-actionable resume text: "${resume.originalRequest}".`);
    return;
  }

  await markFlowAutoResumed(phone).catch(() => {});
  // Persist a ready-made step-aware system note; the chat pipeline consumes it
  // on the very next pass and injects it into the supervisor prompt.
  await setAutoResumeNote(phone, buildAutoResumeNote(resume.kind, resume.originalRequest)).catch(() => {});
  console.log(`[autoResume] Resuming ${kind} flow → original request: "${resume.originalRequest}"`);

  // Re-inject the original request through the normal chat pipeline as a plain
  // text message, so it is handled exactly like the real nfm_reply path.
  const synthetic = {
    from: phone,
    id: `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "text",
    text: { body: resume.originalRequest },
    timestamp: String(Date.now()),
  } as any;

  await handleIncomingMessage(synthetic).catch((err) =>
    console.error(`[autoResume] Failed to process resumed request:`, err)
  );
}

/** Schedule the fallback auto-resume a beat later than the flow's success screen. */
function scheduleAutoResume(phone: string, kind: "link" | "pin"): void {
  if (!phone) return;
  setTimeout(() => {
    autoResumeAfterFlow(phone, kind).catch(() => {});
  }, 3500);
}

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
      "- `/webhook/whatsapp` — Meta WhatsApp Cloud API events (POST) + verification (GET)\n" +
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
      "CreateBankingFlowRequest": {
      "type": "object",
      "required": ["flowType", "name"],
      "properties": {
        "flowType": {
          "type": "string",
          "enum": ["account_linking", "pin_setup"],
          "description": "The specific type of banking flow to generate."
        },
        "name": {
          "type": "string",
          "description": "The name of the Flow in the Meta WhatsApp Manager."
        },
        "description": {
          "type": "string",
          "description": "Optional description of the flow."
        },
        "thankYouText": {
          "type": "string",
          "description": "Custom text to display on the completion screen."
        },
        "banks": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "List of banks to display in the dropdown. Required if flowType is 'account_linking'."
        },
        "autoPublish": {
          "type": "boolean",
          "default": true,
          "description": "Whether to attempt to publish the flow immediately after uploading the JSON asset."
        },
        "dataEndpointUrl": {
          "type": "string",
          "format": "uri",
          "description": "HTTPS webhook URL for Meta to send data exchanges. Defaults to SERVER_URL/webhook/meta-flow-data if omitted."
          }
        }
      },
      "CreateBankingFlowResponse": {
        "type": "object",
        "properties": {
          "success": {
            "type": "boolean",
            "example": true
          },
          "message": {
            "type": "string",
            "example": "Successfully generated account_linking. IMPORTANT: Update your .env file with this ID!"
          },
          "env_instruction": {
            "type": "string",
            "example": "Add this to your .env: ACCOUNT_LINKING_FLOW_ID=123456789012345"
          },
          "flowId": {
            "type": "string",
            "example": "123456789012345"
          },
          "status": {
            "type": "string",
            "enum": ["draft", "published", "draft_with_publish_error"],
            "example": "published"
          },
          "dataEndpointUrl": {
            "type": "string",
            "format": "uri",
            "example": "https://your-api.com/webhook/meta-flow-data"
          },
          "publishResult": {
            "type": "object",
            "description": "The raw response from Meta's publish API (if autoPublish was true).",
            "additionalProperties": true
          }
        }
      },
      "MetaFlowDataRequest": {
        "type": "object",
        "required": ["encrypted_flow_data", "encrypted_aes_key", "initial_vector"],
        "properties": {
          "encrypted_flow_data": {
            "type": "string",
            "description": "Base64 encoded encrypted request payload from Meta containing the action (ping, INIT, data_exchange) and flow data."
          },
          "encrypted_aes_key": {
            "type": "string",
            "description": "Base64 encoded AES key, symmetrically encrypted with your RSA Public Key."
          },
          "initial_vector": {
            "type": "string",
            "description": "Base64 encoded 128-bit initialization vector used for decryption."
          }
        }
      }
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

    "/webhook/whatsapp": {
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

    "/admin/banking-flows": {
      "post": {
        "tags": ["Admin"],
        "summary": "Create and publish a WhatsApp Banking Flow",
        "description": "Generates, uploads, and optionally publishes a Meta WhatsApp Flow JSON for either account linking or PIN setup.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateBankingFlowRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Flow created successfully",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CreateBankingFlowResponse"
                }
              }
            }
          },
          "400": {
            "description": "Bad Request - Validation Error (e.g., missing banks for account linking, invalid URL, or missing name)",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": {
                      "type": "string",
                      "example": "flowType must be 'account_linking' or 'pin_setup'"
                    }
                  }
                }
              }
            }
          },
          "500": {
            "description": "Internal Server Error",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": {
                      "type": "string",
                      "example": "Failed to create banking flow"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    "/webhook/meta-flow-data": {
      "post": {
        "tags": ["Webhook"],
        "summary": "Meta WhatsApp Flow Data Endpoint",
        "description": "Handles encrypted requests from WhatsApp Flows. Processes `ping` for health checks, `INIT` for initial screen state, and `data_exchange` for verifying bank accounts and OTPs. Returns an encrypted Base64 string.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/MetaFlowDataRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Successful operation. Returns an encrypted Base64 string containing the next screen state or action.",
            "content": {
              "text/plain": {
                "schema": {
                  "type": "string",
                  "example": "yZcJQaH3AqfzKgjn64vAcASaJrOMN27S6CESyU68WN/cDCP6abskoMa/pPjszXGKy..."
                }
              }
            }
          },
          "400": {
            "description": "Bad Request - Missing required encryption parameters.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": {
                      "type": "string",
                      "example": "Missing encryption payload parameters"
                    }
                  }
                }
              }
            }
          },
          "500": {
            "description": "Internal Server Error - Missing private key or decryption/processing failure.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": {
                      "type": "string",
                      "example": "Server key configuration error"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

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



app.post('/admin/banking-flows', async (req: Request, res: Response) => {
  try {
    const {
      flowType, // Must be 'account_linking' or 'pin_setup'
      name,
      description,
      thankYouText,
      banks,
      autoPublish = true,
      dataEndpointUrl,
    } = req.body || {};

    // 1. Validate Input
    if (!['account_linking', 'pin_setup'].includes(flowType)) {
      return res.status(400).json({ 
        error: "flowType must be 'account_linking' or 'pin_setup'" 
      });
    }

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    // 2. Validate Endpoint URL (Meta requires this to be a secure HTTPS URL)
    const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
    const endpointUrl = dataEndpointUrl || `${serverUrl}/webhook/meta-flow-data`;

    if (!endpointUrl.startsWith('https://')) {
      return res.status(400).json({
        error: 'dataEndpointUrl must be a valid HTTPS URL (Set SERVER_URL in .env)',
      });
    }

    // 3. Build the specific Flow JSON
    let flowJson;
    
    if (flowType === 'account_linking') {
      if (!Array.isArray(banks) || banks.length === 0) {
        return res.status(400).json({ 
          error: "banks array is required for 'account_linking' flows" 
        });
      }
      flowJson = buildAccountVerificationFlowJson({
        name,
        description,
        banks,
        thankYouText
      });
    } else {
      flowJson = buildSetTransactionPinFlowJson();
    }

    console.log(`\n--- BUILDING FLOW: ${name} ---`);
    const flowJsonBuffer = Buffer.from(JSON.stringify(flowJson, null, 2));

    // 4. Create Meta Flow (Using UTILITY or OTHER category)
    const flowId = await createMetaFlow(name, ['OTHER']);
    console.log(`✅ Flow created on Meta with ID: ${flowId}`);

    // 5. Upload Flow JSON Asset
    await uploadFlowJsonBuffer(flowId, flowJsonBuffer);
    console.log(`✅ JSON successfully uploaded for Flow ID: ${flowId}`);

    // 6. Publish Flow (If requested)
    let publishResult: any = null;
    let finalStatus = 'draft';

    if (autoPublish) {
      try {
        console.log(`🚀 Attempting to publish flow...`);
        // The publishFlow helper correctly sets the endpoint_uri and waits 5 seconds!
        publishResult = await publishFlow(flowId);
        finalStatus = 'published';
        console.log(`✅ Flow Published Successfully`);
      } catch (err: any) {
        console.error('❌ Publish failed. Make sure your webhook is live and responds to "ping".', err.message);
        finalStatus = 'draft_with_publish_error';
      }
    }

    // 7. Return payload for the Developer
    return res.status(201).json({
      success: true,
      message: `Successfully generated ${flowType}. IMPORTANT: Update your .env file with this ID!`,
      env_instruction: `Add this to your .env: ${flowType.toUpperCase()}_FLOW_ID=${flowId}`,
      flowId,
      status: finalStatus,
      dataEndpointUrl: endpointUrl,
      publishResult,
    });

  } catch (e: any) {
    console.error('POST /admin/banking-flows failed', e);
    return res.status(500).json({
      error: e.message || 'Failed to create banking flow',
    });
  }
});


// ─── Meta Webhook Verification (GET) ───────────────────────────
app.get("/webhook/whatsapp", (req: Request, res: Response) => {
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
app.post("/webhook/whatsapp", async (req: Request, res: Response) => {
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

// ─── Dev/Test: Clear session state for a phone number ────────────
// Use in automated E2E tests to reset pending flow + conversation history between sections.
// NEVER expose this in production (guard by NODE_ENV).
if (process.env.NODE_ENV !== "production") {
  app.delete("/admin/clear-session/:phone", async (req: Request, res: Response) => {
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const phone = (req.params.phone || "").replace(/\D/g, "");
      if (!phone) {
        await pool.end();
        return res.status(400).json({ error: "phone is required" });
      }
      await pool.query("DELETE FROM pending_flows WHERE phone = $1", [phone]);
      await pool.query("DELETE FROM conversation_history WHERE phone = $1", [phone]);
      await pool.end();
      res.json({ cleared: true, phone });
    } catch (err) {
      res.status(500).json({ error: "Failed to clear session" });
    }
  });
}

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
    const normalizedMessage = message.trim();
    const threadId = `thread_${phoneNorm}`;
    let state = await stateManager.getOrCreateState(phoneNorm);
    state = await stateManager.processMessage(state, normalizedMessage);
    const extractedContext = stateManager.extractContext(state);

    const respond = async (rawReply: string) => {
      const safeReply = sanitizeAgentReply(rawReply);
      state = await stateManager.recordResponse(state, safeReply);
      await stateManager.saveState(state);
      return res.json({ success: true, reply: safeReply, phone: phoneNorm, threadId });
    };

    const personalMemoryTurn = await analyzePersonalMemoryTurn(normalizedMessage).catch(() => ({ intent: "none" as const }));
    if (personalMemoryTurn.intent === "save_profile") {
      const known = (state.persistent.knowledge || {}) as Record<string, unknown>;
      const mergedName = String(personalMemoryTurn.name || known.preferred_name || "").trim() || undefined;
      const mergedLocation = String(personalMemoryTurn.location || known.location || "").trim() || undefined;
      state.persistent.knowledge = {
        ...known,
        preferred_name: mergedName,
        location: mergedLocation,
      };
      await stateManager.saveState(state);
    }

    if (personalMemoryTurn.intent === "recall_profile") {
      const known = (state.persistent.knowledge || {}) as Record<string, unknown>;
      const name = String(known.preferred_name || "").trim();
      const location = String(known.location || "").trim();
      return await respond(renderProfileMemoryReply({ name, location }));
    }


    const supervisor = mastra.getAgent("bankingSupervisor");

    const messages: Array<{ role: "user" | "system"; content: string }> = [];
    // Always inject phone so tools can auto-lookup accounts without asking the customer.
    messages.push({
      role: "system",
      content: `Customer phone: ${phoneNorm}. Use this phone number when calling account-lookup or balance tools — never ask the customer to provide their account number.`,
    });
    messages.push({ role: "system", content: extractedContext.systemPrompt });
    messages.push({ role: "system", content: buildSystemPrompt(state) });
    const userCtx = buildUserContextPrompt(state);
    if (userCtx?.trim()) {
      messages.push({ role: "system", content: `Conversation context:\n${userCtx}` });
    }
    if (extractedContext.userContext?.trim()) {
      messages.push({ role: "system", content: `Conversation context:\n${extractedContext.userContext}` });
    }
    if (extractedContext.relevantTools.length) {
      messages.push({ role: "system", content: `Relevant tools for current context: ${extractedContext.relevantTools.join(", ")}.` });
    }
    if (customerName) {
      messages.push({
        role: "system",
        content: `Customer name: ${customerName}. Address the customer by this name when appropriate.`,
      });
    }


    messages.push({ role: "user", content: message.trim() });

    // NOTE: toolsets are intentionally NOT injected here — supervisor must delegate
    // all banking operations to specialist sub-agents via agents{} delegation.
    const response = await runWithRequestContext({ phone: phoneNorm }, async () =>
      supervisor.generate(messages, {
        memory: {
          thread: threadId,
          resource: phoneNorm,
        },
      })
    );

    const reply = response?.text?.trim() ?? "";


    return await respond(reply);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal error";
    console.error("[/api/agent/chat] Error:", err);
    return res.status(500).json({ success: false, error: msg });
  }
});




// ─────────────────────────────────────────────────────────────────────────────
// META FLOW DATA WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/meta-flow-data', async (req: Request, res: Response) => {

  try {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body || {};

    if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
      console.error('❌ Missing encryption payload parameters');
      return res.status(400).json({ error: 'Missing encryption payload parameters' });
    }

    // ── 1. LOAD & CLEAN PRIVATE KEY ─────────────────────────────────────────
    let privateKeyRaw = process.env.WHATSAPP_PRIVATE_KEY;

    // Fallback: Read directly from file if env variable is missing or invalid
    if (!privateKeyRaw || !privateKeyRaw.includes('BEGIN RSA PRIVATE KEY')) {
      const keyPath = path.join(process.cwd(), 'private.pem');
      if (fs.existsSync(keyPath)) {
        privateKeyRaw = fs.readFileSync(keyPath, 'utf8');
      }
    }

    if (!privateKeyRaw) {
      console.error('❌ Private key not found in process.env or private.pem');
      return res.status(500).json({ error: 'Server key configuration error' });
    }

    const privateKey = privateKeyRaw.replace(/\\n/g, '\n').trim();

    // ── 2. DECRYPT AES KEY ──────────────────────────────────────────────────
    const aesKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encrypted_aes_key, 'base64')
    );

    // ── 3. DECRYPT FLOW PAYLOAD ─────────────────────────────────────────────
    const iv = Buffer.from(initial_vector, 'base64');
    const encryptedBuffer = Buffer.from(encrypted_flow_data, 'base64');
    const tag = encryptedBuffer.subarray(encryptedBuffer.length - 16);
    const ciphertext = encryptedBuffer.subarray(0, encryptedBuffer.length - 16);

    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    const payload = JSON.parse(decrypted);
    console.log('✅ Decrypted Meta Payload:', JSON.stringify(payload));

    // ── 4. ENCRYPT RESPONSE HELPER ──────────────────────────────────────────
    const flippedIv = Buffer.from(iv.map((byte) => byte ^ 0xff));
    const encryptResponse = (responsePayload: Record<string, any>): string => {
      const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
      let encryptedRes = cipher.update(JSON.stringify(responsePayload), 'utf8');
      encryptedRes = Buffer.concat([encryptedRes, cipher.final()]);
      return Buffer.concat([encryptedRes, cipher.getAuthTag()]).toString('base64');
    };

    const flowVersion = payload.version || '3.0';

    // ── 5. HANDLE PING ──────────────────────────────────────────────────────
    if (payload.action === 'ping') {
      console.log('🟢 Responding to Meta Health Check (ping)');
      const response = encryptResponse({ version: flowVersion, data: { status: 'active' } });
      return res.status(200).type('text/plain').send(response);
    }

    // ── 6. HANDLE INIT & BACK ──────────────────────────────────────────────
    if (payload.action === 'INIT' || payload.action === 'BACK') {
      // Detect whether this INIT belongs to the SET-PIN flow (which starts on
      // PIN_SETUP_SCREEN) vs the LINK-ACCOUNT flow (starts on ACCOUNT_FORM).
      let isPinInit = false;
      try {
        const initToken = String(payload.flow_token || '');
        const initFlowId = String(payload.flow_id || '');
        const setPinNoId = (process.env.SET_PIN_FLOW_ID || process.env.SET_PIN_FLOW || '').trim();
        if (initFlowId && setPinNoId && initFlowId === setPinNoId) isPinInit = true;
        else if (initToken) {
          const initMap = await getTokenMap(initToken).catch(() => null);
          if (initMap) {
            if (initMap.survey_id === 'set-pin') isPinInit = true;
            else if (setPinNoId && String(initMap.flow_id || '') === setPinNoId) isPinInit = true;
          }
        }
      } catch {
        /* default to link flow screen */
      }

      return res.status(200).type('text/plain').send(
        encryptResponse({
          version: flowVersion,
          screen: isPinInit ? 'PIN_SETUP_SCREEN' : 'ACCOUNT_FORM',
          data: isPinInit
            ? { show_error: false, error_message: '' }
            : {
                show_otp: false,
                show_account_error: false,
                account_error: '',
                otpReference: ''
              },
        })
      );
    }

    // ── 7. HANDLE DATA EXCHANGE ACTIONS ─────────────────────────────────────
    if (payload.action === 'data_exchange') {
      const payloadData = payload.data || {};
      const actionType = payloadData.action_type || payload.action_type;

      const firstname = String(payloadData.firstname || '').trim();
      const lastname = String(payloadData.lastname || '').trim();
      const account = String(payloadData.account || '').trim();
      const bankCode = String(payloadData.bank || '').trim();
      const otp = String(payloadData.otp || '').trim();
      const otpReference = String(payloadData.otpReference || '').trim();

      // SUB-ACTION A: VERIFY ACCOUNT NUMBER
      if (actionType === 'verify_account') {
        const bankResponse = await validateBankAccount(account, bankCode);

        if (!bankResponse.success || !bankResponse.data) {
          return res.status(200).type('text/plain').send(
            encryptResponse({
              version: flowVersion,
              screen: 'ACCOUNT_FORM',
              data: {
                show_otp: false,
                show_account_error: true,
                account_error: '❌ Invalid account details. Please verify and try again.',
                otpReference: ''
              },
            })
          );
        }

        return res.status(200).type('text/plain').send(
          encryptResponse({
            version: flowVersion,
            screen: 'ACCOUNT_FORM',
            data: {
              show_otp: true,
              show_account_error: false,
              account_error: '',
              otpReference: bankResponse.data.otpReference 
            },
          })
        );
      }

      // SUB-ACTION B: VERIFY OTP & SUBMIT FORM
      if (actionType === 'submit_form') {
        const otpResponse = await verifyOtp(account, otp, otpReference);
        
        const userToken = otpResponse?.data?.userToken;

        if (!otpResponse || !otpResponse.success || !userToken) {
          return res.status(200).type('text/plain').send(
            encryptResponse({
              version: flowVersion,
              screen: 'ACCOUNT_FORM',
              data: {
                show_otp: true,
                show_account_error: true,
                account_error: '❌ Incorrect OTP code. Please try again.',
                otpReference
              },
            })
          );
        }

        // Save Customer Details
        const storage = mastra.getStorage() as any;
        const flowToken = String(payload.flow_token || payloadData.flow_token || '');
        const flowId = String(payload.flow_id || payloadData.flow_id || '');

        // ── Resolve the customer phone FIRST so every persistence step below
        // (verified_customers + customer_sessions) is keyed to the same phone.
        const flowPhone = await getPhoneByFlowToken(flowToken).catch((err) => {
          console.error(`⚠️ Error fetching phone for token ${flowToken}:`, err);
          return null;
        });
        console.log(`\n🔍 [DEBUG-LINKING] Resolved flowToken: ${flowToken} to flowPhone: ${flowPhone}`);

        if (storage?.db) {
          try {
            await bankingService.saveVerifiedCustomer(storage.db, {
              flowId,
              flowToken,
              accountDetails: { firstname, lastname, account, bankCode },
              bankToken: userToken,
              phoneNumber: flowPhone ?? undefined,
            });
          } catch (dbErr) {
            console.error('⚠️ DB Save Failed:', dbErr);
          }
        }

        try {
          await saveFlowResponse({
            flowId,
            flowToken,
            customerPhone: flowPhone || undefined,
            surveyId: 'link-account',
            responses: {
              firstname,
              lastname,
              account,
              bank: bankCode,
              otpVerified: true,
              userToken: userToken,
            },
          }).catch((err) => console.error('⚠️ Flow response save failed:', err));

          if (flowPhone) {
            console.log(`\n\n🔗 [DEBUG-LINKING] Calling setLinkedAccount for phone: ${flowPhone}`);
                        await setLinkedAccount(flowPhone, {
              accountNumber: account,
              maskedAccount: maskAccountNumber(account),
              accountType: 'current',
            }).catch((err) => {
              console.error(`❌ [DEBUG-LINKING] setLinkedAccount completely failed:`, err);
            });
            // The customer has just verified account + OTP + bank token via the
            // secure Link-Account flow — they are fully onboarded. Auto-accept the
            // service T&C so the bankingSupervisor's PHASE-1 onboarding gate
            // (isUserAcceptedTermsAndConditionTool) returns accepted=true and the
            // request is delegated to the balance/transfer sub-agent instead of
            // re-emitting the link-account CTA on every message.
            await setServiceTermsAccepted(flowPhone).catch((err) => {
              console.error(`⚠️ [DEBUG-LINKING] setServiceTermsAccepted failed:`, err);
            });
            console.log(`✅ [DEBUG-LINKING] setLinkedAccount + T&C accepted for phone: ${flowPhone}`);
            // Auto-resume the customer's original request without waiting for
            // them to type "Done" — this is the nfm_reply-independent fallback.
            scheduleAutoResume(flowPhone, "link");
          } else {
            console.warn(`⚠️ [DEBUG-LINKING] Skipping setLinkedAccount because flowPhone is null. Did you save the token before sending the flow?`);
          }
        } catch (err) {
          console.error('⚠️ Flow response persistence error:', err);
        }

        return res.status(200).type('text/plain').send(
          encryptResponse({
            version: flowVersion,
            screen: 'COMPLETE',
            data: {},
          })
        );
      }

      // SUB-ACTION C: SET TRANSACTION PIN (from the PIN-setup Meta Flow)
      // COMPLETE without ever saving the PIN, so every later balance/transfer
      // attempt kept answering pinCreationRequired=true (the "link loop").
      if (actionType === 'submit_pin') {
        const pin = String(payloadData.pin ?? '').trim();
        const confirmPin = String(payloadData.confirm_pin ?? '').trim();

        const pinFlowToken = String(payload.flow_token || payloadData.flow_token || '');
        const pinFlowId = String(payload.flow_id || payloadData.flow_id || '');

        // Basic validation — return the error screen so the customer can retry
        if (!/^\d{4}$/.test(pin)) {
          return res.status(200).type('text/plain').send(
            encryptResponse({
              version: flowVersion,
              screen: 'PIN_SETUP_SCREEN',
              data: {
                show_error: true,
                error_message: '❌ PIN must be exactly 4 digits. Please try again.',
              },
            })
          );
        }
        if (pin !== confirmPin) {
          return res.status(200).type('text/plain').send(
            encryptResponse({
              version: flowVersion,
              screen: 'PIN_SETUP_SCREEN',
              data: {
                show_error: true,
                error_message: '❌ PINs do not match. Please try again.',
              },
            })
          );
        }

        const pinFlowPhone = await getPhoneByFlowToken(pinFlowToken).catch((err) => {
          console.error(`⚠️ [submit_pin] Error fetching phone for token ${pinFlowToken}:`, err);
          return null;
        });
        console.log(`🔑 [DEBUG-PIN] submit_pin resolved flowToken to phone: ${pinFlowPhone}`);

        if (!pinFlowPhone) {
          console.error('❌ [submit_pin] Cannot save PIN — flow token is not mapped to a customer phone.');
          return res.status(200).type('text/plain').send(
            encryptResponse({
              version: flowVersion,
              screen: 'PIN_SETUP_SCREEN',
              data: {
                show_error: true,
                error_message: '⚠️ We could not identify your number. Please restart the chat and try again.',
              },
            })
          );
        }

        const savedPin = await saveTransactionPin(pinFlowPhone, pin);
        if (!savedPin) {
          console.error('❌ [submit_pin] saveTransactionPin failed for phone:', pinFlowPhone);
          return res.status(200).type('text/plain').send(
            encryptResponse({
              version: flowVersion,
              screen: 'PIN_SETUP_SCREEN',
              data: {
                show_error: true,
                error_message: '⚠️ We could not save your PIN right now. Please try again.',
              },
            })
          );
        }

        // Persist a completion record — NEVER store the PIN itself.
        await saveFlowResponse({
          flowId: pinFlowId,
          flowToken: pinFlowToken,
          customerPhone: pinFlowPhone,
          surveyId: 'set-pin',
          responses: { pinSet: true },
        }).catch((err) => console.error('⚠️ [submit_pin] Flow response save failed:', err));

        console.log(`✅ [submit_pin] Transaction PIN saved for phone: ${pinFlowPhone}`);
        // Auto-resume the original request (no "Done" needed) — nfm_reply fallback.
        scheduleAutoResume(pinFlowPhone, "pin");
        return res.status(200).type('text/plain').send(
          encryptResponse({
            version: flowVersion,
            screen: 'COMPLETE',
            data: {},
          })
        );
      }
    }

    // Default Fallback
    return res.status(200).type('text/plain').send(
      encryptResponse({ version: flowVersion, screen: 'COMPLETE', data: {} })
    );

  } catch (err: any) {
    console.error('❌ META FLOW WEBHOOK ERROR:', err);

    if (err.message?.includes('decrypt') || err.message?.includes('auth tag')) {
      return res.status(421).json({ error: 'Decryption failed' });
    }

    return res.status(500).json({ error: err.message });
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
    console.log(`📬 Webhook:     http://localhost:${PORT}/webhook/whatsapp`);
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
