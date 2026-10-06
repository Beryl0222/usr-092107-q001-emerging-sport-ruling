import { acceptedEvidence, activePenalties, fold } from "./projection.js";
import { hashEvent } from "./envelope.js";

/**
 * 读视图：全部由事件流派生，不保存独立状态。
 * - officialReplay：赛事官员重放一场比赛从原始输入到公告名次的全过程；
 * - teamView：代表队看到自己相关申诉的状态与截止时间；
 * - publicView：公开成绩只包含已生效（已发布）且可核验的版本。
 */

/** 赛事官员重放：事实时间线 + 每个决定的证据来源 + 哈希锚点。 */
export function officialReplay(store, boutId) {
  const events = store
    .replay(boutId)
    .filter((e) => e.correlation_id === boutId || e.payload?.bout_id === boutId);
  const state = fold(events);
  const bout = state.bouts.get(boutId);
  if (!bout) return null;

  const result = state.results.get(boutId);
  const timeline = events.map((e) => ({
    seq: e.seq,
    event_id: e.event_id,
    type: e.event_type,
    occurred_at: e.occurred_at,
    stored_at: e.stored_at,
    version: e.version,
    causation_id: e.causation_id,
    summary: e.summary,
  }));

  const amendments = events
    .filter((e) => e.event_type === "RULING_AMENDED")
    .map((e) => ({
      amendment_id: e.event_id,
      target_id: e.payload.target_id,
      action: e.payload.action,
      reason: e.payload.reason,
      amended_by: e.payload.amended_by,
      appeal_id: e.payload.appeal_id,
      at: e.occurred_at,
    }));

  const appeals = [...state.appeals.values()].map((a) => ({
    id: a.id,
    status: a.status,
    reason: a.reason,
    filed_at: a.filed_at,
    decided_at: a.decided_at,
    decision: a.decision,
    deadline: a.appeal_deadline,
    affected_bout_ids: a.affected_bout_ids,
    opinions: a.opinions,
  }));

  const verification = latestAnchor(store, boutId);
  const chain = store.verifyChain();

  return {
    bout: {
      id: boutId,
      sport: bout.sport,
      rules_version: bout.rules_version,
      status: bout.status,
      entries: bout.entries,
      evidence_deadline: bout.evidence_deadline,
      appeal_deadline: bout.appeal_deadline,
      olympic_locked: bout.olympic_locked ?? false,
    },
    frozen: state.frozenBouts.has(boutId)
      ? { by_appeal: state.frozenBouts.get(boutId) }
      : null,
    current_evidence: acceptedEvidence(state, boutId),
    quarantined_evidence: [...state.evidence.values()].filter(
      (e) => e.bout_id === boutId && e.status === "quarantined",
    ),
    voided_or_superseded: [...state.evidence.values()]
      .filter((e) => e.bout_id === boutId && ["voided", "superseded"].includes(e.status))
      .map((e) => ({ event_id: e.event_id, status: e.status, superseded_by: e.superseded_by })),
    active_penalties: activePenalties(state, boutId),
    amendments,
    appeals,
    candidates: result?.candidates.map((c) => ({
      event_id: c.event_id,
      at: c.at,
      used_evidence: c.used_evidence,
      used_sanctions: c.used_sanctions,
      entries: c.candidate.entries,
      algorithm: c.candidate.algorithm,
    })) ?? [],
    certified: result?.certified
      ? {
          event_id: result.certified.event_id,
          at: result.certified.at,
          signer: result.certified.signer,
          candidate_hash: result.certified.candidate_hash,
          standings: result.certified.standings,
        }
      : null,
    published: result?.published
      ? {
          event_id: result.published.event_id,
          at: result.published.at,
          standings: result.published.standings,
        }
      : null,
    timeline,
    verification,
    chain_valid: chain.valid,
  };
}

/** 已发布结果 -> 签署 -> 候选 的哈希锚点，公开方可据此核验。 */
function latestAnchor(store, boutId) {
  const byId = new Map(store.all().map((e) => [e.event_id, e]));
  const published = store
    .byType("RESULT_PUBLISHED")
    .filter((e) => e.payload.bout_id === boutId)
    .at(-1);
  if (!published) return null;
  const cert = byId.get(published.payload.cert_event_id);
  const candidate = byId.get(cert?.payload.candidate_event_id);
  return {
    published: { event_id: published.event_id, content_hash: published.content_hash },
    certified: cert ? { event_id: cert.event_id, content_hash: cert.content_hash } : null,
    candidate: candidate ? { event_id: candidate.event_id, content_hash: candidate.content_hash } : null,
  };
}

/** 代表队视图：本队相关场次的公告状态、申诉状态与截止时间（不含内部审议细节）。 */
export function teamView(store, teamId) {
  const state = fold(store.all());
  const myAthletes = new Set(
    [...state.athletes.values()].filter((a) => a.team_id === teamId).map((a) => a.id),
  );
  const items = [];
  for (const bout of state.bouts.values()) {
    if (!bout.entries.some((id) => myAthletes.has(id))) continue;
    const appeals = [...state.appeals.values()].filter(
      (a) => a.bout === bout.id || a.bout_id === bout.id,
    );
    const result = state.results.get(bout.id);
    items.push({
      bout_id: bout.id,
      sport: bout.sport,
      status: bout.status,
      evidence_deadline: bout.evidence_deadline,
      appeal_deadline: bout.appeal_deadline,
      advancement_frozen: state.frozenBouts.has(bout.id),
      result_stage: result?.published ? "published" : result?.certified ? "certified" : "pending",
      appeals: appeals.map((a) => ({
        id: a.id,
        status: a.status,
        filed_by: a.filed_by,
        filed_at: a.filed_at,
        decided_at: a.decided_at,
        decision: a.decision,
      })),
    });
  }
  return { team_id: teamId, items };
}

/** 公开视图：仅已发布、哈希链完好的成绩；每条都带核验锚点。 */
export function publicView(store) {
  const chain = store.verifyChain();
  if (!chain.valid) {
    // 链异常时不展示任何成绩，避免公布被篡改过的版本
    return { healthy: false, broken_at: chain.brokenAt, results: [] };
  }
  const state = fold(store.all());
  const results = [];
  for (const [boutId, result] of state.results) {
    if (!result.published) continue;
    const bout = state.bouts.get(boutId);
    const anchor = latestAnchor(store, boutId);
    results.push({
      bout_id: boutId,
      sport: bout.sport,
      rules_version: bout.rules_version,
      published_at: result.published.at,
      standings: result.published.standings,
      verify: anchor,
      olympic_qualifier: bout.olympic_locked ?? false,
    });
  }
  results.sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
  return { healthy: true, results };
}

/** 用事件存储重算单条事件正文哈希，供公开方核验。 */
export function verifyEvent(store, eventId) {
  const event = store.all().find((e) => e.event_id === eventId);
  if (!event) return null;
  const { content_hash, prev_hash, seq, stored_at, ...body } = event;
  return {
    event_id: eventId,
    stored_hash: content_hash,
    recomputed_hash: hashEvent(body),
    matches: hashEvent(body) === content_hash,
    prev_hash,
    seq,
  };
}
