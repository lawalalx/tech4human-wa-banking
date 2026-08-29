import "dotenv/config";
import {
  sendWhatsAppText,
  sendWhatsAppList,
  sendWhatsAppImage,
} from "../whatsapp-client.js";
import { sanitizeAgentReply } from "./sanitize-agent-reply.js";
import { sendFlowMessage } from "@/meta/meta-services/services.js"
import { upsertMetaFlowTokenMap } from "@/meta/meta-services/services.js";
import { normalizePhone } from "./format-phone.js";

/**
 * sendAgentReply — smart reply sender matching the senegal pattern.
 *
 * Agent tags:
 *   <chart_url>https://...</chart_url>  → send as native WhatsApp image
 *   <options>[{"id":"1","title":"..."},...] </options>  → interactive list
 *     with a "Select" button (for ANY number of options ≥ 2).
 *     The numbered text remains in the body so the customer can read it
 *     AND tap the Select button to pick.
 *
 * For ≤ 1 option or no tag → plain text.
 * Fallback: if the list call fails, send as plain text.
 */

const OPTIONS_RE = /<options>([\s\S]*?)<\/options>/i;
const CHART_RE = /<chart_url>(https?:\/\/[^<]+)<\/chart_url>/i;
const FLOW_ACTION_RE = /<flow_action\s+([^>]*)\/>/i;

interface Option {
  id: string;
  title: string;
}

interface FlowAction {
  flowId: string;
  buttonText: string;
}

function parseChartUrl(text: string): { chartUrl: string | null; cleanText: string } {
  const match = CHART_RE.exec(text);
  if (!match) return { chartUrl: null, cleanText: text };
  return {
    chartUrl: match[1].trim(),
    cleanText: text.replace(CHART_RE, "").trim(),
  };
}

function parseOptions(text: string): { cleanText: string; options: Option[] | null } {
  const match = OPTIONS_RE.exec(text);
  console.log(`[sendAgentReply] text length=${text.length} | <options> found=${!!match}`);
  if (!match) return { cleanText: text.trim(), options: null };

  const cleanText = text.replace(OPTIONS_RE, "").trim();
  let options: Option[] | null = null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (Array.isArray(parsed)) {
      options = parsed
        .filter((o: any) => o?.id != null && o?.title)
        .slice(0, 10)
        .map((o: any) => ({ id: String(o.id), title: String(o.title) }));
    }
  } catch {
    console.warn("[sendAgentReply] Failed to parse <options> JSON — sending as plain text");
  }
  return { cleanText, options: options?.length ? options : null };
}

/**
 * Parse a <flow_action flow_id="..." button_text="..." /> tag.
 * Returns the action, stripping the tag from the visible text.
 */
function parseFlowAction(text: string): { cleanText: string; action: FlowAction | null } {
  const match = FLOW_ACTION_RE.exec(text);
  if (!match) return { cleanText: text.trim(), action: null };

  const attrs = match[1];
  const flowIdMatch = /flow_id=["']([^"']+)["']/i.exec(attrs);
  const buttonMatch = /button_text=["']([^"']+)["']/i.exec(attrs);

  if (!flowIdMatch || !buttonMatch) {
    return { cleanText: text.replace(FLOW_ACTION_RE, "").trim(), action: null };
  }

  const result = {
    cleanText: text.replace(FLOW_ACTION_RE, "").trim(),
    action: { flowId: flowIdMatch[1], buttonText: buttonMatch[1] },
  };

  console.log(`\n\nThis is the sent flow parameter from parseFlowAction ${result}`)
  return result
}

/**
 * Send a real WhatsApp Flow message for a <flow_action> tag.
 */
export async function sendFlowActionMessage(
  to: string,
  action: FlowAction,
  customerPhone?: string
): Promise<void> {
  const cta = action.buttonText || "Continue";
  const flowId = resolveFlowId(action.flowId);
  if (!flowId) {
    // The requested Meta Flow is not configured (e.g. SET_PIN_FLOW_ID missing).
    // For PIN we can fall back to the inline create-transaction-pin path; for
    // linking we surface the unconfigured state with a clear follow-up.
    if (/SET_PIN_FLOW/i.test(action.flowId)) {
      console.warn("[sendAgentReply] SET_PIN_FLOW_ID is not configured — instructing inline PIN instead of sending a Flow.");
      await sendWhatsAppText(
        to,
        "🔐 Please reply with the 4-digit PIN you would like to use to secure your transactions (numbers only)."
      );
    } else {
      await sendWhatsAppText(to, "⚠️ Account linking isn't fully configured yet. Please try again shortly or contact support.");
    }
    return;
  }

  // actual flow (the PIN flow used to be mislabelled "Link Bank Account" and
  // stamped with surveyId "link-account", making completions indistinguishable).
  const isPinFlow = /SET_PIN_FLOW/i.test(action.flowId) || flowId === readSetPinFlowId();
  const surveyId = isPinFlow ? "set-pin" : "link-account";
  const headerText = isPinFlow ? "Set Transaction PIN" : "Link Bank Account";
  const bodyText = isPinFlow
    ? "Create the 4-digit PIN you will use to authorise transactions."
    : "Securely link your bank account to WhatsApp to start banking.";
  const footerText = "Your details are always kept private.";

  const flowToken = `${surveyId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const ok = await sendFlowMessage({
      to: to.replace(/\D/g, ""),
      flowId,
      flowToken,
      flowMode: "published",
      cta,
      headerText,
      bodyText,
      footerText,
      initialScreen: isPinFlow ? "PIN_SETUP_SCREEN" : "INTRO",
    });

    if (ok && customerPhone) {
      await upsertMetaFlowTokenMap({
        flowToken,
        flowId,
        surveyId,
        customerPhone: normalizePhone(customerPhone),
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[sendAgentReply] Failed to send Meta Flow message:", err);
  }
}

/** Map internal flow placeholders to real Meta Flow IDs from env. */
function resolveFlowId(name: string): string | null {
  switch (name.toUpperCase()) {
    case "LINK_ACCOUNT_FLOW":
    case "LINKACCOUNTFLOW":
      return (
        process.env.LINK_ACCOUNT_FLOW_ID?.trim() ||
        process.env.LINK_ACCOUNT_FLOW?.trim() ||
        null
      );
    case "SET_PIN_FLOW":
    case "SETPINFLOW":
      return (
        process.env.SET_PIN_FLOW_ID?.trim() ||
        process.env.SET_PIN_FLOW?.trim() ||
        null
      );
    default:
      return (
        process.env.LINK_ACCOUNT_FLOW_ID?.trim() ||
        process.env.LINK_ACCOUNT_FLOW?.trim() ||
        null
      );
  }
}

/** Read the SET-PIN Flow ID tolerating either env naming style. */
export function readSetPinFlowId(): string | null {
  return (
    process.env.SET_PIN_FLOW_ID?.trim() ||
    process.env.SET_PIN_FLOW?.trim() ||
    null
  );
}

/** Read the LINK-ACCOUNT Flow ID tolerating either env naming style. */
export function readLinkFlowId(): string | null {
  return (
    process.env.LINK_ACCOUNT_FLOW_ID?.trim() ||
    process.env.LINK_ACCOUNT_FLOW?.trim() ||
    null
  );
}

export async function sendAgentReply(to: string, agentText: unknown): Promise<void> {
  let text: string = sanitizeAgentReply(agentText);

  // ── 1. Chart URL — send image first, then remaining text ─────────────────
  const { chartUrl, cleanText: afterChart } = parseChartUrl(text);
  if (chartUrl) {
    await sendWhatsAppImage(to, chartUrl).catch((err) => {
      console.error("[sendAgentReply] Failed to send chart image:", err);
    });
    if (!afterChart) return;
    text = afterChart;
  }

  // ── 2. Parse <flow_action> tag (Meta Flow CTA) — takes precedence over lists ─
  const { cleanText: textAfterFlow, action: flowAction } = parseFlowAction(text);

  if (flowAction) {
    // Send the explanation text first (strip the tag), then the Flow message.
    if (textAfterFlow) {
      await sendWhatsAppText(to, textAfterFlow.slice(0, 1024)).catch(() => {});
    }
    await sendFlowActionMessage(to, flowAction, to);
    return;
  }
  text = textAfterFlow;

  // ── 3. Parse <options> tag ────────────────────────────────────────────────
  const { cleanText, options } = parseOptions(text);

  if (options && options.length >= 2) {
    // Always use the interactive list (Select button) for 2+ options.
    // Body keeps the numbered text so customers can read it; they tap "Select"
    // to pick interactively — matching the senegal implementation.
    const bodyText = cleanText.length <= 1024 ? cleanText : cleanText.slice(0, 1021) + "…";
    const rows = options.map((o) => ({
      id: o.id,
      title: o.title.slice(0, 24),
      description: o.title.length > 24 ? o.title.slice(0, 72) : undefined,
    }));

    const ok = await sendWhatsAppList(to, bodyText, "Select", [
      { title: "Options", rows },
    ]).catch((err) => {
      console.warn("[sendAgentReply] List send failed:", err);
      return false;
    });

    if (!ok) {
      // Fallback: send as plain text so the message is never lost
      await sendWhatsAppText(to, cleanText);
    }
    return;
  }

  // ── 4. Plain text (no options, no flow, no chart) ─────────────────────────
  const MAX_LEN = 4096;
  if (cleanText.length <= MAX_LEN) {
    await sendWhatsAppText(to, cleanText);
  } else {
    for (let i = 0; i < cleanText.length; i += MAX_LEN) {
      await sendWhatsAppText(to, cleanText.slice(i, i + MAX_LEN));
    }
  }
}
