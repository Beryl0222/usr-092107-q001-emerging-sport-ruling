// fold：把仅追加的事件流折叠成当前状态快照。命令处理器与投影共用，
// 保证「重放得到的状态」和「在线处理看到的状态」永远一致。

export function createState() {
  return {
    rules: new Map(), // rule_id -> 状态
    activeRuleBySport: new Map(), // sport -> rule_id（最近激活）
    eligibility: new Map(), // athlete_id -> 状态
    programs: new Map(), // program_id/pool_id -> 状态
    bouts: new Map(), // bout_id -> 状态
    devices: new Map(), // device_id -> 状态
    judges: new Map(), // judge_id -> 档案与指派
    assignmentsByBout: new Map(), // bout_id -> Map<judge_id, 指派>
    appeals: new Map(), // appeal_id -> 状态
    results: new Map(), // bout_id -> 结果生命周期（含历史版本）
    chains: new Map(), // chain_id -> 晋级链
    records: new Map(), // record_id -> 状态
  };
}

export function fold(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "RULE_VERSION_REGISTERED": {
      state.rules.set(event.aggregate_id, {
        rule_id: event.aggregate_id,
        sport: p.sport,
        status: "registered",
        registered_at: event.occurred_at,
        version_label: p.version_label,
        windows: p.windows ?? {},
        scoring_params: p.scoring_params ?? {},
        activations: [],
      });
      break;
    }
    case "RULE_ACTIVATED": {
      const rule = state.rules.get(event.aggregate_id);
      if (rule) {
        rule.status = "active";
        rule.activations.push({ at: event.occurred_at, note: p.note });
        state.activeRuleBySport.set(rule.sport, rule.rule_id);
      }
      break;
    }
    case "ATHLETE_ELIGIBILITY_CONFIRMED": {
      const prev = state.eligibility.get(p.athlete_id) ?? { history: [] };
      state.eligibility.set(p.athlete_id, {
        athlete_id: p.athlete_id,
        nation: p.nation ?? prev.nation,
        status: p.status,
        olympic_quota: p.olympic_quota ?? prev.olympic_quota ?? false,
        reason: p.reason,
        as_of: event.occurred_at,
        history: [...prev.history, { at: event.occurred_at, status: p.status, reason: p.reason, rule_version: p.rule_version }],
      });
      break;
    }
    case "EVENT_PROGRAM_DEFINED":
    case "POOL_COMPOSED": {
      state.programs.set(event.aggregate_id, {
        id: event.aggregate_id,
        kind: event.event_type === "POOL_COMPOSED" ? "pool" : "program",
        sport: p.sport,
        parent: p.pool_of ?? null,
        member_bouts: p.bout_ids ?? [],
        members: p.athlete_ids ?? [],
        defined_at: event.occurred_at,
      });
      break;
    }
    case "BOUT_SCHEDULED": {
      state.bouts.set(event.aggregate_id, {
        bout_id: event.aggregate_id,
        sport: p.sport,
        rule_version: p.rule_version,
        phase: p.phase ?? null,
        round_no: p.round_no ?? 1,
        athlete_ids: p.athlete_ids ?? [],
        sides: p.sides ?? null,
        chain_id: p.chain_id ?? null,
        slot: p.slot ?? null,
        olympic_qualification: p.olympic_qualification ?? false,
        status: "scheduled",
        scheduled_at: event.occurred_at,
        started_rounds: [],
        frozen: false,
        freeze_reasons: [],
        evidence: { judge_scores: [], sensor_messages: [], fouls: [], corrections: [] },
        tie_resolutions: [],
      });
      break;
    }
    case "ROSTER_FINALIZED": {
      const bout = state.bouts.get(event.aggregate_id);
      if (bout) {
        bout.athlete_ids = p.athlete_ids ?? bout.athlete_ids;
        bout.sides = p.sides ?? bout.sides;
        bout.status = "roster_finalized";
      }
      break;
    }
    case "ROUND_STARTED": {
      const bout = state.bouts.get(event.aggregate_id);
      if (bout && !bout.started_rounds.includes(p.round)) bout.started_rounds.push(p.round);
      break;
    }
    case "JUDGE_ASSIGNED": {
      const { bout_id, judge_id, role, judge_name, nations = [], conflicts = [] } = p;
      const profile = state.judges.get(judge_id) ?? { judge_id, assignments: new Map() };
      profile.name = judge_name ?? profile.name;
      profile.nations = nations;
      profile.conflicts = conflicts;
      profile.assignments.set(bout_id, { role, status: "assigned", at: event.occurred_at });
      state.judges.set(judge_id, profile);
      if (!state.assignmentsByBout.has(bout_id)) state.assignmentsByBout.set(bout_id, new Map());
      state.assignmentsByBout.get(bout_id).set(judge_id, { role, status: "assigned", at: event.occurred_at });
      break;
    }
    case "JUDGE_REMOVED": {
      const { bout_id, judge_id, reason } = p;
      const priorProfile = state.judges.get(judge_id)?.assignments.get(bout_id) ?? { role: null };
      state.judges.get(judge_id)?.assignments.set(bout_id, { ...priorProfile, status: "removed", reason, removed_at: event.occurred_at });
      const priorBout = state.assignmentsByBout.get(bout_id)?.get(judge_id) ?? { role: null };
      state.assignmentsByBout.get(bout_id)?.set(judge_id, { ...priorBout, status: "removed", reason, removed_at: event.occurred_at });
      break;
    }
    case "DEVICE_REGISTERED": {
      state.devices.set(event.aggregate_id, {
        device_id: event.aggregate_id,
        sport: p.sport,
        kind: p.kind ?? "sensor",
        status: "registered",
        calibrations: [],
        unreliable_since: null,
      });
      break;
    }
    case "DEVICE_CALIBRATED": {
      const device = state.devices.get(event.aggregate_id);
      if (device) {
        device.calibrations.push({ at: event.occurred_at, result: p.result, tolerance: p.tolerance ?? null, by: p.by, note: p.note });
        if (p.result === "passed") device.status = "calibrated";
        if (p.result === "failed") device.status = "calibration_failed";
      }
      break;
    }
    case "DEVICE_DECLARED_UNRELIABLE": {
      const device = state.devices.get(event.aggregate_id);
      if (device) {
        device.unreliable_since = event.occurred_at;
        device.status = "unreliable";
      }
      break;
    }
    case "RAW_SCORE_SUBMITTED": {
      const bout = state.bouts.get(p.bout_id);
      if (bout) {
        bout.evidence.judge_scores.push({
          event_id: event.event_id,
          round: p.round,
          judge_id: p.judge_id,
          athlete_id: p.athlete_id ?? null,
          wave_id: p.wave_id ?? null,
          score: p.score ?? null,
          card: p.card ?? null,
          occurred_at: event.occurred_at,
          recorded_at: event.recorded_at,
          superseded_by: null,
        });
      }
      break;
    }
    case "SENSOR_MESSAGE_INGESTED": {
      const bout = state.bouts.get(p.bout_id);
      if (bout) {
        bout.evidence.sensor_messages.push({
          event_id: event.event_id,
          idempotency_key: event.idempotency_key ?? null,
          round: p.round,
          device_id: p.device_id,
          msg_seq: p.msg_seq ?? null,
          side: p.side ?? null,
          action: p.action ?? null,
          value: p.value ?? null,
          valid: p.valid ?? false,
          invalid_reason: p.invalid_reason ?? null,
          occurred_at: event.occurred_at,
          recorded_at: event.recorded_at,
          ingested_seq: event.seq,
          superseded_by: null,
        });
      }
      break;
    }
    case "FOUL_RULED": {
      const bout = state.bouts.get(p.bout_id);
      if (bout) {
        bout.evidence.fouls.push({
          event_id: event.event_id,
          round: p.round,
          referee_id: p.referee_id,
          against: p.against,
          code: p.code,
          penalty: p.penalty,
          deduction: p.deduction ?? 0,
          reason: p.reason,
          occurred_at: event.occurred_at,
          superseded_by: null,
        });
      }
      break;
    }
    case "SCORE_CORRECTED": {
      const bout = state.bouts.get(p.bout_id);
      if (!bout) break;
      const mark = (entry) => {
        if (entry && entry.event_id === event.correction_of) entry.superseded_by = event.event_id;
      };
      bout.evidence.judge_scores.forEach(mark);
      bout.evidence.sensor_messages.forEach(mark);
      bout.evidence.fouls.forEach(mark);
      bout.evidence.corrections.push({
        event_id: event.event_id,
        correction_of: event.correction_of,
        appeal_id: p.appeal_id ?? null,
        round: p.round,
        kind: p.kind,
        by: p.by,
        reason: p.reason,
        replacement: p.replacement ?? {},
        occurred_at: event.occurred_at,
      });
      // 更正后的新事实同时进入对应证据清单；候选计算只读取未被取代的记录。
      const r = p.replacement ?? {};
      const base = { event_id: event.event_id, correction_of: event.correction_of, occurred_at: event.occurred_at, recorded_at: event.recorded_at, superseded_by: null };
      if (p.kind === "judge_score") {
        bout.evidence.judge_scores.push({
          ...base,
          round: r.round ?? p.round,
          judge_id: r.judge_id,
          athlete_id: r.athlete_id ?? null,
          wave_id: r.wave_id ?? null,
          score: r.score ?? null,
          card: r.card ?? null,
        });
      } else if (p.kind === "sensor_message") {
        bout.evidence.sensor_messages.push({
          ...base,
          round: r.round ?? p.round,
          device_id: r.device_id,
          msg_seq: r.msg_seq ?? null,
          side: r.side ?? null,
          action: r.action ?? null,
          value: r.value ?? null,
          valid: r.valid ?? false,
          invalid_reason: r.invalid_reason ?? null,
          occurred_at: r.occurred_at ?? event.occurred_at,
          ingested_seq: event.seq,
        });
      } else if (p.kind === "foul") {
        bout.evidence.fouls.push({
          ...base,
          round: r.round ?? p.round,
          referee_id: r.referee_id,
          against: r.against,
          code: r.code,
          penalty: r.penalty,
          deduction: r.deduction ?? 0,
          reason: r.reason,
        });
      }
      break;
    }
    case "TIEBREAK_RESOLVED": {
      const bout = state.bouts.get(p.bout_id);
      if (bout) bout.tie_resolutions.push({ event_id: event.event_id, round: p.round, tied: p.tied, winner: p.winner, basis: p.basis, by: p.by, at: event.occurred_at });
      break;
    }
    case "RESULT_CANDIDATE_PROJECTED": {
      const result = state.results.get(p.bout_id) ?? { result_id: event.aggregate_id, bout_id: p.bout_id, status: "none", effective: null, pending: null, history: [] };
      // 候选永远不触碰已生效版本：申诉期间即便挂着改判候选，原公告结果依旧有效。
      result.pending = {
        candidate_event_id: event.event_id,
        candidate: p.candidate,
        basis_seq: p.basis_seq,
        supersedes: p.supersedes_event_id ?? null,
        at: event.occurred_at,
      };
      if (result.status === "none") result.status = "candidate";
      state.results.set(p.bout_id, result);
      break;
    }
    case "RESULT_CERTIFIED": {
      const result = state.results.get(p.bout_id);
      if (result) {
        if (result.effective) result.history.push(result.effective);
        result.effective = {
          stage: "certified",
          certified_event_id: event.event_id,
          candidate: p.candidate ?? result.pending?.candidate,
          basis_seq: result.pending?.basis_seq ?? null,
          certified_at: event.occurred_at,
        };
        result.pending = null;
        result.status = "certified";
      }
      break;
    }
    case "RESULT_PUBLISHED": {
      const result = state.results.get(p.bout_id);
      if (result?.effective) {
        result.effective = {
          ...result.effective,
          stage: "published",
          published_event_id: event.event_id,
          published_at: event.occurred_at,
          public_version: p.public_version,
        };
        result.status = "published";
      }
      break;
    }
    case "RESULT_LOCKED": {
      const result = state.results.get(p.bout_id);
      if (result?.effective) {
        result.effective = { ...result.effective, stage: "locked", locked_event_id: event.event_id, locked_at: event.occurred_at, reason: p.reason };
        result.status = "locked";
      }
      break;
    }
    case "ADVANCEMENT_PROJECTED": {
      const chain = state.chains.get(event.aggregate_id) ?? { chain_id: event.aggregate_id, projections: new Map(), frozen: false, frozen_by: [], confirmed: new Map() };
      chain.projections.set(p.source_bout_id, { event_id: event.event_id, slots: p.slots, basis_result_event_id: p.basis_result_event_id, at: event.occurred_at });
      state.chains.set(event.aggregate_id, chain);
      break;
    }
    case "ADVANCEMENT_FROZEN": {
      const chain = state.chains.get(event.aggregate_id) ?? { chain_id: event.aggregate_id, projections: new Map(), frozen: false, frozen_by: [], confirmed: new Map() };
      chain.frozen = true;
      chain.frozen_by.push({ appeal_id: p.appeal_id, bout_ids: p.bout_ids ?? [], at: event.occurred_at });
      state.chains.set(event.aggregate_id, chain);
      for (const id of p.bout_ids ?? []) {
        const bout = state.bouts.get(id);
        if (bout) {
          bout.frozen = true;
          if (!bout.freeze_reasons.includes(p.appeal_id)) bout.freeze_reasons.push(p.appeal_id);
        }
      }
      break;
    }
    case "ADVANCEMENT_UNFROZEN": {
      const chain = state.chains.get(event.aggregate_id);
      if (chain) {
        chain.frozen = chain.frozen_by.some((f) => f.appeal_id !== p.appeal_id);
        chain.unfrozen_at = event.occurred_at;
        const lifted = chain.frozen_by.find((f) => f.appeal_id === p.appeal_id);
        for (const id of lifted?.bout_ids ?? []) {
          const bout = state.bouts.get(id);
          if (bout) {
            bout.freeze_reasons = bout.freeze_reasons.filter((a) => a !== p.appeal_id);
            if (bout.freeze_reasons.length === 0) bout.frozen = false;
          }
        }
        chain.frozen_by = chain.frozen_by.filter((f) => f.appeal_id !== p.appeal_id);
      }
      break;
    }
    case "ADVANCEMENT_CONFIRMED": {
      const chain = state.chains.get(event.aggregate_id);
      if (chain) {
        chain.confirmed.set(p.source_bout_id, { event_id: event.event_id, slots: p.slots, at: event.occurred_at });
      }
      break;
    }
    case "APPEAL_FILED": {
      state.appeals.set(event.aggregate_id, {
        appeal_id: event.aggregate_id,
        bout_id: p.bout_id,
        against_event_id: p.against_event_id,
        filed_by: p.filed_by,
        delegation: p.delegation,
        grounds: p.grounds,
        status: "filed",
        filed_at: event.occurred_at,
        evidence_window_end: p.evidence_window_end,
        review_window_end: p.review_window_end,
        evidences: [],
        reviews: [],
        decision: null,
      });
      break;
    }
    case "APPEAL_EVIDENCE_ACCEPTED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) appeal.evidences.push({ event_id: event.event_id, kind: p.kind, ref: p.ref, hash: p.hash, submitted_by: p.submitted_by, at: event.occurred_at });
      break;
    }
    case "APPEAL_REVIEW_LOGGED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) {
        appeal.status = "under_review";
        appeal.reviews.push({ event_id: event.event_id, by: p.by, recommendation: p.recommendation, note: p.note, at: event.occurred_at });
      }
      break;
    }
    case "APPEAL_UPHELD": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) {
        appeal.status = "upheld";
        appeal.decision = { outcome: "upheld", directive: p.directive, corrected_result_event_id: p.corrected_result_event_id, at: event.occurred_at };
      }
      break;
    }
    case "APPEAL_REJECTED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) {
        appeal.status = "rejected";
        appeal.decision = { outcome: "rejected", reason: p.reason, at: event.occurred_at };
      }
      break;
    }
    case "APPEAL_WITHDRAWN": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) {
        appeal.status = "withdrawn";
        appeal.decision = { outcome: "withdrawn", at: event.occurred_at };
      }
      break;
    }
    case "RECORD_CERTIFIED": {
      state.records.set(event.aggregate_id, {
        record_id: event.aggregate_id,
        athlete_id: p.athlete_id,
        sport: p.sport,
        category: p.category,
        mark: p.mark,
        bout_id: p.bout_id,
        status: "certified",
        certified_at: event.occurred_at,
        event_id: event.event_id,
      });
      break;
    }
    default:
      break;
  }
  return state;
}

/** 从完整事件流重放出状态。 */
export function replayAll(events) {
  return events.reduce((state, event) => fold(state, event), createState());
}

/** 在指定时刻之前最后激活的规则版本；未激活返回 null。 */
export function activeRuleAt(state, sport, at) {
  let candidate = null;
  for (const rule of state.rules.values()) {
    if (rule.sport !== sport) continue;
    const last = rule.activations.filter((a) => Date.parse(a.at) <= Date.parse(at)).at(-1);
    if (last && (!candidate || Date.parse(last.at) > Date.parse(candidate.activatedAt))) {
      candidate = { rule, activatedAt: last.at };
    }
  }
  return candidate?.rule ?? null;
}

/** 设备在指定时刻是否处于「已通过校准且未被宣布不可靠」的可用状态。 */
export function deviceUsableAt(device, at) {
  if (!device) return false;
  if (device.unreliable_since && Date.parse(device.unreliable_since) <= Date.parse(at)) return false;
  const passed = device.calibrations.filter((c) => c.result === "passed" && Date.parse(c.at) <= Date.parse(at));
  return passed.length > 0;
}
