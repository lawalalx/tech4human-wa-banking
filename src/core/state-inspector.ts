/**
 * State Inspector & Logging - Debug visibility into agent state
 * 
 * Provides:
 * - State snapshots for logging
 * - Transition history tracking
 * - Production telemetry
 * - Debug utilities
 */

import { AgentState, createStateSnapshot } from "./agent-state.js";
import { StateTransition, StateLifecycleEvent } from "./state-lifecycle.js";

export interface StateLog {
  timestamp: string;
  phoneNumber: string;
  eventType: string;
  snapshot: Record<string, any>;
  transition?: StateTransition;
  errorMessage?: string;
}

export interface StateMetrics {
  totalMessages: number;
  totalGoals: number;
  successfulGoals: number;
  failedGoals: number;
  averageStepsPerGoal: number;
  toolsUsedFrequency: Record<string, number>;
  commonIntentSequences: string[][];
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE INSPECTOR
// ─────────────────────────────────────────────────────────────────────────────

export class StateInspector {
  private logs: StateLog[] = [];
  private readonly maxLogs = 10000; // Keep reasonable size
  private metricsCache: Map<string, StateMetrics> = new Map();

  /**
   * Log a state event with snapshot
   */
  logStateEvent(
    state: AgentState,
    eventType: string,
    transition?: StateTransition,
    errorMessage?: string
  ): void {
    const log: StateLog = {
      timestamp: new Date().toISOString(),
      phoneNumber: state.session.phone,
      eventType,
      snapshot: createStateSnapshot(state),
      transition,
      errorMessage,
    };
    
    this.logs.push(log);
    
    // Keep logs bounded
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-Math.floor(this.maxLogs * 0.8));
    }
  }

  /**
   * Get state history for a specific customer
   */
  getStateHistory(phoneNumber: string, limit = 100): StateLog[] {
    return this.logs
      .filter(log => log.phoneNumber === phoneNumber)
      .slice(-limit);
  }

  /**
   * Get current state snapshot for debugging
   */
  getStateSnapshot(state: AgentState): Record<string, any> {
    return createStateSnapshot(state);
  }

  /**
   * Format state for console output (human-readable)
   */
  formatStateForConsole(state: AgentState): string {
    const snap = createStateSnapshot(state);
    
    return `
═══════════════════════════════════════════════════════════════════
                       AGENT STATE SNAPSHOT
───────────────────────────────────────────────────────────────────
Timestamp:    ${snap.timestamp}
Customer:     ${snap.phone}
Current Goal: ${snap.currentGoal || 'none'}
Goal Status:  ${snap.goalStatus || 'idle'}
Task Progress: ${snap.taskProgress}
───────────────────────────────────────────────────────────────────
Conversation: ${snap.conversationTurns} turns
Tools Used:   ${snap.toolsUsed.join(", ") || "none"}
Working Data: ${snap.workingMemoryKeys.join(", ") || "empty"}
Detected Intent: ${snap.detectedIntent || "unknown"}
═══════════════════════════════════════════════════════════════════
    `;
  }

  /**
   * Generate debug report for a customer session
   */
  generateDebugReport(phoneNumber: string): string {
    const history = this.getStateHistory(phoneNumber);
    
    if (history.length === 0) {
      return `No state logs found for ${phoneNumber}`;
    }
    
    const events = history.map(log => log.eventType);
    const goals = history
      .filter(log => log.snapshot.currentGoal)
      .map(log => log.snapshot.currentGoal);
    
    const uniqueGoals = [...new Set(goals)];
    const failedGoals = history
      .filter(log => log.snapshot.goalStatus === "failed")
      .length;
    
    let report = `
╔════════════════════════════════════════════════════════════════════╗
║                    DEBUG REPORT - SESSION ANALYSIS
╚════════════════════════════════════════════════════════════════════╝

Customer: ${phoneNumber}
Total Logs: ${history.length}
Session Duration: ${this.calculateSessionDuration(history)}
Last Active: ${history[history.length - 1]?.timestamp}

─── GOALS SUMMARY ───
Unique Goals: ${uniqueGoals.join(", ")}
Failed Goals: ${failedGoals}
Success Rate: ${((uniqueGoals.length - failedGoals) / uniqueGoals.length * 100).toFixed(1)}%

─── EVENT SEQUENCE ───
${events.slice(-20).join(" → ")}

─── FINAL STATE ───
${this.formatStateSnapshotCompact(history[history.length - 1]?.snapshot)}

─── ANOMALIES ───
${this.detectAnomalies(history).join("\n") || "None detected"}
    `;
    
    return report;
  }

  /**
   * Detect potential issues in state history
   */
  private detectAnomalies(history: StateLog[]): string[] {
    const anomalies: string[] = [];
    
    // Detect stuck flows (same status for too long)
    const lastEvent = history[history.length - 1];
    if (lastEvent?.snapshot.goalStatus === "pending_pin" || 
        lastEvent?.snapshot.goalStatus === "pending_otp") {
      const pinWaitTime = history.filter(
        h => h.snapshot.goalStatus?.startsWith("pending")
      ).length;
      if (pinWaitTime > 10) {
        anomalies.push("⚠️ Customer stuck in PIN/OTP verification for many messages");
      }
    }
    
    // Detect tool failures
    const errorLogs = history.filter(h => h.errorMessage);
    if (errorLogs.length > 3) {
      anomalies.push(`⚠️ Multiple errors detected (${errorLogs.length} occurrences)`);
    }
    
    // Detect rapid state changes
    const recentChanges = history.slice(-5);
    const uniqueGoals = new Set(recentChanges.map(h => h.snapshot.currentGoal));
    if (uniqueGoals.size === recentChanges.length) {
      anomalies.push("⚠️ Rapid goal changes detected - possible rapid user switching");
    }
    
    return anomalies;
  }

  /**
   * Calculate session duration from history
   */
  private calculateSessionDuration(history: StateLog[]): string {
    if (history.length < 2) return "N/A";
    
    const start = new Date(history[0].timestamp);
    const end = new Date(history[history.length - 1].timestamp);
    const durationMs = end.getTime() - start.getTime();
    const durationMins = Math.round(durationMs / 60000);
    
    if (durationMins < 1) return "< 1 minute";
    if (durationMins < 60) return `${durationMins} minutes`;
    
    const hours = Math.floor(durationMins / 60);
    const mins = durationMins % 60;
    return `${hours}h ${mins}m`;
  }

  /**
   * Compact snapshot formatter
   */
  private formatStateSnapshotCompact(snapshot?: Record<string, any>): string {
    if (!snapshot) return "N/A";
    
    return `
  Goal: ${snapshot.currentGoal || "none"}
  Status: ${snapshot.goalStatus || "idle"}
  Progress: ${snapshot.taskProgress}
  Turns: ${snapshot.conversationTurns}
  Tools: ${snapshot.toolsUsed?.join(", ") || "none"}
    `;
  }

  /**
   * Clear logs for a customer (cleanup)
   */
  clearCustomerLogs(phoneNumber: string): number {
    const before = this.logs.length;
    this.logs = this.logs.filter(log => log.phoneNumber !== phoneNumber);
    return before - this.logs.length;
  }

  /**
   * Export all logs as JSON
   */
  exportLogs(): StateLog[] {
    return [...this.logs];
  }

  /**
   * Get statistics on state engine usage
   */
  getUsageStatistics(): {
    totalEvents: number;
    customersTracked: number;
    averageLogsPerCustomer: number;
    eventTypeDistribution: Record<string, number>;
  } {
    const uniqueCustomers = new Set(this.logs.map(l => l.phoneNumber));
    const eventTypes = new Map<string, number>();
    
    this.logs.forEach(log => {
      eventTypes.set(log.eventType, (eventTypes.get(log.eventType) ?? 0) + 1);
    });
    
    return {
      totalEvents: this.logs.length,
      customersTracked: uniqueCustomers.size,
      averageLogsPerCustomer: Math.round(this.logs.length / uniqueCustomers.size),
      eventTypeDistribution: Object.fromEntries(eventTypes),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PRODUCTION TELEMETRY SENDER
// ─────────────────────────────────────────────────────────────────────────

export class TelemetrySender {
  private batchQueue: StateLog[] = [];
  private readonly batchSize = 50;
  private readonly flushIntervalMs = 30000; // 30 seconds
  private flushTimer?: NodeJS.Timeout;

  constructor(private readonly endpoint: string) {}

  /**
   * Queue a state event for telemetry
   */
  queueEvent(log: StateLog): void {
    this.batchQueue.push(log);
    
    if (this.batchQueue.length >= this.batchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Send batched telemetry
   */
  private async flush(): Promise<void> {
    if (this.batchQueue.length === 0) return;
    
    const batch = this.batchQueue.splice(0, this.batchSize);
    
    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          events: batch,
        }),
      });
    } catch (error) {
      console.error("Telemetry send failed:", error);
      // Re-queue on failure (simple retry)
      this.batchQueue.unshift(...batch);
    }
    
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flush();
  }
}

export const stateInspector = new StateInspector();
