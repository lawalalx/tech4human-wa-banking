import { mastra } from "../mastra/index.js";
import { sendAgentReply } from "../utils/send-agent-reply.js";
import { markAsRead, sendWhatsAppTyping } from "../whatsapp-client.js";
import { formatPhoneNumber, maskPhone } from "../utils/format-phone.js";
import { getSessionState, touchSession, buildResumptionHint } from "../utils/session-state.js";
import { getBankingMcpToolsets } from "../mastra/core/mcp/banking-mcp-client.js";

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

    // Inject MCP toolsets from mcp_service_fb (real banking data: balance, transfers,
    // PIN verification, customer lookup, transaction history, etc.)
    // Fails gracefully — if MCP server is down, agents use their built-in tools only.
    const mcpToolsets = await getBankingMcpToolsets();

    const response = await supervisor.generate(
      messages,
      {
        memory: {
          thread: threadId,
          resource: phone,
        },
        ...(Object.keys(mcpToolsets).length > 0 ? { toolsets: mcpToolsets } : {}),
      }
    );

    const replyText = response.text || "Sorry, I was unable to process your request. Please try again.";
    await sendAgentReply(rawPhone, replyText);

    console.log(`[ChatHandler] Reply sent to ${maskPhone(phone)}: "${replyText.slice(0, 80)}"`);
  } catch (error) {
    console.error(`[ChatHandler] Error processing message for ${maskPhone(phone)}:`, error);
    await sendAgentReply(
      rawPhone,
      `⚠️ Something went wrong on our end. Please try again in a moment.\n\n` +
        `If the issue persists, call our support line: ${process.env.SUPPORT_PHONE || "+2348001234567"}`
    ).catch(() => {});
  } finally {
    typingActive = false;
    clearInterval(typingTimer);
  }
}
