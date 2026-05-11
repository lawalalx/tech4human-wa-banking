import {
  sendWhatsAppText,
  sendWhatsAppList,
  sendWhatsAppImage,
} from "../whatsapp-client.js";

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

interface Option {
  id: string;
  title: string;
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

export async function sendAgentReply(to: string, agentText: string): Promise<void> {
  // ── 1. Chart URL — send image first, then remaining text ─────────────────
  const { chartUrl, cleanText: afterChart } = parseChartUrl(agentText);
  if (chartUrl) {
    await sendWhatsAppImage(to, chartUrl).catch((err) => {
      console.error("[sendAgentReply] Failed to send chart image:", err);
    });
    if (!afterChart) return;
    agentText = afterChart;
  }

  // ── 2. Parse <options> tag ────────────────────────────────────────────────
  const { cleanText, options } = parseOptions(agentText);

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

  // ── 3. Plain text (no options, or only 1 option) ─────────────────────────
  const MAX_LEN = 4096;
  if (cleanText.length <= MAX_LEN) {
    await sendWhatsAppText(to, cleanText);
  } else {
    for (let i = 0; i < cleanText.length; i += MAX_LEN) {
      await sendWhatsAppText(to, cleanText.slice(i, i + MAX_LEN));
    }
  }
}
