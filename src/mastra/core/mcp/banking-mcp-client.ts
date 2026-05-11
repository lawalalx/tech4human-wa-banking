/**
 * Banking MCP Client
 *
 * Connects to the mcp_service_fb Python FastMCP server (SSE transport).
 * The server exposes real banking tools: customer lookup, balance, transfers,
 * PIN management, transaction history, bill payment, receipts, etc.
 *
 * Usage pattern (runtime injection into agent.generate):
 *   import { getBankingMcpToolsets } from "../core/mcp/banking-mcp-client.js";
 *   const toolsets = await getBankingMcpToolsets();
 *   const response = await agent.generate(messages, { memory: {...}, toolsets });
 *
 * The server must be running: uvicorn server:app --port 3001 (from mcp_service_fb/)
 */
import { MCPClient } from "@mastra/mcp";

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

// Cached toolsets — fetched on first call, reused afterwards.
let _toolsets: Record<string, Record<string, any>> | null = null;

/**
 * Returns Mastra toolsets from the MCP server, keyed by server name.
 * Caches on first successful load.
 * Returns {} gracefully if the MCP server is not reachable.
 */
export async function getBankingMcpToolsets(): Promise<Record<string, Record<string, any>>> {
  if (_toolsets !== null) return _toolsets;
  try {
    _toolsets = await bankingMcpClient.listToolsets();
    const toolCount = Object.values(_toolsets!).reduce((n, t) => n + Object.keys(t).length, 0);
    console.log(`[BankingMCP] Connected to ${MCP_SERVICE_URL} — ${toolCount} tools loaded`);
  } catch (err) {
    console.warn("[BankingMCP] MCP server not reachable — agents will use built-in tools only.", err instanceof Error ? err.message : err);
    _toolsets = {};
  }
  return _toolsets!;
}

/**
 * Force-refresh the cached toolsets (useful after MCP server restarts).
 */
export function invalidateMcpCache(): void {
  _toolsets = null;
}

/**
 * Call a single MCP tool programmatically from TypeScript code (e.g. from within
 * another Mastra tool's execute function).
 *
 * This is used by transaction-tools.ts and insights-tools.ts so that sub-agents
 * always use real MCP data rather than the mock core-banking.ts functions.
 *
 * Usage:
 *   const result = await callBankingTool<{ found: boolean; customer_id?: number }>(
 *     "lookup_customer_by_phone", { phone_number: "2348012345678" }
 *   );
 */
export async function callBankingTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  const toolsets = await getBankingMcpToolsets();
  const serverTools = toolsets["firstbank"];

  console.log(`\n[BankingMCP] Calling tool '${toolName}' with args:`, args);
  
  if (!serverTools) {
    throw new Error('[BankingMCP] Server "firstbank" not found in toolsets — is mcp_service_fb running?');
  }
  const tool = serverTools[toolName];
  if (!tool) {
    throw new Error(`[BankingMCP] Tool '${toolName}' not found. Available: ${Object.keys(serverTools).join(", ")}`);
  }
  // Mastra tool execute(input, context) — context is optional
  const result = await (tool as any).execute(args, {});
  return result as T;
}
