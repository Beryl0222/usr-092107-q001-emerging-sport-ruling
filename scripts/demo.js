#!/usr/bin/env node
/**
 * 端到端演示：新兴赛项裁判与成绩后端。
 * 直接运行：node scripts/demo.js
 *
 * 故事线：
 * 1. 规则版本、运动员资格、裁判回避、设备校准；
 * 2. 冲浪半决赛：离线设备重复/乱序补传、干扰扣分、候选结果；
 * 3. 申诉只冻结受影响的晋级链——另一半决赛与综合格斗场照常完赛签署；
 * 4. 改判引用原记录（不覆盖）、复核意见、申诉成立、解冻、并列突破、签署发布；
 * 5. 奥运配额分配后证据链锁定；
 * 6. 综合格斗（十分制记分卡）与虚拟跆拳道（传感器+犯规+校准隔离）；
 * 7. 三类视图与哈希链防篡改核验。
 */
import { EventStore } from "../src/store.js";
import { RulingService, DomainError } from "../src/services.js";
import { setClock } from "../src/envelope.js";
import { officialReplay, publicView, teamView } from "../src/views.js";

const store = new EventStore();
const svc = new RulingService(store);

let T = Date.parse("2026-11-02T09:00:00+08:00");
const tick = (minutes = 1) => {
  T += minutes * 60_000;
  return new Date(T).toISOString();
};
setClock(() => new Date(T).toISOString());

const log = (title) => console.log(`\n=== ${title} ===`);
const ok = (label, e) =>
  console.log(`  ✓ ${label}${e?.summary ? `：${e.summary}` : ""}`);
function fail(label, fn) {
  try {
    fn();
    console.log(`  ✗ 本应被拒绝：${label}`);
    process.exitCode = 1;
  } catch (err) {
    if (process.env.DEBUG_FAIL) console.log(err.stack);
    console.log(`  ✓ 已拒绝 ${label} → [${err.code}] ${err.message}`);
  }
}

// ---------- 1. 规则版本 ----------
log("1. 规则版本发布与激活");
for (const [sport, version, windows] of [
  ["surfing", "2026.1", { evidence_window_minutes: 30, appeal_window_minutes: 15 }],
  ["mma", "2026.1", { evidence_window_minutes: 20, appeal_window_minutes: 15 }],
  ["virtual_taekwondo", "2026.1", { evidence_window_minutes: 15, appeal_window_minutes: 10 }],
]) {
  ok("发布规则", svc.publishRulebook({ sport, rules_version: version, config: windows, effective_from: tick(0) }));
  ok("激活规则", svc.activateRulebook({ sport, rulebook_id: `rule-${sport}-2026-1` }));
}

// ---------- 2. 人员、资格与回避 ----------
log("2. 运动员、资格、裁判登记与回避");
const athletes = [
  ["surf-jpn-1", "佐藤", "JPN"], ["surf-jpn-2", "鈴木", "JPN"],
  ["surf-bra-1", "Silva", "BRA"], ["surf-bra-2", "SANTOS", "BRA"],
  ["mma-red", "Red Fighter", "RED"], ["mma-blue", "Blue Fighter", "BLU"],
  ["vtk-kor-1", "Kim", "KOR"], ["vtk-kor-2", "Park", "KOR"],
];
for (const [id, name, team] of athletes) {
  svc.registerAthlete({ athlete_id: id, name, team_id: team });
  svc.grantEligibility({ athlete_id: id, competition_id: "AG2026", olympic_path: id.startsWith("surf") });
}
ok("8 名运动员登记并获资格");

svc.registerOfficial({ official_id: "j1", name: "裁判甲", roles: ["judge"] });
svc.registerOfficial({ official_id: "j2", name: "裁判乙", roles: ["judge"] });
svc.registerOfficial({ official_id: "j3", name: "裁判丙", roles: ["judge"] });
svc.registerOfficial({ official_id: "j4", name: "裁判丁（日籍）", roles: ["judge"] });
svc.registerOfficial({ official_id: "pres", name: "仲裁主任", roles: ["jury_president"] });
svc.registerOfficial({ official_id: "td", name: "技术代表", roles: ["technical_delegate"] });
svc.registerOfficial({ official_id: "ref1", name: "台上裁判", roles: ["referee"] });
svc.registerOfficial({ official_id: "rec1", name: "纪录官", roles: ["record_committee"] });
ok("官员登记", );

svc.declareConflict({
  official_id: "j4", conflict_type: "nationality", ref_id: "JPN",
  reason: "与日本代表队同国籍，冲浪场次回避",
});
ok("裁判丁声明回避");

// ---------- 3. 冲浪抽签（含晋级括号） ----------
log("3. 冲浪抽签：半决赛 SF-A / SF-B 汇入决赛 FINAL");
svc.conductDraw({
  draw_id: "draw-surf",
  session_id: "sess-surf",
  sport: "surfing",
  bracket: [
    { bout_id: "SF-A", feeds_into: "FINAL", quota: 1 },
    { bout_id: "SF-B", feeds_into: "FINAL", quota: 1 },
    { bout_id: "FINAL", feeds_into: null, quota: 0 },
  ],
});
svc.publishDraw({ draw_id: "draw-surf" });
for (const [id, label, entries] of [
  ["SF-A", "半决赛 A", ["surf-jpn-1", "surf-bra-1"]],
  ["SF-B", "半决赛 B", ["surf-jpn-2", "surf-bra-2"]],
  ["FINAL", "决赛", ["surf-jpn-1", "surf-bra-2"]],
]) {
  svc.scheduleBout({ bout_id: id, sport: "surfing", session_id: "sess-surf", draw_id: "draw-surf", round_label: label, entries, scheduled_at: tick(1) });
  for (const a of entries) svc.qualifyParticipant({ bout_id: id, athlete_id: a, competition_id: "AG2026", source_bout_id: null });
}
ok("三场冲浪场次编排完成");

fail("指派存在国籍冲突的裁判丁执法 SF-A", () =>
  svc.assignPanel({
    bout_id: "SF-A",
    seats: [
      { official_id: "j1", role: "judge" }, { official_id: "j2", role: "judge" },
      { official_id: "j4", role: "judge" },
    ],
  }),
);
svc.assignPanel({
  bout_id: "SF-A",
  seats: [
    { official_id: "j1", role: "judge" }, { official_id: "j2", role: "judge" },
    { official_id: "j3", role: "judge" }, { official_id: "ref1", role: "referee" },
  ],
});
ok("裁判甲/乙/丙组成 SF-A 裁判组");

// ---------- 4. 冲浪比赛：乱序、重复补传、处罚 ----------
log("4. SF-A 比赛：离线设备先到第 2 浪、再补第 1 浪，第 2 浪重复补传被幂等去重");
svc.startRound({ bout_id: "SF-A", round_no: 1 });
const scores = {
  "surf-bra-1": { 1: [7.0, 7.0, 7.0], 2: [6.5, 6.5, 6.5] },
  "surf-jpn-1": { 1: [6.0, 6.0, 6.0], 2: [5.5, 5.5, 5.5] },
};
const tWave2 = tick(3);
const tWave1 = new Date(T - 2 * 60_000).toISOString(); // 第 1 浪事实时间更早
const sendWave = (athlete, waveNo, judgeIdx, key) =>
  svc.recordEvidence({
    bout_id: "SF-A",
    kind: "wave_judge_score",
    judge_id: ["j1", "j2", "j3"][judgeIdx],
    occurred_at: waveNo === 2 ? tWave2 : tWave1,
    idempotency_key: key,
    data: { athlete_id: athlete, wave_no: waveNo, score: scores[athlete][waveNo][judgeIdx] },
  });

// 先收到第 2 浪（乱序）
for (let j = 0; j < 3; j += 1) sendWave("surf-bra-1", 2, j, `wave:SF-A:bra:2:j${j}`);
for (let j = 0; j < 3; j += 1) sendWave("surf-jpn-1", 2, j, `wave:SF-A:jpn:2:j${j}`);
// 后补第 1 浪
for (let j = 0; j < 3; j += 1) sendWave("surf-bra-1", 1, j, `wave:SF-A:bra:1:j${j}`);
for (let j = 0; j < 3; j += 1) sendWave("surf-jpn-1", 1, j, `wave:SF-A:jpn:1:j${j}`);
// 设备重连后重复补传第 2 浪：同幂等键
const dup = sendWave("surf-bra-1", 2, 0, "wave:SF-A:bra:2:j0");
console.log(`  ✓ 重复补传返回首条记录 seq=${dup.event.seq}，status=${dup.status}，quarantined=${dup.quarantined}`);

svc.imposePenalty({
  bout_id: "SF-A", athlete_id: "surf-jpn-1", official_id: "ref1",
  kind: "interference", deduction_points: 1.0,
  reason: "第 2 浪抢浪干扰，扣 1.0 分",
});
ok("干扰犯规扣分");
tick(8);
svc.endRound({ bout_id: "SF-A", round_no: 1 });
svc.endBout({ bout_id: "SF-A" });
ok("比赛结束，证据/申诉窗口开始计时");

// ---------- 5. 候选结果（自动计算不等于生效） ----------
log("5. 自动计算只形成候选结果");
const c1 = svc.computeCandidate({ bout_id: "SF-A" });
console.log("  候选名次：");
for (const row of c1.payload.candidate.entries) {
  console.log(`    第 ${row.rank} 名 ${row.athlete_id}：${row.score} 分（两浪 ${row.detail.counted.join("、")}，扣分 ${row.deduction}）`);
}
fail("裁判甲（judge 角色）无权签署", () => svc.certifyResult({ bout_id: "SF-A", official_id: "j1" }));
fail("未经签署不能发布", () => svc.publishResult({ bout_id: "SF-A", official_id: "pres" }));

// ---------- 6. 申诉：定向冻结，其他场次照常 ----------
log("6. 日本队申诉：仅冻结 SF-A 及其下游 FINAL");
tick(2);
const appealId = svc.fileAppeal({ bout_id: "SF-A", filed_by: "JPN", reason: "第 2 浪裁判输入终端按键错误，三人原始分均应为 8.5" });
console.log(`  ✓ 申诉 ${appealId} 已受理，冻结域：SF-A、FINAL`);
fail("冻结期间不能确认 SF-A 晋级", () =>
  svc.confirmAdvancement({ bout_id: "SF-A", official_id: "pres" }),
);
fail("决赛席位（冻结目标）不能接收另一半决赛的晋级确认", () => {
  // 先让 SF-B 走完并签署，再尝试把胜者推进冻结中的 FINAL
  runSurfB();
  svc.confirmAdvancement({ bout_id: "SF-B", official_id: "pres" });
});
console.log("  ✓ SF-B 本身照常完成比赛与签署，只是晋级动作挂起");

// 综合格斗场完全不受影响
log("6b. 综合格斗场次在申诉期间照常推进并发布");
runMma();

// ---------- 7. 复核与引用式改判 ----------
log("7. 复核受理：补充证据、出具意见；改判引用原记录而非覆盖");
svc.openReview({ appeal_id: appealId, official_id: "pres" });
// 找到第 2 浪 j1、j2 给日本选手的 5.5 原记录
const replayBefore = officialReplay(store, "SF-A");
const targetWaves = replayBefore.current_evidence.wave_judge_score
  .filter((e) => e.athlete_id === "surf-jpn-1" && e.wave_no === 2)
  .sort((a, b) => (a.judge_id < b.judge_id ? -1 : 1));
svc.addAppealEvidence({ appeal_id: appealId, evidence_event_id: targetWaves[0].event_id, note: "终端按键日志佐证" });
svc.issueOpinion({ appeal_id: appealId, official_id: "td", recommendation: "uphold", note: "去极值后更正两名裁判分数即可反映真实评分" });
// 改判 j1、j2 的两条原记录（j3 的 5.5 作为最低分将被去除）；先留存 j3 原记录 id 供后面锁定测试
const untouchedWave = targetWaves[2];
for (const target of targetWaves.slice(0, 2)) {
  svc.amendRuling({
    target_id: target.event_id,
    action: "correct",
    correction: { score: 8.5 },
    reason: "终端按键错误 5.5→8.5，经裁判本人确认",
    official_id: "pres",
    appeal_id: appealId,
  });
}
ok("两条改判均引用原记录，原记录保留为 superseded");
fail("已被取代的记录不能再次改判（只能引用现行版本）", () =>
  svc.amendRuling({ target_id: targetWaves[0].event_id, action: "void", reason: "再试一次", official_id: "pres" }),
);
const c2 = svc.computeCandidate({ bout_id: "SF-A" });
console.log("  复核后候选名次：");
for (const row of c2.payload.candidate.entries) {
  console.log(`    第 ${row.rank} 名 ${row.athlete_id}：${row.score} 分（第 2 浪组内去极值平均 ${row.detail.waves.find((w) => w.wave_no === 2).score}）`);
}
svc.resolveTie({
  bout_id: "SF-A",
  method: "highest_single_wave",
  winner: "surf-jpn-1",
  reason: "总分并列，按冲浪规则附录 A 回看单浪最高分：8.5 > 7.0",
  official_id: "pres",
});
ok("并列突破：日本选手凭单浪最高分列前");
const c3 = svc.computeCandidate({ bout_id: "SF-A" });
console.log("  突破重算后候选名次：");
for (const row of c3.payload.candidate.entries) console.log(`    第 ${row.rank} 名 ${row.athlete_id}：${row.score} 分`);
svc.decideAppeal({ appeal_id: appealId, official_id: "pres", decision: "upheld", note: "改判后日本选手胜出" });
ok("申诉成立，晋级链解冻");

// ---------- 8. 签署、发布、晋级、奥运配额 ----------
log("8. 签署发布、晋级确认与奥运配额锁定");
svc.certifyResult({ bout_id: "SF-A", official_id: "pres" });
svc.publishResult({ bout_id: "SF-A", official_id: "td" });
ok("SF-A 成绩经仲裁主任签署、技术代表发布");
svc.confirmAdvancement({ bout_id: "SF-A", official_id: "pres" });
svc.confirmAdvancement({ bout_id: "SF-B", official_id: "pres" });
ok("两场半决赛胜者晋级 FINAL");
svc.allocateOlympicQuota({ bout_id: "SF-A", athlete_id: "surf-jpn-1", games: "2028", official_id: "td" });
ok("奥运资格配额授予，证据链锁定");
fail("奥运配额锁定后任何改写都被拒绝", () =>
  svc.amendRuling({ target_id: untouchedWave.event_id, action: "void", reason: "赛后想再改", official_id: "pres" }),
);
svc.ratifyRecord({
  bout_id: "SF-A", athlete_id: "surf-jpn-1", label: "亚运会冲浪男子单浪最高分",
  value: 8.5, official_id: "rec1", witnesses: ["pres", "td"],
});
ok("纪录认证基于已发布成绩");

// ---------- 9. 虚拟跆拳道 ----------
log("9. 虚拟跆拳道：传感器命中、校准过期隔离、重复命中去重、gam-jeom 加分");
runVtk();

// ---------- 10. 三类视图 ----------
log("10. 视图：代表队 / 公开 / 官员重放");
const japan = teamView(store, "JPN");
console.log("  日本代表队视图（节选）：");
for (const item of japan.items) {
  console.log(`    ${item.bout_id} [${item.sport}] 成绩阶段=${item.result_stage} 冻结=${item.advancement_frozen} 申诉=${item.appeals.map((a) => `${a.id}:${a.status}`).join(",") || "无"} 申诉截止=${item.appeal_deadline}`);
}

const pub = publicView(store);
console.log(`  公开视图（链健康=${pub.healthy}），已发布 ${pub.results.length} 场：`);
for (const r of pub.results) {
  console.log(`    ${r.bout_id} [${r.sport} v${r.rules_version}] 发布于 ${r.published_at}`);
  for (const s of r.standings) console.log(`      第${s.rank}名 ${s.athlete_id} ${s.score} 分`);
  console.log(`      核验锚点：published=${r.verify.published.content_hash.slice(0, 12)}… → cert=${r.verify.certified.content_hash.slice(0, 12)}… → candidate=${r.verify.candidate.content_hash.slice(0, 12)}…`);
}

const replay = officialReplay(store, "SF-A");
console.log(`  官员重放 SF-A：时间线 ${replay.timeline.length} 个决定，改判 ${replay.amendments.length} 条，链有效=${replay.chain_valid}`);
console.log("    现行证据中仍可看到原始 5.5 记录被标记为 superseded，且指向改判事件：");
for (const v of replay.voided_or_superseded) {
  console.log(`      ${v.event_id} [${v.status}] → ${v.superseded_by}`);
}

// ---------- 11. 防篡改 ----------
log("11. 哈希链防篡改：事后改写任一记录都会被发现");
const target = store.all().find((e) => e.event_type === "RESULT_PUBLISHED" && e.payload.bout_id === "SF-A");
console.log(`  篡改成 ${target.event_id} 的发布名次（仅作演示）…`);
target.payload.standings[0].athlete_id = "surf-bra-1";
const verify = store.verifyChain();
console.log(`  链校验：valid=${verify.valid}，断点 seq=${verify.brokenAt}，原因：${verify.reason}`);
const pubAfter = publicView(store);
console.log(`  公开视图健康=${pubAfter.healthy}，公布成绩数=${pubAfter.results.length}（链异常时不展示任何版本）`);

// ---------- 辅助：SF-B / MMA / VTK 完整流程 ----------
function runSurfB() {
  svc.assignPanel({
    bout_id: "SF-B",
    seats: [
      { official_id: "j1", role: "judge" }, { official_id: "j2", role: "judge" },
      { official_id: "j3", role: "judge" },
    ],
  });
  svc.startRound({ bout_id: "SF-B", round_no: 1 });
  const table = { "surf-bra-2": { 1: [8.0, 8.0, 8.0], 2: [7.5, 7.5, 7.5] }, "surf-jpn-2": { 1: [5.0, 5.0, 5.0], 2: [6.0, 6.0, 6.0] } };
  for (const athlete of Object.keys(table)) {
    for (const wave of [1, 2]) {
      for (let j = 0; j < 3; j += 1) {
        svc.recordEvidence({
          bout_id: "SF-B", kind: "wave_judge_score", judge_id: ["j1", "j2", "j3"][j],
          data: { athlete_id: athlete, wave_no: wave, score: table[athlete][wave][j] },
        });
      }
    }
  }
  tick(5);
  svc.endRound({ bout_id: "SF-B", round_no: 1 });
  svc.endBout({ bout_id: "SF-B" });
  svc.computeCandidate({ bout_id: "SF-B" });
  svc.certifyResult({ bout_id: "SF-B", official_id: "pres" });
  svc.publishResult({ bout_id: "SF-B", official_id: "td" });
}

function runMma() {
  svc.scheduleBout({
    bout_id: "MMA-1", sport: "mma", session_id: "sess-mma", draw_id: null,
    round_label: "铜牌战", entries: ["mma-red", "mma-blue"], scheduled_at: tick(0),
  });
  svc.assignPanel({
    bout_id: "MMA-1",
    seats: [
      { official_id: "j1", role: "judge" }, { official_id: "j2", role: "judge" },
      { official_id: "j3", role: "judge" }, { official_id: "ref1", role: "referee" },
    ],
  });
  // 三轮十分制：红方 10-9 / 10-9（蓝方被扣 1 分）/ 9-10
  const cards = [
    { round: 1, red: 10, blue: 9 },
    { round: 2, red: 10, blue: 9 },
    { round: 3, red: 9, blue: 10 },
  ];
  for (const c of cards) {
    svc.startRound({ bout_id: "MMA-1", round_no: c.round });
    for (const j of ["j1", "j2", "j3"]) {
      svc.recordEvidence({
        bout_id: "MMA-1", kind: "round_scorecard", judge_id: j,
        data: { round_no: c.round, red: { points: c.red }, blue: { points: c.blue } },
      });
    }
    if (c.round === 2) {
      svc.imposePenalty({
        bout_id: "MMA-1", athlete_id: "mma-blue", official_id: "ref1",
        kind: "point_deduction", deduction_points: 1, round_no: 2,
        reason: "第二回合多次抓网，扣 1 分",
      });
    }
    svc.endRound({ bout_id: "MMA-1", round_no: c.round });
  }
  svc.endBout({ bout_id: "MMA-1" });
  const cand = svc.computeCandidate({ bout_id: "MMA-1" });
  console.log(`    MMA 判定方式：${cand.payload.candidate.entries[0].detail.method}`);
  svc.certifyResult({ bout_id: "MMA-1", official_id: "pres" });
  svc.publishResult({ bout_id: "MMA-1", official_id: "td" });
  ok("MMA-1 成绩在冲浪申诉期间正常发布");
}

function runVtk() {
  svc.registerDevice({ device_id: "dev-vtk", device_type: "electronic_sensor", model: "VTK-Guard v3" });
  const calibStart = tick(0);
  svc.calibrateDevice({
    device_id: "dev-vtk", result: "pass", tolerance: 0.02,
    valid_until: new Date(T + 10 * 60_000).toISOString(), certifier_id: "td",
  });
  svc.scheduleBout({
    bout_id: "VTK-1", sport: "virtual_taekwondo", session_id: "sess-vtk", draw_id: null,
    round_label: "决赛", entries: ["vtk-kor-1", "vtk-kor-2"], scheduled_at: tick(1),
  });
  svc.bindDevice({ device_id: "dev-vtk", bout_id: "VTK-1" });
  svc.assignPanel({
    bout_id: "VTK-1",
    seats: [
      { official_id: "j1", role: "judge" }, { official_id: "j2", role: "judge" },
      { official_id: "ref1", role: "referee" },
    ],
  });
  svc.startRound({ bout_id: "VTK-1", round_no: 1 });
  const hit = (athlete, target, key, at) =>
    svc.recordEvidence({
      bout_id: "VTK-1", kind: "sensor_hit", device_id: "dev-vtk",
      occurred_at: at ?? new Date(T).toISOString(), idempotency_key: key,
      data: { athlete_id: athlete, target },
    });
  hit("vtk-kor-1", "body", "hit:1");
  hit("vtk-kor-1", "body", "hit:2");
  hit("vtk-kor-1", "head", "hit:3");
  const dupHit = hit("vtk-kor-1", "head", "hit:3"); // 设备重发
  console.log(`  重复传感器消息去重：status=${dupHit.status}（duplicate 时返回首条记录 seq=${dupHit.event.seq}）`);
  hit("vtk-kor-2", "body", "hit:4");
  // 校准窗口外的迟到消息 → 隔离
  const expired = hit("vtk-kor-2", "head", "hit:5", new Date(T + 30 * 60_000).toISOString());
  console.log(`  校准期外命中 → quarantined=${expired.quarantined}（${expired.reason}）`);
  // 未绑定设备的消息 → 隔离
  svc.registerDevice({ device_id: "dev-stranger", device_type: "electronic_sensor" });
  const stranger = svc.recordEvidence({
    bout_id: "VTK-1", kind: "sensor_hit", device_id: "dev-stranger",
    data: { athlete_id: "vtk-kor-2", target: "head" },
  });
  console.log(`  未绑定设备消息 → quarantined=${stranger.quarantined}（${stranger.reason}）`);
  svc.imposePenalty({
    bout_id: "VTK-1", athlete_id: "vtk-kor-2", official_id: "ref1",
    kind: "gam-jeom", points: 1, reason: "回避消极，对方得 1 分",
  });
  svc.endRound({ bout_id: "VTK-1", round_no: 1 });
  tick(9);
  svc.endBout({ bout_id: "VTK-1" });
  const cand = svc.computeCandidate({ bout_id: "VTK-1" });
  const leader = cand.payload.candidate.entries[0];
  console.log(`  候选第 1 名 ${leader.athlete_id}：躯干 ${leader.detail.body_hits}、头部 ${leader.detail.head_hits}、对方犯规赠分 ${leader.detail.penalty_points_awarded}，隔离命中 ${leader.detail.rejected_hits} 条不计`);
  svc.certifyResult({ bout_id: "VTK-1", official_id: "pres" });
  svc.publishResult({ bout_id: "VTK-1", official_id: "td" });
  ok("VTK-1 成绩发布（隔离证据不参与计算）");
}
