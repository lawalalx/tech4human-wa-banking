/**
 * State Lifecycle Manager - Manages state transitions and persistence
 * 
 * Handles:
 * - Ephemeral state (current message): created → processed → cleared
 * - Session state (conversation): loaded → updated → saved
 * - Persistent state (long-term): loaded → updated → saved to DB
 */

import { AgentState, EphemeralState, SessionState, PersistentState, createInitialAgentState } from "./agent-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// STATE LIFECYCLE EVENTS
// ─────────────────────────────────────────────────────────────────────────────

export type StateLifecycleEvent =
  | { type: "message_received"; message: string; timestamp: string }
  | { type: "intent_detected"; intent: string; confidence: number }
  | { type: "goal_created"; action: string; description: string }
  | { type: "goal_updated"; status: string }
  | { type: "step_started"; step: number }
  | { type: "step_completed"; step: number; result: unknown }
  | { type: "tool_called"; toolName: string; result: unknown }
  | { type: "state_cleared"; reason: string }
  | { type: "session_resumed"; gapMinutes: number }
  | { type: "persistent_synced" };

export interface StateTransition {
  from: string;
  to: string;
  reason: StateLifecycleEvent;
  timestamp: string;
  affectedLayers: ("ephemeral" | "session" | "persistent")[];
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE LIFECYCLE MANAGER
// ─────────────────────────────────────────────────────────────────────────────

export class StateLifecycleManager {
  private stateTransitions: StateTransition[] = [];
  private eventCallbacks: Map<StateLifecycleEvent["type"], (event: StateLifecycleEvent, state: AgentState) => void> = new Map();

  /**
   * Subscribe to state lifecycle events for logging/monitoring
   */
  subscribe(eventType: StateLifecycleEvent["type"], callback: (event: StateLifecycleEvent, state: AgentState) => void): void {
    this.eventCallbacks.set(eventType, callback);
  }

  /**
   * Start processing a new message (ephemeral state)
   */
  startMessageProcessing(state: AgentState, message: string): AgentState {
    const now = new Date().toISOString();
    const event: StateLifecycleEvent = { type: "message_received", message, timestamp: now };
    
    state.ephemeral = {
      currentMessage: message,
      detectedIntent: "unknown",
      messageTimestamp: now,
    };
    
    this.recordTransition(state, "idle", "message_received", [event], ["ephemeral"]);
    this.emit(event, state);
    
    return state;
  }

  /**
   * Record intent detection in ephemeral state
   */
  recordIntentDetection(
    state: AgentState,
    intent: string,
    confidence?: number,
    extractedParams?: Record<string, any>
  ): AgentState {
    if (!state.ephemeral) return state;
    
    state.ephemeral.detectedIntent = intent as any;
    state.ephemeral.intentConfidence = confidence ?? 0.5;
    state.ephemeral.extractedParams = extractedParams;
    
    const event: StateLifecycleEvent = { type: "intent_detected", intent, confidence: confidence ?? 0.5 };
    this.recordTransition(state, "intent_unknown", "intent_detected", [event], ["ephemeral"]);
    this.emit(event, state);
    
    return state;
  }

  /**
   * Create a new goal in session state
   */
  createGoal(
    state: AgentState,
    action: string,
    description: string,
    taskSteps?: string[]
  ): AgentState {
    const now = new Date().toISOString();
    
    // Create goal
    state.session.currentGoal = {
      action: action as any,
      description,
      status: "in_progress",
      startedAt: now,
    };
    
    // Create task plan if multi-step
    if (taskSteps && taskSteps.length > 0) {
      state.session.taskPlan = taskSteps.map((desc, idx) => ({
        step: idx,
        description: desc,
        status: "pending",
      }));
      state.session.currentStep = 0;
    }
    
    const event: StateLifecycleEvent = { type: "goal_created", action, description };
    this.recordTransition(state, "no_goal", "goal_created", [event], ["session"]);
    this.emit(event, state);
    
    return state;
  }

  /**
   * Update goal status
   */
  updateGoalStatus(state: AgentState, status: string): AgentState {
    if (!state.session.currentGoal) return state;
    
    state.session.currentGoal.status = status as any;
    
    if (status === "completed" || status === "failed") {
      state.session.currentGoal.completedAt = new Date().toISOString();
    }
    
    const event: StateLifecycleEvent = { type: "goal_updated", status };
    this.recordTransition(state, state.session.currentGoal.status, "goal_updated", [event], ["session"]);
    this.emit(event, state);
    
    return state;
  }

  /**
   * Move to next step in multi-step task
   */
  completeStep(state: AgentState, result?: unknown): AgentState {
    if (!state.session.taskPlan || state.session.currentStep >= state.session.taskPlan.length) {
      return state;
    }
    
    const currentStep = state.session.taskPlan[state.session.currentStep];
    currentStep.status = "completed";
    currentStep.completedAt = new Date().toISOString();
    
    // Store result in working memory
    if (result) {
      const stepKey = `step_${state.session.currentStep}_result`;
      state.session.workingMemory = state.session.workingMemory ?? {};
      state.session.workingMemory[stepKey] = result;
    }
    
    const event: StateLifecycleEvent = { type: "step_completed", step: state.session.currentStep, result };
    this.recordTransition(state, `step_${state.session.currentStep}`, "step_completed", [event], ["session"]);
    this.emit(event, state);
    
    // Move to next step
    state.session.currentStep += 1;
    if (state.session.currentStep < state.session.taskPlan.length) {
      const nextStep = state.session.taskPlan[state.session.currentStep];
      nextStep.status = "in_progress";
      
      const nextEvent: StateLifecycleEvent = { type: "step_started", step: state.session.currentStep };
      this.emit(nextEvent, state);
    }
    
    return state;
  }

  /**
   * Record tool usage and result
   */
  recordToolUsage(state: AgentState, toolName: string, result: unknown): AgentState {
    if (!state.session.toolsUsed.includes(toolName)) {
      state.session.toolsUsed.push(toolName);
    }
    
    // Store result
    state.session.workingMemory = state.session.workingMemory ?? {};
    state.session.workingMemory[`tool_${toolName}_result`] = result;
    
    const event: StateLifecycleEvent = { type: "tool_called", toolName, result };
    this.recordTransition(state, "tool_pending", "tool_called", [event], ["session"]);
    this.emit(event, state);
    
    return state;
  }

  /**
   * Add message to conversation history and session state
   */
  recordConversationTurn(state: AgentState, role: "user" | "assistant", content: string): AgentState {
    const now = new Date().toISOString();
    
    state.session.conversationHistory.push({
      role,
      content,
      timestamp: now,
      intent: state.ephemeral?.detectedIntent,
    });
    
    state.lastUpdated = now;
    return state;
  }

  /**
   * Clear ephemeral state after message processing
   */
  clearEphemeralState(state: AgentState, reason: string): AgentState {
    const event: StateLifecycleEvent = { type: "state_cleared", reason };
    this.recordTransition(state, "message_processing", "state_cleared", [event], ["ephemeral"]);
    this.emit(event, state);
    
    state.ephemeral = undefined;
    state.lastUpdated = new Date().toISOString();
    
    return state;
  }

  /**
   * Complete and clear session goal
   */
  completeGoal(state: AgentState): AgentState {
    if (!state.session.currentGoal) return state;
    
    this.updateGoalStatus(state, "completed");
    
    // Archive session state to persistent
    state.persistent.interactionSummary = state.persistent.interactionSummary ?? { totalSessions: 0 };
    state.persistent.interactionSummary.lastInteraction = new Date().toISOString();
    state.persistent.interactionSummary.totalSessions = (state.persistent.interactionSummary.totalSessions ?? 0) + 1;
    
    // Clear session working memory after goal complete
    state.session.workingMemory = {};
    state.session.toolsUsed = [];
    state.session.currentStep = 0;
    state.session.taskPlan = undefined;
    state.session.currentGoal = undefined;
    
    return state;
  }

  /**
   * Handle session resumption after timeout
   */
  resumeSession(state: AgentState, gapMinutes: number): AgentState {
    const event: StateLifecycleEvent = { type: "session_resumed", gapMinutes };
    this.recordTransition(state, "idle", "session_resumed", [event], ["session", "ephemeral"]);
    this.emit(event, state);
    
    return state;
  }

  /**
   * Sync session state to persistent state
   */
  syncToPersistent(state: AgentState): AgentState {
    // Update persistent profile if we learned new info
    if (state.session.conversationHistory.length > 0 && state.persistent.customerProfile?.name === undefined) {
      // Could extract name from conversation here if needed
    }
    
    const event: StateLifecycleEvent = { type: "persistent_synced" };
    this.recordTransition(state, "session_updated", "persistent_synced", [event], ["persistent"]);
    this.emit(event, state);
    
    state.lastUpdated = new Date().toISOString();
    return state;
  }

  /**
   * Get transition history
   */
  getTransitionHistory(): StateTransition[] {
    return [...this.stateTransitions];
  }

  /**
   * Clear transition history
   */
  clearTransitionHistory(): void {
    this.stateTransitions = [];
  }

  // ─────────────────────────────────────────────────────────────────────────

  private recordTransition(
    state: AgentState,
    fromStatus: string,
    reason: string,
    events: StateLifecycleEvent[],
    affectedLayers: ("ephemeral" | "session" | "persistent")[]
  ): void {
    this.stateTransitions.push({
      from: fromStatus,
      to: reason,
      reason: events[0],
      timestamp: new Date().toISOString(),
      affectedLayers,
    });
  }

  private emit(event: StateLifecycleEvent, state: AgentState): void {
    const callback = this.eventCallbacks.get(event.type);
    if (callback) {
      callback(event, state);
    }
  }
}

export const stateLifecycleManager = new StateLifecycleManager();
