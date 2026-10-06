// 公开成绩视图：只展示已经正式公告（published/locked）且可核验的版本。
// 候选、待签署、申诉中的中间结果一律不出现；被新版本取代的旧版本标注 superseded。
import { hashEvent } from "../events/envelope.js";

export function publicResults(backend, { sport } = {}) {
  const state = backend.state();
  const out = [];

  for (const result of state.results.values()) {
    const bout = state.bouts.get(result.bout_id);
    if (!bout || (sport && bout.sport !== sport)) continue;
    const effective = result.effective;
    if (!effective || !["published", "locked"].includes(effective.stage)) continue;

    const pv = effective.public_version;
    const publishedEvent = backend.store.byId(effective.published_event_id);
    const chain = backend.store.verifyChain();
    const signatureValid = publishedEvent?.signature ? backend.signing.verify(publishedEvent.signature, publishedEvent.hash) : false;

    out.push({
      bout_id: result.bout_id,
      sport: bout.sport,
      phase: bout.phase,
      olympic_qualification: bout.olympic_qualification,
      version_no: pv.version_no,
      winner: pv.winner,
      winner_athlete_id: pv.winner_athlete_id,
      standings: pv.standings,
      outcome: pv.outcome,
      published_at: effective.published_at,
      locked: effective.stage === "locked",
      verification: {
        published_event_id: effective.published_event_id,
        event_hash: publishedEvent?.hash ?? null,
        basis_event_ids: pv.basis_event_ids,
        basis_seq: pv.basis_seq,
        signed_by: publishedEvent?.signature ? { official_id: publishedEvent.signature.official_id, role: publishedEvent.signature.role } : null,
        signature_valid: signatureValid,
        chain_intact: chain.ok,
        verifiable: signatureValid && chain.ok,
      },
      // 历史版本仅保留公告事件与哈希，供公众核验“当前版本之前发生过什么”。
      history: result.history
        .filter((h) => h.public_version)
        .map((h) => ({
          version_no: h.public_version.version_no,
          published_event_id: h.published_event_id,
          winner: h.public_version.winner,
          superseded: true,
        })),
    });
  }

  out.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return { as_of: backend.now(), count: out.length, results: out };
}

/** 公众按事件哈希独立核验一条公告。 */
export function publicVerify(backend, eventId, expectedHash) {
  const event = backend.store.byId(eventId);
  if (!event || event.event_type !== "RESULT_PUBLISHED") {
    return { ok: false, verifiable: false, reason: "NOT_A_PUBLISHED_RESULT" };
  }
  const recomputed = hashEvent(event);
  const signatureValid = event.signature ? backend.signing.verify(event.signature, event.hash) : false;
  const hashMatches = recomputed === event.hash && (!expectedHash || expectedHash === event.hash);
  const state = backend.state();
  const result = state.results.get(event.payload.bout_id);
  const isCurrent = result?.effective?.published_event_id === eventId;
  return {
    ok: hashMatches && signatureValid,
    verifiable: hashMatches && signatureValid,
    current_version: isCurrent,
    superseded: !isCurrent,
    event_hash: event.hash,
    signature_valid: signatureValid,
    summary: event.summary,
    occurred_at: event.occurred_at,
  };
}
