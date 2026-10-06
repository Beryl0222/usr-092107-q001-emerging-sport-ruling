import { EventStore } from "../../src/store.js";
import { RulingService } from "../../src/services.js";
import { setClock } from "../../src/envelope.js";

/**
 * 测试夹具：构建一个含三赛项规则、运动员、官员、冲浪晋级括号的最小世界。
 * 时钟可推进，窗口判定全部基于这个时钟。
 */
export function newGame() {
  let now = new Date("2026-11-02T09:00:00+08:00");
  setClock(() => now.toISOString());
  const advance = (minutes) => {
    now = new Date(now.getTime() + minutes * 60_000);
    return now.toISOString();
  };
  const at = () => now.toISOString();

  const store = new EventStore();
  const svc = new RulingService(store);

  const rules = {
    surfing: { evidence_window_minutes: 30, appeal_window_minutes: 15 },
    mma: { evidence_window_minutes: 20, appeal_window_minutes: 15 },
    virtual_taekwondo: { evidence_window_minutes: 15, appeal_window_minutes: 10 },
  };
  for (const [sport, config] of Object.entries(rules)) {
    svc.publishRulebook({ sport, rules_version: "2026.1", config, effective_from: at() });
    svc.activateRulebook({ sport, rulebook_id: `rule-${sport}-2026-1` });
  }

  const athletes = [
    ["surf-jpn-1", "佐藤", "JPN"], ["surf-jpn-2", "鈴木", "JPN"],
    ["surf-bra-1", "Silva", "BRA"], ["surf-bra-2", "Santos", "BRA"],
    ["mma-red", "Red", "RED"], ["mma-blue", "Blue", "BLU"],
    ["vtk-kor-1", "Kim", "KOR"], ["vtk-kor-2", "Park", "KOR"],
  ];
  for (const [id, name, team] of athletes) {
    svc.registerAthlete({ athlete_id: id, name, team_id: team });
    svc.grantEligibility({ athlete_id: id, competition_id: "AG2026" });
  }

  const officials = [
    ["j1", ["judge"]], ["j2", ["judge"]], ["j3", ["judge"]], ["j4", ["judge"]],
    ["ref1", ["referee"]],
    ["pres", ["jury_president"]], ["td", ["technical_delegate"]],
    ["rp", ["review_panel"]], ["rec1", ["record_committee"]],
  ];
  for (const [id, roles] of officials) svc.registerOfficial({ official_id: id, roles });

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

  const scheduleSurf = (id, label, entries) => {
    svc.scheduleBout({
      bout_id: id, sport: "surfing", session_id: "sess-surf", draw_id: "draw-surf",
      round_label: label, entries, scheduled_at: at(),
    });
    for (const athlete of entries) {
      svc.qualifyParticipant({ bout_id: id, athlete_id: athlete, competition_id: "AG2026" });
    }
  };
  scheduleSurf("SF-A", "半决赛A", ["surf-jpn-1", "surf-bra-1"]);
  scheduleSurf("SF-B", "半决赛B", ["surf-jpn-2", "surf-bra-2"]);
  scheduleSurf("FINAL", "决赛", ["surf-jpn-1", "surf-bra-2"]);

  svc.assignPanel({
    bout_id: "SF-A",
    seats: [
      { official_id: "j1", role: "judge" },
      { official_id: "j2", role: "judge" },
      { official_id: "j3", role: "judge" },
      { official_id: "ref1", role: "referee" },
    ],
  });
  svc.assignPanel({
    bout_id: "SF-B",
    seats: [
      { official_id: "j1", role: "judge" },
      { official_id: "j2", role: "judge" },
      { official_id: "j3", role: "judge" },
    ],
  });

  /** 发送一条冲浪浪次评分（三名裁判）。 */
  const waveScores = (boutId, table, options = {}) => {
    for (const [athleteId, waves] of Object.entries(table)) {
      for (const [waveNo, scores] of Object.entries(waves)) {
        scores.forEach((score, j) => {
          svc.recordEvidence({
            bout_id: boutId,
            kind: "wave_judge_score",
            judge_id: ["j1", "j2", "j3"][j],
            occurred_at: options.occurred_at,
            idempotency_key: options.keyPrefix
              ? `${options.keyPrefix}:${athleteId}:${waveNo}:j${j}`
              : undefined,
            data: { athlete_id: athleteId, wave_no: Number(waveNo), score },
          });
        });
      }
    }
  };

  /** 完赛并计算候选，返回候选事件。 */
  const finishSurf = (boutId) => {
    svc.startRound({ bout_id: boutId, round_no: 1 });
    advance(8);
    svc.endRound({ bout_id: boutId, round_no: 1 });
    svc.endBout({ bout_id: boutId });
    return svc.computeCandidate({ bout_id: boutId });
  };

  return { store, svc, advance, at, waveScores, finishSurf, now: () => now };
}
