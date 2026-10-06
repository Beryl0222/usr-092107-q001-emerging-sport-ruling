import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { RulingService } from "../src/services.js";
import { createApp } from "../src/server.js";

/**
 * 不监听端口的 HTTP 集成测试：直接把请求喂给 app，收集响应。
 */
function harness(service) {
  const app = createApp(service);
  return async function request(method, path, body, headers = {}) {
    const chunks = [];
    const req = {
      method,
      url: path,
      headers: { ...headers },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    };
    const res = {
      statusCode: 0,
      headers: {},
      ended: false,
      writeHead(status, h) {
        this.statusCode = status;
        this.headers = h;
      },
      end(data) {
        this.ended = true;
        if (data) chunks.push(data);
      },
    };
    await app(req, res);
    const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { status: res.statusCode, body: raw ? JSON.parse(raw) : null };
  };
}

function setup() {
  const service = new RulingService(new EventStore());
  const request = harness(service);
  return { service, request };
}

test("未知命令返回 404", async () => {
  const { request } = setup();
  const res = await request("POST", "/api/cmd/nope", {});
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "UNKNOWN_COMMAND");
});

test("命令总线：发布规则成功；领域错误带状态码返回", async () => {
  const { request } = setup();
  const ok = await request("POST", "/api/cmd/publishRulebook", {
    sport: "surfing", rules_version: "2026.1",
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.event_type, "RULEBOOK_PUBLISHED");

  // 未激活规则就编排场次 → 422 领域错误
  const { request: request2, service } = setup();
  void service;
  const bad = await request2("POST", "/api/cmd/scheduleBout", {
    bout_id: "B1", sport: "surfing", round_label: "r", entries: [],
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, "NO_ACTIVE_RULEBOOK");
});

test("Idempotency-Key 请求头：离线重传只落一条", async () => {
  const { request, service } = setup();
  await request("POST", "/api/cmd/publishRulebook", { sport: "surfing", rules_version: "2026.1", config: {} });
  await request("POST", "/api/cmd/activateRulebook", { sport: "surfing", rulebook_id: "rule-surfing-2026-1" });
  await request("POST", "/api/cmd/registerAthlete", { athlete_id: "a1", team_id: "T" });
  await request("POST", "/api/cmd/registerAthlete", { athlete_id: "a2", team_id: "T" });
  await request("POST", "/api/cmd/grantEligibility", { athlete_id: "a1", competition_id: "c" });
  await request("POST", "/api/cmd/grantEligibility", { athlete_id: "a2", competition_id: "c" });
  await request("POST", "/api/cmd/scheduleBout", {
    bout_id: "B1", sport: "surfing", round_label: "r", entries: ["a1", "a2"],
  });
  const payload = {
    bout_id: "B1", kind: "wave_judge_score",
    data: { athlete_id: "a1", wave_no: 1, score: 7 },
  };
  const first = await request("POST", "/api/cmd/recordEvidence", payload, { "idempotency-key": "dev:42" });
  const second = await request("POST", "/api/cmd/recordEvidence", payload, { "idempotency-key": "dev:42" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.result.event.event_id, first.body.result.event.event_id);
  assert.equal(second.body.result.status, "duplicate");
  assert.equal(service.store.byType("EVIDENCE_RECORDED").length, 1);
});

test("只读端点：公开成绩、链校验、单事件核验、健康检查、404", async () => {
  const { request, service } = setup();
  const health = await request("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const pub = await request("GET", "/api/public/results");
  assert.equal(pub.status, 200);
  assert.equal(pub.body.healthy, true);

  const chain = await request("GET", "/api/chain/verify");
  assert.equal(chain.status, 200);
  assert.equal(chain.body.valid, true);

  const rule = await request("POST", "/api/cmd/publishRulebook", { sport: "mma", rules_version: "2026.1" });
  const verify = await request("GET", `/api/events/${rule.body.result.event_id}/verify`);
  assert.equal(verify.status, 200);
  assert.equal(verify.body.matches, true);

  const missing = await request("GET", "/api/events/nope/verify");
  assert.equal(missing.status, 404);

  const notFound = await request("GET", "/nope");
  assert.equal(notFound.status, 404);
});

test("非法 JSON 返回错误而非崩溃", async () => {
  const service = new RulingService(new EventStore());
  const app = createApp(service);
  const req = {
    method: "POST", url: "/api/cmd/publishRulebook", headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("{not json");
    },
  };
  let status;
  const res = {
    writeHead(s) { status = s; },
    end() {},
  };
  await app(req, res);
  assert.equal(status, 422);
});
