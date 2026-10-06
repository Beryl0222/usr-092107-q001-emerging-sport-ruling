import assert from "node:assert/strict";
import test from "node:test";

import { DomainError, RulingService } from "../src/services.js";
import { EventStore } from "../src/store.js";
import { fold } from "../src/projection.js";
import { newGame } from "./helpers/fixtures.js";

const expectError = (code, fn) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof DomainError || err.code, `期望领域错误，实际：${err}`);
    assert.equal(err.code, code);
    return true;
  });
};

test("资格：未取得有效资格的运动员不能出场，撤销后同样被拒", () => {
  const { svc } = newGame();
  svc.registerAthlete({ athlete_id: "nobody", name: "无资格选手", team_id: "X" });
  expectError("NOT_ELIGIBLE", () =>
    svc.qualifyParticipant({ bout_id: "SF-A", athlete_id: "nobody", competition_id: "AG2026" }),
  );
  svc.grantEligibility({ athlete_id: "nobody", competition_id: "AG2026" });
  svc.qualifyParticipant({ bout_id: "SF-A", athlete_id: "nobody", competition_id: "AG2026" });
  svc.revokeEligibility({ athlete_id: "nobody", competition_id: "AG2026", reason: "资格复查未过" });
  expectError("NOT_ELIGIBLE", () =>
    svc.qualifyParticipant({ bout_id: "SF-A", athlete_id: "nobody", competition_id: "AG2026" }),
  );
});

test("回避：声明国籍/同队冲突的裁判不能被指派到相关场次", () => {
  const { svc } = newGame();
  svc.declareConflict({
    official_id: "j4", conflict_type: "nationality", ref_id: "JPN",
    reason: "日本籍裁判回避日本队场次",
  });
  // SF-A 含 surf-jpn-1
  expectError("JUDGE_CONFLICT", () =>
    svc.assignPanel({ bout_id: "SF-A", seats: [{ official_id: "j4", role: "judge" }] }),
  );
  // SF-B 也含日本队选手
  expectError("JUDGE_CONFLICT", () =>
    svc.assignPanel({ bout_id: "SF-B", seats: [{ official_id: "j4", role: "judge" }] }),
  );
  // MMA 场与日本队无关，可以指派
  svc.scheduleBout({
    bout_id: "MMA-X", sport: "mma", round_label: "预赛",
    entries: ["mma-red", "mma-blue"], scheduled_at: new Date().toISOString(),
  });
  svc.assignPanel({ bout_id: "MMA-X", seats: [{ official_id: "j4", role: "judge" }] });
});

test("设备：未登记、未绑定、校准过期的传感器消息全部隔离，且不参与计算", () => {
  const { svc, advance, at } = newGame();
  svc.registerDevice({ device_id: "dev", device_type: "sensor" });
  svc.calibrateDevice({
    device_id: "dev", result: "pass",
    valid_until: new Date(new Date(at()).getTime() + 5 * 60_000).toISOString(), certifier_id: "td",
  });
  svc.scheduleBout({
    bout_id: "VTK-X", sport: "virtual_taekwondo", round_label: "决赛",
    entries: ["vtk-kor-1", "vtk-kor-2"],
  });

  const stranger = svc.recordEvidence({
    bout_id: "VTK-X", kind: "sensor_hit", device_id: "dev-stranger",
    data: { athlete_id: "vtk-kor-1", target: "head" },
  });
  assert.equal(stranger.quarantined, true);

  const unbound = svc.recordEvidence({
    bout_id: "VTK-X", kind: "sensor_hit", device_id: "dev",
    data: { athlete_id: "vtk-kor-1", target: "head" },
  });
  assert.equal(unbound.quarantined, true);

  svc.bindDevice({ device_id: "dev", bout_id: "VTK-X" });
  const valid = svc.recordEvidence({
    bout_id: "VTK-X", kind: "sensor_hit", device_id: "dev",
    data: { athlete_id: "vtk-kor-1", target: "body" },
  });
  assert.equal(valid.quarantined, false);

  advance(10); // 超出校准 5 分钟有效期
  const expired = svc.recordEvidence({
    bout_id: "VTK-X", kind: "sensor_hit", device_id: "dev",
    data: { athlete_id: "vtk-kor-2", target: "head" },
  });
  assert.equal(expired.quarantined, true);
  assert.match(expired.reason, /校准/);
});

test("窗口：证据/申诉窗口关闭后拒绝接收，窗口内补传有效", () => {
  const { svc, advance } = newGame();
  svc.startRound({ bout_id: "SF-A", round_no: 1 });
  advance(8);
  svc.endRound({ bout_id: "SF-A", round_no: 1 });
  svc.endBout({ bout_id: "SF-A" }); // 证据窗 30 分钟、申诉窗 15 分钟

  advance(10); // 比赛结束后 10 分钟：两个窗口都仍开放
  const lateWave = svc.recordEvidence({
    bout_id: "SF-A", kind: "wave_judge_score", judge_id: "j1",
    data: { athlete_id: "surf-bra-1", wave_no: 1, score: 7.0 },
  });
  assert.equal(lateWave.quarantined, false);

  const appealId = svc.fileAppeal({ bout_id: "SF-A", filed_by: "BRA", reason: "补分异议" });
  advance(21); // 距结束 31 分钟：申诉窗（15）、证据窗（30）均已关闭
  expectError("EVIDENCE_WINDOW_CLOSED", () =>
    svc.recordEvidence({
      bout_id: "SF-A", kind: "wave_judge_score", judge_id: "j2",
      data: { athlete_id: "surf-bra-1", wave_no: 2, score: 8.0 },
    }),
  );
  // 新申诉不能再提出
  expectError("APPEAL_WINDOW_CLOSED", () =>
    svc.fileAppeal({ bout_id: "SF-A", filed_by: "BRA", reason: "超时再诉" }),
  );
  assert.ok(appealId);
});

test("改判必须引用原记录：原记录保留并指向改判事件，且只能引用现行版本", () => {
  const { svc, store, waveScores, finishSurf } = newGame();
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [6, 6, 6], 2: [5.5, 5.5, 5.5] },
    "surf-bra-1": { 1: [7, 7, 7], 2: [6.5, 6.5, 6.5] },
  });
  finishSurf("SF-A");
  const state1 = fold(store.all());
  const original = [...state1.evidence.values()].find(
    (e) => e.bout_id === "SF-A" && e.athlete_id === "surf-jpn-1" && e.wave_no === 2 && e.judge_id === "j1",
  );

  const appealId = svc.fileAppeal({ bout_id: "SF-A", filed_by: "JPN", reason: "终端误触" });
  svc.openReview({ appeal_id: appealId, official_id: "pres" });
  const amended = svc.amendRuling({
    target_id: original.event_id, action: "correct",
    correction: { score: 8.5 }, reason: "5.5 误触，应为 8.5",
    official_id: "pres", appeal_id: appealId,
  });

  const state2 = fold(store.all());
  assert.equal(state2.evidence.get(original.event_id).status, "superseded");
  assert.equal(state2.evidence.get(original.event_id).superseded_by, amended.event_id);
  const current = state2.evidence.get(amended.event_id);
  assert.equal(current.score, 8.5);
  assert.equal(current.origin_id, original.event_id);

  // 原记录不能被再次改判
  expectError("TARGET_NOT_CURRENT", () =>
    svc.amendRuling({ target_id: original.event_id, action: "void", reason: "二次改原记录", official_id: "pres" }),
  );
});

test("申诉定向冻结：只冻结本场及下游晋级链，无关场次照常完赛与发布", () => {
  const { svc, waveScores, finishSurf } = newGame();
  // SF-B 先完赛签署（无申诉）
  waveScores("SF-B", {
    "surf-bra-2": { 1: [8, 8, 8], 2: [7.5, 7.5, 7.5] },
    "surf-jpn-2": { 1: [5, 5, 5], 2: [6, 6, 6] },
  });
  finishSurf("SF-B");
  svc.certifyResult({ bout_id: "SF-B", official_id: "pres" });
  svc.publishResult({ bout_id: "SF-B", official_id: "td" });

  // SF-A 完赛后申诉
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [6, 6, 6] },
    "surf-bra-1": { 1: [7, 7, 7] },
  });
  finishSurf("SF-A");
  svc.fileAppeal({ bout_id: "SF-A", filed_by: "JPN", reason: "评分异议" });

  // SF-A 晋级冻结
  expectError("ADVANCEMENT_FROZEN", () => svc.confirmAdvancement({ bout_id: "SF-A", official_id: "pres" }));
  // 下游 FINAL 也冻结，SF-B 的胜者无法在申诉期间送入决赛
  expectError("ADVANCEMENT_FROZEN", () => svc.confirmAdvancement({ bout_id: "SF-B", official_id: "pres" }));

  // 无关的 MMA 场次照常推进并发布
  svc.scheduleBout({
    bout_id: "MMA-OK", sport: "mma", round_label: "预赛",
    entries: ["mma-red", "mma-blue"],
  });
  svc.assignPanel({
    bout_id: "MMA-OK",
    seats: [
      { official_id: "j1", role: "judge" }, { official_id: "j2", role: "judge" },
      { official_id: "j3", role: "judge" }, { official_id: "ref1", role: "referee" },
    ],
  });
  for (let round = 1; round <= 3; round += 1) {
    svc.startRound({ bout_id: "MMA-OK", round_no: round });
    for (const judge of ["j1", "j2", "j3"]) {
      svc.recordEvidence({
        bout_id: "MMA-OK", kind: "round_scorecard", judge_id: judge,
        data: { round_no: round, red: { points: 10 }, blue: { points: 9 } },
      });
    }
    svc.endRound({ bout_id: "MMA-OK", round_no: round });
  }
  svc.endBout({ bout_id: "MMA-OK" });
  svc.computeCandidate({ bout_id: "MMA-OK" });
  svc.certifyResult({ bout_id: "MMA-OK", official_id: "pres" });
  svc.publishResult({ bout_id: "MMA-OK", official_id: "td" }); // 不抛错即通过
});

test("申诉驳回也解冻；成立必须先改判", () => {  const { svc, waveScores, finishSurf } = newGame();
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [6, 6, 6] },
    "surf-bra-1": { 1: [7, 7, 7] },
  });
  finishSurf("SF-A");
  const appealId = svc.fileAppeal({ bout_id: "SF-A", filed_by: "JPN", reason: "异议" });
  svc.openReview({ appeal_id: appealId, official_id: "pres" });
  expectError("AMENDMENT_REQUIRED", () =>
    svc.decideAppeal({ appeal_id: appealId, official_id: "pres", decision: "upheld" }),
  );
  svc.decideAppeal({ appeal_id: appealId, official_id: "pres", decision: "rejected", note: "证据不足" });
  // 解冻后可签署（候选无并列）
  svc.certifyResult({ bout_id: "SF-A", official_id: "pres" });
});

test("申诉撤回同样解冻晋级链，并显式落 ADVANCEMENT_RELEASED 事件", () => {
  const { svc, store, waveScores, finishSurf } = newGame();
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [6, 6, 6] },
    "surf-bra-1": { 1: [7, 7, 7] },
  });
  finishSurf("SF-A");
  const appealId = svc.fileAppeal({ bout_id: "SF-A", filed_by: "JPN", reason: "异议" });
  assert.ok(store.byType("ADVANCEMENT_FROZEN").length === 1);
  // 裁决前撤回
  svc.withdrawAppeal({ appeal_id: appealId, filed_by: "JPN", reason: "补充材料不足" });
  assert.equal(store.byType("APPEAL_WITHDRAWN").length, 1);
  assert.equal(store.byType("ADVANCEMENT_RELEASED").length, 1);
  const state = fold(store.all());
  assert.equal(state.frozenBouts.has("SF-A"), false);
  assert.equal(state.frozenBouts.has("FINAL"), false);
  // 已结束的申诉不能重复撤回
  expectError("APPEAL_CLOSED", () =>
    svc.withdrawAppeal({ appeal_id: appealId, filed_by: "JPN" }),
  );
  // 解冻后晋级确认恢复（先签署）
  svc.certifyResult({ bout_id: "SF-A", official_id: "pres" });
  svc.confirmAdvancement({ bout_id: "SF-A", official_id: "pres" });
});

test("签署权限：自动计算只是候选；无签署角色不能确认，未签署不能发布", () => {
  const { svc, waveScores, finishSurf } = newGame();
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [6, 6, 6] },
    "surf-bra-1": { 1: [7, 7, 7] },
  });
  finishSurf("SF-A");
  expectError("FORBIDDEN", () => svc.certifyResult({ bout_id: "SF-A", official_id: "j1" }));
  expectError("FORBIDDEN", () => svc.certifyResult({ bout_id: "SF-A", official_id: "ref1" })); // referee 不能签署成绩
  expectError("NOT_CERTIFIED", () => svc.publishResult({ bout_id: "SF-A", official_id: "td" }));
  svc.certifyResult({ bout_id: "SF-A", official_id: "pres" }); // 仲裁主任可签署
  expectError("FORBIDDEN", () => svc.publishResult({ bout_id: "SF-A", official_id: "j1" }));
  svc.publishResult({ bout_id: "SF-A", official_id: "td" }); // 技术代表可发布
});

test("并列未突破不能签署；突破决定重排名次后可签署", () => {
  const { svc, waveScores, finishSurf } = newGame();
  // 两人总分恰好 13.5 平
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [7, 7, 7], 2: [6.5, 6.5, 6.5] },
    "surf-bra-1": { 1: [7, 7, 7], 2: [6.5, 6.5, 6.5] },
  });
  const candidate = finishSurf("SF-A");
  assert.ok(candidate.payload.candidate.entries.some((e) => e.tie?.unresolved));
  expectError("TIE_UNRESOLVED", () => svc.certifyResult({ bout_id: "SF-A", official_id: "pres" }));

  // 无并列时强行裁决需要显式 force
  const { svc: svc2, waveScores: ws2, finishSurf: fs2 } = newGame();
  ws2("SF-A", {
    "surf-jpn-1": { 1: [8, 8, 8] },
    "surf-bra-1": { 1: [6, 6, 6] },
  });
  fs2("SF-A");
  expectError("NO_TIE", () =>
    svc2.resolveTie({ bout_id: "SF-A", winner: "surf-jpn-1", method: "m", official_id: "pres" }),
  );

  // 并列突破后重算候选，名次唯一，可签署
  svc.resolveTie({
    bout_id: "SF-A", winner: "surf-jpn-1", method: "highest_single_wave",
    reason: "回看单浪最高分", official_id: "pres",
  });
  const recalc = svc.computeCandidate({ bout_id: "SF-A" });
  assert.deepEqual(recalc.payload.candidate.winners, ["surf-jpn-1"]);
  assert.ok(recalc.payload.candidate.entries.every((e) => !e.tie?.unresolved));
  svc.certifyResult({ bout_id: "SF-A", official_id: "pres" });
});

test("奥运资格：仅已发布的冲浪成绩可分配配额；分配后证据链锁定不可改写", () => {
  const { svc, store, waveScores, finishSurf } = newGame();
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [8, 8, 8] },
    "surf-bra-1": { 1: [6, 6, 6] },
  });
  finishSurf("SF-A");
  expectError("NOT_PUBLISHED", () =>
    svc.allocateOlympicQuota({ bout_id: "SF-A", athlete_id: "surf-jpn-1", games: "2028", official_id: "td" }),
  );
  svc.certifyResult({ bout_id: "SF-A", official_id: "pres" });
  svc.publishResult({ bout_id: "SF-A", official_id: "td" });
  svc.allocateOlympicQuota({ bout_id: "SF-A", athlete_id: "surf-jpn-1", games: "2028", official_id: "td" });
  expectError("QUOTA_ALREADY_ALLOCATED", () =>
    svc.allocateOlympicQuota({ bout_id: "SF-A", athlete_id: "surf-jpn-1", games: "2028", official_id: "td" }),
  );

  const state = fold(store.all());
  const evidence = [...state.evidence.values()].find((e) => e.bout_id === "SF-A");
  expectError("OLYMPIC_LOCKED", () =>
    svc.amendRuling({ target_id: evidence.event_id, action: "void", reason: "赛后改写", official_id: "pres" }),
  );
  expectError("OLYMPIC_LOCKED", () =>
    svc.imposePenalty({
      bout_id: "SF-A", athlete_id: "surf-jpn-1", official_id: "ref1",
      kind: "interference", deduction_points: 1, reason: "赛后追加判罚",
    }),
  );
});

test("纪录认证必须基于已发布成绩，且需纪录委员会角色", () => {
  const { svc, waveScores, finishSurf } = newGame();
  waveScores("SF-A", {
    "surf-jpn-1": { 1: [9.5, 9.5, 9.5] },
    "surf-bra-1": { 1: [5, 5, 5] },
  });
  finishSurf("SF-A");
  expectError("NOT_PUBLISHED", () =>
    svc.ratifyRecord({ bout_id: "SF-A", athlete_id: "surf-jpn-1", label: "单浪纪录", value: 9.5, official_id: "rec1" }),
  );
  svc.certifyResult({ bout_id: "SF-A", official_id: "pres" });
  svc.publishResult({ bout_id: "SF-A", official_id: "td" });
  expectError("FORBIDDEN", () =>
    svc.ratifyRecord({ bout_id: "SF-A", athlete_id: "surf-jpn-1", label: "单浪纪录", value: 9.5, official_id: "pres" }),
  );
  const record = svc.ratifyRecord({
    bout_id: "SF-A", athlete_id: "surf-jpn-1", label: "单浪最高分", value: 9.5,
    official_id: "rec1", witnesses: ["pres"],
  });
  assert.equal(record.event_type, "RECORD_RATIFIED");
});

test("规则版本：同赛项激活新版本后旧版本失效，场次固定引用编排时的版本", () => {
  const store = new EventStore();
  const svc = new RulingService(store);
  svc.publishRulebook({ sport: "mma", rules_version: "2026.1", config: {}, effective_from: new Date().toISOString() });
  svc.activateRulebook({ sport: "mma", rulebook_id: "rule-mma-2026-1" });
  svc.scheduleBout({
    bout_id: "MMA-PIN", sport: "mma", round_label: "锁定版本场",
    entries: ["mma-red", "mma-blue"],
  });
  svc.publishRulebook({ sport: "mma", rules_version: "2027.0", config: {}, effective_from: new Date().toISOString() });
  svc.activateRulebook({ sport: "mma", rulebook_id: "rule-mma-2027-0" });

  const state = fold(store.all());
  assert.equal(state.rulebooks.get("rule-mma-2026-1").status, "superseded");
  assert.equal(state.rulebooks.get("rule-mma-2027-0").status, "active");
  // 已编排场次仍引用旧版本，重放按旧规则
  assert.equal(state.bouts.get("MMA-PIN").rulebook_id, "rule-mma-2026-1");
});
