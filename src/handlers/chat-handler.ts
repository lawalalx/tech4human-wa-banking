import { mastra } from "../mastra/index.js";
import { TRANSACTION_UNKNOWN_REPLY, transactionWorkflow } from "../mastra/workflows/transaction-workflow.js";
import { sendAgentReply } from "../utils/send-agent-reply.js";
import { markAsRead, sendWhatsAppTyping } from "../whatsapp-client.js";
import { formatPhoneNumber, maskPhone } from "../utils/format-phone.js";
import { getSessionState, touchSession, buildResumptionHint } from "../utils/session-state.js";
import { stateManager } from "../core/index.js";

// ─────────────────────────────────────────────────────────────────────────
// NEW SERVICES FOR PRODUCTION
// ─────────────────────────────────────────────────────────────────────────
import {
  buildSystemPrompt,
  buildUserContextPrompt,
  buildResumptionMessage,
} from "../services/conversation-context.js";

import {
  getAuthorizationStatus,
  isPinExpired,
  isOtpExpired,
} from "../services/authorization-service.js";
import { analyzePersonalMemoryTurn, renderProfileMemoryReply } from "../services/personal-memory.js";
import { runWithRequestContext } from "../utils/request-context.js";

const TYPING_INTERVAL_MS = 8_000;
// How long of a gap (ms) qualifies a customer as "returning" for resumption hints
const RESUME_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

interface WhatsAppMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  image?: { caption?: string; id: string };
  timestamp: string;
}

/**
 * Extract text content from any incoming WhatsApp message type.
 */
function extractMessageText(message: WhatsAppMessage): string {
  switch (message.type) {
    case "text":
      return message.text?.body?.trim() || "";
    case "interactive": {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply;
      if (reply) return reply.title || reply.id;
      return "";
    }
    case "image":
      return message.image?.caption || "[Image received]";
    default:
      return `[${message.type} received]`;
  }
}

/**
 * Main incoming WhatsApp message handler.
 * Called for every inbound message from Meta's webhook.
 */
export async function handleIncomingMessage(message: WhatsAppMessage): Promise<void> {
  const rawPhone = message.from;
  const phone = formatPhoneNumber(rawPhone);
  const messageId = message.id;

  // Mark as read immediately for a good UX signal
  await markAsRead(messageId).catch(() => {});

  const userText = extractMessageText(message);
  if (!userText) {
    console.log(`[ChatHandler] Empty or unsupported message from ${maskPhone(phone)}`);
    return;
  }

  let state = await stateManager.getOrCreateState(phone);
  state = await stateManager.processMessage(state, userText);
  const extractedContext = stateManager.extractContext(state);

  console.log(`[ChatHandler] Incoming from ${maskPhone(phone)}: "${userText.slice(0, 80)}"`);

  // ── Session resumption detection ─────────────────────────────────────────
  // Mastra memory already persists the full conversation thread.
  // We additionally inject a system hint if the customer had a pending flow
  // (e.g. OTP mid-transfer, KYC in-progress) when they last left.
  let resumptionSystemMsg: string | null = null;
  try {
    const session = await getSessionState(phone);
    if (session) {
      const rawHint = buildResumptionHint(session, RESUME_THRESHOLD_MS);
      if (rawHint) {
        // Use richer buildResumptionMessage when state has customer context
        const pendingAction = session?.pending_flow?.action as string | undefined;
        const minutesAway = session?.last_active
          ? Math.round((Date.now() - new Date(session.last_active).getTime()) / 60000)
          : undefined;
        resumptionSystemMsg = buildResumptionMessage(state, pendingAction, minutesAway);
      }
    }
    // Fire-and-forget — update last_active so next message can detect the gap correctly
    touchSession(phone).catch(() => {});
  } catch {
    // Non-fatal — continue without resumption hint
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Keep-alive typing indicator while the agent processes.
  // Fire immediately so the customer sees the typing bubble at once,
  // then keep refreshing every 8 s (WhatsApp drops it after ~10 s).
  await sendWhatsAppTyping(rawPhone, messageId).catch(() => {});
  let typingActive = true;
  const typingTimer = setInterval(async () => {
    if (typingActive) {
      await sendWhatsAppTyping(rawPhone, messageId).catch(() => {});
    }
  }, TYPING_INTERVAL_MS);

  try {
    const sendAndTrack = async (reply: string) => {
      await sendAgentReply(rawPhone, reply);
      state = await stateManager.recordResponse(state, reply);
      await stateManager.saveState(state);
    };

    const personalMemoryTurn = await analyzePersonalMemoryTurn(userText).catch(() => ({ intent: "none" as const }));
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
      await sendAndTrack(renderProfileMemoryReply({ name, location }));
      return;
    }

    const wf = await runWithRequestContext({ phone }, async () => {
      const run = await transactionWorkflow.createRun();
      return await run.start({
        inputData: {
          phone,
          message: userText,
        },
      });
    });

    if (wf.status === "success" && wf.result.handled && wf.result.reply !== TRANSACTION_UNKNOWN_REPLY) {
      await sendAndTrack(wf.result.reply);
      const workflowReplyPreview = typeof wf.result.reply === "string" ? wf.result.reply : JSON.stringify(wf.result.reply);
      console.log(`[ChatHandler] Workflow reply sent to ${maskPhone(phone)}: "${workflowReplyPreview.slice(0, 80)}\n..."`);
      return;
    }

    const supervisor = mastra.getAgent("bankingSupervisor");

    // Thread ID is per-user; provides persistent memory across sessions via PostgreSQL.
    // Mastra loads the last 50 messages automatically — full conversation continuity is built-in.
    const threadId = `thread_${phone}`;

    // Build the messages array.
    // If a resumption hint exists, prepend it as a system message so the supervisor
    // proactively acknowledges the pending flow before responding.
    const messages: Array<{ role: "user" | "system" | "assistant"; content: string }> = [];
    // Always inject phone so transaction/insights tools can auto-lookup accounts without
    // asking the customer for their account number.
    messages.push({ role: "system", content: `Customer phone: ${phone}. Use this phone number when calling account-lookup or balance tools — never ask the customer to provide their account number.` });
    // Use auth-aware system prompt from conversation-context service
    messages.push({ role: "system", content: buildSystemPrompt(state) });
    // Inject conversation context from the context service
    const userCtx = buildUserContextPrompt(state);
    if (userCtx?.trim()) {
      messages.push({ role: "system", content: `Conversation context:\n${userCtx}` });
    } else if (extractedContext.userContext?.trim()) {
      messages.push({ role: "system", content: `Conversation context:\n${extractedContext.userContext}` });
    }
    // Add authorization status for the supervisor
    const authStatus = getAuthorizationStatus(state);
    if (authStatus.pinStatus !== "pending" || authStatus.otpStatus !== "pending") {
      messages.push({
        role: "system",
        content: `Authorization status — PIN: ${authStatus.pinStatus}${authStatus.pinStatus === "verified" ? ` (${authStatus.pinRemainingSeconds}s remaining)` : ""}. OTP: ${authStatus.otpStatus}${authStatus.otpStatus === "verified" ? ` (${authStatus.otpRemainingSeconds}s remaining)` : ""}.`,
      });
    }
    if (extractedContext.relevantTools.length) {
      messages.push({ role: "system", content: `Relevant tools for current context: ${extractedContext.relevantTools.join(", ")}.` });
    }
    if (resumptionSystemMsg) {
      messages.push({ role: "system", content: resumptionSystemMsg });
      console.log(`[ChatHandler] Injecting resumption hint for ${maskPhone(phone)}: state="${resumptionSystemMsg.slice(0, 80)}..."`);
    }


    messages.push({ role: "user", content: userText });

    // NOTE: MCP toolsets are intentionally NOT injected into the supervisor's generate() call.
    // The supervisor must delegate ALL banking data operations to specialist sub-agents.
    // Sub-agents use callBankingTool() (direct HTTP to MCP server) independently.
    // Injecting toolsets here caused the supervisor to call raw MCP tools directly
    // (e.g. get_customer_accounts with customer_id=null), bypassing the proper tool chain.
    const response = await runWithRequestContext({ phone }, async () =>
      supervisor.generate(
        messages,
        {
          memory: {
            thread: threadId,
            resource: phone,
          },
        }
      )
    );

    const replyText = response.text || "Sorry, I was unable to process your request. Please try again.";

    await sendAndTrack(replyText);

    console.log(`[ChatHandler] Reply sent to ${maskPhone(phone)}: "${replyText.slice(0, 80)}\n..."`);
  } catch (error) {
    console.error(`[ChatHandler] Error processing message for ${maskPhone(phone)}:`, error);
    const fallbackReply =
      `⚠️ Something went wrong on our end. Please try again in a moment.\n\n` +
      `If the issue persists, call our support line: ${process.env.SUPPORT_PHONE}`;
    await sendAgentReply(
      rawPhone,
      fallbackReply
    ).catch(() => {});
    state = await stateManager.recordResponse(state, fallbackReply);
    await stateManager.saveState(state).catch(() => {});
  } finally {
    typingActive = false;
    clearInterval(typingTimer);
  }
}
