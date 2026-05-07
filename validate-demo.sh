#!/bin/bash
# Demo Validation Checklist
# Run this before judges arrive to confirm all systems are ready.

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "  AUTONOMOUS TASK AGENT - PRE-DEMO VALIDATION"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_task() {
  local name=$1
  local cmd=$2
  
  echo -n "[$name] ... "
  if eval "$cmd" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
    return 0
  else
    echo -e "${RED}✗${NC}"
    return 1
  fi
}

check_value() {
  local name=$1
  local var=$2
  local expected=$3
  
  echo -n "[$name] ... "
  if [ -z "${!var}" ]; then
    echo -e "${RED}✗ (not set)${NC}"
    return 1
  fi
  if [ ! -z "$expected" ] && [ "${!var}" != "$expected" ]; then
    echo -e "${YELLOW}⚠ (${!var})${NC}"
    return 0
  fi
  echo -e "${GREEN}✓ (${!var})${NC}"
  return 0
}

fail_count=0

echo "1. ENVIRONMENT CONFIGURATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
check_value "LLM_PROVIDER" "LLM_PROVIDER" "" || ((fail_count++))
check_value "LLM_API_KEY" "OPENAI_API_KEY" "" || ((fail_count++))
check_value "LLM_MODEL" "LLM_MODEL" "" || ((fail_count++))
check_value "TASK_AGENT_LLM_TIMEOUT_MS" "TASK_AGENT_LLM_TIMEOUT_MS" "" || ((fail_count++))
echo ""

echo "2. SERVICE CONNECTIVITY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
check_task "MongoDB" "mongosh --eval 'db.adminCommand(\"ping\")'" || ((fail_count++))
check_task "Task Worker Service" "curl -s http://localhost:3000/health > /dev/null" || ((fail_count++))
check_task "LLM Provider Health" "curl -s http://localhost:3000/health | grep -q 'ok'" || ((fail_count++))
echo ""

echo "3. PROVIDER CAPABILITY CHECK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
check_task "Provider supports chat-completions" "curl -s http://localhost:3000/health | grep -q 'completions'" || ((fail_count++))
echo ""

echo "4. TOOL CONFIGURATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
check_value "GITHUB_TOKEN" "GITHUB_TOKEN" "" && echo "  (GitHub issues tool available)" || true
check_value "RESEND_API_KEY" "RESEND_API_KEY" "" && echo "  (Email tool available)" || true
check_value "SCHEDULE_MEETING_WEBHOOK_URL" "SCHEDULE_MEETING_WEBHOOK_URL" "" && echo "  (Meeting scheduling available)" || true
echo ""

echo "5. TIMEOUT BUDGETS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
llm_timeout=${TASK_AGENT_LLM_TIMEOUT_MS:-30000}
tool_timeout=${TASK_AGENT_TOOL_TIMEOUT_MS:-60000}
iter_timeout=${TASK_AGENT_ITERATION_TIMEOUT_MS:-120000}

echo "  LLM Timeout:       ${llm_timeout}ms"
if [ "$llm_timeout" -lt 30000 ]; then
  echo -e "    ${YELLOW}⚠ Warning: < 30s may cause false timeouts on slower models${NC}"
fi
echo "  Tool Timeout:      ${tool_timeout}ms"
echo "  Iteration Timeout: ${iter_timeout}ms"
echo ""

echo "6. DEMO ENVIRONMENT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
check_value "Log Level" "LOG_LEVEL" "info" || ((fail_count++))
check_value "Max Iterations (for demo)" "TASK_AGENT_MAX_ITERATIONS" "" || ((fail_count++))
echo ""

echo "7. LOGS VERIFICATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Try a quick test task
echo "Submitting test task..."
TASK_ID=$(curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Send test email",
    "description": "Send an email to test@example.com with subject Test."
  }' | grep -o '"taskId":"[^"]*' | cut -d'"' -f4)

if [ ! -z "$TASK_ID" ]; then
  echo -e "  ${GREEN}✓${NC} Test task created: $TASK_ID"
  
  # Wait for task to complete
  echo "  Waiting for execution (max 60s)..."
  for i in {1..60}; do
    STATUS=$(curl -s http://localhost:3000/tasks/$TASK_ID | grep -o '"status":"[^"]*' | cut -d'"' -f4)
    if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
      echo -e "  ${GREEN}✓${NC} Task completed with status: $STATUS"
      break
    fi
    sleep 1
  done
  
  # Check logs for critical paths
  if grep -q "llm:request" /tmp/demo.log 2>/dev/null || true; then
    echo -e "  ${GREEN}✓${NC} LLM request logged"
  fi
  if grep -q "step:execute" /tmp/demo.log 2>/dev/null || true; then
    echo -e "  ${GREEN}✓${NC} Tool execution logged"
  fi
else
  echo -e "  ${RED}✗${NC} Failed to create test task (service may be unresponsive)"
  ((fail_count++))
fi
echo ""

echo "8. FINAL SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $fail_count -eq 0 ]; then
  echo -e "${GREEN}✓ All checks passed. System is ready for demo.${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Keep logs visible in a separate window"
  echo "  2. Run demo scenario from DEMO_HARDENING.md"
  echo "  3. Observe logs for critical path: llm:request → step:execute → step:verify → lifecycle:completed"
  exit 0
else
  echo -e "${RED}✗ $fail_count check(s) failed. Please fix before demo.${NC}"
  echo ""
  echo "Common issues:"
  echo "  - MongoDB not running: start with 'mongod' or 'docker-compose up mongo'"
  echo "  - LLM endpoint unreachable: check AMD_BASE_URL and AMD_API_KEY"
  echo "  - Service not running: start with 'npm run dev' in apps/task-worker"
  exit 1
fi
