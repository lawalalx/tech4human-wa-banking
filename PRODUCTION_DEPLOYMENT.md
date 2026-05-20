# 🚀 Production Deployment & Testing Guide

## Executive Summary

Your TypeScript Mastra banking agent is now production-ready with:
- ✅ Proper state management with timeout enforcement
- ✅ Context engineering for natural conversations
- ✅ MCP alignment with correct tool usage
- ✅ Authorization flow with PIN/OTP sequencing
- ✅ Rich, conversational messaging
- ✅ Comprehensive error handling

---

## 📋 Pre-Deployment Checklist

### Code Quality
- [ ] All TypeScript types are correct
- [ ] No `any` types used (except where necessary)
- [ ] All imports are resolved
- [ ] No console.log() left in production code
- [ ] Error handling is comprehensive
- [ ] Logging is structured and useful

### Integration
- [ ] Authorization service imported in transaction workflow
- [ ] Conversation context imported in chat handler
- [ ] MCP transaction handler used for all tool calls
- [ ] State management properly initialized
- [ ] Database migrations run successfully

### Testing
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] End-to-end tests passing
- [ ] PIN timeout tested (2 minutes)
- [ ] OTP timeout tested (5 minutes)
- [ ] Attempt tracking tested (max 3)
- [ ] State cleanup tested
- [ ] Error scenarios tested

### Configuration
- [ ] Environment variables set
- [ ] MCP server URL configured
- [ ] Database connection string set
- [ ] WhatsApp credentials configured
- [ ] Logging level appropriate

---

## 🧪 Testing Strategy

### 1. Unit Tests (Individual Services)

**Authorization Service Tests:**
```bash
npm test -- authorization-service.test.ts
```

Test coverage:
- PIN timeout validation
- OTP timeout validation
- Attempt tracking
- State verification
- Error messages

**Conversation Context Tests:**
```bash
npm test -- conversation-context.test.ts
```

Test coverage:
- System prompt generation
- User context extraction
- PIN/OTP prompts
- Confirmation messages
- Receipt generation
- Error messages

**MCP Transaction Handler Tests:**
```bash
npm test -- mcp-transaction-handler.test.ts
```

Test coverage:
- Bank resolution
- OTP code extraction
- PIN verification
- State updates
- Error handling

### 2. Integration Tests (Services + Workflow)

**Transaction Workflow Tests:**
```bash
npm test -- transaction-workflow.integration.test.ts
```

Test scenarios:
1. **Balance Enquiry**
   - User requests balance
   - PIN verification
   - Balance displayed

2. **Mini Statement**
   - User requests statement
   - PIN verification
   - Transactions displayed

3. **Transfer (Full Flow)**
   - User initiates transfer
   - Recipient details collected
   - Confirmation shown
   - PIN requested
   - OTP requested
   - Transfer executed
   - Receipt shown

4. **Bill Payment (Full Flow)**
   - User initiates bill payment
   - Biller details collected
   - Confirmation shown
   - PIN requested
   - OTP requested
   - Payment executed
   - Receipt shown

### 3. End-to-End Tests (Full System)

**Chat Handler Tests:**
```bash
npm test -- chat-handler.e2e.test.ts
```

Test scenarios:
1. **New Customer Greeting**
   - User sends "Hi"
   - Main menu displayed

2. **Returning Customer Resumption**
   - User had pending transfer
   - Resumption message shown
   - Can continue or start new

3. **Full Transfer Flow**
   - Message → Workflow → Response
   - State persisted correctly
   - Authorization enforced

4. **Error Handling**
   - Invalid input handled
   - Service errors handled
   - Graceful fallbacks

### 4. Performance Tests

**Load Testing:**
```bash
npm test -- performance.test.ts
```

Metrics:
- Response time < 2 seconds
- State save < 500ms
- MCP calls < 1 second
- Memory usage stable

---

## 🔍 Testing Commands

### Run All Tests
```bash
npm test
```

### Run Specific Test Suite
```bash
npm test -- authorization-service.test.ts
npm test -- conversation-context.test.ts
npm test -- transaction-workflow.integration.test.ts
npm test -- chat-handler.e2e.test.ts
```

### Run with Coverage
```bash
npm test -- --coverage
```

### Run in Watch Mode
```bash
npm test -- --watch
```

---

## 📊 Test Scenarios

### Scenario 1: Successful Transfer

**Setup:**
```
Customer: 2348012345678
Account: 0123456789
Transfer to: 0987654321
Amount: 5000
```

**Flow:**
```
1. Customer: "Transfer 5000 to 0987654321"
   Bot: Shows confirmation with recipient details
   
2. Customer: "YES"
   Bot: "🔐 VERIFY YOUR PIN\nEnter your 4-digit PIN..."
   
3. Customer: "1234"
   Bot: "✅ PIN verified\n📱 OTP SENT\nEnter the 4-digit code..."
   
4. Customer: "5678"
   Bot: "✅ TRANSFER SUCCESSFUL!\n[Receipt with details]"
```

**Assertions:**
- ✅ State transitions correctly
- ✅ PIN verified within 2 minutes
- ✅ OTP verified within 5 minutes
- ✅ Transfer executed
- ✅ Receipt shown

### Scenario 2: PIN Timeout

**Setup:**
```
Customer: 2348012345678
PIN verified at: T=0
Current time: T=130 seconds
```

**Flow:**
```
1. PIN verified at T=0
   
2. At T=130 seconds (> 120 second timeout):
   Bot: "🔐 PIN EXPIRED\nPlease enter your PIN again..."
   
3. Customer: "1234"
   Bot: "✅ PIN verified"
```

**Assertions:**
- ✅ PIN timeout enforced
- ✅ User asked to re-enter
- ✅ New PIN accepted

### Scenario 3: OTP Max Attempts

**Setup:**
```
Customer: 2348012345678
OTP: 1234
Attempts: 0/3
```

**Flow:**
```
1. Customer: "5678" (wrong)
   Bot: "❌ Incorrect OTP. You have 2 attempts remaining."
   
2. Customer: "9999" (wrong)
   Bot: "❌ Incorrect OTP. You have 1 attempt remaining."
   
3. Customer: "8888" (wrong)
   Bot: "🔒 OTP VERIFICATION LOCKED\nPlease request a new OTP..."
```

**Assertions:**
- ✅ Attempts tracked
- ✅ Remaining attempts shown
- ✅ Locked after max attempts

### Scenario 4: State Cleanup

**Setup:**
```
Customer: 2348012345678
Transaction 1: Transfer (completed)
Transaction 2: Balance (new)
```

**Flow:**
```
1. Transfer completed
   State: authorizationState cleared
   State: transactionContext cleared
   
2. New balance request
   State: Fresh authorization state
   State: No leftover data from transfer
```

**Assertions:**
- ✅ Authorization state cleared
- ✅ Transaction context cleared
- ✅ No data leakage between transactions

---

## 🚀 Deployment Steps

### Step 1: Pre-Deployment

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Build TypeScript
npm run build

# Check for errors
npm run lint
```

### Step 2: Staging Deployment

```bash
# Deploy to staging environment
npm run deploy:staging

# Run smoke tests
npm run test:smoke

# Monitor logs
npm run logs:staging
```

### Step 3: Production Deployment

```bash
# Deploy to production
npm run deploy:production

# Verify deployment
curl https://api.firstbank.com/health

# Monitor metrics
npm run metrics:production
```

### Step 4: Post-Deployment

```bash
# Monitor for errors
npm run logs:production --tail

# Check authorization metrics
curl https://api.firstbank.com/admin/metrics

# Monitor customer interactions
npm run monitor:customers
```

---

## 📈 Monitoring & Metrics

### Key Metrics to Track

1. **Authorization Success Rate**
   ```
   (PIN verified + OTP verified) / Total transactions
   Target: > 95%
   ```

2. **Average Response Time**
   ```
   Time from user message to bot response
   Target: < 2 seconds
   ```

3. **State Consistency**
   ```
   Transactions with correct state after completion
   Target: 100%
   ```

4. **Error Rate**
   ```
   Failed transactions / Total transactions
   Target: < 2%
   ```

5. **Timeout Occurrences**
   ```
   PIN timeouts / Total PIN verifications
   OTP timeouts / Total OTP verifications
   Target: < 1%
   ```

### Monitoring Dashboard

```typescript
// Endpoint: GET /admin/metrics
{
  "timestamp": "2025-01-16T10:30:00Z",
  "authorization": {
    "pinSuccessRate": 0.96,
    "otpSuccessRate": 0.98,
    "avgPinAttempts": 1.2,
    "avgOtpAttempts": 1.1,
    "pinTimeouts": 5,
    "otpTimeouts": 2
  },
  "transactions": {
    "total": 1000,
    "successful": 980,
    "failed": 20,
    "avgResponseTime": 1.8,
    "avgDuration": 45
  },
  "errors": {
    "invalidPin": 15,
    "invalidOtp": 12,
    "mcpFailures": 3,
    "timeouts": 7
  }
}
```

---

## 🔧 Troubleshooting

### Issue: PIN Timeout Too Short

**Symptom:** Users getting "PIN expired" messages too quickly

**Solution:**
```bash
# Increase PIN timeout in .env
PIN_TIMEOUT_MS=300000  # 5 minutes instead of 2
```

### Issue: OTP Code Not Stored

**Symptom:** OTP verification always fails

**Solution:**
1. Check `sendPhoneVerificationOtpTool` returns OTP code
2. Verify `updateOtpCode()` is called after sending OTP
3. Check state is persisted to database

### Issue: State Mixup Between Transactions

**Symptom:** Previous transaction context showing in new transaction

**Solution:**
1. Verify `resetAuthorizationState()` is called
2. Check state cleanup is happening
3. Monitor state transitions

### Issue: MCP Tool Failures

**Symptom:** "Failed to resolve bank" errors

**Solution:**
1. Verify MCP server is running
2. Check `lookup_customer_by_account` returns bank_name
3. Monitor MCP server logs

---

## 📝 Rollback Plan

If issues occur in production:

1. **Immediate Rollback:**
   ```bash
   npm run deploy:rollback
   ```

2. **Partial Rollback:**
   - Disable new services in feature flags
   - Route traffic to previous version
   - Investigate issues

3. **Root Cause Analysis:**
   - Check logs for errors
   - Review state transitions
   - Analyze MCP responses

4. **Fix & Re-Deploy:**
   - Fix identified issues
   - Run tests again
   - Deploy to staging
   - Deploy to production

---

## 📞 Support Contacts

**Engineering Team:**
- On-call: +234-XXX-XXXX
- Slack: #banking-agent-support

**MCP Server Team:**
- Contact: mcp-support@firstbank.com
- Status: https://mcp-status.firstbank.com

**WhatsApp API Support:**
- Meta Support: https://developers.facebook.com/support

---

## ✅ Final Checklist Before Go-Live

- [ ] All tests passing
- [ ] Code reviewed and approved
- [ ] Performance benchmarks met
- [ ] Security audit completed
- [ ] Staging deployment successful
- [ ] Monitoring configured
- [ ] Alerting configured
- [ ] Runbooks prepared
- [ ] Team trained
- [ ] Rollback plan ready
- [ ] Customer communication ready

---

## 🎉 Go-Live!

Your production-ready banking agent is ready to serve customers. Monitor closely for the first 24 hours and adjust as needed.

**Good luck!** 🚀
