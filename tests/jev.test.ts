import assert from "node:assert/strict";
import { test } from "node:test";
import { legalActions, newGame } from "../src/engine/game.ts";
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
