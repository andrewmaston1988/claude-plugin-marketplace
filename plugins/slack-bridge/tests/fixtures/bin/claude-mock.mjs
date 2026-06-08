#!/usr/bin/env node
/**
 * Mock `claude` subprocess for integration tests.
 * Behaviour controlled by CLAUDE_MOCK_RESPONSE env var (defaults to "Hello from Claude").
 * Emits a single JSON object (matching --output-format json) then exits 0.
 */
const response  = process.env.CLAUDE_MOCK_RESPONSE ?? "Hello from Claude";
const sessionId = process.env.CLAUDE_MOCK_SESSION  ?? "sess-test-1234";

process.stdout.write(JSON.stringify({ result: response, session_id: sessionId, total_cost_usd: 0 }) + "\n");
process.exit(0);
