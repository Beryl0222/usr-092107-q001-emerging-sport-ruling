import assert from "node:assert/strict";
import test from "node:test";

import { makeApp, activateRule, eligible } from "./helpers.js";
import { createHttpServer } from "../src/server.js";

async function withServer(run) {
  const app = makeApp();
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base, app);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.cleanup();
  }
}

const post = (base, name, body, headers = {}) =>
  fetch(`${base}/commands/${name}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("HTTP：健康检查、命令鉴权失败 403、签署发布后公开成绩可查", async () => {
  await withServer(async (base, app) => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    activateRule(app, "surfing");
    eligible(app, "A", "JPN");
    eligible(app, "B", "BRA");
    // 通过 API 走完排赛到发布。
    const send = (name, body) => post(base, name, body);
    let r = await send("scheduleBout", { bout_id: "W1", sport: "surfing", athlete_ids: ["A", "B"], olympic_qualification: true });
    assert.equal(r.status, 201);
    await send("finalizeRoster", { bout_id: "W1" });
    for (const j of ["J1", "J2", "J3"]) await send("assignJudge", { bout_id: "W1", judge_id: j, role: "scoring", nations: [] });
    await send("startRound", { bout_id: "W1", round: 1 });
    for (const wid of ["w1", "w2"]) for (const j of ["J1", "J2", "J3"]) await send("submitJudgeScore", { bout_id: "W1", judge_id: j, round: 1, wave_id: wid, athlete_id: "A", score: 8 });
    for (const wid of ["w3"]) for (const j of ["J1", "J2", "J3"]) await send("submitJudgeScore", { bout_id: "W1", judge_id: j, round: 1, wave_id: wid, athlete_id: "B", score: 4 });
    await send("projectCandidate", { bout_id: "W1" });

    // 无签名认证 → 403。
    const noSig = await send("certifyResult", { bout_id: "W1", signers: [] });
    assert.equal(noSig.status, 403);
    assert.equal((await noSig.json()).code, "SIGNATURE_REQUIRED");

    // 未知命令 → 404。
    const unknown = await post(base, "nope", {});
    assert.equal(unknown.status, 404);

    await send("certifyResult", { bout_id: "W1", signers: ["head"] });
    await send("publishResult", { bout_id: "W1", signers: ["arbiter"] });

    const pub = await fetch(`${base}/public/results?sport=surfing`).then((x) => x.json());
    assert.equal(pub.count, 1);
    assert.equal(pub.results[0].winner, "A");
    assert.equal(pub.results[0].locked, true);
    assert.equal(pub.results[0].verification.verifiable, true);

    // 公开核验公告事件。
    const eventId = pub.results[0].verification.published_event_id;
    const v = await fetch(`${base}/public/verify/${eventId}`).then((x) => x.json());
    assert.equal(v.ok, true);
    assert.equal(v.current_version, true);

    // 官员整场重放。
    const replay = await fetch(`${base}/official/bouts/W1/replay`).then((x) => x.json());
    assert.equal(replay.ok, true);
  });
});

test("HTTP：回避冲突返回 422 且带 conflicts；代表队申诉视图可查状态与截止时间", async () => {
  await withServer(async (base, app) => {
    activateRule(app, "surfing");
    eligible(app, "A", "JPN");
    await post(base, "scheduleBout", { bout_id: "W2", sport: "surfing", athlete_ids: ["A"] });
    await post(base, "finalizeRoster", { bout_id: "W2" });
    const conflict = await post(base, "assignJudge", { bout_id: "W2", judge_id: "JN", role: "scoring", nations: ["JPN"] });
    assert.equal(conflict.status, 422);
    const body = await conflict.json();
    assert.equal(body.code, "JUDGE_CONFLICT");
    assert.equal(body.conflicts[0].reasons[0], "同国籍（JPN）");

    // 无冲突裁判执裁后提一条评分，便于提申诉。
    await post(base, "assignJudge", { bout_id: "W2", judge_id: "JK", role: "scoring", nations: [] });
    await post(base, "startRound", { bout_id: "W2", round: 1 });
    const scoreResp = await post(base, "submitJudgeScore", { bout_id: "W2", judge_id: "JK", round: 1, wave_id: "w", athlete_id: "A", score: 7 }).then((x) => x.json());
    await post(base, "fileAppeal", { appeal_id: "APW2", bout_id: "W2", against_event_id: scoreResp.output.event_id, filed_by: "coach", delegation: "JPN", grounds: "争议" });

    const dv = await fetch(`${base}/delegation/JPN/appeals`).then((x) => x.json());
    assert.equal(dv.appeals.length, 1);
    assert.equal(dv.appeals[0].status, "filed");
    assert.ok(dv.appeals[0].evidence_window_end);
    assert.equal(dv.appeals[0].evidence_open, true);

    // 其他代表队看不到该申诉。
    const other = await fetch(`${base}/delegation/BRA/appeals`).then((x) => x.json());
    assert.equal(other.appeals.length, 0);
  });
});

test("HTTP：候选结果不出现在公开成绩；未发布比赛公开列表为空", async () => {
  await withServer(async (base, app) => {
    activateRule(app, "surfing");
    eligible(app, "A", "JPN");
    await post(base, "scheduleBout", { bout_id: "W3", sport: "surfing", athlete_ids: ["A"] });
    await post(base, "finalizeRoster", { bout_id: "W3" });
    for (const j of ["J1", "J2", "J3"]) await post(base, "assignJudge", { bout_id: "W3", judge_id: j, role: "scoring", nations: [] });
    await post(base, "startRound", { bout_id: "W3", round: 1 });
    for (const j of ["J1", "J2", "J3"]) await post(base, "submitJudgeScore", { bout_id: "W3", judge_id: j, round: 1, wave_id: "w", athlete_id: "A", score: 9 });
    await post(base, "projectCandidate", { bout_id: "W3" });

    const pub = await fetch(`${base}/public/results`).then((x) => x.json());
    assert.equal(pub.count, 0);

    // 事件仍可按标识检索（官员侧）。
    const chain = await fetch(`${base}/official/chain`).then((x) => x.json());
    assert.equal(chain.ok, true);
    assert.ok(chain.count >= 6);
  });
});
