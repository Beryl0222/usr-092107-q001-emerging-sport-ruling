import assert from "node:assert/strict";
import test from "node:test";

import { officialReplay, publicView, teamView, verifyEvent } from "../src/views.js";
import { newGame } from "./helpers/fixtures.js";

function publishSimpleSurf(svc, store, boutId = "SF-A") {
  svc.startRound({ bout_id: boutId, round_no: 1 });
  const waveScores = {
    [boutId === "SF-A" ? "surf-jpn-1" : "surf-jpn-2"]: { 1: [8, 8, 8], 2: [7, 7, 7] },
    [boutId === "SF-A" ? "surf-bra-1" : "surf-bra-2"]: { 1: [6, 6, 6], 2: [5, 5, 5] },
  };
  for (const [athleteId, waves] of Object.entries(waveScores)) {
    for (const [waveNo, scores] of Object.entries(waves)) {
      scores.forEach((score, j) => {
        svc.recordEvidence({
          bout_id: boutId, kind: "wave_judge_score", judge_id: ["j1", "j2", "j3"][j],
          data: { athlete_id: athleteId, wave_no: Number(waveNo), score },
        });
      });
    }
  }
  svc.endRound({ bout_id: boutId, round_no: 1 });
  svc.endBout({ bout_id: boutId });
  svc.computeCandidate({ bout_id: boutId });
  svc.certifyResult({ bout_id: boutId, official_id: "pres" });
  svc.publishResult({ bout_id: boutId, official_id: "td" });
}

test("公开视图：只展示已发布成绩，候选/签署中均不可见；带三级核验锚点", () => {
  const { store, svc } = newGame();
  publishSimpleSurf(svc, store, "SF-A"); // 已发布
  // SF-B 只形成候选
  svc.startRound({ bout_id: "SF-B", round_no: 1 });
  svc.endRound({ bout_id: "SF-B", round_no: 1 });
  svc.endBout({ bout_id: "SF-B" });
  svc.computeCandidate({ bout_id: "SF-B" });

  const view = publicView(store);
  assert.equal(view.healthy, true);
  assert.deepEqual(view.results.map((r) => r.bout_id), ["SF-A"]);
  const row = view.results[0];
  assert.equal(row.sport, "surfing");
  assert.equal(row.rules_version, "2026.1");
  assert.ok(row.verify.published.content_hash);
  assert.ok(row.verify.certified.content_hash);
  assert.ok(row.verify.candidate.content_hash);
});

test("公开视图：哈希链被破坏时不公布任何成绩", () => {
  const { store, svc } = newGame();
  publishSimpleSurf(svc, store);
  store.all().find((e) => e.event_type === "RESULT_PUBLISHED").payload.standings[0].score = 999;
  const view = publicView(store);
  assert.equal(view.healthy, false);
  assert.equal(view.results.length, 0);
});

test("代表队视图：展示本队相关场次的申诉状态、截止时间与冻结标记", () => {
  const { svc } = newGame();
  publishSimpleSurf(svc, null, "SF-A");
  const appealId = svc.fileAppeal({ bout_id: "SF-B", filed_by: "JPN", reason: "等待评分" });
  svc.startRound({ bout_id: "SF-B", round_no: 1 });
  svc.endRound({ bout_id: "SF-B", round_no: 1 });
  svc.endBout({ bout_id: "SF-B" });

  const japan = teamView(svc.store, "JPN");
  const ids = japan.items.map((i) => i.bout_id).sort();
  assert.deepEqual(ids, ["FINAL", "SF-A", "SF-B"]);
  const sfA = japan.items.find((i) => i.bout_id === "SF-A");
  assert.equal(sfA.result_stage, "published");
  assert.equal(sfA.advancement_frozen, false);
  const sfB = japan.items.find((i) => i.bout_id === "SF-B");
  assert.equal(sfB.advancement_frozen, true);
  assert.equal(sfB.appeals[0].id, appealId);
  assert.equal(sfB.appeals[0].status, "filed");
  assert.ok(sfB.appeal_deadline);
  // 别的队看不到日本队的行
  const brazil = teamView(svc.store, "BRA");
  assert.ok(!brazil.items.find((i) => i.bout_id === "SF-B" && i.advancement_frozen === false));
});

test("官员重放：完整时间线、改判链、锚点与重放确定性", () => {
  const { store, svc } = newGame();
  publishSimpleSurf(svc, store);
  const appealId = svc.fileAppeal({ bout_id: "SF-A", filed_by: "JPN", reason: "误触" });
  svc.openReview({ appeal_id: appealId, official_id: "pres" });
  const replay1 = officialReplay(store, "SF-A");
  const target = replay1.current_evidence.wave_judge_score.find((e) => e.athlete_id === "surf-jpn-1");
  svc.amendRuling({
    target_id: target.event_id, action: "correct", correction: { score: 9.0 },
    reason: "终端误触", official_id: "pres", appeal_id: appealId,
  });
  svc.decideAppeal({ appeal_id: appealId, official_id: "pres", decision: "rejected" });

  const replay = officialReplay(store, "SF-A");
  assert.equal(replay.bout.id, "SF-A");
  assert.equal(replay.bout.rules_version, "2026.1");
  assert.ok(replay.timeline.length >= 10);
  // 时间线按事实时间排列
  const times = replay.timeline.map((t) => t.occurred_at);
  assert.deepEqual(times, [...times].sort());
  assert.equal(replay.amendments.length, 1);
  assert.equal(replay.amendments[0].target_id, target.event_id);
  assert.equal(replay.frozen, null);
  assert.equal(replay.chain_valid, true);
  assert.ok(replay.verification.published.content_hash);

  // 重放是纯派生：同一份日志两次重放结果一致
  const replayAgain = officialReplay(store, "SF-A");
  assert.equal(
    JSON.stringify(replayAgain.timeline),
    JSON.stringify(replay.timeline),
  );
  assert.equal(officialReplay(store, "UNKNOWN"), null);
});

test("单事件核验：重算正文哈希与存储哈希一致", () => {
  const { store, svc } = newGame();
  const event = svc.publishRulebook({ sport: "mma", rules_version: "2099.1", effective_from: new Date().toISOString() });
  const verdict = verifyEvent(store, event.event_id);
  assert.equal(verdict.matches, true);
  assert.equal(verdict.stored_hash, verdict.recomputed_hash);
  assert.equal(verifyEvent(store, "nope"), null);
});
