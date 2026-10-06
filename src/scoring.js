/**
 * 三赛项评分引擎：纯函数，只消费投影层整理好的“现行证据 + 有效处罚”，
 * 不读写事件存储。输出始终是候选结果（candidate），正式名次需另行签署发布。
 *
 * 引擎带 algorithmVersion：历史比赛重放时按当时算法计算，保证结果可复现。
 */

export const ALGORITHM_VERSION = "2026.1";

/** 去掉一个最高分、一个最低分后求平均（裁判数不足 3 时直接求平均）。 */
export function trimmedMean(values) {
  if (values.length === 0) return 0;
  if (values.length < 3) return values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.slice(1, -1);
  return round1(middle.reduce((a, b) => a + b, 0) / middle.length);
}

const round1 = (n) => Math.round(n * 100) / 100;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 统一入口。
 * @param {"surfing"|"mma"|"virtual_taekwondo"} sport
 * @param {object} input
 * @param {string[]} input.entries 参赛运动员 id
 * @param {Record<string, any[]>} input.evidence 按 kind 分组的现行证据
 * @param {any[]} input.penalties 有效处罚（已撤销的不在其中）
 * @param {object} [input.config] 规则参数
 * @returns {CandidateResult}
 */
export function compute(sport, input) {
  switch (sport) {
    case "surfing":
      return surfing(input);
    case "mma":
      return mma(input);
    case "virtual_taekwondo":
      return virtualTaekwondo(input);
    default:
      throw new Error(`不支持的赛项：${sport}`);
  }
}

/**
 * 冲浪：每条浪由裁判组按 0–10 打分，组内去极值平均；
 * 每队取得分最高的两条浪求和；干扰犯规按规则扣分。
 */
function surfing({ entries, evidence, penalties, config = {} }) {
  const waves = evidence.wave_judge_score ?? [];
  /** @type {Map<string, Map<number, number[]>>} 运动员 -> 浪号 -> 裁判分 */
  const byAthlete = new Map(entries.map((id) => [id, new Map()]));
  for (const ev of waves) {
    if (!byAthlete.has(ev.athlete_id)) continue;
    const map = byAthlete.get(ev.athlete_id);
    if (!map.has(ev.wave_no)) map.set(ev.wave_no, []);
    map.get(ev.wave_no).push(Number(ev.score));
  }

  const deductions = collectDeductions(penalties);
  const rows = entries.map((athlete_id) => {
    const waveScores = [...byAthlete.get(athlete_id).entries()]
      .map(([wave_no, scores]) => ({ wave_no, score: trimmedMean(scores), judges: scores.length }))
      .sort((a, b) => b.score - a.score);
    const topTwo = waveScores.slice(0, 2);
    const gross = round1(topTwo.reduce((sum, w) => sum + w.score, 0));
    const deduction = deductions.get(athlete_id) ?? 0;
    return {
      athlete_id,
      gross_score: gross,
      deduction,
      score: Math.max(0, round1(gross - deduction)),
      detail: { waves: waveScores, counted: topTwo.map((w) => w.wave_no) },
    };
  });

  const ranking = rankWithTies(rows, (a, b) => b.score - a.score, config.tie_basis ?? "冲浪规则附录 A");
  return {
    sport: "surfing",
    algorithm: ALGORITHM_VERSION,
    entries: ranking,
    winners: ranking.filter((r) => r.rank === 1).map((r) => r.athlete_id),
  };
}

/**
 * 综合格斗：十分制记分卡。每名裁判逐轮给胜者 10 分、负者 9 或 8 分，
 * 扣分处罚在该轮生效；KO/降服等终止证据可提前结束比赛。
 * 名次按三张卡的一致/多数/分歧判定产生，允许平局并交由并列处理。
 */
function mma({ entries, evidence, penalties, config = {} }) {
  if (entries.length !== 2) throw new Error("综合格斗每场恰有两名选手");
  const [red, blue] = entries;
  const cards = evidence.round_scorecard ?? [];
  const stoppage = (evidence.bout_outcome ?? []).find((e) => e.winner_athlete_id);

  const roundDeductions = new Map(); // judge|round|athlete -> points（ALL 表示台上裁判判罚，对全体记分卡生效）
  for (const p of penalties) {
    if (!p.deduction_points) continue;
    const scope = p.applies_to === "all_judges" ? "ALL" : (p.judge_id ?? "ALL");
    const key = `${scope}|${p.round_no ?? 0}|${p.athlete_id}`;
    roundDeductions.set(key, (roundDeductions.get(key) ?? 0) + p.deduction_points);
  }

  /** @type {Map<string, {rounds: number[], total: number}>} */
  const judgeTotals = new Map();
  for (const card of cards) {
    const j = card.judge_id;
    if (!judgeTotals.has(j)) judgeTotals.set(j, { [red]: [], [blue]: [] });
    const acc = judgeTotals.get(j);
    for (const side of [red, blue]) {
      const base = Number(card[side === red ? "red" : "blue"]?.points ?? 0);
      const ded =
        (roundDeductions.get(`${j}|${card.round_no}|${side}`) ?? 0) +
        (roundDeductions.get(`ALL|${card.round_no}|${side}`) ?? 0);
      acc[side].push(base - ded);
    }
  }

  const judgeCards = [...judgeTotals.entries()].map(([judge_id, acc]) => {
    const redTotal = acc[red].reduce((a, b) => a + b, 0);
    const blueTotal = acc[blue].reduce((a, b) => a + b, 0);
    return {
      judge_id,
      red_total: redTotal,
      blue_total: blueTotal,
      rounds_scored: acc[red].length,
      vote: redTotal > blueTotal ? red : blueTotal > redTotal ? blue : "draw",
    };
  });

  let method = "decision";
  let winners = [];
  if (stoppage) {
    method = stoppage.method ?? "referee_stoppage";
    winners = [stoppage.winner_athlete_id];
  } else {
    const redVotes = judgeCards.filter((c) => c.vote === red).length;
    const blueVotes = judgeCards.filter((c) => c.vote === blue).length;
    const draws = judgeCards.length - redVotes - blueVotes;
    if (redVotes > blueVotes && redVotes >= 2) winners = [red];
    else if (blueVotes > redVotes && blueVotes >= 2) winners = [blue];
    else winners = [red, blue]; // 票数不足多数 => 并列待突破
    if (draws === 0) {
      method = redVotes === judgeCards.length || blueVotes === judgeCards.length
        ? "unanimous_decision"
        : "split_decision";
    } else if (winners.length === 1) {
      method = "majority_decision";
    } else {
      method = "majority_draw";
    }
  }

  const scoreOf = (athlete) => {
    const total = judgeCards.reduce(
      (sum, c) => sum + (athlete === red ? c.red_total : c.blue_total),
      0,
    );
    return judgeCards.length ? round1(total / judgeCards.length) : 0;
  };
  const rows = entries.map((athlete_id) => ({
    athlete_id,
    score: scoreOf(athlete_id),
    detail: { cards: judgeCards, method },
  }));
  const ranking = rankWithTies(
    rows,
    (a, b) => b.score - a.score,
    config.tie_basis ?? "综合格斗规则第 3 章（十分制与平局处理）",
    winners,
  );
  return {
    sport: "mma",
    algorithm: ALGORITHM_VERSION,
    entries: ranking,
    winners: winners.length === 1 ? winners : [],
    tie: winners.length > 1 ? { tied: winners, method } : undefined,
  };
}

/**
 * 虚拟跆拳道：电子传感器命中（躯干 2 分、头部 5 分，按规则版本可调），
 * 犯规（gam-jeom）给对方加 1 分；可融合裁判技术艺术分（去极值平均）。
 * 只统计来自在校准有效期内、已绑定设备的命中。
 */
function virtualTaekwondo({ entries, evidence, penalties, config = {} }) {
  const values = config.sensor_values ?? { body: 2, head: 5 };
  const hits = evidence.sensor_hit ?? [];
  const sensor = new Map(entries.map((id) => [id, { body: 0, head: 0, rejected: 0 }]));
  for (const hit of hits) {
    if (!sensor.has(hit.athlete_id)) continue;
    if (hit.accepted === false) {
      sensor.get(hit.athlete_id).rejected += 1;
      continue;
    }
    const target = hit.target === "head" ? "head" : "body";
    sensor.get(hit.athlete_id)[target] += 1;
  }

  // gam-jeom：犯规方的对方加分
  const awarded = new Map(entries.map((id) => [id, 0]));
  for (const p of penalties) {
    if (p.kind !== "gam-jeom") continue;
    const opponent = entries.find((id) => id !== p.athlete_id);
    if (opponent) awarded.set(opponent, (awarded.get(opponent) ?? 0) + (p.points ?? 1));
  }

  // 裁判艺术分（可选）
  const artRaw = evidence.judge_art_score ?? [];
  const artGroups = new Map(entries.map((id) => [id, []]));
  for (const a of artRaw) if (artGroups.has(a.athlete_id)) artGroups.get(a.athlete_id).push(Number(a.value));
  const useArt = artRaw.length > 0;

  const rows = entries.map((athlete_id) => {
    const s = sensor.get(athlete_id);
    const sensorPoints = s.body * values.body + s.head * values.head;
    const penaltyPoints = awarded.get(athlete_id) ?? 0;
    const art = useArt ? trimmedMean(artGroups.get(athlete_id)) : 0;
    return {
      athlete_id,
      score: round2(sensorPoints + penaltyPoints + art),
      detail: {
        body_hits: s.body,
        head_hits: s.head,
        rejected_hits: s.rejected,
        sensor_points: sensorPoints,
        penalty_points_awarded: penaltyPoints,
        ...(useArt ? { art_score: art } : {}),
      },
    };
  });

  const ranking = rankWithTies(rows, (a, b) => b.score - a.score, config.tie_basis ?? "虚拟跆拳道规则第 6 章（传感器与平局突破）");
  return {
    sport: "virtual_taekwondo",
    algorithm: ALGORITHM_VERSION,
    entries: ranking,
    winners: ranking.filter((r) => r.rank === 1).map((r) => r.athlete_id),
  };
}

/**
 * @param {any[]} penalties
 * @returns {Map<string, number>} 运动员 -> 总扣分（冲浪干扰等直接扣总分的处罚）
 */
function collectDeductions(penalties) {
  const map = new Map();
  for (const p of penalties) {
    if (p.deduction_points) {
      map.set(p.athlete_id, (map.get(p.athlete_id) ?? 0) + p.deduction_points);
    }
  }
  return map;
}

/**
 * 排名并标记并列。compare 为正值表示 a 排在 b 前。
 * winners 可由项目规则从外部指定（如记分卡判定），指定后据此分出名次，
 * 否则按 compare；compare 为 0 的名次共享。
 * @returns {Array<{athlete_id: string, rank: number, tied?: boolean}>}
 */
export function rankWithTies(rows, compare, tieBasis, forcedWinners) {
  const sorted = [...rows].sort(compare);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    let rank = i + 1;
    const tiedWith = [];
    for (const other of sorted) {
      if (other !== row && compare(row, other) === 0) tiedWith.push(other.athlete_id);
    }
    if (tiedWith.length > 0) {
      const cluster = [row.athlete_id, ...tiedWith].sort();
      rank = sorted.filter((r) => compare(r, row) > 0).length + 1;
      if (forcedWinners && forcedWinners.length === 1 && cluster.includes(forcedWinners[0])) {
        // 外部规则已强制分出胜负（如裁判分歧判定），不保留并列标记
      } else {
        row.tie = { tied_with: tiedWith, basis: tieBasis, unresolved: true };
      }
    }
    out.push({ ...row, rank });
  }
  // forcedWinners 唯一时，重排名次
  if (forcedWinners && forcedWinners.length === 1) {
    const winnerId = forcedWinners[0];
    out.sort((a, b) =>
      a.athlete_id === winnerId ? -1 : b.athlete_id === winnerId ? 1 : compare(a, b),
    );
    out.forEach((r, i) => (r.rank = i + 1));
    for (const r of out) if (r.tie) delete r.tie;
  }
  return out;
}

/**
 * @typedef {object} CandidateResult
 * @property {"surfing"|"mma"|"virtual_taekwondo"} sport
 * @property {string} algorithm
 * @property {Array<{athlete_id: string, score: number, rank: number, detail?: any, tie?: any}>} entries
 * @property {string[]} winners
 * @property {{tied: string[], method?: string}} [tie]
 */
