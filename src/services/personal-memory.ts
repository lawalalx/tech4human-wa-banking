import { generateText } from "ai";
import { z } from "zod";
import { getChatModel } from "../mastra/core/llm/provider.js";

const personalMemorySchema = z.object({
  intent: z.enum(["none", "save_profile", "recall_profile"]).default("none"),
  name: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
});

export type PersonalMemoryTurn = z.infer<typeof personalMemorySchema>;

function safeParsePersonalMemoryTurn(text: string): PersonalMemoryTurn {
  const candidates: string[] = [text];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = personalMemorySchema.safeParse(JSON.parse(candidate.trim()));
      if (parsed.success) return parsed.data;
    } catch {
      // Try next candidate.
    }
  }

  return { intent: "none" };
}

export async function analyzePersonalMemoryTurn(message: string): Promise<PersonalMemoryTurn> {
  try {
    const result = await generateText({
      model: getChatModel(),
      prompt:
        "Return ONLY compact JSON with keys: intent, name, location. " +
        "intent must be one of: none, save_profile, recall_profile. " +
        "Use save_profile when the customer shares personal profile facts about themselves (for example name or where they are from). " +
        "Use recall_profile when the customer asks what personal details you remember about them. " +
        "Use none for all other intents. " +
        "Set name/location when explicitly stated in the customer message; otherwise null. " +
        "No markdown, no prose, JSON only.\n\n" +
        `Customer message: ${message}`,
    });

    return safeParsePersonalMemoryTurn(result.text);
  } catch {
    return { intent: "none" };
  }
}

export function renderProfileMemoryReply(params: { name?: string | null; location?: string | null }): string {
  const name = String(params.name || "").trim();
  const location = String(params.location || "").trim();

  if (name && location) {
    return `Your name is ${name}, and you are from ${location}.`;
  }
  if (name) {
    return `Your name is ${name}.`;
  }
  if (location) {
    return `You told me you are from ${location}.`;
  }
  return "I do not have your profile details yet. You can share your name and where you are from.";
}
