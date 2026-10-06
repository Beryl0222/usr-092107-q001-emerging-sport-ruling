// 纯计分包：只做规则数学，不做签署、不改状态。
// 所有函数返回「候选结果」：并列无法自动打破时，在 unresolved_ties 中显式标出，
// 由裁判长/仲裁用 TIEBREAK_RESOLVED 决定，绝不静默猜测名次。

const round2 = (n) => Math.round(n * 100) / 100;

/** 去掉一个最高分、一个最低分后求平均（裁判数不足 3 时直接平均）。 */
export function trimmedMean(scores) {
  const values = scores.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const used = values.length >= 3 ? values.slice(1, -1) : values;
  return round2(used.reduce((sum, n) => sum + n, 0) / used.length);
}

/**
 * 冲浪：每名选手取两条最高分浪之和；干扰/优先规则罚分从总分扣除。
 * @param {{athlete_id:string, waves:Array<{wave_id:string, judge_scores:number[], factor?:number}>, deductions?:number}[]} athleteInputs
 * @returns {{standings: Array<{rank:number, athlete_id:string, total:number, best_waves:number[], tied_with:string[]}>, unresolved_ties: string[][]}
 */
export function scoreSurfing(athleteInputs) {
  const rows = athleteInputs.map(({ athlete_id, waves = [], deductions = 0 }) => {
    const waveScores = waves.map((w) => round2(trimmedMean(w.judge_scores ?? []) * (w.factor ?? 1)));
    const bestWaves = waveScores.sort((a, b) => b - a).slice(0, 2);
    const total = round2(Math.max(0, bestWaves.reduce((s, n) => s + n, 0) - deductions));
    return { athlete_id, total, best_waves: bestWaves };
  });
  return rankWithCountback(rows);
}

/** 冲浪并列回算：总分 → 最高单浪 → 次高单浪；仍相同则留待裁判长决定。 */
function rankWithCountback(rows) {
  const key = (r) => [r.total, r.best_waves[0] ?? 0, r.best_waves[1] ?? 0];
  const sorted = rows.slice().sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (kb[i] !== ka[i]) return kb[i] - ka[i];
    return 0;
  });
  return assembleStandings(sorted, key);
}

function assembleStandings(sorted, keyOf) {
  const standings = [];
  const unresolvedTies = [];
  let i = 0;
  let rank = 1;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && keyOf(sorted[j]).every((v, k) => v === keyOf(sorted[i])[k])) j++;
    const group = sorted.slice(i, j);
    const tied = group.map((g) => g.athlete_id);
    for (const row of group) {
      standings.push({
        rank,
        athlete_id: row.athlete_id,
        total: row.total,
        best_waves: row.best_waves,
        tied_with: group.length > 1 ? tied.filter((id) => id !== row.athlete_id) : [],
      });
    }
    if (group.length > 1) unresolvedTies.push(tied);
    rank += group.length;
    i = j;
  }
  return { standings, unresolved_ties: unresolvedTies };
}

/**
 * 综合格斗：三名边裁各自 10 分制计分卡汇总；扣分在回合有效分中先行扣除。
 * @param {{rounds: Array<{round:number, cards:Array<{judge_id:string, red:number, blue:number, red_deductions?:number, blue_deductions?:number}>}>}} input
 */
export function scoreMma({ rounds }) {
  const totals = new Map(); // judge_id -> {red, blue}

  for (const r of rounds) {
    for (const card of r.cards) {
      const t = totals.get(card.judge_id) ?? { red: 0, blue: 0 };
      t.red += (card.red ?? 0) - (card.red_deductions ?? 0);
      t.blue += (card.blue ?? 0) - (card.blue_deductions ?? 0);
      totals.set(card.judge_id, t);
    }
  }

  const cards = [];
  for (const [judge_id, t] of totals) {
    const verdict = t.red > t.blue ? "red" : t.blue > t.red ? "blue" : "draw";
    cards.push({ judge_id, red: t.red, blue: t.blue, verdict });
  }
  const votes = { red: cards.filter((c) => c.verdict === "red").length, blue: cards.filter((c) => c.verdict === "blue").length, draw: cards.filter((c) => c.verdict === "draw").length };

  let outcome;
  if (votes.red === 0 && votes.blue === 0) outcome = "unanimous_draw";
  else if (votes.red === votes.blue) outcome = "split_draw"; // 含一张平局卡形成的 1-1-1
  else if (votes.red > votes.blue) {
    outcome = votes.blue === 0 && votes.draw === 0 ? "unanimous_decision_red" : votes.blue === 0 ? "majority_decision_red" : "split_decision_red";
  } else {
    outcome = votes.red === 0 && votes.draw === 0 ? "unanimous_decision_blue" : votes.red === 0 ? "majority_decision_blue" : "split_decision_blue";
  }

  const winner = outcome.endsWith("_red") ? "red" : outcome.endsWith("_blue") ? "blue" : null;
  return { cards, votes, outcome, winner, unresolved_ties: winner ? [] : [["red", "blue"]] };
}

/**
 * 虚拟跆拳道：三回合有效传感得分 + 扣分；平分进入金赛点，金赛点无得分按优势（有效接触次数）裁决。
 * 上游已依据校准时点过滤无效设备消息；这里只接受 valid 技术动作。
 * @param {{regulation:Array<{round:number, red:{kicks:number[], deductions:number}, blue:{kicks:number[], deductions:number}}>,
 *          golden?:{first_scorer?:"red"|"blue"|null, contacts?:{red:number, blue:number}}}} input
 */
export function scoreVirtualTaekwondo({ regulation, golden }) {
  const sum = (side) => side.kicks.reduce((a, b) => a + b, 0);
  const perRound = regulation.map((r) => {
    // 对方扣分（告警）记为己方 +1
    const red = sum(r.red) + r.blue.deductions;
    const blue = sum(r.blue) + r.red.deductions;
    return { round: r.round, red: round2(red), blue: round2(blue) };
  });
  const redTotal = round2(perRound.reduce((s, r) => s + r.red, 0));
  const blueTotal = round2(perRound.reduce((s, r) => s + r.blue, 0));

  if (redTotal !== blueTotal) {
    return { per_round: perRound, red_total: redTotal, blue_total: blueTotal, winner: redTotal > blueTotal ? "red" : "blue", mode: "regulation", unresolved_ties: [] };
  }
  if (!golden) {
    return { per_round: perRound, red_total: redTotal, blue_total: blueTotal, winner: null, mode: "golden_required", unresolved_ties: [["red", "blue"]] };
  }
  if (golden.first_scorer) {
    return { per_round: perRound, red_total: redTotal, blue_total: blueTotal, winner: golden.first_scorer, mode: "golden_point", unresolved_ties: [] };
  }
  const contacts = golden.contacts ?? { red: 0, blue: 0 };
  if (contacts.red !== contacts.blue) {
    return { per_round: perRound, red_total: redTotal, blue_total: blueTotal, winner: contacts.red > contacts.blue ? "red" : "blue", mode: "superiority_contacts", unresolved_ties: [] };
  }
  // 优势仍相同：必须由仲裁团显式裁决，系统不猜。
  return { per_round: perRound, red_total: redTotal, blue_total: blueTotal, winner: null, mode: "superiority_referee", unresolved_ties: [["red", "blue"]] };
}
