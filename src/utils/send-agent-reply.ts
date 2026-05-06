import {
  sendWhatsAppText,
  sendWhatsAppInteractiveButtons,
  sendWhatsAppList,
} from "../whatsapp-client.js";

interface ButtonOption {
  id: string;
  title: string;
}

interface ListOption {
  id: string;
  title: string;
  description?: string;
}

interface ListSection {
  title: string;
  rows: ListOption[];
}

/**
 * Parse <options>[...]</options> JSON tag from agent response text.
 * Returns the options array (button or list items) and the cleaned message text.
 */
function parseOptions(text: string): {
  cleanText: string;
  options: ButtonOption[] | null;
} {
  const match = text.match(/<options>(\[[\s\S]*?\])<\/options>/i);
  if (!match) {
    return { cleanText: text.trim(), options: null };
  }

  let options: ButtonOption[] | null = null;
  try {
    options = JSON.parse(match[1]);
  } catch {
    // Malformed JSON — ignore and send as plain text
  }

  const cleanText = text.replace(/<options>[\s\S]*?<\/options>/i, "").trim();
  return { cleanText, options };
}

/**
 * Sends the agent's reply to a WhatsApp user.
 * If the reply contains an <options>[...]</options> tag:
 *   - 2–3 options → Interactive Buttons
 *   - 4–10 options → Interactive List (single section)
 * Otherwise → plain text message.
 *
 * Splits long plain-text messages into chunks of 4096 chars max.
 */
export async function sendAgentReply(to: string, agentText: string): Promise<void> {
  const { cleanText, options } = parseOptions(agentText);

  if (options && options.length > 0) {
    if (options.length <= 3) {
      // WhatsApp supports max 3 interactive buttons
      const buttons = options.slice(0, 3).map((o) => ({
        id: o.id,
        title: o.title.slice(0, 20), // Max 20 chars per button title
      }));
      await sendWhatsAppInteractiveButtons(to, cleanText, buttons);
    } else {
      // Use list message for 4+ options
      const rows = options.slice(0, 10).map((o) => ({
        id: o.id,
        title: o.title.slice(0, 24), // Max 24 chars per row title
        description: (o as ListOption).description?.slice(0, 72),
      }));
      const sections: ListSection[] = [{ title: "Options", rows }];
      await sendWhatsAppList(to, cleanText, "Choose an option", sections);
    }
  } else {
    // Plain text — chunk if necessary (WhatsApp limit: 4096 chars)
    const MAX_LEN = 4096;
    if (cleanText.length <= MAX_LEN) {
      await sendWhatsAppText(to, cleanText);
    } else {
      const chunks: string[] = [];
      for (let i = 0; i < cleanText.length; i += MAX_LEN) {
        chunks.push(cleanText.slice(i, i + MAX_LEN));
      }
      for (const chunk of chunks) {
        await sendWhatsAppText(to, chunk);
      }
    }
  }
}
