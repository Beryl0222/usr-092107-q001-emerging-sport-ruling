import assert from "node:assert/strict";
import test from "node:test";

import { compute, trimmedMean } from "../src/scoring.js";

test("trimmedMean：去极值平均；不足三人时直接平均", () => {
  assert.equal(trimmedMean([5, 7, 9]), 7);
  assert.equal(trimmedMean([5.5, 8.5, 8.5]), 8.5);
  assert.equal(trimmedMean([8, 10]), 9);
  assert.equal(trimmedMean([6]), 6);
});

test("冲浪：取两条最高分浪、组内去极值平均，干扰扣分作用于总分", () => {
  const result = compute("surfing", {
    entries: ["A", "B"],
    evidence: {
      wave_judge_score: [
        // A：浪1 三人 7，浪2 三人 6，浪3 三人 9（取 9 和 7）
        ...[7, 7, 7].map((score) => ({ athlete_id: "A", wave_no: 1, score })),
        ...[6, 6, 6].map((score) => ({ athlete_id: "A", wave_no: 2, score })),
        ...[9, 9, 9].map((score) => ({ athlete_id: "A", wave_no: 3, score })),
        // B：两条 8，另有 1 分干扰扣减
        ...[8, 8, 8].map((score) => ({ athlete_id: "B", wave_no: 1, score })),
        ...[8, 8, 8].map((score) => ({ athlete_id: "B", wave_no: 2, score })),
      ],
    },
    penalties: [{ athlete_id: "B", deduction_points: 1 }],
  });
  const a = result.entries.find((r) => r.athlete_id === "A");
  const b = result.entries.find((r) => r.athlete_id === "B");
  assert.equal(a.score, 16);
  assert.deepEqual(a.detail.counted, [3, 1]);
  assert.equal(b.gross_score, 16);
  assert.equal(b.deduction, 1);
  assert.equal(b.score, 15);
  assert.equal(a.rank, 1);
  assert.equal(b.rank, 2);
  assert.deepEqual(result.winners, ["A"]);
});

test("冲浪：单条极端裁判分被去除，不影响浪次得分", () => {
  const result = compute("surfing", {
    entries: ["A"],
    evidence: {
      wave_judge_score: [
        { athlete_id: "A", wave_no: 1, score: 2 },
        { athlete_id: "A", wave_no: 1, score: 8 },
        { athlete_id: "A", wave_no: 1, score: 8 },
      ],
    },
    penalties: [],
  });
  assert.equal(result.entries[0].detail.waves[0].score, 8);
});

test("综合格斗：三裁判一致判定，台上裁判扣分对全体记分卡生效", () => {
  const scorecards = [];
  for (const roundNo of [1, 2, 3]) {
    for (const judge_id of ["j1", "j2", "j3"]) {
      scorecards.push({
        judge_id,
        round_no: roundNo,
        red: { points: roundNo === 2 ? 10 : 10 },
        blue: { points: 9 },
      });
    }
  }
  const result = compute("mma", {
    entries: ["red", "blue"],
    evidence: { round_scorecard: scorecards },
    penalties: [
      { athlete_id: "blue", round_no: 2, deduction_points: 1, applies_to: "all_judges" },
    ],
  });
  for (const card of result.entries[0].detail.cards) {
    assert.equal(card.red_total, 30);
    assert.equal(card.blue_total, 9 + 8 + 9); // 第二回合 9-1
    assert.equal(card.vote, "red");
  }
  assert.equal(result.entries[0].detail.method, "unanimous_decision");
  assert.deepEqual(result.winners, ["red"]);
});

test("综合格斗：分歧判定 2:1", () => {
  const scorecards = [];
  const votes = { j1: "red", j2: "red", j3: "blue" };
  for (const [judge_id, winner] of Object.entries(votes)) {
    for (const round_no of [1, 2, 3]) {
      scorecards.push({
        judge_id, round_no,
        red: { points: winner === "red" ? 10 : 9 },
        blue: { points: winner === "blue" ? 10 : 9 },
      });
    }
  }
  const result = compute("mma", {
    entries: ["red", "blue"],
    evidence: { round_scorecard: scorecards },
    penalties: [],
  });
  assert.equal(result.entries[0].detail.method, "split_decision");
  assert.deepEqual(result.winners, ["red"]);
});

test("综合格斗：两张平票卡形成多数平，输出并列待突破", () => {
  const scorecards = [];
  const votes = { j1: "red", j2: "draw", j3: "draw" };
  for (const [judge_id, vote] of Object.entries(votes)) {
    for (const round_no of [1, 2, 3]) {
      scorecards.push({
        judge_id, round_no,
        red: { points: vote === "blue" ? 9 : 10 },
        blue: { points: vote === "red" ? 9 : 10 },
      });
    }
  }
  const result = compute("mma", {
    entries: ["red", "blue"],
    evidence: { round_scorecard: scorecards },
    penalties: [],
  });
  assert.equal(result.entries[0].detail.method, "majority_draw");
  assert.deepEqual(result.winners, []);
  assert.ok(result.tie);
});

test("综合格斗：KO/降服等终止证据直接定胜，不再依赖记分卡", () => {
  const result = compute("mma", {
    entries: ["red", "blue"],
    evidence: {
      round_scorecard: [
        { judge_id: "j1", round_no: 1, red: { points: 8 }, blue: { points: 10 } },
      ],
      bout_outcome: [{ winner_athlete_id: "red", method: "knockout", round_no: 2 }],
    },
    penalties: [],
  });
  assert.equal(result.entries[0].detail.method, "knockout");
  assert.deepEqual(result.winners, ["red"]);
  assert.equal(result.entries[0].athlete_id, "red");
});

test("虚拟跆拳道：躯干 2 分、头部 5 分；gam-jeom 给对方加分", () => {
  const result = compute("virtual_taekwondo", {
    entries: ["K1", "K2"],
    evidence: {
      sensor_hit: [
        { athlete_id: "K1", target: "body", accepted: true },
        { athlete_id: "K1", target: "body", accepted: true },
        { athlete_id: "K1", target: "head", accepted: true },
        { athlete_id: "K2", target: "body", accepted: true },
        { athlete_id: "K2", target: "head", accepted: false }, // 被裁判/设备判无效
      ],
    },
    penalties: [{ athlete_id: "K2", kind: "gam-jeom", points: 1 }],
  });
  const k1 = result.entries.find((r) => r.athlete_id === "K1");
  const k2 = result.entries.find((r) => r.athlete_id === "K2");
  assert.equal(k1.detail.sensor_points, 9); // 2*2+5
  assert.equal(k1.detail.penalty_points_awarded, 1);
  assert.equal(k1.score, 10);
  assert.equal(k2.detail.sensor_points, 2);
  assert.equal(k2.detail.rejected_hits, 1);
  assert.equal(k2.score, 2);
  assert.deepEqual(result.winners, ["K1"]);
});

test("虚拟跆拳道：融合裁判艺术分时去极值平均并计入", () => {
  const result = compute("virtual_taekwondo", {
    entries: ["K1", "K2"],
    evidence: {
      sensor_hit: [{ athlete_id: "K1", target: "body" }],
      judge_art_score: [
        { athlete_id: "K1", value: 8 }, { athlete_id: "K1", value: 9 }, { athlete_id: "K1", value: 8.5 },
        { athlete_id: "K2", value: 9 }, { athlete_id: "K2", value: 9 }, { athlete_id: "K2", value: 9 },
      ],
    },
    penalties: [],
  });
  const k1 = result.entries.find((r) => r.athlete_id === "K1");
  const k2 = result.entries.find((r) => r.athlete_id === "K2");
  assert.equal(k1.detail.art_score, 8.5);
  assert.equal(k1.score, 10.5); // 2 + 8.5
  assert.equal(k2.score, 9);
});

test("算法带版本号，候选结果可被历史复现", () => {
  const input = {
    entries: ["A"],
    evidence: { wave_judge_score: [{ athlete_id: "A", wave_no: 1, score: 7 }] },
    penalties: [],
  };
  const result = compute("surfing", input);
  assert.match(result.algorithm, /^\d{4}\.\d+$/);
});
