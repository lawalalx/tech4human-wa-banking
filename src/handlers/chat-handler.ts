import { mastra } from "../mastra/index.js";
import { sendAgentReply } from "../utils/send-agent-reply.js";
import { markAsRead, sendWhatsAppTyping } from "../whatsapp-client.js";
import { formatPhoneNumber, maskPhone } from "../utils/format-phone.js";
import { readSetPinFlowId, readLinkFlowId } from "../utils/send-agent-reply.js";

import {
  getSessionState,
  touchSession,
  buildResumptionHint,
  setServiceTermsPrompted,
  setAwaitingResume,
  popAwaitingResume,
  getLinkedAccount,
  wasRecentlyAutoResumed,
  popAutoResumeNote,
} from "../utils/session-state.js";
import { hasTransactionPin } from "../utils/pin-store.js";
import {
  isFlowDonePhrase,
  classifyBankingIntent,
} from "../utils/intent-classifier.js";

// Contextual (LLM) flow-completion detection — replaces the old brittle
// anchored FLOW_DONE_RE. Same name, now async; re-exported so index.ts and
// the auto-resume path keep their import surface.
export { isFlowDonePhrase };
import { getTokenMap } from "@/meta/meta-services/services.js";
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
import { 
  acceptTermsAndConditionsTool,
  lookupCustomerByPhoneTool

} from "@/mastra/tools/index.js";

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
    nfm_reply?: {
      response_json?: string;
      body?: string;
      name?: string;
    };
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
      // 👇 FIX: Meta Flow completions arrive as interactive nfm_reply events.
      // They used to fall through as "Empty or unsupported message" and were
      // silently dropped — the customer got no confirmation and nothing resumed.
      if (message.interactive?.type === "nfm_reply") return "__FLOW_COMPLETED__";
      return "";
    }
    case "image":
      return message.image?.caption || "[Image received]";
    default:
      return `[${message.type} received]`;
  }
}

/**
 * Phrases a customer sends right after completing a Link-Account / PIN flow
 * are now detected contextually by the LLM classifier (see
 * src/utils/intent-classifier.ts) — customers phrase completion any way they
 * like ("all set", "we good", "that's all"), so an anchored regex cannot
 * cover the space. The async `isFlowDonePhrase` is imported above.
 *
 * Nudge shown when a flow completes but there is no stored request to resume.
 */
function nextStepHint(kind: "link" | "pin"): string {
  return kind === "link"
    ? "Type *Balance* to see your account balance, or *Menu* to see everything I can do."
    : "Your PIN is ready — please repeat your request (e.g. *Balance*) to continue.";
}

/**
 * Build the deterministic AUTO-RESUME system note injected into the supervisor
 * prompt after a Meta Flow completes. This is what makes the LLM *step-aware*:
 * it knows exactly what just happened and exactly what the customer wanted
 * before they left to complete the flow — so it executes immediately instead of
 * re-asking the customer to link an account or type "Done".
 */
export function buildAutoResumeNote(
  kind: "link" | "pin",
  originalRequest: string
): string {
  const completedWhat =
    kind === "pin" ? "the transaction-PIN setup flow" : "the account-linking flow";
  const proceedHow =
    kind === "pin"
      ? "their transaction PIN is now stored, so tools will no longer report pinCreationRequired."
      : "their bank account is now linked and resolvable, so tools will no longer report not_found.";
  return (
    `AUTO-RESUME: The customer just completed ${completedWhat}; ${proceedHow} ` +
    `Their original request was: "${originalRequest}". ` +
    `Execute it NOW with the appropriate tools (resolve-customer-account first, then the matching ` +
    `balance/transfer/statement tool). Do NOT ask them to link an account, set a PIN, or type "Done" again.`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Deterministic auto-resume routing
// ─────────────────────────────────────────────────────────────────────────
/**
 * Bypass the supervisor and run a sub-agent directly with authoritative DB
 * state. Used ONLY on the auto-resume path (resumeNote set + account linked)
 * so the link-account CTA can NEVER be regenerated on a confirmed-linked
 * resume — the root cause of the "keeps taking me back to link account" loop.
 *
 * The balance/transfer/statement sub-agents hit the local Postgres vault +
 * mock-bank API directly (no MCP), so they are fully functional here.
 */
async function routeAutoResumeToSubagent(
  userText: string,
  phone: string,
  session: { account_number?: string },
  hasPin: boolean,
  resumeNote: string
): Promise<string | null> {
  const agentId = await classifyBankingIntent(userText);
  if (!agentId) return null;
  const agent = mastra.getAgent(agentId as any);
  if (!agent) return null;

  console.log(`[ChatHandler] Deterministic auto-resume → ${agentId} for "${userText.slice(0, 40)}" (${maskPhone(phone)})`);

  const messages: Array<{ role: "user" | "system"; content: string }> = [
    { role: "system", content: `Customer phone: ${phone}. Use this phone for all account lookups.` },
    {
      role: "system",
      content:
        `🚨 ACCOUNT STATUS: The customer HAS a linked bank account (${session.account_number}). ` +
        `DO NOT ask them to link an account again. Proceed immediately with their request via the proper tools.`,
    },
    {
      role: "system",
      content: hasPin
        ? `🔐 PIN STATUS: The customer HAS a 4-digit transaction PIN already stored. Do NOT send the PIN-setup flow again — proceed straight to the requested transaction.`
        : `🔐 PIN STATUS: The customer does NOT have a transaction PIN yet. If a tool returns pinCreationRequired=true, send the PIN-setup flow (set-transaction-pin). After the PIN is saved, the original request will auto-resume.`,
    },
    { role: "system", content: resumeNote },
    { role: "user", content: userText },
  ];

  const res = await agent.generate(messages, {
    memory: { thread: `thread_${phone}`, resource: phone },
  });
  const text = (res?.text || "").trim();
  return text || null;
}

function buildMainMenu(bankName: string, botName: string): string {
  return (
    `👋 Welcome to *${bankName}* WhatsApp Banking!\n\n` +
    `I'm ${botName}. Here's what I can help you with today:\n\n` +
    `[1] *Account & Transactions* — balance, transfers, bill payments\n` +
    `[2] *Link an account* — link an account\n` +
    `[3] *Security* — fraud alerts, block card, manage devices\n` +
    `[4] *Financial Insights* — spending analysis, budget, credit score\n` +
    `[5] *Support & Help* — FAQs, complaints, speak to an agent\n\n` +
    `Just type what you need, or reply with a number.\n` +
    `<options>[{"id":"1","title":"Account & Transactions"},{"id":"2","title":"Link an account"},{"id":"3","title":"Security"},{"id":"4","title":"Financial Insights"},{"id":"5","title":"Support & Help"}]</options>`
  );
}

interface FlowCompletion {
  kind: "link" | "pin";
  /** true when the DB confirms the flow's effect actually persisted */
  confirmed: boolean;
  confirmText: string;
}

/**
 * Classify an incoming nfm_reply (Meta Flow completion) and verify against the
 * database that the flow's effect truly persisted BEFORE telling the customer
 * it succeeded. Returns null when the flow type cannot be determined.
 */
async function resolveFlowCompletion(
  message: WhatsAppMessage,
  phone: string
): Promise<FlowCompletion | null> {
  // 1. Identify which flow completed (token map first, env IDs as fallback)
  let flowToken = "";
  try {
    const parsed = JSON.parse(message.interactive?.nfm_reply?.response_json || "{}");
    flowToken = String(parsed.flow_token || "");
  } catch {
    flowToken = "";
  }

  let kind: "link" | "pin" | null = null;
  if (flowToken) {
    const map = await getTokenMap(flowToken).catch(() => null);
    const flowId = String(map?.flow_id || "");
    const setPinId = readSetPinFlowId();
    const linkId = readLinkFlowId();
    if (map?.survey_id === "set-pin") kind = "pin";
    else if (map?.survey_id === "link-account") kind = "link";
    else if (setPinId && flowId === setPinId) kind = "pin";
    else if (linkId && flowId === linkId) kind = "link";
  }

  // 2. Verify actual state in the DB — never trust the event alone
  const session = await getSessionState(phone).catch(() => null);
  const hasPin = await hasTransactionPin(phone).catch(() => false);

  // If the flow type is still unknown, infer it from what is/isn't persisted
  if (kind === null) {
    if (session?.account_number && !hasPin) kind = "pin";
    else if (session?.account_number) kind = "link";
    else return null;
  }

  if (kind === "link") {
    if (session?.account_number) {
      const linked = await getLinkedAccount(phone).catch(() => null);
      const masked = linked?.maskedAccount ?? `••••${String(session.account_number).slice(-4)}`;
      return {
        kind,
        confirmed: true,
        confirmText:
          `✅ *Account linked successfully!*\n\n` +
          `Your account ${masked} is now connected to WhatsApp.\n` +
          `You can check your balance, transfer money and more.`,
      };
    }
    return {
      kind,
      confirmed: false,
      confirmText:
        "⚠️ I couldn't find a linked account on my end — the flow may not have completed fully.\n\n" +
        "Please type *Menu* and choose “Link an account” to try again.",
    };
  }

  // kind === "pin"
  if (hasPin) {
    return {
      kind,
      confirmed: true,
      confirmText: "✅ *Your 4-digit transaction PIN is set!*",
    };
  }
  return {
    kind,
    confirmed: false,
    confirmText:
      "⚠️ It seems your PIN wasn't saved. Please type *Menu* and try setting it again.",
  };
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

  let userText = extractMessageText(message);
  if (!userText) {
    console.log(`[ChatHandler] Empty or unsupported message from ${maskPhone(phone)}`);
    return;
  }

  let state = await stateManager.getOrCreateState(phone);

  state = await stateManager.processMessage(state, userText);
  const extractedContext = stateManager.extractContext(state);

  console.log(`[ChatHandler] Incoming from ${maskPhone(phone)}: "${userText.slice(0, 80)}"`);

  // ── DETERMINISTIC FLOW-COMPLETION HANDLING ───────────────────────────────
  // Meta Flow completions (nfm_reply events) and "Done"-type replies are
  // resolved HERE, in code — never left to the LLM to interpret. This is what
  // breaks the account-link / PIN-setup loop for good.
  const originalUserText = userText; // snapshot before any auto-resume swap
  let resumeNote: string | null = null;

  if (userText === "__FLOW_COMPLETED__") {
    // If the data_exchange fallback already resumed this flow moments ago,
    // this nfm_reply is a duplicate — skip it entirely (no confirm, no hint).
    const alreadyResumed = await wasRecentlyAutoResumed(phone).catch(() => false);
    if (alreadyResumed) {
      console.log(`[ChatHandler] nfm_reply for ${maskPhone(phone)} is duplicate of an auto-resume — skipping.`);
      return;
    }

    const completion = await resolveFlowCompletion(message, phone);
    if (!completion) {
      console.log(`[ChatHandler] nfm_reply from ${maskPhone(phone)} could not be classified — ignoring.`);
      return;
    }
    // Confirm to the customer based on verified DB state (not just the event)
    await sendAgentReply(rawPhone, completion.confirmText);
    if (!completion.confirmed) return; // effect never persisted — customer advised to retry
    const resume = await popAwaitingResume(phone).catch(() => null);
    if (!resume || (await isFlowDonePhrase(resume.originalRequest))) {
      // If the data_exchange webhook already auto-resumed this flow moments
      // ago, do not spam a second confirmation — the customer just saw it.
      const alreadyResumed = await wasRecentlyAutoResumed(phone).catch(() => false);
      if (alreadyResumed) return;
      await sendAgentReply(rawPhone, nextStepHint(completion.kind));
      return;
    }
    console.log(`[ChatHandler] Auto-resuming post-${completion.kind} request: "${resume.originalRequest}"`);
    userText = resume.originalRequest;
    resumeNote = buildAutoResumeNote(completion.kind, resume.originalRequest);
  } else if (await isFlowDonePhrase(userText)) {
    const sessionNow = await getSessionState(phone).catch(() => null);
    if (sessionNow?.account_number) {
      // The account IS linked — "Done" must never be fed to the LLM as a riddle.
      const resume = await popAwaitingResume(phone).catch(() => null);
      if (resume && !(await isFlowDonePhrase(resume.originalRequest))) {
        console.log(`[ChatHandler] "Done" received — resuming stored request: "${resume.originalRequest}"`);
        userText = resume.originalRequest;
        resumeNote = buildAutoResumeNote(resume.kind, resume.originalRequest);
      } else {
        // Nothing stored to resume → deterministic main menu (no LLM guessing).
        const menu = buildMainMenu(
          process.env.BANK_NAME || "First Bank Nigeria",
          process.env.BOT_NAME || "FBN Banking Assistant"
        );
        await sendAgentReply(rawPhone, menu);
        state = await stateManager.recordResponse(state, menu);
        await stateManager.saveState(state).catch(() => {});
        return;
      }
    }
    // No account linked yet → fall through so the pipeline guides them to link.
  }

  // ── Data-exchange auto-resume note (fallback when nfm_reply was dropped) ──
  // The webhook sets an AUTO-RESUME note in context right after the flow saved
  // (link-account or set-pin). If we got here on the customer's original request
  // re-injected as plain text, apply the note so the LLM is fully step-aware.
  if (!resumeNote) {
    const note = await popAutoResumeNote(phone).catch(() => null);
    if (note) {
      resumeNote = note;
      console.log(`[ChatHandler] Applying stored AUTO-RESUME note for ${maskPhone(phone)}`);
    }
  }

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

    // ── Deterministic auto-resume short-circuit ─────────────────────────────
    // When a Meta Flow just completed (link-account OR set-pin) and the account
    // is confirmed linked in the DB, route STRAIGHT to the correct sub-agent
    // with authoritative DB state. This is the deterministic fix for "keeps
    // taking me back to link account": the bankingSupervisor's PHASE-1
    // onboarding gate must NEVER re-fire on a confirmed-linked resume, because
    // T&C acceptance alone was insufficient (MCP may be unreachable, and the
    // supervisor can regenerate the link CTA from thread memory).
    if (resumeNote && (await classifyBankingIntent(userText))) {
      const sessionNow = await getSessionState(phone).catch(() => null);
      const linkedAccount = sessionNow?.account_number
        ? await getLinkedAccount(phone).catch(() => null)
        : null;
      if (sessionNow?.account_number && linkedAccount?.maskedAccount) {
        const hasPinNow = await hasTransactionPin(phone).catch(() => false);
        console.log(`[ChatHandler] 🔀 Auto-resume with linked account — routing directly to sub-agent (bypass supervisor gate)`);
        const directReply = await routeAutoResumeToSubagent(
          userText,
          phone,
          { account_number: sessionNow.account_number },
          hasPinNow,
          resumeNote
        ).catch((err) => {
          console.error(`[ChatHandler] Direct sub-agent resume failed, falling back to supervisor:`, err);
          return null;
        });
        if (directReply) {
          // Mirror the supervisor path: if the sub-agent replied with a Meta
          // Flow CTA (e.g. the PIN-setup flow), store the original request so
          // the flow's completion (data_exchange/nfm_reply) can auto-resume it.
          if (/<flow_action/i.test(directReply)) {
            const flowKind = /SET_PIN_FLOW/i.test(directReply) ? "pin" : "link";
            console.log(`[ChatHandler] Direct-resume Flow CTA (${flowKind}) — storing awaiting_resume request="${originalUserText.slice(0, 60)}"`);
            await setAwaitingResume(phone, flowKind, originalUserText).catch((err) => {
              console.error(`[ChatHandler] setAwaitingResume (direct path) failed:`, err);
            });
          }
          await sendAndTrack(directReply); // typing timer cleared by finally
          return; // ✅ deterministic path — never reaches the supervisor
        }
        // Direct routing produced nothing → fall through to the supervisor,
        // which still receives resumeNote + ACCOUNT/PIN STATUS notes.
      }
    }

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
    
    
    // ======================
    const currentSession = await getSessionState(phone).catch(() => null);
    if (currentSession?.account_number) {
      messages.push({ 
        role: "system", 
        content: `🚨 ACCOUNT STATUS: The customer HAS a linked bank account (${currentSession.account_number}). DO NOT ask them to link an account again. If they just said "Done", you MUST IMMEDIATELY call the balance or transaction tool they originally requested to proceed.` 
      });
    } else {
      messages.push({ 
        role: "system", 
        content: `🚨 ACCOUNT STATUS: The customer does NOT have a linked bank account yet.` 
      });
    }

    // PIN status (authoritative from the local PIN vault) so sub-agents never
    // loop "set your PIN" when a PIN already exists.
    const hasPinNow = await hasTransactionPin(phone).catch(() => false);
    messages.push({
      role: "system",
      content: hasPinNow
        ? `🔐 PIN STATUS: The customer HAS a 4-digit transaction PIN already stored. Do NOT send the PIN-setup flow again — proceed straight to the requested transaction.`
        : `🔐 PIN STATUS: The customer does NOT have a transaction PIN yet. If a tool returns pinCreationRequired=true, ask them to set one via the PIN flow.`,
    });

    // AUTO-RESUME note (set when a Meta Flow / "Done" completion re-attaches
    // the customer's original request) — make the LLM execute it, never re-ask.
    if (resumeNote) {
      messages.push({ role: "system", content: resumeNote });
    }

    // ============================

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
    // Sub-agents call the external bank API directly via src/bank-api/external/register.ts.
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

    // If the reply sent a Meta Flow CTA (link account / set PIN), store the
    // original request so the flow's nfm_reply completion can resume it —
    // instead of leaving the customer to type "Done" and hope the LLM guesses.
    if (/<flow_action/i.test(replyText)) {
      const flowKind = /SET_PIN_FLOW/i.test(replyText) ? "pin" : "link";
      const resumeSource = resumeNote ? originalUserText : userText;
      console.log(`[ChatHandler] Flow CTA sent to ${maskPhone(phone)} — storing awaiting_resume kind=${flowKind} request="${resumeSource.slice(0, 60)}"`);
      await setAwaitingResume(phone, flowKind, resumeSource).catch((err) => {
        console.error(`[ChatHandler] setAwaitingResume failed:`, err);
      });
    }

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
