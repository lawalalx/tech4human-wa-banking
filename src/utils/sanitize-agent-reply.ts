/**
 * Removes internal routing artifacts from user-facing assistant replies.
 */
export function sanitizeAgentReply(input: unknown): string {
  if (input == null) return "";

  let text = "";
  if (typeof input === "string") {
    text = input;
  } else if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
    text = String(input);
  } else if (Array.isArray(input)) {
    text = input
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
  } else if (typeof input === "object") {
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.text === "string") {
      text = candidate.text;
    } else if (typeof candidate.content === "string") {
      text = candidate.content;
    } else {
      text = JSON.stringify(input);
    }
  } else {
    text = String(input);
  }

  if (!text) return "";

  let clean = text.replace(/\r\n/g, "\n");

  // Normalize common mojibake artifacts from mixed encodings in replies.
  const mojibakeReplacements: Array<[RegExp, string]> = [
    [/â‚¦/g, "NGN "],
    [/â€¢/g, "-"],
    [/â€”/g, "-"],
    [/âŒ/g, "ERROR:"],
    [/ðŸ”/g, "PIN:"],
    [/ðŸ”’/g, "LOCKED:"],
    [/ðŸ“²/g, "OTP:"],
    [/ðŸ”´/g, "Debit"],
    [/ðŸŸ¢/g, "Credit"],
    [/ðŸ’°/g, "Balance"],
    [/ðŸ¦/g, "Account"],
    [/ðŸ“‚/g, "Type"],
    [/ðŸ’µ/g, "Amount"],
    [/ðŸŒ/g, "Currency"],
    [/ðŸ•’/g, "Time"],
  ];
  for (const [pattern, replacement] of mojibakeReplacements) {
    clean = clean.replace(pattern, replacement);
  }

  // If mojibake markers remain, strip non-ASCII bytes to avoid garbled output.
  if (/[ðâ]/.test(clean)) {
    clean = clean.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  }

  // Recover malformed PIN prompts that leak serialized fragments.
  if (/^'?\+?\d{7,}.*\}\s*$/i.test(clean)) {
    clean = "Please enter your 4-digit transaction PIN to continue.";
  }

  // Remove whole lines that leak internal delegation phone context.
  clean = clean.replace(/^[ \t]*Customer phone:\s*\+?\d[\d\s-]{6,20}[^\n]*\n?/gim, "");

  // Remove inline occurrences if they appear in the middle of a sentence.
  clean = clean.replace(/Customer phone:\s*\+?\d[\d\s-]{6,20}\.?\s*/gi, "");

  // Keep formatting neat after removals.
  clean = clean.replace(/^Customer not found\.?$/i, "Your phone number is not registered with First Bank Nigeria. Please visit any First Bank branch or dial *894# to link your WhatsApp number.");
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

  return clean;
}
