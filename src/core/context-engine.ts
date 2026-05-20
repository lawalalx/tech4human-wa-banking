/**
 * Context Engine - Extracts and optimizes context for LLM
 * 
 * Handles:
 * - Dynamic context extraction based on goal/state
 * - Token budget management
 * - Context compression/summarization
 * - System prompt generation
 * - Relevance ranking
 */

import { AgentState, extractConversationContext, buildContextSummary, getRelevantTools } from "./agent-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT COMPRESSION STRATEGIES
// ─────────────────────────────────────────────────────────────────────────────

export type CompressionStrategy = "full" | "summary" | "focused" | "minimal";

export interface ContextBudget {
  /** Total tokens available for context */
  totalTokens: number;
  /** Estimated tokens already used by model instruction */
  modelInstructionTokens: number;
  /** Available tokens for context */
  availableTokens: number;
}

export interface ExtractedContext {
  systemPrompt: string;
  userContext: string;
  conversationHistory: Array<{ role: string; content: string }>;
  relevantTools: string[];
  estimatedTokens: number;
  compressionStrategy: CompressionStrategy;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export class ContextEngine {
  private readonly tokensPerCharacter = 0.25; // Rough estimate: 1 token ≈ 4 characters
  private readonly systemPromptTokens = 500; // Typical system prompt overhead

  /**
   * Extract relevant context from agent state based on current goal
   */
  extractContext(
    state: AgentState,
    budget: ContextBudget,
    strategy?: CompressionStrategy
  ): ExtractedContext {
    const goal = state.session.currentGoal;
    const phase = goal?.status ?? "idle";
    
    // Choose strategy based on phase if not specified
    if (!strategy) {
      strategy = this.selectStrategy(phase, budget);
    }
    
    const systemPrompt = this.buildSystemPrompt(state, goal?.action);
    const userContext = this.buildUserContext(state, strategy);
    const conversationHistory = this.selectConversationHistory(state, strategy, budget);
    const relevantTools = getRelevantTools(state);
    
    // Estimate tokens
    const estimatedTokens = this.estimateTokens(systemPrompt, userContext, conversationHistory);
    
    return {
      systemPrompt,
      userContext,
      conversationHistory,
      relevantTools,
      estimatedTokens,
      compressionStrategy: strategy,
    };
  }

  /**
   * Build a role-based system prompt tailored to current context
   */
  private buildSystemPrompt(state: AgentState, action?: string): string {
    const basePrompt = `You are FirstBot, a friendly and helpful WhatsApp banking assistant for FirstBank Nigeria.

Your core responsibilities:
1. Help customers with banking transactions (balance, transfers, bill payments, statements)
2. Verify customer identity and security (KYC, PINs, OTPs)
3. Provide clear, conversational guidance without internal jargon
4. Handle errors gracefully and offer solutions
5. Always prioritize security and confirmation for money movements

Communication style:
- Be conversational and human-like, not robotic
- Use simple language and avoid technical banking jargon
- Show empathy and understanding
- Confirm important details before proceeding
- Keep responses concise (2-3 sentences typically)
- Use WhatsApp-friendly formatting (emojis, line breaks)`;

    // Add phase-specific guidance
    const phaseGuidance = this.getPhaseGuidance(action);
    return `${basePrompt}\n\n${phaseGuidance}`;
  }

  /**
   * Get phase-specific guidance for current goal
   */
  private getPhaseGuidance(action?: string): string {
    const guidance: Record<string, string> = {
      balance: `Customer is checking their account balance.
- Confirm we have their PIN if required
- Provide a clear summary: Account type, available balance, currency, timestamp
- Be concise and accurate`,

      mini_statement: `Customer is checking recent transactions.
- Format transactions clearly with date, type (debit/credit), amount, and description
- Sort most recent first
- Limit to requested number (default 10)
- Allow filtering by keyword if requested`,

      transfer: `Customer is initiating a fund transfer.
- Collect: amount, recipient account number, optional description
- Show collected info back for confirmation before proceeding
- Confirm recipient exists and show their name
- Guide through PIN and OTP verification
- Show final receipt`,

      bill_payment: `Customer is paying a bill.
- Collect: biller name, amount, reference number (meter/smartcard/phone)
- Validate biller before proceeding
- Show summary for confirmation
- Guide through PIN and OTP
- Provide receipt/confirmation`,

      kyc: `Customer is verifying their identity.
- Guide through required documents/info
- Explain why each piece is needed
- Be clear about timelines
- Offer support if they have questions`,

      unknown: `Current request is unclear.
- Ask for clarification
- Offer menu of available services
- Be helpful and patient`,
    };

    return guidance[action ?? "unknown"] ?? guidance.unknown;
  }

  /**
   * Build user context based on current state
   */
  private buildUserContext(state: AgentState, strategy: CompressionStrategy): string {
    let context = "";
    
    // Customer info
    const profile = state.persistent.customerProfile;
    if (profile?.name) {
      context += `Customer: ${profile.name}\n`;
    }
    
    // Current goal
    const goal = state.session.currentGoal;
    if (goal) {
      context += `\nCurrent Goal: ${goal.action.toUpperCase()}\n`;
      context += `Status: ${goal.status}\n`;
      context += `Description: ${goal.description}\n`;
      
      // Task progress
      if (state.session.taskPlan) {
        const progress = `${state.session.taskPlan.filter(s => s.status === "completed").length}/${state.session.taskPlan.length}`;
        context += `Progress: ${progress} steps completed\n`;
      }
    }
    
    // Working memory (collected data)
    if (strategy !== "minimal" && state.session.workingMemory && Object.keys(state.session.workingMemory).length > 0) {
      context += `\nCollected Information:\n`;
      Object.entries(state.session.workingMemory).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
          context += `  • ${key}: ${displayValue}\n`;
        }
      });
    }
    
    // Recent conversation context for "focused" strategy
    if (strategy === "focused" && state.session.conversationHistory.length > 0) {
      const recent = state.session.conversationHistory.slice(-2);
      context += `\nRecent Context:\n`;
      recent.forEach((turn, idx) => {
        context += `  ${idx === 0 ? "Customer" : "You"}: ${turn.content.slice(0, 100)}...\n`;
      });
    }
    
    return context;
  }

  /**
   * Select conversation history based on strategy and token budget
   */
  private selectConversationHistory(
    state: AgentState,
    strategy: CompressionStrategy,
    budget: ContextBudget
  ): Array<{ role: string; content: string }> {
    const history = state.session.conversationHistory;
    
    if (history.length === 0) return [];
    
    switch (strategy) {
      case "minimal":
        // Only last message
        return history.slice(-1).map(h => ({ role: h.role, content: h.content }));
      
      case "focused":
        // Last 3-5 messages
        return history.slice(-5).map(h => ({ role: h.role, content: h.content }));
      
      case "summary":
        // Last 10 messages
        return history.slice(-10).map(h => ({ role: h.role, content: h.content }));
      
      case "full":
        // All history within token budget
        const availableForHistory = budget.availableTokens - 1000; // Reserve for response
        let tokens = 0;
        let selected = [];
        
        for (let i = history.length - 1; i >= 0; i--) {
          const turn = history[i];
          const turnTokens = this.estimateTokens("", `${turn.role}: ${turn.content}`, []);
          if (tokens + turnTokens > availableForHistory) break;
          selected.unshift(turn);
          tokens += turnTokens;
        }
        
        return selected.map(h => ({ role: h.role, content: h.content }));
    }
  }

  /**
   * Choose compression strategy based on goal phase and budget
   */
  private selectStrategy(phase: string, budget: ContextBudget): CompressionStrategy {
    // If very tight budget, minimize
    if (budget.availableTokens < 2000) return "minimal";
    
    // Different strategies for different phases
    const strategyByPhase: Record<string, CompressionStrategy> = {
      idle: "summary",
      in_progress: "focused", // Keep recent context of current task
      pending_confirmation: "full", // Need full context for important decision
      pending_pin: "minimal", // Don't need context, just PIN verification
      pending_otp: "minimal", // Don't need context, just OTP verification
      completed: "summary",
      failed: "full", // Full context for debugging failure
    };
    
    return strategyByPhase[phase] ?? "summary";
  }

  /**
   * Estimate token count for content
   */
  private estimateTokens(...contents: (string | Array<any>)[]): number {
    let totalChars = 0;
    
    for (const content of contents) {
      if (typeof content === 'string') {
        totalChars += content.length;
      } else if (Array.isArray(content)) {
        content.forEach(item => {
          if (item.role && item.content) {
            totalChars += item.content.length;
          }
        });
      }
    }
    
    return Math.ceil(totalChars * this.tokensPerCharacter) + this.systemPromptTokens;
  }

  /**
   * Compress context using summarization
   */
  compressContext(context: ExtractedContext, targetTokens: number): ExtractedContext {
    if (context.estimatedTokens <= targetTokens) {
      return context;
    }
    
    // Reduce conversation history
    const maxMessages = Math.max(2, Math.floor(context.conversationHistory.length * 0.5));
    const compressedHistory = context.conversationHistory.slice(-maxMessages);
    
    return {
      ...context,
      conversationHistory: compressedHistory,
      compressionStrategy: "summary",
      estimatedTokens: this.estimateTokens(context.systemPrompt, context.userContext, compressedHistory),
    };
  }

  /**
   * Check if context fits within budget
   */
  fitsInBudget(context: ExtractedContext, budget: ContextBudget): boolean {
    return context.estimatedTokens <= budget.availableTokens;
  }
}

export const contextEngine = new ContextEngine();
