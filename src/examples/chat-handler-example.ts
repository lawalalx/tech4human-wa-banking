// @ts-nocheck
/**
 * Example: Refactored Chat Handler with Context Engineering
 * 
 * This shows how to integrate the new context engineering framework
 * into your existing supervisor (chat-handler.ts)
 * 
 * NOT production code - shows integration patterns
 */

import { stateManager, contextEngine, stateInspector } from "../core/index.js";
import { transactionWorkflow } from "../mastra/workflows/transaction-workflow.js";
import { sendAgentReply } from "../utils/send-agent-reply.js";
import { maskPhone } from "../utils/format-phone.js";

// ─────────────────────────────────────────────────────────────────────────
// CHAT HANDLER WITH CONTEXT ENGINEERING
// ─────────────────────────────────────────────────────────────────────────

export async function handleIncomingMessageRefactored(message: any): Promise<void> {
  const rawPhone = message.from;
  const phone = maskPhone(rawPhone);
  const messageId = message.id;
  const userText = extractMessageText(message);

  console.log(`[ChatHandler] Incoming from ${phone}: "${userText.slice(0, 80)}"`);

  try {
    // ─────────────────────────────────────────────────────────────────
    // 1. LOAD OR CREATE AGENT STATE
    // ─────────────────────────────────────────────────────────────────
    let state = await stateManager.getOrCreateState(rawPhone);
    
    // ─────────────────────────────────────────────────────────────────
    // 2. RECORD MESSAGE IN STATE
    // ─────────────────────────────────────────────────────────────────
    state = await stateManager.processMessage(state, userText);
    
    // Log for inspection
    stateInspector.logStateEvent(state, "message_processed");

    // ─────────────────────────────────────────────────────────────────
    // 3. EXTRACT CONTEXT FOR SUPERVISOR ROUTING DECISION
    // ─────────────────────────────────────────────────────────────────
    const context = stateManager.extractContext(state, 6000); // Leave room for response
    
    console.log(`[Context] Strategy: ${context.compressionStrategy}`);
    console.log(`[Context] Tools: ${context.relevantTools.join(", ")}`);

    // ─────────────────────────────────────────────────────────────────
    // 4. SUPERVISOR ROUTING LOGIC (ENHANCED WITH CONTEXT)
    // ─────────────────────────────────────────────────────────────────
    
    // Option A: Check if there's a pending goal to resume
    const currentGoal = state.session.currentGoal;
    if (currentGoal && !isEndCommand(userText)) {
      console.log(`[Supervisor] Resuming: ${currentGoal.action} (${currentGoal.status})`);
      
      // Route to appropriate subagent based on goal
      const result = await routeToSubagent(state, userText, context);
      
      if (result.handled) {
        state = await stateManager.recordResponse(state, result.reply);
        await sendAgentReply(rawPhone, result.reply);
        await stateManager.saveState(state);
        return;
      }
    }

    // Option B: Fresh request - analyze intent and create new goal
    if (!currentGoal) {
      const intentResult = await detectIntent(userText, context);
      console.log(`[Intent] Detected: ${intentResult.intent} (confidence: ${intentResult.confidence})`);
      
      // Record intent detection in ephemeral state
      state.ephemeral = {
        currentMessage: userText,
        detectedIntent: intentResult.intent as any,
        intentConfidence: intentResult.confidence,
        messageTimestamp: new Date().toISOString(),
      };

      // Route based on intent
      if (intentResult.intent !== "unknown" && intentResult.intent !== "greeting") {
        // Create goal for this transaction
        state = await stateManager.createGoal(
          state,
          intentResult.intent,
          `User initiated ${intentResult.intent}`,
          getTaskStepsForIntent(intentResult.intent)
        );

        console.log(`[Goal] Created: ${state.session.currentGoal?.action}`);
        
        // Route to subagent
        const result = await routeToSubagent(state, userText, context);
        
        if (result.handled) {
          state = await stateManager.recordResponse(state, result.reply);
          await sendAgentReply(rawPhone, result.reply);
          await stateManager.saveState(state);
          return;
        }
      }
    }

    // Handle greetings and unknown intents
    if (isGreetingOnly(userText)) {
      const mainMenuReply = buildMainMenu();
      state = await stateManager.recordResponse(state, mainMenuReply);
      await sendAgentReply(rawPhone, mainMenuReply);
      await stateManager.saveState(state);
      return;
    }

    // Fallback: Route to insights or supervisor
    const supervisorResult = await supervisorFallback(state, userText, context);
    state = await stateManager.recordResponse(state, supervisorResult);
    await sendAgentReply(rawPhone, supervisorResult);
    await stateManager.saveState(state);

  } catch (error) {
    console.error(`[Error] Processing message for ${phone}:`, error);
    stateInspector.logStateEvent(state, "error_occurred", undefined, String(error));
    
    await sendAgentReply(rawPhone, "An error occurred. Please try again.");
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ROUTING LOGIC
// ─────────────────────────────────────────────────────────────────────────

async function routeToSubagent(
  state: any,
  message: string,
  context: any
): Promise<{ handled: boolean; reply: string }> {
  const goal = state.session.currentGoal;
  
  if (!goal) {
    return { handled: false, reply: "" };
  }

  // Route transaction goals to transaction workflow
  if (["balance", "mini_statement", "transfer", "bill_payment"].includes(goal.action)) {
    try {
      const run = await transactionWorkflow.createRun();
      const wf = await run.start({
        inputData: {
          phone: state.session.phone,
          action: goal.action,
          message,
          // Pass full state context to workflow
          agentState: state,
          extractedContext: context,
        },
      });

      if (wf.status === "success" && wf.result.handled) {
        // Update state with workflow results
        if (wf.result.stateUpdates) {
          Object.assign(state.session.workingMemory, wf.result.stateUpdates);
        }
        
        // Record tool usage if applicable
        if (wf.result.toolsUsed) {
          for (const tool of wf.result.toolsUsed) {
            await stateManager.recordToolCall(state, tool, wf.result.toolResults?.[tool]);
          }
        }

        // Update goal status if changed
        if (wf.result.goalStatus) {
          await stateManager.updateGoalStatus(state, wf.result.goalStatus);
          
          if (wf.result.goalStatus === "completed") {
            await stateManager.completeGoal(state);
          }
        }

        return {
          handled: true,
          reply: wf.result.reply,
        };
      }
    } catch (error) {
      console.error("[Subagent] Transaction workflow error:", error);
      stateInspector.logStateEvent(state, "subagent_error", undefined, String(error));
    }
  }

  return { handled: false, reply: "" };
}

// ─────────────────────────────────────────────────────────────────────────
// INTENT DETECTION (CONTEXT-AWARE)
// ─────────────────────────────────────────────────────────────────────────

async function detectIntent(
  message: string,
  context: any
): Promise<{ intent: string; confidence: number }> {
  // Could use LLM here with context.systemPrompt as guidance
  // For now, simple pattern matching
  
  const text = message.toLowerCase();
  
  const patterns: Record<string, RegExp> = {
    balance: /\b(balance|account balance|how much|available)\b/,
    mini_statement: /\b(statement|history|recent|transactions|last\s+\d+)\b/,
    transfer: /\b(transfer|send|pay|bank|recipient|account)\b/,
    bill_payment: /\b(bill|payment|airtime|data|electricity|water)\b/,
    greeting: /^(hi+|hello|hey|yo|start|menu|help)\b/,
  };

  for (const [intent, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) {
      return { intent, confidence: 0.8 };
    }
  }

  return { intent: "unknown", confidence: 0 };
}

// ─────────────────────────────────────────────────────────────────────────
// TASK PLANNING
// ─────────────────────────────────────────────────────────────────────────

function getTaskStepsForIntent(intent: string): string[] {
  const steps: Record<string, string[]> = {
    balance: [
      "Verify PIN if required",
      "Fetch balance from backend",
      "Format and present balance",
    ],
    mini_statement: [
      "Verify PIN if required",
      "Fetch recent transactions",
      "Format transaction list",
      "Present to customer",
    ],
    transfer: [
      "Collect amount",
      "Collect recipient account number",
      "Collect description (optional)",
      "Confirm details with customer",
      "Verify recipient exists",
      "Verify PIN",
      "Send OTP",
      "Verify OTP",
      "Execute transfer",
      "Generate receipt",
    ],
    bill_payment: [
      "Collect biller name",
      "Collect bill reference number",
      "Collect amount",
      "Validate biller",
      "Confirm details",
      "Verify PIN",
      "Send OTP",
      "Verify OTP",
      "Execute payment",
      "Generate receipt",
    ],
  };

  return steps[intent] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────

function extractMessageText(message: any): string {
  if (message.type === "text") {
    return message.text?.body || "";
  }
  if (message.type === "interactive") {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    return reply?.title || reply?.id || "";
  }
  return `[${message.type} received]`;
}

function isEndCommand(text: string): boolean {
  return /^end$/i.test(text.trim());
}

function isGreetingOnly(text: string): boolean {
  const greetingPattern = /^(hi+|hello+|hey+|yo+|sup+|howdy|good\s+(morning|afternoon|evening)|start|menu|help)[!.?,\s]*$/i;
  return greetingPattern.test(text.trim());
}

function buildMainMenu(): string {
  return (
    `👋 Welcome to *FirstBank* WhatsApp Banking!\n\n` +
    `I'm FirstBot. Here's what I can help you with today:\n\n` +
    `[1] *Account & Transactions* — balance, transfers, bill payments\n` +
    `[2] *Onboarding & KYC* — open account, verify identity\n` +
    `[3] *Support & Help* — FAQs, complaints\n\n` +
    `Just type what you need, or reply with a number.`
  );
}

async function supervisorFallback(
  state: any,
  message: string,
  context: any
): Promise<string> {
  // Route to supervisor agent for complex reasoning
  // Could use LLM with context.systemPrompt
  
  return "I'm not sure what you're asking. Could you tell me more? I can help with balance, transfers, and bill payments.";
}

// ─────────────────────────────────────────────────────────────────────────
// ANALYTICS / MONITORING
// ─────────────────────────────────────────────────────────────────────────

export function getAgentMetrics(): any {
  const stats = stateInspector.getUsageStatistics();
  
  return {
    customersTracked: stats.customersTracked,
    totalInteractions: stats.totalEvents,
    averageInteractionsPerCustomer: stats.averageLogsPerCustomer,
    eventTypeBreakdown: stats.eventTypeDistribution,
    timestamp: new Date().toISOString(),
  };
}

export function getCustomerDebugInfo(phone: string): string {
  return stateInspector.generateDebugReport(phone);
}
