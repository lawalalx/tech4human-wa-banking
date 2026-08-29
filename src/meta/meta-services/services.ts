/**
 * metaFlowApi.ts
 *
 * Meta WhatsApp Cloud API helpers for creating, managing, and sending Flows.
 * https://developers.facebook.com/docs/whatsapp/flows
 */
import fetch from 'node-fetch';
import fs from 'fs';
import FormData from 'form-data';
import { Pool } from "pg";
import { normalizePhone } from "@/utils/format-phone";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });


const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";
const META_GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

function authHeader() {
  return { Authorization: `Bearer ${ACCESS_TOKEN}` };
}

// ─── Flow Management ──────────────────────────────────────────────────────────

/** Create a new (empty) Meta Flow under the business account */
export async function createMetaFlow(
  flowName: string,
  categories: string[] = ['SURVEY'],
): Promise<string> {
  const url = `${META_GRAPH_URL}/${WHATSAPP_BUSINESS_ACCOUNT_ID}/flows`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: flowName, categories }),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Meta Flow creation failed: ${JSON.stringify(err)}`);
  }
  const data = await res.json() as any;
  return data.id as string;
}

/** Upload Flow JSON from a file path */
export async function uploadFlowJson(flowId: string, jsonPath: string): Promise<any> {
  const graphAssetsUrl = `${META_GRAPH_URL}/${flowId}/assets`;
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', fs.createReadStream(jsonPath), 'survey.json');
  const res = await fetch(graphAssetsUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload flow.json failed: ${res.statusText}`);
  return await res.json() as any;
}

/** Upload Flow JSON from an in-memory Buffer (no temp file needed) */
export async function uploadFlowJsonBuffer(flowId: string, jsonBuffer: Buffer): Promise<any> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${flowId}/assets`;

  const form = new FormData();

  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');

  // ✅ CRITICAL FIX
  form.append('file', jsonBuffer, {
    filename: 'flow.json',
    contentType: 'application/json'
  });

  const res = await fetch(url, {
    method: 'POST',

    // ✅ CRITICAL FIX — include form headers
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...form.getHeaders()
    },

    body: form
  });

  const data = await res.json();
  console.log("✅ UPLOAD RESPONSE:", data);

  if (!res.ok) {
    throw new Error(`Upload failed: ${JSON.stringify(data)}`);
  }

  return data;
}



export async function publishFlow(flowId: string): Promise<any> {
  const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';
  const endpointUrl = `${process.env.SERVER_URL}/webhook/meta-flow-data`;

  console.log("Setting endpoint_uri:", endpointUrl);

  // STEP 1: Update Flow
  const updateRes = await fetch(`${META_GRAPH_URL}/${flowId}`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      endpoint_uri: endpointUrl,
    }),
  });

  const updateData = await updateRes.json();
  console.log("Update response:", updateData);

  if (!updateRes.ok) {
    throw new Error(`Pre-publish update failed: ${JSON.stringify(updateData)}`);
  }


  // 🛑 CRITICAL: Wait for Meta to propagate the URI change
  console.log("⏳ Waiting 5 seconds for endpoint propagation...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  //  STEP 1.5 — VERIFY WHAT META STORED
  const verifyRes = await fetch(`${META_GRAPH_URL}/${flowId}`, {
    method: 'GET',
    headers: authHeader(),
  });

  const verifyData = await verifyRes.json();
  console.log("Flow after update:", verifyData);

  // STEP 2: Publish
  const res = await fetch(`${META_GRAPH_URL}/${flowId}/publish`, {
    method: 'POST',
    headers: authHeader(),
  });

  const data = await res.json();
  console.log("Publish response:", data);

  if (!res.ok) {
    throw new Error(`Publish flow failed: ${JSON.stringify(data)}`);
  }

  return data;
}



/** Deprecate a published Flow (soft-delete; responses already collected are kept) */
export async function deprecateFlow(flowId: string): Promise<any> {
  const url = `${META_GRAPH_URL}/${flowId}/deprecate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader(),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Deprecate flow failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

/** Hard-delete a Flow (only works on DRAFT flows that were never published) */
export async function deleteFlow(flowId: string): Promise<any> {
  const url = `${META_GRAPH_URL}/${flowId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: authHeader(),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Delete flow failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

/** Get details of a single Flow including validation errors */
export async function getFlow(flowId: string): Promise<any> {
  const url = `${META_GRAPH_URL}/${flowId}?fields=id,name,status,categories,validation_errors,preview.fields(preview_url,expires_at)`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Get flow failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

/** List all Flows for the WhatsApp Business Account */
export async function listFlows(): Promise<any> {
  const url = `${META_GRAPH_URL}/${WHATSAPP_BUSINESS_ACCOUNT_ID}/flows?fields=id,name,status,categories,preview.fields(preview_url,expires_at)`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`List flows failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}



// ─── Sending Flows ────────────────────────────────────────────────────────────

/**
 * Sends an interactive WhatsApp Flow message to a customer.
 * The customer will see a CTA button that opens the Flow inside WhatsApp.
 *
 * @param to           Recipient phone in E.164 format without '+' (e.g. "2349013360717")
 * @param flowId       Meta Flow ID (returned by createMetaFlow)
 * @param flowToken    Unique token for this session (used to correlate the submission)
 * @param cta          CTA button label (max 20 chars), e.g. "Take Survey"
 * @param headerText   Optional header text shown above the message body
 * @param bodyText     Message body text shown to the user
 * @param footerText   Optional footer text
 * @param phoneNumberId  WhatsApp phone number ID (defaults to env var)
 * @param initialScreen: The initial screen to load
 */
export async function sendFlowMessage(params: {
  to: string;
  flowId: string;
  flowToken: string;
  cta: string;
  headerText?: string;
  bodyText?: string;
  footerText?: string;
  flowMode?: 'draft' | 'published';
  phoneNumberId?: string;
  initialScreen?: string;
}): Promise<any> {
  const pid = params.phoneNumberId || PHONE_NUMBER_ID;
  const url = `${META_GRAPH_URL}/${pid}/messages`;
  const initialScreen = params.initialScreen || 'INTRO';

  const interactive: any = {
    type: 'flow',
    body: { text: params.bodyText || 'Kindly fill and complete the form' },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_token: params.flowToken,
        flow_id: params.flowId,
        ...(params.flowMode ? { mode: params.flowMode } : {}),
        flow_cta: params.cta.substring(0, 20),
        flow_action: 'navigate',
        flow_action_payload: { screen: initialScreen },
      },
    },
  };

  if (params.headerText) {
    interactive.header = { type: 'text', text: params.headerText.substring(0, 60) };
  }
  if (params.footerText) {
    interactive.footer = { text: params.footerText.substring(0, 60) };
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.to,
    type: 'interactive',
    interactive,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json() as any;
    // throw new Error(`Send flow message failed: ${JSON.stringify(err)}`);
    return false
  }
  const result = await res.json();
  console.log(`\n\nThis is the result from sendFlowMessage function: ${JSON.stringify(result, null, 2)}`);
  return true
}






export interface TokenMapRow {
  flow_token: string;
  flow_id: string;
  customer_phone: string | null;
  survey_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowResponseRow {
  id: string;
  flow_id: string;
  flow_token: string;
  customer_phone: string | null;
  responses: Record<string, any>;
  source: "data_exchange" | "nfm_reply";
  created_at: string;
}

/**
 * Upsert a token → phone mapping.
 * Called right after `sendFlowMessage` so the webhook can resolve the sender
 * when the customer submits the flow.
 */
export async function upsertMetaFlowTokenMap(params: {
  flowToken: string;
  flowId: string;
  surveyId?: string;
  customerPhone?: string;
}): Promise<void> {
  const { flowToken, flowId, surveyId, customerPhone } = params;
  const sql = `
    INSERT INTO meta_flow_token_maps (flow_token, flow_id, survey_id, customer_phone, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (flow_token) DO UPDATE SET
      flow_id       = EXCLUDED.flow_id,
      survey_id     = EXCLUDED.survey_id,
      customer_phone = EXCLUDED.customer_phone,
      updated_at     = NOW()
  `;
  const values = [flowToken, flowId, surveyId ?? null, customerPhone ?? null];
  const client = await pool.connect();
  try {
    await client.query(sql, values);
  } finally {
    client.release();
  }
}

/**
 * Resolve a flow_token to its customer phone (digits only).
 */
export async function getPhoneByFlowToken(flowToken: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT customer_phone FROM meta_flow_token_maps WHERE flow_token = $1 LIMIT 1`,
      [flowToken]
    );
    if (!result.rows?.length) return null;
    const phone = result.rows[0]?.customer_phone;
    return phone ? normalizePhone(String(phone)) : null;
  } finally {
    client.release();
  }
}

/**
 * Resolve a flow_token to its full token-map row (flow_id + survey_id + phone).
 * Used to classify WHICH flow completed when the nfm_reply event arrives.
 */
export async function getTokenMap(flowToken: string): Promise<TokenMapRow | null> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT flow_token, flow_id, survey_id, customer_phone, created_at, updated_at
         FROM meta_flow_token_maps
        WHERE flow_token = $1
        LIMIT 1`,
      [flowToken]
    );
    return result.rows?.[0] ?? null;
  } finally {
    client.release();
  }
}

/**
 * Look up the most recent complete submission for a given flow + phone.
 * Returns the parsed `responses` JSON or `null` if none found.
 */
export async function getLatestFlowResponses(params: {
  flowId: string;
  customerPhone: string;
  reuseWindowSeconds?: number;
}): Promise<Record<string, any> | null> {
  const { flowId, customerPhone, reuseWindowSeconds = 300 } = params;
  const normalizedPhone = normalizePhone(String(customerPhone));
  const windowMs = reuseWindowSeconds * 1000;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT responses, created_at
         FROM meta_flow_responses
        WHERE flow_id = $1
          AND source = 'data_exchange'
          AND regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [flowId, normalizedPhone]
    );
    if (!result.rows?.length) return null;

    const row = result.rows[0];
    const createdAt = row?.created_at ? new Date(row.created_at).getTime() : NaN;
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > windowMs) return null;

    const responses = row.responses;
    return typeof responses === "string" ? JSON.parse(responses) : responses;
  } finally {
    client.release();
  }
}

/**
 * Persist a completed flow submission.
 * Called from the `/webhook/meta-flow-data` endpoint on `submit_form`.
 */
export async function saveFlowResponse(params: {
  flowId: string;
  flowToken: string;
  customerPhone?: string;
  surveyId?: string;
  responses: Record<string, any>;
  source?: "data_exchange" | "nfm_reply";
}): Promise<void> {
  const {
    flowId,
    flowToken,
    customerPhone,
    surveyId,
    responses,
    source = "data_exchange",
  } = params;

  const sql = `
    INSERT INTO meta_flow_responses
      (flow_id, flow_token, customer_phone, survey_id, responses, source, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `;
  const values = [
    flowId,
    flowToken,
    customerPhone ?? null,
    surveyId ?? null,
    JSON.stringify(responses),
    source,
  ];
  const client = await pool.connect();
  try {
    await client.query(sql, values);
  } finally {
    client.release();
  }
}
