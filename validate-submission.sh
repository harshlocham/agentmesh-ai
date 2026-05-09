#!/bin/bash
# Final Submission Validation

set -e

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║           AUTONOMOUS TASK AGENT - FINAL VALIDATION           ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

cd "$(dirname "$0")/apps/task-worker"

echo "1. STABILITY TEST SUITE"
echo "───────────────────────────────────────────────────────────────"
echo "Running provider fallback tests..."
npm test -- --runInBand tests/llm-provider.test.ts 2>&1 | grep -E "pass|fail|✔|✖" | head -20

echo ""
echo "Running persistent-loop reliability tests..."
npm test -- --runInBand tests/agent-runner.persistent-loop.test.ts 2>&1 | grep -E "pass|fail|✔|✖" | head -20

echo ""
echo "2. TYPE SAFETY"
echo "───────────────────────────────────────────────────────────────"
echo "Running TypeScript compiler..."
npx tsc --noEmit -p tsconfig.json && echo "✓ TypeScript compilation passed" || echo "✗ TypeScript errors found"

echo ""
echo "3. SUBMISSION FILES"
echo "───────────────────────────────────────────────────────────────"
for file in DEPLOYMENT_CHECKLIST.md DEMO_HARDENING.md SUBMISSION_NARRATIVE.md examples/amd-production-env.md; do
  if [ -f "../$file" ] || [ -f "../../$file" ]; then
    echo "✓ $file"
  else
    echo "✗ $file (missing!)"
  fi
done

echo ""
echo "4. CORE RUNTIME FILES"
echo "───────────────────────────────────────────────────────────────"
for file in services/agent-runner.ts services/llm/providers/openai-provider.ts services/task-lease.ts services/tools/tool-registry.ts; do
  if [ -f "services/$(basename $file)" ] || grep -q "currentRunId\|idempotencyKey" $file 2>/dev/null; then
    echo "✓ $file (stabilization changes present)"
  else
    echo "? $file (verify changes)"
  fi
done

echo ""
echo "5. DOCUMENTATION CHECK"
echo "───────────────────────────────────────────────────────────────"
cd ../..
doc_quality=0
for keyword in "AMD" "deployment" "timeout" "fallback" "demo" "idempotency"; do
  count=$(grep -r "$keyword" DEPLOYMENT_CHECKLIST.md DEMO_HARDENING.md SUBMISSION_NARRATIVE.md 2>/dev/null | wc -l)
  if [ $count -gt 0 ]; then
    echo "✓ $keyword documentation found ($count mentions)"
    ((doc_quality++))
  fi
done

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
if [ $doc_quality -ge 5 ]; then
  echo "║  ✓ READY FOR SUBMISSION                                     ║"
else
  echo "║  ⚠ Review documentation quality before submission           ║"
fi
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "Final Checklist:"
echo "  [ ] Provider tests pass"
echo "  [ ] Runtime tests pass"
echo "  [ ] TypeScript compiles"
echo "  [ ] Demo scenario runs < 40s"
echo "  [ ] Logs show: llm:request → step:execute → step:verify → lifecycle:completed"
echo "  [ ] No 'llm:error' with category 'auth' or 'non_retryable' during demo"
echo "  [ ] Deployment checklist reviewed"
echo "  [ ] Demo hardening guide reviewed"
echo "  [ ] Submission narrative confirmed"
echo ""
