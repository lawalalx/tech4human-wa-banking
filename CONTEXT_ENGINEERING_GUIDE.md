# Context Engineering Integration Guide

## Overview

This guide shows how to integrate the new context engineering infrastructure into your existing FirstBank agent while maintaining the supervisor-subagent architecture.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           SUPERVISOR                                 │
│                      (chat-handler.ts)                               │
│  - Uses ContextEngine for dynamic routing                            │
│  - Manages AgentState lifecycle                                      │
│  - Extracts context for routing decisions                            │
└──────────────┬──────────────────────────┬──────────────────────────┘
               │                          │
      ┌────────▼────────┐        ┌────────▼────────┐
      │ SUBAGENT 1      │        │ SUBAGENT 2      │
      │ (transaction)   │        │ (insights)      │
      │ - Balance       │        │ - Charts        │
      │ - Transfer      │        │ - Analytics     │
      │ - Payments      │        │ - Budgets       │
      └─────────────────┘        └─────────────────┘
```

## Key Concepts

### 1. AgentState - Your Complete Context

`AgentState` replaces scattered session variables with a unified model:

```typescript
// Old way (scattered):
session.pending_flow.data.amount
session.context.last_intent
session.phoneNumber

// New way (unified):
state.session.workingMemory.amount
state.ephemeral?.detectedIntent
state.session.phone
```

### 2. State Lifecycle - Event-Driven Architecture

State transitions trigger events that can be logged/monitored:

```
message_received 
  → intent_detected 
  → goal_created 
  → step_started 
  → tool_called 
  → step_completed 
  → goal_completed 
  → state_cleared
```

### 3. Context Engine - Token-Aware LLM Context

Automatically extracts only relevant context for the LLM:

```
Strategy Selection:
├─ "idle" → summary (recent history)
├─ "in_progress" → focused (relevant data)
├─ "pending_confirmation" → full (everything needed for decision)
├─ "pending_pin" → minimal (just prompt for input)
└─ "failed" → full (debug info)
```

## Integration Steps

### Step 1: Update Chat Handler

**Before (chat-handler.ts):**
```typescript
const session = await getSessionState(phone);
const pendingAction = session?.pending_flow?.action;

if (hasPendingTransactionFlow) {
  const run = await transactionWorkflow.createRun();
  // ...
}
```

**After:**
```typescript
import { stateManager, contextEngine } from "../core/index.js";

const state = await stateManager.getOrCreateState(phone);
state = await stateManager.processMessage(state, userText);

// Extract context for better routing
const context = stateManager.extractContext(state);
console.log(context.systemPrompt); // See what LLM sees

// Route based on current goal
const goal = state.session.currentGoal?.action;
if (goal === "transfer") {
  // Handle transfer with full state context
  const result = await transactionWorkflow.createRun().start({
    state, // Pass entire AgentState
    message: userText,
  });
}

// Record response
state = await stateManager.recordResponse(rawPhone, reply);
await stateManager.saveState(state);
```

### Step 2: Update Transaction Workflow

**Before (transaction-workflow.ts):**
```typescript
const pending = session?.pending_flow;
const hasTransferDetails = Boolean(
  intentData.amount || 
  intentData.recipientAccount || 
  asAmount(message) || 
  asAccountNumber(message)
);
```

**After:**
```typescript
import { stateManager } from "../../core/index.js";

// Receive state from supervisor
const executeConversationFlowStep = createStep({
  execute: async ({ inputData }) => {
    const { state, message } = inputData;
    
    // Goal already created by supervisor or in workflow
    const goal = state.session.currentGoal;
    
    if (!goal) {
      // Create goal if not exists
      state = await stateManager.createGoal(
        state,
        "transfer",
        "User initiated fund transfer",
        [
          "Collect transfer details (amount, recipient, description)",
          "Confirm recipient exists",
          "Request PIN verification",
          "Request OTP verification",
          "Execute transfer",
          "Provide receipt"
        ]
      );
    }
    
    // Handle based on current step/status
    const status = goal.status;
    
    if (status === "in_progress") {
      // Collect details
      state = await stateManager.updateGoalStatus(state, "in_progress");
      // ... collect amount, recipient
    }
    
    if (status === "pending_pin") {
      // Verify PIN
      const pinResult = await verifyPin(state, directPin);
      state = await stateManager.recordToolCall(state, "verify_pin", pinResult);
    }
    
    // Progress to next step
    state = await stateManager.completeStep(state, result);
    
    return { handled: true, reply: message, state };
  }
});
```

### Step 3: Add State Inspection to Debugging

```typescript
// In your error handler or debug endpoint:
import { stateInspector } from "../core/state-inspector.js";

app.get("/debug/:phone", (req, res) => {
  const phone = req.params.phone;
  const report = stateInspector.generateDebugReport(phone);
  res.send(`<pre>${report}</pre>`);
});

// Log state snapshots:
if (DEBUG_MODE) {
  console.log(
    stateInspector.formatStateForConsole(state)
  );
}
```

### Step 4: Update Session Resumption

**Before:**
```typescript
resumptionSystemMsg = buildResumptionHint(session, RESUME_THRESHOLD_MS);
```

**After:**
```typescript
import { stateLifecycleManager } from "../core/index.js";

const gapMinutes = calculateGap(state.lastUpdated);
if (gapMinutes > 5) {
  state = stateLifecycleManager.resumeSession(state, gapMinutes);
  // The lifecycle manager records this event
}
```

## Usage Patterns

### Pattern 1: Multi-Step Goal with Progress Tracking

```typescript
// Create goal with plan
state = await stateManager.createGoal(
  state,
  "transfer",
  "Execute fund transfer",
  [
    "Collect amount",
    "Collect recipient",
    "Collect description",
    "Confirm details",
    "Verify PIN",
    "Verify OTP",
    "Execute transfer",
    "Generate receipt"
  ]
);

// Progress through steps
state = await stateManager.recordToolCall(state, "collect_amount", { amount: 5000 });
state = await stateManager.completeStep(state); // Move to step 2

state = await stateManager.recordToolCall(state, "collect_recipient", { account: "1234567890" });
state = await stateManager.completeStep(state); // Move to step 3

// Query progress:
console.log(`${state.session.currentStep}/${state.session.taskPlan?.length} steps done`);
```

### Pattern 2: Context-Aware Decisions

```typescript
// Get context tailored to current phase
const context = stateManager.extractContext(state);

// Full context for confirmation decisions:
if (state.session.currentGoal?.status === "pending_confirmation") {
  const context = stateManager.extractContext(state, 8000);
  console.log(context.conversationHistory); // Full history
}

// Minimal context for PIN verification:
if (state.session.currentGoal?.status === "pending_pin") {
  const context = stateManager.extractContext(state, 8000);
  console.log(context.conversationHistory); // Just recent msg
}
```

### Pattern 3: Logging & Monitoring

```typescript
// Auto-log all state events:
stateLifecycleManager.subscribe("goal_created", (event, state) => {
  const metrics = {
    phone: state.session.phone,
    goal: event.action,
    timestamp: new Date().toISOString(),
  };
  sendToAnalytics(metrics);
});

// Get session debug info:
const history = stateInspector.getStateHistory(phone, 50);
const anomalies = stateInspector.generateDebugReport(phone);
```

## Migration Strategy

### Phase 1: Parallel Operation (Backward Compatible)
- Keep existing session-state.ts
- Use legacy-adapter.ts to sync states
- Gradually introduce stateManager in new code paths

### Phase 2: Selective Integration
- Convert transaction workflow to use AgentState
- Update chat handler to use contextEngine for routing
- Keep legacy fallbacks

### Phase 3: Full Integration
- Replace all session state with AgentState
- Remove legacy adapter
- Leverage new logging/telemetry

## Best Practices

### ✅ DO

1. **Use state manager for all state operations**
   ```typescript
   state = await stateManager.createGoal(state, ...);
   state = await stateManager.completeStep(state);
   ```

2. **Extract context before LLM calls**
   ```typescript
   const context = stateManager.extractContext(state);
   // Use context.systemPrompt, context.userContext
   ```

3. **Log important transitions**
   ```typescript
   stateInspector.logStateEvent(state, "transfer_initiated");
   ```

4. **Check goal status before state changes**
   ```typescript
   if (state.session.currentGoal?.status === "pending_pin") {
     // Handle PIN entry
   }
   ```

5. **Save state after significant changes**
   ```typescript
   state = await stateManager.completeStep(state);
   await stateManager.saveState(state);
   ```

### ❌ DON'T

1. **Don't manually mutate state properties**
   ```typescript
   // Bad:
   state.session.currentGoal.status = "completed";
   
   // Good:
   state = await stateManager.updateGoalStatus(state, "completed");
   ```

2. **Don't ignore lifecycle events**
   ```typescript
   // Bad: Skipping logging
   const result = await tool.execute();
   
   // Good:
   const result = await tool.execute();
   state = await stateManager.recordToolCall(state, toolName, result);
   ```

3. **Don't pass arbitrary context to LLM**
   ```typescript
   // Bad:
   prompt += JSON.stringify(state); // Too much data
   
   // Good:
   const context = stateManager.extractContext(state);
   prompt += context.userContext; // Filtered & token-aware
   ```

4. **Don't create duplicate goal states**
   ```typescript
   // Bad:
   if (!pending) {
     state.session.currentGoal = { ... };
   }
   
   // Good:
   if (!state.session.currentGoal) {
     state = await stateManager.createGoal(...);
   }
   ```

## Debugging

### Get Full State Snapshot
```typescript
console.log(stateInspector.formatStateForConsole(state));
```

### Generate Debug Report
```typescript
const report = stateInspector.generateDebugReport(phone);
console.log(report); // Shows full session analysis
```

### Get Usage Stats
```typescript
const stats = stateInspector.getUsageStatistics();
console.log(`Tracked ${stats.customersTracked} customers`);
console.log(`Event types:`, stats.eventTypeDistribution);
```

## Summary

The context engineering refactor provides:

1. **Unified State Model** - Single source of truth for agent context
2. **Event-Driven Architecture** - Observable state transitions
3. **Token-Aware Context** - LLM gets only relevant information
4. **Debug Visibility** - Full session history and anomaly detection
5. **Backward Compatible** - Gradual migration with legacy adapter

This makes your agent **more organized, observable, and robust** while maintaining the supervisor-subagent architecture you already have.
