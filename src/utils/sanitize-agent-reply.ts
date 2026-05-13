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

  // Remove whole lines that leak internal delegation phone context.
  clean = clean.replace(/^[ \t]*Customer phone:\s*\+?\d[\d\s-]{6,20}[^\n]*\n?/gim, "");

  // Remove inline occurrences if they appear in the middle of a sentence.
  clean = clean.replace(/Customer phone:\s*\+?\d[\d\s-]{6,20}\.?\s*/gi, "");

  // Keep formatting neat after removals.
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

  return clean;
}
