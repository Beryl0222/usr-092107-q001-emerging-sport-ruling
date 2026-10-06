import assert from "node:assert/strict";
import test from "node:test";

import { makeApp, activateRule, eligible, standardWindows } from "./helpers.js";
import { DomainError } from "../src/domain/errors.js";

/** 安排一场带三裁判、两运动员的冲浪比赛并提交两组浪评分。 */
function surfScores(app, boutId, waves) {
  app.command("startRound", { bout_id: boutId, round: 1 });
  const ids = [];
  for (const [athlete, byWave] of Object.entries(waves)) {
    for (const [wave, scores] of Object.entries(byWave)) {
      scores.forEach((score, i) => {
        ids.push(
          app.command("submitJudgeScore", { bout_id: boutId, judge_id: `J${i + 1}`, round: 1, wave_id: wave, athlete_id: athlete, score }).event_id,
        );
      });
    }
  }
  return ids;
}

function setupSurfProgram(app) {
  activateRule(app, "surfing");
  ["A", "B", "C", "D"].forEach((id, i) => eligible(app, id, ["JPN", "BRA", "FRA", "ESP"][i]));
  for (const [bout, chain, oq] of [["SF1", "CH1", true], ["SF2", "CH1", false], ["SF3", "CH2", false]]) {
    app.command("scheduleBout", {
      bout_id: bout,
      sport: "surfing",
      chain_id: chain,
      olympic_qualification: oq,
      athlete_ids: bout === "SF1" ? ["A", "B"] : bout === "SF3" ? ["C", "D"] : [],
    });
  }
  app.command("finalizeRoster", { bout_id: "SF1" });
  app.command("finalizeRoster", { bout_id: "SF3" });
  for (const bout of ["SF1", "SF3"]) {
    for (const j of ["J1", "J2", "J3"]) app.command("assignJudge", { bout_id: bout, judge_id: j, role: "scoring", nations: [] });
  }
}

test("冲浪奥运资格赛：签署发布后锁定，候选结果不对外，公开结果可核验", () => {
  const app = makeApp();
  setupSurfProgram(app);
  surfScores(app, "SF1", { A: { w1: [8, 8, 8], w2: [6, 6, 6] }, B: { w3: [5, 5, 5], w4: [5, 5, 5] } });

  app.command("projectCandidate", { bout_id: "SF1" });
  // 尚未签署：公开视图为空。
  assert.equal(app.view.publicResults().count, 0);

  // 无签名不得认证。
  assert.throws(() => app.command("certifyResult", { bout_id: "SF1", signers: [] }), (e) => e.code === "SIGNATURE_REQUIRED");
  // 总记录长无权签署比赛结果。
  assert.throws(() => app.command("certifyResult", { bout_id: "SF1", signers: ["recorder"] }), (e) => e.code === "SIGNATURE_ROLE");

  app.command("certifyResult", { bout_id: "SF1", signers: ["head"] });
  // 已认证但未公告：公开视图仍为空。
  assert.equal(app.view.publicResults().count, 0);
  app.command("publishResult", { bout_id: "SF1", signers: ["arbiter"] });

  const result = app.backend.state().results.get("SF1");
  assert.equal(result.effective.stage, "locked"); // 奥运资格赛公告即锁定
  const pub = app.view.publicResults({ sport: "surfing" });
  assert.equal(pub.count, 1);
  assert.equal(pub.results[0].winner, "A");
  assert.equal(pub.results[0].locked, true);
  assert.equal(pub.results[0].verification.verifiable, true);
  assert.equal(pub.results[0].verification.signed_by.role, "result_arbiter");

  // 锁定后不得直接改判或重新签署。
  assert.throws(() => app.command("certifyResult", { bout_id: "SF1", signers: ["head"] }), (e) => e.code === "RESULT_LOCKED");
  app.cleanup();
});

test("申诉只冻结受影响晋级链闭包；无关场次照常推进", () => {
  const app = makeApp();
  setupSurfProgram(app);
  const scoreIds = surfScores(app, "SF1", { A: { w1: [8, 8, 8], w2: [6, 6, 6] }, B: { w3: [5, 5, 5], w4: [5, 5, 5] } });
  app.command("projectCandidate", { bout_id: "SF1" });
  app.command("certifyResult", { bout_id: "SF1", signers: ["head"] });
  app.command("publishResult", { bout_id: "SF1", signers: ["arbiter"] });
  app.command("projectAdvancement", { chain_id: "CH1", source_bout_id: "SF1", qualifying_positions: [{ rank: 1, slot: "P1", target_bout_id: "SF2" }] });

  // 代表队就 J3 的一条原始评分申诉。
  app.command("fileAppeal", {
    appeal_id: "AP1",
    bout_id: "SF1",
    against_event_id: scoreIds[2],
    filed_by: "coach-bra",
    delegation: "BRA",
    grounds: "认为 A 首浪被高估",
  });

  const state = app.backend.state();
  assert.deepEqual(state.bouts.get("SF1").freeze_reasons, ["AP1"]);
  assert.deepEqual(state.bouts.get("SF2").freeze_reasons, ["AP1"]); // 下游场次冻结
  assert.equal(state.bouts.get("SF3").frozen, false); // 另一条链不受影响

  // 冻结链上的晋级确认被阻止。
  assert.throws(() => app.command("confirmAdvancement", { chain_id: "CH1", source_bout_id: "SF1", signers: ["arbiter"] }), (e) => e.code === "CHAIN_FROZEN");

  // 无关场次 SF3 在申诉期间照常完成全部流程。
  surfScores(app, "SF3", { C: { x1: [7, 7, 7] }, D: { y1: [4, 4, 4] } });
  app.command("projectCandidate", { bout_id: "SF3" });
  app.command("certifyResult", { bout_id: "SF3", signers: ["head"] });
  app.command("publishResult", { bout_id: "SF3", signers: ["arbiter"] });
  assert.equal(app.view.publicResults().results.find((r) => r.bout_id === "SF3").winner, "C");

  // 代表队视图：状态、两个截止时间、倒计时。
  const dv = app.view.delegation("BRA");
  assert.equal(dv.appeals.length, 1);
  assert.equal(dv.appeals[0].status, "filed");
  assert.ok(dv.appeals[0].evidence_window_end.endsWith("Z"));
  assert.ok(dv.appeals[0].seconds_to_evidence_close > 0);
  app.cleanup();
});

test("申诉改判引用原始记录、产生新版本公告；驳回时原结果保持生效", () => {
  const app = makeApp();
  setupSurfProgram(app);
  // 记录每条评分的事件标识，便于引用改判。
  const byKey = new Map();
  app.command("startRound", { bout_id: "SF1", round: 1 });
  for (const [athlete, waves] of [["A", { w1: [8, 8, 8], w2: [6, 6, 6] }], ["B", { w3: [5, 5, 5], w4: [5, 5, 5] }]]) {
    for (const [wave, scores] of Object.entries(waves)) {
      scores.forEach((score, i) => {
        const e = app.command("submitJudgeScore", { bout_id: "SF1", judge_id: `J${i + 1}`, round: 1, wave_id: wave, athlete_id: athlete, score });
        byKey.set(`${wave}-J${i + 1}`, e.event_id);
      });
    }
  }
  app.command("projectCandidate", { bout_id: "SF1" });
  app.command("certifyResult", { bout_id: "SF1", signers: ["head"] });
  app.command("publishResult", { bout_id: "SF1", signers: ["arbiter"] });
  app.command("projectAdvancement", { chain_id: "CH1", source_bout_id: "SF1", qualifying_positions: [{ rank: 1, slot: "P1", target_bout_id: "SF2" }] });

  const v1Public = app.view.publicResults().results.find((r) => r.bout_id === "SF1");
  assert.equal(v1Public.winner, "A");

  app.command("fileAppeal", { appeal_id: "AP1", bout_id: "SF1", against_event_id: byKey.get("w1-J3"), filed_by: "coach-bra", delegation: "BRA", grounds: "A 首浪高估" });

  // 申诉窗口内补一份证据。
  app.command("submitAppealEvidence", { appeal_id: "AP1", kind: "video", ref: "s3://footage/SF1-w1.mp4", hash: "a".repeat(64) });
  app.command("logReview", { appeal_id: "AP1", by: "jury-1", recommendation: "video supports downgrade", note: "两名裁判评分应下调" });

  // 已发布结果不得绕过申诉直接改判。
  assert.throws(
    () => app.command("correctScore", { bout_id: "SF1", correction_of: byKey.get("w1-J1"), kind: "judge_score", reason: "x", replacement: { score: 0 }, actor: { id: "head", role: "head_judge" } }),
    (e) => e.code === "MUST_USE_APPEAL",
  );

  // 改判 J1、J2 对 A 首浪的评分 8 → 0（引用原始记录，原记录保留）。
  for (const j of ["J1", "J2"]) {
    const ev = app.command("correctScore", {
      bout_id: "SF1",
      correction_of: byKey.get(`w1-${j}`),
      appeal_id: "AP1",
      kind: "judge_score",
      reason: "录像显示动作未完成",
      replacement: { judge_id: j, wave_id: "w1", athlete_id: "A", score: 0 },
      actor: { id: "jury-1", role: "jury" },
    });
    assert.equal(ev.correction_of, byKey.get(`w1-${j}`));
  }
  // 同一条原始记录不允许二次改判。
  assert.throws(
    () => app.command("correctScore", { bout_id: "SF1", correction_of: byKey.get("w1-J1"), appeal_id: "AP1", kind: "judge_score", reason: "again", replacement: { score: 1 }, actor: { id: "jury-1", role: "jury" } }),
    (e) => e.code === "ALREADY_CORRECTED",
  );

  // 改判审理期间：对外仍是原版本（A），只是多了待决候选。
  assert.equal(app.view.publicResults().results.find((r) => r.bout_id === "SF1").winner, "A");
  assert.ok(app.backend.state().results.get("SF1").pending);

  // 缺成绩签署人时，申诉成立也无法重发（授权分离）。
  assert.throws(
    () => app.command("decideAppeal", { appeal_id: "AP1", outcome: "upheld", signers: ["jury"], publish_signers: ["jury"] }),
    (e) => e.code === "SIGNATURE_ROLE",
  );

  app.command("decideAppeal", { appeal_id: "AP1", outcome: "upheld", signers: ["jury"], publish_signers: ["arbiter"] });

  const state = app.backend.state();
  assert.equal(state.appeals.get("AP1").status, "upheld");
  assert.equal(state.bouts.get("SF1").frozen, false); // 处理完解冻
  assert.equal(state.bouts.get("SF2").frozen, false);
  const result = state.results.get("SF1");
  assert.equal(result.effective.stage, "locked");
  assert.equal(result.effective.public_version.version_no, 2);
  assert.equal(result.effective.public_version.winner, "B"); // 首浪归零后 B 反超
  assert.equal(result.history.length, 1); // 旧版本留档而非删除

  const v2 = app.view.publicResults().results.find((r) => r.bout_id === "SF1");
  assert.equal(v2.winner, "B");
  assert.equal(v2.version_no, 2);
  assert.equal(v2.verification.verifiable, true);
  assert.equal(v2.history[0].superseded, true);

  // 旧公告事件仍可独立核验，只是被标注为历史版本。
  const oldVerify = app.view.publicVerify(v1Public.verification.published_event_id);
  assert.equal(oldVerify.verifiable, true);
  assert.equal(oldVerify.superseded, true);

  // 解冻后晋级按新冠军 B 重新投影并确认。
  app.command("projectAdvancement", { chain_id: "CH1", source_bout_id: "SF1", qualifying_positions: [{ rank: 1, slot: "P1", target_bout_id: "SF2" }] });
  app.command("confirmAdvancement", { chain_id: "CH1", source_bout_id: "SF1", signers: ["arbiter"] });
  assert.deepEqual(app.backend.state().chains.get("CH1").confirmed.get("SF1").slots.map((s) => s.athlete_id), ["B"]);

  // 官员整场重放：链完整、每个历史候选都能重算复现、公告签名有效。
  const replay = app.view.replayBout("SF1");
  assert.equal(replay.ok, true, JSON.stringify(replay.candidate_checks?.map((c) => c.matches_history)));
  assert.ok(replay.candidate_checks.length >= 3); // 每次改判一个候选 + 最终候选
  assert.equal(replay.candidate_checks.every((c) => c.matches_history), true);
  assert.equal(replay.announced_versions.length, 2);
  assert.equal(replay.announced_versions.every((a) => a.signature_valid), true);
  assert.equal(replay.recompute_matches_current, true);
  assert.ok(replay.timeline.some((t) => t.type === "SCORE_CORRECTED" && t.correction_of === byKey.get("w1-J1")));

  const dv = app.view.delegation("BRA");
  assert.equal(dv.appeals[0].status, "upheld");
  assert.equal(dv.appeals[0].decision.republished, true);

  // 全库哈希链一致。
  assert.equal(app.verifyChain().ok, true);
  app.cleanup();
});

test("申诉驳回：原公告名次保持生效，挂接改判作废、原始证据复活", () => {
  const app = makeApp();
  setupSurfProgram(app);
  const ids = surfScores(app, "SF1", { A: { w1: [8, 8, 8], w2: [6, 6, 6] }, B: { w3: [5, 5, 5], w4: [5, 5, 5] } });
  app.command("projectCandidate", { bout_id: "SF1" });
  app.command("certifyResult", { bout_id: "SF1", signers: ["head"] });
  app.command("publishResult", { bout_id: "SF1", signers: ["arbiter"] });

  app.command("fileAppeal", { appeal_id: "AP2", bout_id: "SF1", against_event_id: ids[0], filed_by: "c", delegation: "BRA", grounds: "争议" });
  app.command("correctScore", {
    bout_id: "SF1",
    correction_of: ids[0],
    appeal_id: "AP2",
    kind: "judge_score",
    reason: "暂改",
    replacement: { judge_id: "J1", wave_id: "w1", athlete_id: "A", score: 0 },
    actor: { id: "jury-1", role: "jury" },
  });
  // 审理中对外仍是 A。
  assert.equal(app.view.publicResults().results.find((r) => r.bout_id === "SF1").winner, "A");

  app.command("decideAppeal", { appeal_id: "AP2", outcome: "rejected", reason: "录像不支持", signers: ["jury"] });
  assert.equal(app.backend.state().appeals.get("AP2").status, "rejected");
  // 驳回后重算候选：被驳回申诉名下的更正作废，原始 J1=8 复活 → A 仍第一。
  app.command("projectCandidate", { bout_id: "SF1" });
  assert.equal(app.backend.state().results.get("SF1").pending.candidate.winner, "A");
  assert.equal(app.view.publicResults().results.find((r) => r.bout_id === "SF1").winner, "A");
  app.cleanup();
});

test("裁判回避：同国籍或明示利害关系不得指派；撤换后评分被拒", () => {
  const app = makeApp();
  activateRule(app, "surfing");
  eligible(app, "A", "JPN");
  app.command("scheduleBout", { bout_id: "SFX", sport: "surfing", athlete_ids: ["A"] });
  app.command("finalizeRoster", { bout_id: "SFX" });

  let err;
  try {
    app.command("assignJudge", { bout_id: "SFX", judge_id: "JN", role: "scoring", nations: ["JPN"] });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof DomainError);
  assert.equal(err.code, "JUDGE_CONFLICT");
  assert.deepEqual(err.conflicts[0].reasons, ["同国籍（JPN）"]);

  // 明示利害关系同样拦截。
  assert.throws(() => app.command("assignJudge", { bout_id: "SFX", judge_id: "JX", role: "scoring", nations: [], conflicts: ["A"] }), (e) => e.code === "JUDGE_CONFLICT");

  app.command("assignJudge", { bout_id: "SFX", judge_id: "JK", role: "scoring", nations: [] });
  app.command("removeJudge", { bout_id: "SFX", judge_id: "JK", reason: "临场回避" });
  app.command("startRound", { bout_id: "SFX", round: 1 });
  assert.throws(() => app.command("submitJudgeScore", { bout_id: "SFX", judge_id: "JK", round: 1, wave_id: "w", athlete_id: "A", score: 7 }), (e) => e.code === "JUDGE_NOT_ASSIGNED");
  app.cleanup();
});
