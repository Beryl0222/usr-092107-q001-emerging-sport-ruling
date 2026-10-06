// 代表队视图：只看本队相关申诉的状态、窗口截止时间与当前进展；看不到其他队申诉与内部评审员身份。
export function delegationView(backend, delegationOrFiler) {
  const state = backend.state();
  const appeals = [...state.appeals.values()]
    .filter((a) => a.delegation === delegationOrFiler || a.filed_by === delegationOrFiler)
    .map((a) => {
      const now = Date.parse(backend.now());
      const bout = state.bouts.get(a.bout_id);
      return {
        appeal_id: a.appeal_id,
        bout_id: a.bout_id,
        sport: bout?.sport ?? null,
        status: a.status,
        status_label: {
          filed: "已受理",
          under_review: "仲裁复核中",
          upheld: "申诉成立",
          rejected: "申诉驳回",
          withdrawn: "已撤回",
        }[a.status],
        filed_at: a.filed_at,
        grounds: a.grounds,
        evidence_window_end: a.evidence_window_end,
        review_window_end: a.review_window_end,
        evidence_open: now <= Date.parse(a.evidence_window_end),
        review_open: now <= Date.parse(a.review_window_end),
        seconds_to_evidence_close: Math.max(0, Math.round((Date.parse(a.evidence_window_end) - now) / 1000)),
        seconds_to_review_close: Math.max(0, Math.round((Date.parse(a.review_window_end) - now) / 1000)),
        evidence_count: a.evidences.length,
        review_rounds: a.reviews.length,
        decision: a.decision
          ? {
              outcome: a.decision.outcome,
              at: a.decision.at,
              // 驳回原因对申诉方可见；改判内部编号不外显，只告知是否已产生新版本。
              reason: a.decision.reason ?? null,
              republished: a.decision.outcome === "upheld",
            }
          : null,
        // 受冻结影响的后续场次（只给编号，不给对阵细节）。
        frozen_chain: bout?.chain_id ?? null,
      };
    });

  return { viewer: delegationOrFiler, as_of: backend.now(), appeals };
}
