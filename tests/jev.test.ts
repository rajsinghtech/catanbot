import assert from "node:assert/strict";
import { test } from "node:test";
import { legalActions, newGame } from "../src/engine/game.ts";
import { setupSecondSettlementScore } from "../src/policy/doctrine.ts";
import { decide } from "../src/policy/jev.ts";

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("JEV gateway answers are used instead of silently falling back", async () => {
  const env = {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    JEV_PROVIDER: process.env.JEV_PROVIDER,
    JEV_PROXY_ENABLED: process.env.JEV_PROXY_ENABLED,
  };
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
  delete process.env.JEV_PROVIDER;
  delete process.env.JEV_PROXY_ENABLED;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body));
    const operation = Object.keys(request.questions.operation.criteria)[0];
    const targetKey = `${operation.toLowerCase()}_target`;
    const target = Object.keys(request.questions[targetKey].criteria)[0];
    return new Response(JSON.stringify({
      answers: {
        operation: { choice: operation, confidence: 0.91 },
        [targetKey]: { choice: target },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const state = newGame({ playerCount: 2 }, { seed: 41, us: "red" });
    const rec = await decide(state);
    assert.equal(calls, 1);
    assert.equal(rec.source, "jev");
    assert.ok(legalActions(state).some((action) => action.id === rec.action.id));
    assert.match(rec.reason, /JEV selected/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test("JEV target guard keeps the second setup settlement strategically complete", async () => {
  const env = {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    JEV_CALLS_PER_EPOCH: process.env.JEV_CALLS_PER_EPOCH,
  };
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
  process.env.JEV_CALLS_PER_EPOCH = "1";
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body));
    const operation = Object.keys(request.questions.operation.criteria)[0];
    const targetKey = `${operation.toLowerCase()}_target`;
    const target = Object.keys(request.questions[targetKey].criteria)[0];
    return new Response(JSON.stringify({
      answers: {
        operation: { choice: operation, confidence: 0.91 },
        [targetKey]: { choice: target },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
    const first = legalActions(state).find((action) => action.type === "PLACE_SETTLEMENT");
    assert.ok(first?.vertex);
    state.players[0].settlements = [first.vertex];
    state.current = "red";
    state.phase = "setup_settle";
    state.setupForward = false;
    state.setupIndex = 0;
    const candidates = legalActions(state).filter((action) => action.type === "PLACE_SETTLEMENT");
    const expected = candidates
      .slice()
      .sort((a, b) => setupSecondSettlementScore(state, "red", b.vertex!) - setupSecondSettlementScore(state, "red", a.vertex!))[0];
    const rec = await decide(state);
    assert.equal(calls, 1);
    assert.equal(rec.source, "jev");
    assert.equal(rec.action.id, expected.id);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test("JEV cannot replace a materially stronger direct VP build with a pass", async () => {
  const env = {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    JEV_CALLS_PER_EPOCH: process.env.JEV_CALLS_PER_EPOCH,
  };
  const previousFetch = globalThis.fetch;
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
  process.env.JEV_CALLS_PER_EPOCH = "1";
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    const operations = Object.keys(request.questions.operation.criteria);
    const operation = operations[operations.length - 1];
    const targetKey = `${operation.toLowerCase()}_target`;
    const targetCriteria = request.questions[targetKey]?.criteria ?? {};
    const target = Object.keys(targetCriteria)[0];
    return new Response(JSON.stringify({
      answers: {
        operation: { choice: operation, confidence: 0.99 },
        ...(target ? { [targetKey]: { choice: target } } : {}),
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const state = newGame({ playerCount: 2 }, { seed: 12, us: "red" });
    state.players[0].settlements = [Object.keys(state.board.vertices)[0]];
    state.players[0].hand = { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 };
    state.current = "red";
    state.phase = "turn";
    state.turn = 1;
    state.dice = [6, 6];
    const rec = await decide(state);
    assert.equal(rec.source, "jev");
    assert.equal(rec.action.type, "BUILD_CITY");
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test("the live OpenAI-compatible proxy can run the same JEV question contract", async () => {
  const env = {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    JEV_PROVIDER: process.env.JEV_PROVIDER,
    JEV_PROXY_ENABLED: process.env.JEV_PROXY_ENABLED,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  const previousFetch = globalThis.fetch;
  let calls = 0;
  delete process.env.AI_GATEWAY_API_KEY;
  process.env.JEV_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-proxy-key";
  process.env.OPENAI_BASE_URL = "http://proxy.test/v1";
  globalThis.fetch = (async (input, init) => {
    calls += 1;
    assert.equal(String(input), "http://proxy.test/v1/chat/completions");
    const request = JSON.parse(String(init?.body));
    const prompt = request.messages[1].content as string;
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    const operation = Object.keys(payload.questions.operation.criteria)[0];
    const targetKey = `${operation.toLowerCase()}_target`;
    const target = Object.keys(payload.questions[targetKey].criteria)[0];
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        operation: { choice: operation, confidence: 0.88 },
        [targetKey]: { choice: target },
      }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const state = newGame({ playerCount: 2 }, { seed: 43, us: "red" });
    const rec = await decide(state);
    assert.equal(calls, 1);
    assert.equal(rec.source, "jev");
    assert.match(rec.reason, /JEV-compatible evaluator selected/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test("the internal JEV-compatible proxy works without an API key", async () => {
  const env = {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    JEV_PROVIDER: process.env.JEV_PROVIDER,
    JEV_PROXY_ENABLED: process.env.JEV_PROXY_ENABLED,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  const previousFetch = globalThis.fetch;
  let calls = 0;
  delete process.env.AI_GATEWAY_API_KEY;
  process.env.JEV_PROVIDER = "openai";
  delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = "http://ai/v1";
  globalThis.fetch = (async (input, init) => {
    calls += 1;
    assert.equal(String(input), "http://ai/v1/chat/completions");
    const requestHeaders = init?.headers as Record<string, string>;
    assert.equal(requestHeaders.Authorization, undefined);
    const request = JSON.parse(String(init?.body));
    const prompt = request.messages[1].content as string;
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    const operation = Object.keys(payload.questions.operation.criteria)[0];
    const targetKey = `${operation.toLowerCase()}_target`;
    const target = Object.keys(payload.questions[targetKey].criteria)[0];
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        operation: { choice: operation, confidence: 0.87 },
        [targetKey]: { choice: target },
      }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const state = newGame({ playerCount: 2 }, { seed: 47, us: "red" });
    const rec = await decide(state);
    assert.equal(calls, 1);
    assert.equal(rec.source, "jev");
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
