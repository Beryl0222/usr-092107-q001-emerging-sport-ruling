// 官员视图：重放一场比赛从原始输入到公告名次的全过程。
// 重放不是展示日志，而是独立验算：
//  1) 校验全库哈希链未被改写；
//  2) 在每个候选投影时点，用截至该时点的事件重新折叠并重算，与历史候选逐字段比对；
//  3) 对公告事件验签；公开版本必须链、算、签三者一致才可核验通过。
import { replayAll } from "./fold.js";
import { buildCandidate } from "./compute.js";
import { hashEvent, canonicalize } from "../events/envelope.js";

function stableEqual(a, b) {
  return canonicalize(a) === canonicalize(b);
}

export function replayBout(backend, boutId) {
  const events = backend.events();
  const state = backend.state();
  const bout = state.bouts.get(boutId);
  if (!bout) return { ok: false, error: "BOUT_NOT_FOUND", bout_id: boutId };

  const chain = backend.store.verifyChain();
  const boutEvents = events.filter((e) => e.correlation_id === boutId).sort((a, b) => a.seq - b.seq);

  // 原始输入时间线（按全局接收顺序），标注离线补传与被取代状态。
  const timeline = boutEvents
    .filter((e) => ["RAW_SCORE_SUBMITTED", "SENSOR_MESSAGE_INGESTED", "FOUL_RULED", "SCORE_CORRECTED", "TIEBREAK_RESOLVED"].includes(e.event_type))
    .map((e) => ({
      seq: e.seq,
      event_id: e.event_id,
      type: e.event_type,
      occurred_at: e.occurred_at,
      recorded_at: e.recorded_at,
      delayed: e.recorded_at !== undefined && Date.parse(e.recorded_at) - Date.parse(e.occurred_at) > 1000,
      correction_of: e.correction_of ?? null,
      summary: e.summary,
      payload: e.payload,
    }));

  // 逐候选验算：取 basis_seq 时点之前的事件重放重算。
  const candidateChecks = boutEvents
    .filter((e) => e.event_type === "RESULT_CANDIDATE_PROJECTED")
    .map((e) => {
      const basisSeq = e.payload.basis_seq;
      const stateThen = replayAll(events.filter((x) => x.seq <= basisSeq));
      const boutThen = stateThen.bouts.get(boutId);
      const recomputed = boutThen ? buildCandidate(stateThen, boutThen) : null;
      return {
        event_id: e.event_id,
        seq: e.seq,
        causation_id: e.causation_id ?? null,
        basis_seq: basisSeq,
        matches_history: stableEqual(recomputed, e.payload.candidate),
        historical_candidate: e.payload.candidate,
        recomputed,
      };
    });

  // 公告版本与验签。
  const result = state.results.get(boutId);
  const publishedEvents = boutEvents.filter((e) => e.event_type === "RESULT_PUBLISHED");
  const announced = publishedEvents.map((e) => {
    const sig = e.signature;
    const signatureValid = sig ? backend.signing.verify(sig, e.hash) : false;
    return {
      event_id: e.event_id,
      seq: e.seq,
      hash: e.hash,
      version_no: e.payload.public_version.version_no,
      olympic_qualification: e.payload.olympic_qualification,
      public_version: e.payload.public_version,
      signed_by: sig ? { official_id: sig.official_id, role: sig.role } : null,
      signature_valid: signatureValid,
    };
  });

  const freezeEvents = boutEvents.filter((e) => ["ADVANCEMENT_FROZEN", "ADVANCEMENT_UNFROZEN"].includes(e.event_type)).map((e) => ({
    seq: e.seq,
    type: e.event_type,
    appeal_id: e.payload.appeal_id,
    bout_ids: e.payload.bout_ids,
    at: e.occurred_at,
  }));

  const current = result?.effective
    ? {
        stage: result.effective.stage,
        version_no: result.effective.public_version?.version_no ?? null,
        candidate: result.effective.candidate,
        published_event_id: result.effective.published_event_id ?? null,
        certified_event_id: result.effective.certified_event_id ?? null,
      }
    : null;

  const currentRecomputed = buildCandidate(state, bout);
  const recomputeMatchesCurrent = current ? stableEqual(currentRecomputed, current.candidate) : null;

  const ok =
    chain.ok &&
    candidateChecks.every((c) => c.matches_history) &&
    (recomputeMatchesCurrent === null || recomputeMatchesCurrent) &&
    announced.every((a) => a.signature_valid);

  return {
    ok,
    bout_id: boutId,
    sport: bout.sport,
    olympic_qualification: bout.olympic_qualification,
    chain,
    timeline,
    candidate_checks: candidateChecks,
    freeze_timeline: freezeEvents,
    announced_versions: announced,
    current,
    current_recomputed: currentRecomputed,
    recompute_matches_current: recomputeMatchesCurrent,
  };
}

/** 核验单条事件哈希（公开页面用来验证某条公告）。 */
export function verifyEventHash(backend, eventId) {
  const event = backend.store.byId(eventId);
  if (!event) return { ok: false, error: "EVENT_NOT_FOUND", event_id: eventId };
  const recomputedHash = hashEvent(event);
  const signatureValid = event.signature ? backend.signing.verify(event.signature, event.hash) : null;
  return {
    ok: recomputedHash === event.hash,
    event_id: eventId,
    hash: event.hash,
    recomputed_hash: recomputedHash,
    event_type: event.event_type,
    signature_valid: signatureValid,
  };
}
