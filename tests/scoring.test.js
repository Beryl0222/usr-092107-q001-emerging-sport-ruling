import assert from "node:assert/strict";
import test from "node:test";

import { trimmedMean, scoreSurfing, scoreMma, scoreVirtualTaekwondo } from "../src/domain/scoring.js";

test("trimmedMean：五裁判去最高最低取平均", () => {
  assert.equal(trimmedMean([6, 8, 8, 8, 10]), 8); // 去掉 6、10，剩 8,8,8
  assert.equal(trimmedMean([6, 6]), 6); // 不足三人直接平均
});

test("冲浪：取两条最高浪之和并排名", () => {
  const r = scoreSurfing([
    { athlete_id: "A", waves: [{ judge_scores: [8, 8, 8] }, { judge_scores: [6, 6, 6] }, { judge_scores: [3, 3, 3] }] },
    { athlete_id: "B", waves: [{ judge_scores: [7, 7, 7] }, { judge_scores: [7, 7, 7] }] },
  ]);
  assert.equal(r.standings[0].athlete_id, "A");
  assert.equal(r.standings[0].total, 14); // 8 + 6
  assert.equal(r.standings[1].total, 14); // 7 + 7 —— 总分并列
});

test("冲浪：总分并列用最高单浪回算打破", () => {
  const r = scoreSurfing([
    { athlete_id: "A", waves: [{ judge_scores: [9, 9, 9] }, { judge_scores: [5, 5, 5] }] }, // 14，最高 9
    { athlete_id: "B", waves: [{ judge_scores: [7, 7, 7] }, { judge_scores: [7, 7, 7] }] }, // 14，最高 7
  ]);
  assert.equal(r.standings[0].athlete_id, "A");
  assert.deepEqual(r.unresolved_ties, []);
  assert.deepEqual(r.standings[0].tied_with, []);
});

test("冲浪：回算仍相同则保留为未决并列，交裁判长裁决", () => {
  const r = scoreSurfing([
    { athlete_id: "A", waves: [{ judge_scores: [7, 7, 7] }, { judge_scores: [7, 7, 7] }] },
    { athlete_id: "B", waves: [{ judge_scores: [7, 7, 7] }, { judge_scores: [7, 7, 7] }] },
  ]);
  assert.equal(r.unresolved_ties.length, 1);
  assert.deepEqual(r.unresolved_ties[0].sort(), ["A", "B"]);
  assert.equal(r.standings[0].rank, 1);
  assert.equal(r.standings[1].rank, 1); // 并列同名次
});

test("冲浪：干扰罚分从总分扣除", () => {
  const r = scoreSurfing([
    { athlete_id: "A", waves: [{ judge_scores: [8, 8, 8] }], deductions: 3 },
    { athlete_id: "B", waves: [{ judge_scores: [6, 6, 6] }] },
  ]);
  assert.equal(r.standings[0].athlete_id, "B");
});

test("MMA：三裁判一致判定红方胜", () => {
  const r = scoreMma({
    rounds: [{ round: 1, cards: [
      { judge_id: "J1", red: 10, blue: 9 },
      { judge_id: "J2", red: 10, blue: 9 },
      { judge_id: "J3", red: 10, blue: 9 },
    ] }],
  });
  assert.equal(r.outcome, "unanimous_decision_red");
  assert.equal(r.winner, "red");
});

test("MMA：分歧判定（2 红 1 蓝）", () => {
  const r = scoreMma({
    rounds: [{ round: 1, cards: [
      { judge_id: "J1", red: 10, blue: 9 },
      { judge_id: "J2", red: 10, blue: 9 },
      { judge_id: "J3", red: 9, blue: 10 },
    ] }],
  });
  assert.equal(r.outcome, "split_decision_red");
});

test("MMA：扣分在有效分中先行扣除，可翻转胜者", () => {
  const r = scoreMma({
    rounds: [{ round: 1, cards: [
      { judge_id: "J1", red: 10, blue: 10, red_deductions: 1 },
      { judge_id: "J2", red: 10, blue: 10, red_deductions: 1 },
      { judge_id: "J3", red: 10, blue: 10, red_deductions: 1 },
    ] }],
  });
  assert.equal(r.winner, "blue");
  assert.equal(r.cards[0].red, 9);
});

test("MMA：三张卡全平为一致平局并列", () => {
  const r = scoreMma({
    rounds: [{ round: 1, cards: [
      { judge_id: "J1", red: 10, blue: 10 },
      { judge_id: "J2", red: 10, blue: 10 },
      { judge_id: "J3", red: 10, blue: 10 },
    ] }],
  });
  assert.equal(r.outcome, "unanimous_draw");
  assert.equal(r.winner, null);
  assert.deepEqual(r.unresolved_ties, [["red", "blue"]]);
});

test("虚拟跆拳道：三回合有效得分分胜负", () => {
  const r = scoreVirtualTaekwondo({
    regulation: [
      { round: 1, red: { kicks: [2], deductions: 0 }, blue: { kicks: [3], deductions: 0 } },
      { round: 2, red: { kicks: [2, 2], deductions: 0 }, blue: { kicks: [], deductions: 0 } },
    ],
  });
  assert.equal(r.red_total, 6);
  assert.equal(r.blue_total, 3);
  assert.equal(r.winner, "red");
});

test("虚拟跆拳道：对方扣分记为己方加一", () => {
  const r = scoreVirtualTaekwondo({
    regulation: [{ round: 1, red: { kicks: [], deductions: 2 }, blue: { kicks: [], deductions: 0 } }],
  });
  assert.equal(r.red_total, 0);
  assert.equal(r.blue_total, 2);
});

test("虚拟跆拳道：平分进入金赛点，首得分者胜", () => {
  const r = scoreVirtualTaekwondo({
    regulation: [{ round: 1, red: { kicks: [2], deductions: 0 }, blue: { kicks: [2], deductions: 0 } }],
    golden: { first_scorer: "blue", contacts: { red: 5, blue: 1 } },
  });
  assert.equal(r.mode, "golden_point");
  assert.equal(r.winner, "blue");
});

test("虚拟跆拳道：金赛点无得分，按有效接触次数优势裁决", () => {
  const r = scoreVirtualTaekwondo({
    regulation: [{ round: 1, red: { kicks: [2], deductions: 0 }, blue: { kicks: [2], deductions: 0 } }],
    golden: { first_scorer: null, contacts: { red: 4, blue: 7 } },
  });
  assert.equal(r.mode, "superiority_contacts");
  assert.equal(r.winner, "blue");
});

test("虚拟跆拳道：优势仍相同，不猜测胜者，要求仲裁显式裁决", () => {
  const r = scoreVirtualTaekwondo({
    regulation: [{ round: 1, red: { kicks: [2], deductions: 0 }, blue: { kicks: [2], deductions: 0 } }],
    golden: { first_scorer: null, contacts: { red: 3, blue: 3 } },
  });
  assert.equal(r.winner, null);
  assert.equal(r.mode, "superiority_referee");
  assert.deepEqual(r.unresolved_ties, [["red", "blue"]]);
});
