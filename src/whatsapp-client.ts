import "dotenv/config";

const getConfig = () => {
  const apiVersion = process.env.WHATSAPP_API_VERSION || "v22.0";
  const phoneNumberId = process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error("Missing WHATSAPP_BUSINESS_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN");
  }
  return {
    url: `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  };
};

async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> {
  const { url, headers } = getConfig();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = await res.text().catch(() => null);
  }
  if (!res.ok) {
    console.error("WhatsApp API error:", res.status, data);
  }
  return { ok: res.ok, data };
}

export async function sendWhatsAppText(to: string, body: string): Promise<boolean> {
  const { ok } = await post({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body, preview_url: false },
  });
  return ok;
}

/**
 * Sends an actual WhatsApp typing indicator (animated dots visible to the recipient).
 * Marks the message as read AND sends `typing_indicator` so WhatsApp shows the "typing…" bubble.
 */
export async function sendWhatsAppTyping(to: string, messageId: string): Promise<void> {
  const { url, headers } = getConfig();
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }),
  }).catch(() => {});
}

export async function markAsRead(messageId: string): Promise<void> {
  const { url, headers } = getConfig();
  await fetch(url.replace("/messages", `/${messageId}/read`), {
    method: "POST",
    headers,
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read" }),
  }).catch(() => {});
}

export async function sendWhatsAppInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
): Promise<boolean> {
  const { ok } = await post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.substring(0, 20) },
        })),
      },
    },
  });
  return ok;
}

export async function sendWhatsAppList(
  to: string,
  bodyText: string,
  buttonText: string,
  sections: {
    title: string;
    rows: { id: string; title: string; description?: string }[];
  }[]
): Promise<boolean> {
  const { ok } = await post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonText,
        sections,
      },
    },
  });
  return ok;
}

export async function sendWhatsAppImage(to: string, imageUrl: string, caption?: string): Promise<boolean> {
  const { ok } = await post({
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,
      ...(caption ? { caption } : {}),
    },
  });
  return ok;
}
