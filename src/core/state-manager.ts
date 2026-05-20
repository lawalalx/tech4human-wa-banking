/**
 * State Manager Service - High-level state operations
 * 
 * Orchestrates:
 * - State lifecycle management
 * - Context extraction
 * - State inspection/logging
 * - Persistence to database
 */

import { AgentState, createInitialAgentState } from "./agent-state.js";
import { StateLifecycleManager, stateLifecycleManager } from "./state-lifecycle.js";
import { ContextEngine, contextEngine, ContextBudget } from "./context-engine.js";
import { StateInspector, stateInspector } from "./state-inspector.js";
import { loadAgentStateFromLegacyDB, saveAgentStateToLegacyDB } from "./legacy-adapter.js";

export interface StateManagerConfig {
  enableLogging?: boolean;
  enableTelemetry?: boolean;
  contextTokenBudget?: number;
}

export class StateManager {
  private manager: StateLifecycleManager;
  private contextEngine: ContextEngine;
  private inspector: StateInspector;
  private stateCache: Map<string, AgentState> = new Map();
  private config: StateManagerConfig;

  constructor(config: StateManagerConfig = {}) {
    this.manager = stateLifecycleManager;
    this.contextEngine = contextEngine;
    this.inspector = stateInspector;
    this.config = {
      enableLogging: true,
      enableTelemetry: false,
      contextTokenBudget: 8000,
      ...config,
    };
    
    // Set up logging if enabled
    if (this.config.enableLogging) {
      this.setupLogging();
    }
  }

  // ─────────────────────────────────────────────────────────────────────

  /**
   * Get or create state for a customer
   */
  async getOrCreateState(phone: string): Promise<AgentState> {
    // Check cache first
    if (this.stateCache.has(phone)) {
      return this.stateCache.get(phone)!;
    }
    
    // Load from database or create new
    let state = await this.loadStateFromDatabase(phone);
    if (!state) {
      state = createInitialAgentState(phone);
    }
    
    // Cache in memory
    this.stateCache.set(phone, state);
    return state;
  }

  /**
   * Process incoming message and update state
   */
  async processMessage(state: AgentState, message: string): Promise<AgentState> {
    // Start message processing cycle
    state = this.manager.startMessageProcessing(state, message);
    
    // Record in conversation history
    state = this.manager.recordConversationTurn(state, "user", message);
    
    // Log if enabled
    if (this.config.enableLogging) {
      this.inspector.logStateEvent(state, "message_received");
    }
    
    return state;
  }

  /**
   * Record assistant response
   */
  async recordResponse(state: AgentState, response: string): Promise<AgentState> {
    state = this.manager.recordConversationTurn(state, "assistant", response);
    
    if (this.config.enableLogging) {
      this.inspector.logStateEvent(state, "response_sent");
    }
    
    return state;
  }

  /**
   * Create a new goal
   */
  async createGoal(
    state: AgentState,
    action: string,
    description: string,
    steps?: string[]
  ): Promise<AgentState> {
    state = this.manager.createGoal(state, action, description, steps);
    
    if (this.config.enableLogging) {
      this.inspector.logStateEvent(state, "goal_created");
    }
    
    return state;
  }

  /**
   * Update goal status
   */
  async updateGoalStatus(state: AgentState, status: string): Promise<AgentState> {
    state = this.manager.updateGoalStatus(state, status);
    
    if (this.config.enableLogging) {
      this.inspector.logStateEvent(state, "goal_status_updated");
    }
    
    return state;
  }

  /**
   * Record tool call and result
   */
  async recordToolCall(state: AgentState, toolName: string, result: unknown): Promise<AgentState> {
    state = this.manager.recordToolUsage(state, toolName, result);
    
    if (this.config.enableLogging) {
      this.inspector.logStateEvent(state, "tool_called", undefined, undefined);
    }
    
    return state;
  }

  /**
   * Complete current step and move to next
   */
  async completeStep(state: AgentState, result?: unknown): Promise<AgentState> {
    state = this.manager.completeStep(state, result);
    
    if (this.config.enableLogging) {
      this.inspector.logStateEvent(state, "step_completed");
    }
    
    return state;
  }

  /**
   * Complete entire goal
   */
  async completeGoal(state: AgentState): Promise<AgentState> {
    state = this.manager.completeGoal(state);
    
    if (this.config.enableLogging) {
      this.inspector.logStateEvent(state, "goal_completed");
    }
    
    // Save to database
    await this.saveStateToDatabase(state);
    
    return state;
  }

  /**
   * Extract optimized context for LLM
   */
  extractContext(state: AgentState, tokenBudget?: number) {
    const budget: ContextBudget = {
      totalTokens: tokenBudget ?? this.config.contextTokenBudget ?? 8000,
      modelInstructionTokens: 1500,
      availableTokens: (tokenBudget ?? this.config.contextTokenBudget ?? 8000) - 1500,
    };
    
    return this.contextEngine.extractContext(state, budget);
  }

  /**
   * Get human-readable state snapshot
   */
  getStateSnapshot(state: AgentState) {
    return this.inspector.getStateSnapshot(state);
  }

  /**
   * Get debug report for customer
   */
  getDebugReport(phone: string): string {
    return this.inspector.generateDebugReport(phone);
  }

  /**
   * Save state to database and cache
   */
  async saveState(state: AgentState): Promise<void> {
    this.stateCache.set(state.session.phone, state);
    await this.saveStateToDatabase(state);
  }

  /**
   * End session and cleanup
   */
  async endSession(phone: string): Promise<void> {
    let state = this.stateCache.get(phone);
    if (state) {
      state = this.manager.completeGoal(state);
      await this.saveStateToDatabase(state);
    }
    
    this.stateCache.delete(phone);
    
    if (this.config.enableLogging && state) {
      this.inspector.logStateEvent(state, "session_ended");
    }
  }

  // ─────────────────────────────────────────────────────────────────────

  /**
   * Set up lifecycle event logging
   */
  private setupLogging(): void {
    this.manager.subscribe("message_received", (event, state) => {
      if (event.type === "message_received") {
        console.log(`[MESSAGE] ${state.session.phone}: "${event.message.slice(0, 50)}..."`);
      }
    });
    
    this.manager.subscribe("intent_detected", (event, state) => {
      if (event.type === "intent_detected") {
        console.log(`[INTENT] ${state.session.phone}: ${event.intent} (confidence: ${event.confidence.toFixed(2)})`);
      }
    });
    
    this.manager.subscribe("goal_created", (event, state) => {
      if (event.type === "goal_created") {
        console.log(`[GOAL] ${state.session.phone}: ${event.action} - ${event.description}`);
      }
    });
    
    this.manager.subscribe("tool_called", (event, state) => {
      if (event.type === "tool_called") {
        console.log(`[TOOL] ${state.session.phone}: ${event.toolName}`);
      }
    });
    
    this.manager.subscribe("goal_updated", (event, state) => {
      if (event.type === "goal_updated") {
        console.log(`[STATUS] ${state.session.phone}: ${state.session.currentGoal?.action} -> ${event.status}`);
      }
    });
  }

  /**
   * Load state from database (stub - implement with your DB)
   */
  private async loadStateFromDatabase(phone: string): Promise<AgentState | null> {
    return await loadAgentStateFromLegacyDB(phone);
  }

  /**
   * Save state to database (stub - implement with your DB)
   */
  private async saveStateToDatabase(state: AgentState): Promise<void> {
    await saveAgentStateToLegacyDB(state);
  }
}

// ─────────────────────────────────────────────────────────────────────
// SINGLETON INSTANCE
// ─────────────────────────────────────────────────────────────────────

export const stateManager = new StateManager({
  enableLogging: true,
  enableTelemetry: false,
  contextTokenBudget: 8000,
});
