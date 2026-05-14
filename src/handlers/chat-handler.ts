import { mastra } from "../mastra/index.js";
import { TRANSACTION_UNKNOWN_REPLY, transactionWorkflow } from "../mastra/workflows/transaction-workflow.js";
import { INSIGHTS_UNKNOWN_REPLY, insightsWorkflow } from "../mastra/workflows/insights-workflow.js";
import { sendAgentReply } from "../utils/send-agent-reply.js";
import { markAsRead, sendWhatsAppTyping } from "../whatsapp-client.js";
import { formatPhoneNumber, maskPhone } from "../utils/format-phone.js";
import { clearPendingFlow, getSessionState, touchSession, buildResumptionHint } from "../utils/session-state.js";

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

  console.log(`[ChatHandler] Incoming from ${maskPhone(phone)}: "${userText.slice(0, 80)}"`);

  // ── Session resumption detection ─────────────────────────────────────────
  // Mastra memory already persists the full conversation thread.
  // We additionally inject a system hint if the customer had a pending flow
  // (e.g. OTP mid-transfer, KYC in-progress) when they last left.
  let resumptionSystemMsg: string | null = null;
  try {
    const session = await getSessionState(phone);
    if (session) {
      resumptionSystemMsg = buildResumptionHint(session, RESUME_THRESHOLD_MS);
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
    if (/^end$/i.test(userText.trim())) {
      await clearPendingFlow(phone).catch(() => {});
    }

    const session = await getSessionState(phone).catch(() => null);
    const pendingAction = session?.pending_flow?.action;
    const hasPendingTransactionFlow = ["balance", "mini_statement", "transfer", "bill_payment"].includes(
      String(pendingAction || "")
    );
    if (hasPendingTransactionFlow) {
      const run = await transactionWorkflow.createRun();
      const wf = await run.start({
        inputData: {
          phone,
          action: pendingAction as any,
          message: userText,
        },
      });

      if (wf.status === "success" && wf.result.handled) {
        await sendAgentReply(rawPhone, wf.result.reply);
        const workflowReplyPreview = typeof wf.result.reply === "string" ? wf.result.reply : JSON.stringify(wf.result.reply);
        console.log(`[ChatHandler] Workflow reply sent to ${maskPhone(phone)}: "${workflowReplyPreview.slice(0, 80)}\n..."`);
        return;
      }
    }

    // Run transaction workflow first for fresh requests as well.
    // If it returns the unknown sentinel, continue with supervisor for general conversation.
    {
      const run = await transactionWorkflow.createRun();
      const wf = await run.start({
        inputData: {
          phone,
          message: userText,
        },
      });

      if (wf.status === "success" && wf.result.handled && wf.result.reply !== TRANSACTION_UNKNOWN_REPLY) {
        await sendAgentReply(rawPhone, wf.result.reply);
        const workflowReplyPreview = typeof wf.result.reply === "string" ? wf.result.reply : JSON.stringify(wf.result.reply);
        console.log(`[ChatHandler] Workflow reply sent to ${maskPhone(phone)}: "${workflowReplyPreview.slice(0, 80)}\n..."`);
        return;
      }
    }

    // Run insights workflow before supervisor fallback to keep analytics/chart behavior deterministic.
    {
      const run = await insightsWorkflow.createRun();
      const wf = await run.start({
        inputData: {
          phone,
          message: userText,
        },
      });

      if (wf.status === "success" && wf.result.handled && wf.result.reply !== INSIGHTS_UNKNOWN_REPLY) {
        await sendAgentReply(rawPhone, wf.result.reply);
        const workflowReplyPreview = typeof wf.result.reply === "string" ? wf.result.reply : JSON.stringify(wf.result.reply);
        console.log(`[ChatHandler] Insights workflow reply sent to ${maskPhone(phone)}: "${workflowReplyPreview.slice(0, 80)}\n..."`);
        return;
      }
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
    const response = await supervisor.generate(
      messages,
      {
        memory: {
          thread: threadId,
          resource: phone,
        },
      }
    );

    const replyText = response.text || "Sorry, I was unable to process your request. Please try again.";

    await sendAgentReply(rawPhone, replyText);

    console.log(`[ChatHandler] Reply sent to ${maskPhone(phone)}: "${replyText.slice(0, 80)}\n..."`);
  } catch (error) {
    console.error(`[ChatHandler] Error processing message for ${maskPhone(phone)}:`, error);
    await sendAgentReply(
      rawPhone,
      `⚠️ Something went wrong on our end. Please try again in a moment.\n\n` +
        `If the issue persists, call our support line: ${process.env.SUPPORT_PHONE}`
    ).catch(() => {});
  } finally {
    typingActive = false;
    clearInterval(typingTimer);
  }
}
