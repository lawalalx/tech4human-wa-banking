/**
 * Banking MCP Client
 *
 * Connects to the mcp_service_fb Python FastMCP server (SSE transport).
 * The server exposes real banking tools: customer lookup, balance, transfers,
 * PIN management, transaction history, bill payment, receipts, etc.
 */
import { MCPClient } from "@mastra/mcp";
import { getRequestContextPhone } from "../../../utils/request-context.js";

const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL;

if (!MCP_SERVICE_URL) {
  throw new Error("MCP_SERVICE_URL environment variable is not set. Please set it to the URL of the MCP server (e.g. http://localhost:3001/sse)");
}

export const bankingMcpClient = new MCPClient({
  servers: {
    firstbank: {
      url: new URL(MCP_SERVICE_URL),
    },
  },
});

let _toolsets: Record<string, Record<string, any>> | null = null;

export async function getBankingMcpToolsets(): Promise<Record<string, Record<string, any>>> {
  if (_toolsets !== null) return _toolsets;
  try {
    _toolsets = await bankingMcpClient.listToolsets();
    const toolCount = Object.values(_toolsets).reduce((n, t) => n + Object.keys(t).length, 0);
    console.log(`[BankingMCP] Connected to ${MCP_SERVICE_URL} - ${toolCount} tools loaded`);
  } catch (err) {
    console.warn(
      "[BankingMCP] MCP server not reachable - agents will use built-in tools only.",
      err instanceof Error ? err.message : err
    );
    _toolsets = {};
  }
  return _toolsets;
}

export function invalidateMcpCache(): void {
  _toolsets = null;
}

function sanitizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const placeholderPattern = /^(contextphone|\{\{\s*contextphone\s*\}\}|phone_from_context|customer_phone)$/i;
  const phoneKeys = new Set(["phone", "phone_number", "customer_phone", "whatsapp_phone"]);
  const contextPhone = getRequestContextPhone();

  const out: Record<string, unknown> = { ...args };
  for (const [key, rawValue] of Object.entries(out)) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    const keyLc = String(key).toLowerCase();

    if (phoneKeys.has(keyLc) && placeholderPattern.test(value)) {
      if (contextPhone) {
        out[key] = contextPhone;
      } else {
        throw new Error(
          `[BankingMCP] Unresolved phone placeholder for '${toolName}.${key}'. Ensure request context includes the customer phone.`
        );
      }
      continue;
    }

    if (phoneKeys.has(keyLc)) {
      out[key] = value;
    }
  }

  return out;
}

export async function callBankingTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  const safeArgs = sanitizeToolArgs(toolName, args || {});
  const toolsets = await getBankingMcpToolsets();
  const serverTools = toolsets["firstbank"];

  console.log(`\n[BankingMCP] Calling tool '${toolName}' with args:`, safeArgs);

  if (!serverTools) {
    throw new Error('[BankingMCP] Server "firstbank" not found in toolsets - is mcp_service_fb running?');
  }

  const tool = serverTools[toolName];
  if (!tool) {
    throw new Error(`[BankingMCP] Tool '${toolName}' not found. Available: ${Object.keys(serverTools).join(", ")}`);
  }

  const result = await (tool as any).execute(safeArgs, {});
  return result as T;
}
