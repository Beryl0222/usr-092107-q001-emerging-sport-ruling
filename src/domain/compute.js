// 从折叠状态构建候选结果。命令处理器发布前用它计算；重放时用它与历史候选逐版比对。
// 关键不变量：被更正取代的原始证据不参与计算；申诉被驳回/撤回时，其名下更正作废，原始证据复活。
import { scoreSurfing, scoreMma, scoreVirtualTaekwondo } from "./scoring.js";

/** 找出作废的更正事件：更正挂在申诉名下，而申诉最终被驳回或撤回。 */
export function voidedCorrectionIds(state) {
  const voided = new Set();
  for (const appeal of state.appeals.values()) {
    if (appeal.status === "rejected" || appeal.status === "withdrawn") {
      for (const bout of state.bouts.values()) {
        for (const c of bout.evidence.corrections) {
          if (c.appeal_id === appeal.appeal_id) voided.add(c.event_id);
        }
      }
    }
  }
  return voided;
}

function liveEvidence(bout, voided) {
  const corrections = bout.evidence.corrections.filter((c) => !voided.has(c.event_id));
  // 原证据被「未作废」的更正取代才失效；若更正随申诉驳回而作废，原证据复活。
  const isAlive = (entry) => {
    if (voided.has(entry.event_id)) return false; // 作废更正带入的替换条目
    if (entry.superseded_by) return voided.has(entry.superseded_by); // 被有效更正取代→死；被作废更正取代→活
    return true;
  };
  return {
    corrections,
    judgeScores: bout.evidence.judge_scores.filter(isAlive),
    sensorMessages: bout.evidence.sensor_messages.filter(isAlive),
    fouls: bout.evidence.fouls.filter(isAlive),
  };
}

function applySurfingTieResolutions(result, bout) {
  for (const resolution of bout.tie_resolutions) {
    const group = result.unresolved_ties.find((g) => g.length === resolution.tied.length && g.every((id) => resolution.tied.includes(id)));
    if (!group) continue;
    const start = result.standings.findIndex((r) => group.includes(r.athlete_id));
    const groupRows = result.standings.filter((r) => group.includes(r.athlete_id));
    const winnerRow = groupRows.find((r) => r.athlete_id === resolution.winner);
    if (!winnerRow) continue;
    const before = result.standings.slice(0, start);
    const after = result.standings.slice(start + groupRows.length);
    const reordered = [winnerRow, ...groupRows.filter((r) => r.athlete_id !== resolution.winner)];
    result.standings = rerank([...before, ...reordered, ...after]);
    for (const r of reordered) r.tied_with = [];
    result.unresolved_ties = result.unresolved_ties.filter((g) => g !== group);
    result.resolved_by = resolution.event_id;
  }
  return result;
}

function rerank(standings) {
  return standings.map((r, i) => ({ ...r, rank: i + 1 }));
}

function applySideTieResolution(result, bout, sides) {
  if (result.winner) return result;
  for (const resolution of bout.tie_resolutions.slice().reverse()) {
    const tiedPair = resolution.tied ?? ["red", "blue"];
    if (!tiedPair.includes("red") || !tiedPair.includes("blue")) continue;
    const side = resolution.winner === "red" || resolution.winner === "blue" ? resolution.winner : sides?.[resolution.winner] ? Object.entries(sides).find(([, id]) => id === resolution.winner)?.[0] : null;
    if (!side) continue;
    result.winner = side;
    result.winner_athlete_id = sides?.[side] ?? null;
    result.unresolved_ties = [];
    result.resolved_by = resolution.event_id;
    result.mode = result.mode ? `${result.mode}+official_decision` : "official_decision";
    return result;
  }
  return result;
}

/**
 * @returns {{sport:string, winner:string|null, winner_athlete_id:string|null, standings?:any[], outcome?:any, unresolved_ties:string[][], basis_event_ids:string[]}}
 */
export function buildCandidate(state, bout) {
  const voided = voidedCorrectionIds(state);
  const ev = liveEvidence(bout, voided);
  const basis = [
    ...ev.judgeScores.map((e) => e.event_id),
    ...ev.sensorMessages.filter((m) => m.valid).map((e) => e.event_id),
    ...ev.fouls.map((e) => e.event_id),
  ];

  if (bout.sport === "surfing") {
    const waves = new Map();
    for (const s of ev.judgeScores) {
      if (!s.wave_id || typeof s.score !== "number") continue;
      if (!waves.has(s.wave_id)) waves.set(s.wave_id, { athlete_id: s.athlete_id, judge_scores: [] });
      waves.get(s.wave_id).judge_scores.push(s.score);
    }
    const deductionsByAthlete = new Map();
    for (const f of ev.fouls) deductionsByAthlete.set(f.against, (deductionsByAthlete.get(f.against) ?? 0) + (f.deduction ?? 0));
    const inputs = bout.athlete_ids.map((athlete_id) => {
      const athleteWaves = [...waves.values()].filter((w) => w.athlete_id === athlete_id).map((w) => ({ judge_scores: w.judge_scores }));
      return { athlete_id, waves: athleteWaves, deductions: deductionsByAthlete.get(athlete_id) ?? 0 };
    });
    const result = scoreSurfing(inputs);
    applySurfingTieResolutions(result, bout);
    const winnerRow = result.standings.find((r) => r.rank === 1);
    return {
      sport: "surfing",
      standings: result.standings,
      winner: result.unresolved_ties.length === 0 && result.standings[0]?.tied_with.length === 0 ? winnerRow?.athlete_id ?? null : null,
      winner_athlete_id: result.unresolved_ties.length === 0 ? winnerRow?.athlete_id ?? null : null,
      unresolved_ties: result.unresolved_ties,
      resolved_by: result.resolved_by ?? null,
      basis_event_ids: basis,
    };
  }

  if (bout.sport === "mma") {
    const roundNos = [...new Set(ev.judgeScores.map((s) => s.round))].sort((a, b) => a - b);
    const rounds = roundNos.map((round) => {
      const byJudge = new Map();
      for (const s of ev.judgeScores) {
        if (s.round !== round || !s.card) continue;
        byJudge.set(s.judge_id, { judge_id: s.judge_id, red: s.card.red, blue: s.card.blue, red_deductions: s.card.red_deductions ?? 0, blue_deductions: s.card.blue_deductions ?? 0 });
      }
      // 裁判长的扣分裁决对所有边裁计分卡同等生效。
      for (const f of ev.fouls.filter((f) => f.round === round)) {
        for (const card of byJudge.values()) {
          if (f.against === "red" || f.against === bout.sides?.red) card.red_deductions += f.deduction ?? 0;
          if (f.against === "blue" || f.against === bout.sides?.blue) card.blue_deductions += f.deduction ?? 0;
        }
      }
      return { round, cards: [...byJudge.values()] };
    });
    const result = scoreMma({ rounds });
    applySideTieResolution(result, bout, bout.sides);
    result.winner_athlete_id = result.winner ? bout.sides?.[result.winner] ?? null : null;
    return { sport: "mma", outcome: result.outcome, cards: result.cards, votes: result.votes, winner: result.winner, winner_athlete_id: result.winner_athlete_id, mode: result.mode, unresolved_ties: result.unresolved_ties, resolved_by: result.resolved_by ?? null, basis_event_ids: basis };
  }

  if (bout.sport === "virtual_taekwondo") {
    const regulationRounds = [...new Set(ev.sensorMessages.map((m) => m.round).filter((r) => Number.isInteger(r)))].sort((a, b) => a - b);
    const regulation = regulationRounds.map((round) => {
      const sideKicks = { red: [], blue: [] };
      for (const m of ev.sensorMessages) {
        if (m.round !== round || !m.valid || !m.side) continue;
        sideKicks[m.side]?.push(m.value ?? 0);
      }
      const ded = { red: 0, blue: 0 };
      for (const f of ev.fouls) {
        if (f.round !== round) continue;
        const side = f.against === "red" || f.against === bout.sides?.red ? "red" : f.against === "blue" || f.against === bout.sides?.blue ? "blue" : null;
        if (side) ded[side] += 1;
      }
      return { round, red: { kicks: sideKicks.red, deductions: ded.red }, blue: { kicks: sideKicks.blue, deductions: ded.blue } };
    });
    const goldenMsgs = ev.sensorMessages.filter((m) => m.round === "golden" && m.valid).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.ingested_seq - b.ingested_seq);
    let golden;
    if (goldenMsgs.length > 0) {
      const firstPoint = goldenMsgs.find((m) => (m.action ?? "").includes("kick") && (m.value ?? 0) > 0);
      golden = {
        first_scorer: firstPoint?.side ?? null,
        contacts: {
          red: goldenMsgs.filter((m) => m.side === "red" && m.action === "contact").length,
          blue: goldenMsgs.filter((m) => m.side === "blue" && m.action === "contact").length,
        },
      };
    }
    const result = scoreVirtualTaekwondo({ regulation, golden });
    applySideTieResolution(result, bout, bout.sides);
    result.winner_athlete_id = result.winner ? bout.sides?.[result.winner] ?? null : null;
    return { sport: "virtual_taekwondo", ...result, winner_athlete_id: result.winner_athlete_id, basis_event_ids: basis };
  }

  return { sport: bout.sport, winner: null, winner_athlete_id: null, unresolved_ties: bout.athlete_ids.map((id) => [id]), basis_event_ids: basis, note: "未知赛项，无法自动计算" };
}
