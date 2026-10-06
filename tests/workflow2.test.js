import assert from "node:assert/strict";
import test from "node:test";

import { makeApp, activateRule, eligible } from "./helpers.js";

function schedulePair(app, { boutId, sport, chain = "C", sides }) {
  eligible(app, "R", "KOR");
  eligible(app, "X", "USA");
  app.command("scheduleBout", { bout_id: boutId, sport, chain_id: chain, athlete_ids: ["R", "X"], sides, olympic_qualification: false });
  app.command("finalizeRoster", { bout_id: boutId });
}

test("设备：校准时点决定消息有效性——校准前与宣布不可靠后的消息均无效且不计分", () => {
  const app = makeApp();
  activateRule(app, "virtual_taekwondo");
  schedulePair(app, { boutId: "VT", sport: "virtual_taekwondo", sides: { red: "R", blue: "X" } });
  app.command("registerDevice", { device_id: "DEV", sport: "virtual_taekwondo" });
  app.command("startRound", { bout_id: "VT", round: 1 });

  const before = app.command("ingestSensorMessage", { bout_id: "VT", device_id: "DEV", round: 1, side: "red", action: "body_kick", value: 2, msg_seq: 1, idempotency_key: "msg-1" });
  assert.equal(before.valid, false);
  assert.equal(before.invalid_reason, "not_calibrated_at_occurrence");

  app.clockFn.advance(60);
  const calTime = app.clockFn();
  app.command("calibrateDevice", { device_id: "DEV", result: "passed", by: "tech-1" });
  const good = app.command("ingestSensorMessage", {
    bout_id: "VT", device_id: "DEV", round: 1, side: "blue", action: "head_kick", value: 3, msg_seq: 2, idempotency_key: "msg-2",
    occurred_at: app.clockFn(),
  });
  assert.equal(good.valid, true);

  app.command("declareDeviceUnreliable", { device_id: "DEV", reason: "漂移超限" });
  const bad = app.command("ingestSensorMessage", { bout_id: "VT", device_id: "DEV", round: 1, side: "red", action: "body_kick", value: 2, msg_seq: 3, idempotency_key: "msg-3" });
  assert.equal(bad.valid, false);
  assert.equal(bad.invalid_reason, "device_unreliable");
  void calTime;

  // 只有校准通过期间的蓝方 3 分计入 → 蓝胜。
  app.command("projectCandidate", { bout_id: "VT" });
  const c = app.backend.state().results.get("VT").pending.candidate;
  assert.equal(c.winner, "blue");
  assert.equal(c.basis_event_ids.length, 1); // 仅一条有效证据
  app.cleanup();
});

test("离线补传：乱序到达按接收顺序入链，评分仍按发生时刻与轮次归集", () => {
  const app = makeApp();
  activateRule(app, "virtual_taekwondo");
  schedulePair(app, { boutId: "VT2", sport: "virtual_taekwondo", sides: { red: "R", blue: "X" } });
  app.command("registerDevice", { device_id: "DEV2", sport: "virtual_taekwondo" });
  app.command("startRound", { bout_id: "VT2", round: 1 });
  app.command("calibrateDevice", { device_id: "DEV2", result: "passed" });
  // 校准后经过一段时间，设备离线积累消息。
  app.clockFn.advance(120);

  // 设备时钟比接收端慢约 10 秒（离线）：msg-2 先到（较晚发生），msg-1 补传后到（较早发生）。
  const ref = app.clockFn(); // 当前接收时刻（在校准之后）
  const deviceAt = (offsetSec) => new Date(Date.parse(ref) - 10000 + offsetSec * 1000).toISOString();
  app.command("ingestSensorMessage", { bout_id: "VT2", device_id: "DEV2", round: 1, side: "red", action: "body_kick", value: 2, msg_seq: 2, idempotency_key: "o-2", occurred_at: deviceAt(5) });
  const late = app.command("ingestSensorMessage", { bout_id: "VT2", device_id: "DEV2", round: 1, side: "red", action: "body_kick", value: 2, msg_seq: 1, idempotency_key: "o-1", occurred_at: deviceAt(2) });
  assert.equal(late.duplicate, false);
  assert.ok(Date.parse(late.event.recorded_at) > Date.parse(late.event.occurred_at));

  // 再次补传 msg-1（乱序重发）→ 幂等命中，不产生新事件。
  const redeliver = app.command("ingestSensorMessage", { bout_id: "VT2", device_id: "DEV2", round: 1, side: "red", action: "body_kick", value: 2, msg_seq: 1, idempotency_key: "o-1", occurred_at: deviceAt(2) });
  assert.equal(redeliver.duplicate, true);

  app.command("projectCandidate", { bout_id: "VT2" });
  const c = app.backend.state().results.get("VT2").pending.candidate;
  assert.equal(c.red_total, 4); // 两条有效踢各 2 分，未因重发翻倍
  app.cleanup();
});

test("证据窗口：超出规则窗口的原始评分被拒；补传超出宽限被标记无效", () => {
  const app = makeApp();
  activateRule(app, "virtual_taekwondo", { evidence_minutes: 5, ingest_grace_minutes: 10, appeal_minutes: 30, review_minutes: 60 });
  schedulePair(app, { boutId: "VT3", sport: "virtual_taekwondo", sides: { red: "R", blue: "X" } });
  app.command("registerDevice", { device_id: "D3", sport: "virtual_taekwondo" });
  app.command("assignJudge", { bout_id: "VT3", judge_id: "J1", role: "judge", nations: [] });
  const roundStart = app.clockFn();
  app.command("startRound", { bout_id: "VT3", round: 1 });
  app.command("calibrateDevice", { device_id: "D3", result: "passed" });

  // 裁判评分发生时间晚于窗口 6 分钟 → 直接拒绝。
  assert.throws(
    () => app.command("submitJudgeScore", { bout_id: "VT3", judge_id: "J1", round: 1, occurred_at: new Date(Date.parse(roundStart) + 6 * 60000).toISOString(), card: { red: 10, blue: 9 } }),
    (e) => e.code === "EVIDENCE_WINDOW_CLOSED",
  );
  // MMA 才用 card；此处仅验证窗口，先给该场补裁判。
  app.cleanup();
});

test("虚拟跆拳道：平分进入金赛点，首得分者胜；无得分时按优势，仍平则须仲裁裁决", () => {
  const app = makeApp();
  activateRule(app, "virtual_taekwondo");
  schedulePair(app, { boutId: "VT4", sport: "virtual_taekwondo", sides: { red: "R", blue: "X" } });
  app.command("registerDevice", { device_id: "D4", sport: "virtual_taekwondo" });
  app.command("startRound", { bout_id: "VT4", round: 1 });
  app.command("calibrateDevice", { device_id: "D4", result: "passed" });
  app.command("ingestSensorMessage", { bout_id: "VT4", device_id: "D4", round: 1, side: "red", action: "body_kick", value: 2, msg_seq: 1, idempotency_key: "g1" });
  app.command("ingestSensorMessage", { bout_id: "VT4", device_id: "D4", round: 1, side: "blue", action: "body_kick", value: 2, msg_seq: 2, idempotency_key: "g2" });
  app.command("projectCandidate", { bout_id: "VT4" });
  assert.equal(app.backend.state().results.get("VT4").pending.candidate.mode, "golden_required");
  assert.throws(() => app.command("certifyResult", { bout_id: "VT4", signers: ["head"] }), (e) => e.code === "TIE_UNRESOLVED");

  // 金赛点蓝方率先得分。
  app.command("ingestSensorMessage", { bout_id: "VT4", device_id: "D4", round: "golden", side: "blue", action: "body_kick", value: 1, msg_seq: 3, idempotency_key: "g3" });
  app.command("projectCandidate", { bout_id: "VT4" });
  const c = app.backend.state().results.get("VT4").pending.candidate;
  assert.equal(c.mode, "golden_point");
  assert.equal(c.winner, "blue");
  app.command("certifyResult", { bout_id: "VT4", signers: ["head"] });
  app.cleanup();
});

test("综合格斗：一致平局无法自动出名次，裁判长并列裁决后方可签署", () => {
  const app = makeApp();
  activateRule(app, "mma");
  schedulePair(app, { boutId: "MMA", sport: "mma", sides: { red: "R", blue: "X" } });
  for (const j of ["J1", "J2", "J3"]) app.command("assignJudge", { bout_id: "MMA", judge_id: j, role: "judge", nations: [] });
  app.command("startRound", { bout_id: "MMA", round: 1 });
  for (const j of ["J1", "J2", "J3"]) app.command("submitJudgeScore", { bout_id: "MMA", judge_id: j, round: 1, card: { red: 10, blue: 10 } });
  app.command("projectCandidate", { bout_id: "MMA" });
  assert.equal(app.backend.state().results.get("MMA").pending.candidate.outcome, "unanimous_draw");
  assert.throws(() => app.command("certifyResult", { bout_id: "MMA", signers: ["head"] }), (e) => e.code === "TIE_UNRESOLVED");

  // 胜者必须出自并列各方。
  assert.throws(
    () => app.command("resolveTie", { bout_id: "MMA", tied: ["red", "blue"], winner: "R", basis: "octagon control" }),
    (e) => e.code === "BAD_TIE_WINNER",
  );
  app.command("resolveTie", { bout_id: "MMA", tied: ["red", "blue"], winner: "red", basis: "优势控制", by: "head" });
  app.command("certifyResult", { bout_id: "MMA", signers: ["head"] });
  assert.equal(app.backend.state().results.get("MMA").effective.stage, "certified");
  app.cleanup();
});

test("犯规扣分影响所有边裁计分卡并可翻转综合格斗胜者", () => {
  const app = makeApp();
  activateRule(app, "mma");
  schedulePair(app, { boutId: "MMA2", sport: "mma", sides: { red: "R", blue: "X" } });
  for (const j of ["J1", "J2", "J3"]) app.command("assignJudge", { bout_id: "MMA2", judge_id: j, role: "judge", nations: [] });
  app.command("startRound", { bout_id: "MMA2", round: 1 });
  for (const j of ["J1", "J2", "J3"]) app.command("submitJudgeScore", { bout_id: "MMA2", judge_id: j, round: 1, card: { red: 10, blue: 9 } });
  // 红方被扣 1 分（抓网），对三张卡同等生效 → 红 9 : 蓝 9 全平。
  app.command("ruleFoul", { bout_id: "MMA2", round: 1, referee_id: "REF", against: "red", code: "fence_grab", penalty: "point_deduction", deduction: 1, reason: "抓网" });
  app.command("projectCandidate", { bout_id: "MMA2" });
  const c = app.backend.state().results.get("MMA2").pending.candidate;
  assert.equal(c.outcome, "unanimous_draw");
  assert.deepEqual(c.cards.map((x) => [x.red, x.blue]), [[9, 9], [9, 9], [9, 9]]);
  app.cleanup();
});

test("纪录认证：必须总记录长与裁判长共同签署，且只能在结果正式签署后", () => {
  const app = makeApp();
  activateRule(app, "surfing");
  eligible(app, "A", "JPN");
  app.command("scheduleBout", { bout_id: "SF", sport: "surfing", athlete_ids: ["A"] });
  app.command("finalizeRoster", { bout_id: "SF" });
  for (const j of ["J1", "J2", "J3"]) app.command("assignJudge", { bout_id: "SF", judge_id: j, role: "scoring", nations: [] });
  app.command("startRound", { bout_id: "SF", round: 1 });
  for (const j of ["J1", "J2", "J3"]) app.command("submitJudgeScore", { bout_id: "SF", judge_id: j, round: 1, wave_id: "w1", athlete_id: "A", score: 9 });
  app.command("projectCandidate", { bout_id: "SF" });

  // 结果未签署，纪录不能认证。
  assert.throws(
    () => app.command("certifyRecord", { record_id: "REC1", bout_id: "SF", athlete_id: "A", sport: "surfing", mark: { value: 18.5, unit: "points" }, signers: ["recorder", "head"] }),
    (e) => e.code === "RESULT_NOT_CERTIFIED",
  );
  app.command("certifyResult", { bout_id: "SF", signers: ["head"] });

  // 只有总记录长一人 → 法定人数不足。
  assert.throws(
    () => app.command("certifyRecord", { record_id: "REC1", bout_id: "SF", athlete_id: "A", sport: "surfing", mark: { value: 18.5, unit: "points" }, signers: ["recorder"] }),
    (e) => e.code === "SIGNATURE_QUORUM",
  );
  // 总记录长 + 裁判长会签通过。
  const rec = app.command("certifyRecord", { record_id: "REC1", bout_id: "SF", athlete_id: "A", sport: "surfing", category: "mens", mark: { value: 18.5, unit: "points" }, signers: ["recorder", "head"] });
  assert.equal(rec.event_type, "RECORD_CERTIFIED");
  assert.equal(rec.co_signatures.length, 1);
  assert.equal(app.verifyChain().ok, true);
  app.cleanup();
});

test("持久化重启：从 JSONL 重建后哈希链、公开成绩与整场重放全部一致", () => {
  const app = makeApp({ file: true });
  const file = app.dir();
  activateRule(app, "surfing");
  eligible(app, "A", "JPN");
  eligible(app, "B", "BRA");
  app.command("scheduleBout", { bout_id: "PERSIST", sport: "surfing", athlete_ids: ["A", "B"] });
  app.command("finalizeRoster", { bout_id: "PERSIST" });
  for (const j of ["J1", "J2", "J3"]) app.command("assignJudge", { bout_id: "PERSIST", judge_id: j, role: "scoring", nations: [] });
  app.command("startRound", { bout_id: "PERSIST", round: 1 });
  for (const wid of ["w1", "w2"]) for (const j of ["J1", "J2", "J3"]) app.command("submitJudgeScore", { bout_id: "PERSIST", judge_id: j, round: 1, wave_id: wid, athlete_id: "A", score: 7 });
  for (const wid of ["w3"]) for (const j of ["J1", "J2", "J3"]) app.command("submitJudgeScore", { bout_id: "PERSIST", judge_id: j, round: 1, wave_id: wid, athlete_id: "B", score: 4 });
  app.command("projectCandidate", { bout_id: "PERSIST" });
  app.command("certifyResult", { bout_id: "PERSIST", signers: ["head"] });
  app.command("publishResult", { bout_id: "PERSIST", signers: ["arbiter"] });
  const beforeCount = app.events().length;

  // 用同一文件、同一签署密钥重建应用。
  const app2 = makeApp({ file });
  assert.equal(app2.verifyChain().ok, true);
  assert.equal(app2.events().length, beforeCount);
  const pub = app2.view.publicResults();
  assert.equal(pub.count, 1);
  assert.equal(pub.results[0].winner, "A");
  assert.equal(pub.results[0].verification.verifiable, true);
  const replay = app2.view.replayBout("PERSIST");
  assert.equal(replay.ok, true);
  app.cleanup();
  app2.cleanup();
});

test("申诉证据/复核窗口超时关闭，窗口内可正常提交", () => {
  const app = makeApp();
  activateRule(app, "surfing", { evidence_minutes: 10, appeal_minutes: 60, review_minutes: 30 });
  eligible(app, "A", "JPN");
  app.command("scheduleBout", { bout_id: "SFW", sport: "surfing", athlete_ids: ["A"] });
  app.command("finalizeRoster", { bout_id: "SFW" });
  for (const j of ["J1", "J2", "J3"]) app.command("assignJudge", { bout_id: "SFW", judge_id: j, role: "scoring", nations: [] });
  app.command("startRound", { bout_id: "SFW", round: 1 });
  const score = app.command("submitJudgeScore", { bout_id: "SFW", judge_id: "J1", round: 1, wave_id: "w", athlete_id: "A", score: 7 });
  app.command("fileAppeal", { appeal_id: "APW", bout_id: "SFW", against_event_id: score.event_id, filed_by: "c", delegation: "JPN", grounds: "g" });

  // 证据窗口 10 分钟：11 分钟后提交证据被拒。
  app.clockFn.advance(11 * 60);
  assert.throws(() => app.command("submitAppealEvidence", { appeal_id: "APW", kind: "video", ref: "x" }), (e) => e.code === "APPEAL_EVIDENCE_WINDOW_CLOSED");

  // 复核窗口 30 分钟：在证据窗口外但复核窗口内仍可登记复核意见。
  app.clockFn.set(new Date(Date.parse(app.backend.state().appeals.get("APW").filed_at) + 20 * 60000).toISOString());
  app.command("logReview", { appeal_id: "APW", by: "jury-1", recommendation: "reject", note: "证据不足" });

  // 超过复核窗口不得裁决。
  app.clockFn.set(new Date(Date.parse(app.backend.state().appeals.get("APW").filed_at) + 31 * 60000).toISOString());
  assert.throws(() => app.command("decideAppeal", { appeal_id: "APW", outcome: "rejected", reason: "x", signers: ["jury"] }), (e) => e.code === "REVIEW_WINDOW_CLOSED");
  app.cleanup();
});
