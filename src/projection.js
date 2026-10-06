/**
 * 世界状态投影：把仅追加事件流折叠成当前状态。
 * 投影随时可以整体重建，因此不保存任何事件之外的状态。
 * 证据从不消失：被改判的记录保留原状并标记 superseded_by，
 * 更正后的内容以原记录为来源生成新的现行版本。
 */

export function fold(events) {
  const state = createState();
  for (const event of events) foldEvent(state, event);
  return state;
}

export function createState() {
  return {
    rulebooks: new Map(),
    athletes: new Map(),
    eligibility: new Map(),
    officials: new Map(),
    panels: new Map(),
    devices: new Map(),
    sessions: new Map(),
    draws: new Map(),
    bouts: new Map(),
    evidence: new Map(),
    sanctions: new Map(),
    appeals: new Map(),
    frozenBouts: new Map(), // bout_id -> appeal_id
    progression: new Map(), // draw_id -> {confirmed: Map(bout->winners), qualified: Map(bout->[athletes])}
    results: new Map(),
    quotas: new Map(), // bout_id -> 分配事件
    records: new Map(),
  };
}

function boutResult(state, boutId) {
  if (!state.results.has(boutId)) {
    state.results.set(boutId, {
      candidates: [],
      tie_resolution: undefined,
      certified: undefined,
      published: undefined,
    });
  }
  return state.results.get(boutId);
}

function foldEvent(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "RULEBOOK_PUBLISHED":
      state.rulebooks.set(event.aggregate_id, {
        id: event.aggregate_id,
        status: "published",
        ...p,
        published_at: event.occurred_at,
      });
      break;
    case "RULEBOOK_ACTIVATED": {
      const book = state.rulebooks.get(event.aggregate_id);
      if (book) {
        book.status = "active";
        book.activated_at = event.occurred_at;
      }
      // 同一赛项旧版本失效
      for (const other of state.rulebooks.values()) {
        if (other.sport === p.sport && other.id !== event.aggregate_id) other.status = "superseded";
      }
      break;
    }
    case "ATHLETE_REGISTERED":
      state.athletes.set(event.aggregate_id, { id: event.aggregate_id, ...p });
      break;
    case "ELIGIBILITY_GRANTED":
    case "ELIGIBILITY_REVOKED": {
      const key = `${p.athlete_id}:${p.competition_id}`;
      const prev = state.eligibility.get(key);
      state.eligibility.set(key, {
        ...prev,
        athlete_id: p.athlete_id,
        competition_id: p.competition_id,
        status: event.event_type === "ELIGIBILITY_GRANTED" ? "eligible" : "revoked",
        reason: p.reason,
        since: event.occurred_at,
      });
      break;
    }
    case "OFFICIAL_REGISTERED":
      state.officials.set(event.aggregate_id, {
        id: event.aggregate_id,
        conflicts: [],
        ...p,
      });
      break;
    case "CONFLICT_DECLARED": {
      const official = state.officials.get(p.official_id);
      if (official) {
        official.conflicts.push({
          type: p.conflict_type,
          ref_id: p.ref_id,
          reason: p.reason,
          since: event.occurred_at,
        });
      }
      break;
    }
    case "PANEL_ASSIGNED": {
      // 同一角色可有多名裁判（如三名打分裁判），席位按人而非角色区分
      const list = state.panels.get(p.bout_id) ?? [];
      for (const seat of p.seats) {
        const idx = list.findIndex(
          (s) => s.official_id === seat.official_id || (s.seat_no === seat.seat_no && seat.seat_no !== undefined),
        );
        const entry = { status: "active", since: event.occurred_at, ...seat };
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
      }
      state.panels.set(p.bout_id, list);
      break;
    }
    case "JUDGE_REPLACED": {
      const list = state.panels.get(p.bout_id) ?? [];
      // 优先按被替换者定位；未指定时替换该角色当前在任的第一人
      const seat = list.find(
        (s) =>
          s.status === "active" &&
          (p.replaced_official_id ? s.official_id === p.replaced_official_id : s.role === p.role),
      );
      if (seat) {
        seat.status = "withdrawn";
        seat.withdrawn_at = event.occurred_at;
      }
      list.push({ official_id: p.replacement_id, role: p.role, status: "active", since: event.occurred_at });
      state.panels.set(p.bout_id, list);
      break;
    }
    case "DEVICE_REGISTERED":
      state.devices.set(event.aggregate_id, {
        id: event.aggregate_id,
        calibrations: [],
        ...p,
      });
      break;
    case "DEVICE_CALIBRATED": {
      const device = state.devices.get(event.aggregate_id);
      if (device) {
        device.calibrations.push({
          at: event.occurred_at,
          valid_until: p.valid_until,
          result: p.result,
          tolerance: p.tolerance,
          event_id: event.event_id,
        });
      }
      break;
    }
    case "DEVICE_BOUND": {
      const device = state.devices.get(p.device_id);
      if (device) device.bound = { bout_id: p.bout_id, from: event.occurred_at };
      break;
    }
    case "SESSION_SCHEDULED":
      state.sessions.set(event.aggregate_id, { id: event.aggregate_id, ...p });
      break;
    case "DRAW_CONDUCTED":
      state.draws.set(event.aggregate_id, {
        id: event.aggregate_id,
        status: "conducted",
        ...p,
        bracket: new Map(p.bracket.map((node) => [node.bout_id, node])),
      });
      break;
    case "DRAW_PUBLISHED": {
      const draw = state.draws.get(event.aggregate_id);
      if (draw) draw.status = "published";
      break;
    }
    case "BOUT_SCHEDULED":
      state.bouts.set(event.aggregate_id, {
        id: event.aggregate_id,
        status: "scheduled",
        participants: [],
        rounds: [],
        ...p,
      });
      break;
    case "BOUT_PARTICIPANT_QUALIFIED": {
      const bout = state.bouts.get(event.aggregate_id);
      if (bout && !bout.participants.includes(p.athlete_id)) bout.participants.push(p.athlete_id);
      break;
    }
    case "ROUND_STARTED": {
      const bout = state.bouts.get(p.bout_id);
      if (bout) {
        bout.status = "in_progress";
        bout.rounds.push({ round_no: p.round_no, started_at: event.occurred_at, ended_at: undefined });
      }
      break;
    }
    case "ROUND_ENDED": {
      const bout = state.bouts.get(p.bout_id);
      const round = bout?.rounds.find((r) => r.round_no === p.round_no);
      if (round) round.ended_at = event.occurred_at;
      break;
    }
    case "BOUT_ENDED": {
      const bout = state.bouts.get(p.bout_id);
      if (bout) {
        bout.status = "ended";
        bout.ended_at = event.occurred_at;
        bout.evidence_deadline = p.evidence_deadline;
        bout.appeal_deadline = p.appeal_deadline;
      }
      break;
    }
    case "EVIDENCE_RECORDED":
      state.evidence.set(event.aggregate_id, {
        event_id: event.aggregate_id,
        version: event.version,
        status: "recorded",
        occurred_at: event.occurred_at,
        stored_at: event.stored_at,
        judge_id: p.judge_id,
        device_id: p.device_id,
        ...p,
      });
      break;
    case "EVIDENCE_QUARANTINED":
      state.evidence.set(event.aggregate_id, {
        event_id: event.aggregate_id,
        version: event.version,
        status: "quarantined",
        occurred_at: event.occurred_at,
        stored_at: event.stored_at,
        ...p,
        quarantine_reason: p.reason,
      });
      break;
    case "PENALTY_IMPOSED":
      state.sanctions.set(event.aggregate_id, {
        event_id: event.aggregate_id,
        status: "active",
        occurred_at: event.occurred_at,
        ...p,
      });
      break;
    case "PENALTY_REVOKED": {
      const sanction = state.sanctions.get(p.sanction_id);
      if (sanction) {
        sanction.status = "revoked";
        sanction.revoked_at = event.occurred_at;
        sanction.revoke_reason = p.reason;
      }
      break;
    }
    case "RULING_AMENDED": {
      // 引用原记录：原记录保留并指向本事件；更正内容成为现行版本
      const targetId = p.target_id;
      const target = state.evidence.get(targetId) ?? state.sanctions.get(targetId);
      if (target) {
        target.status = p.action === "void" ? "voided" : "superseded";
        target.superseded_by = event.event_id;
      }
      if (p.action === "correct" && state.evidence.has(targetId)) {
        const origin = state.evidence.get(targetId);
        state.evidence.set(event.event_id, {
          ...origin,
          event_id: event.event_id,
          origin_id: targetId,
          occurred_at: origin.occurred_at,
          status: "recorded",
          superseded_by: undefined,
          ...p.correction,
          amended_at: event.occurred_at,
          amendment_reason: p.reason,
        });
      }
      if (p.appeal_id) {
        const appeal = state.appeals.get(p.appeal_id);
        if (appeal) appeal.amendments.push(event.event_id);
      }
      break;
    }
    case "APPEAL_FILED":
      state.appeals.set(event.aggregate_id, {
        id: event.aggregate_id,
        status: "filed",
        opinions: [],
        amendments: [],
        filed_at: event.occurred_at,
        ...p,
      });
      state.frozenBouts.set(p.bout_id, event.aggregate_id);
      for (const id of p.affected_bout_ids ?? []) state.frozenBouts.set(id, event.aggregate_id);
      break;
    case "APPEAL_EVIDENCE_ADDED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) appeal.attached_evidence = [...(appeal.attached_evidence ?? []), p.evidence_event_id];
      break;
    }
    case "REVIEW_OPENED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) appeal.status = "in_review";
      break;
    }
    case "REVIEW_OPINION_ISSUED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) {
        appeal.opinions.push({
          official_id: p.official_id,
          recommendation: p.recommendation,
          note: p.note,
          at: event.occurred_at,
        });
      }
      break;
    }
    case "APPEAL_DECIDED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) {
        appeal.status = p.decision === "withdrawn" ? "withdrawn" : "decided";
        appeal.decision = p.decision;
        appeal.decided_at = event.occurred_at;
        appeal.note = p.note;
      }
      for (const [boutId, appealId] of state.frozenBouts) {
        if (appealId === event.aggregate_id) state.frozenBouts.delete(boutId);
      }
      break;
    }
    case "APPEAL_WITHDRAWN": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) appeal.status = "withdrawn";
      for (const [boutId, appealId] of state.frozenBouts) {
        if (appealId === event.aggregate_id) state.frozenBouts.delete(boutId);
      }
      break;
    }
    case "ADVANCEMENT_FROZEN":
      for (const id of p.affected_bout_ids ?? []) {
        if (!state.frozenBouts.has(id)) state.frozenBouts.set(id, event.aggregate_id);
      }
      break;
    case "ADVANCEMENT_RELEASED":
      for (const [boutId, owner] of state.frozenBouts) {
        if ((p.affected_bout_ids ?? []).includes(boutId) && owner === p.appeal_id) {
          state.frozenBouts.delete(boutId);
        }
      }
      break;
    case "ADVANCEMENT_CONFIRMED": {
      const prog = progressionState(state, p.draw_id);
      prog.confirmed.set(p.bout_id, p.winners);
      for (const winner of p.winners) {
        const list = prog.qualified.get(p.target_bout_id) ?? [];
        if (!list.includes(winner)) list.push(winner);
        prog.qualified.set(p.target_bout_id, list);
      }
      break;
    }
    case "TIE_RESOLVED": {
      const result = boutResult(state, p.bout_id);
      result.tie_resolution = { event_id: event.event_id, ...p, at: event.occurred_at };
      break;
    }
    case "RESULT_CANDIDATE_COMPUTED": {
      const result = boutResult(state, p.bout_id);
      result.candidates.push({ event_id: event.event_id, at: event.occurred_at, ...p });
      break;
    }
    case "RESULT_CERTIFIED": {
      const result = boutResult(state, p.bout_id);
      result.certified = { event_id: event.event_id, at: event.occurred_at, ...p };
      break;
    }
    case "RESULT_PUBLISHED": {
      const result = boutResult(state, p.bout_id);
      result.published = { event_id: event.event_id, at: event.occurred_at, ...p };
      break;
    }
    case "OLYMPIC_QUOTA_ALLOCATED": {
      state.quotas.set(p.bout_id, { event_id: event.event_id, ...p });
      const bout = state.bouts.get(p.bout_id);
      if (bout) bout.olympic_locked = true;
      break;
    }
    case "RECORD_RATIFIED":
      state.records.set(event.aggregate_id, { id: event.aggregate_id, ...p, at: event.occurred_at });
      break;
    default:
      // 未知事件不影响投影（前向兼容）
      break;
  }
}

function progressionState(state, drawId) {
  if (!state.progression.has(drawId)) {
    state.progression.set(drawId, { confirmed: new Map(), qualified: new Map() });
  }
  return state.progression.get(drawId);
}

/** 该场当前生效的证据，按 kind 分组；被撤销/取代/隔离的不计入。 */
export function acceptedEvidence(state, boutId) {
  const groups = {};
  for (const ev of state.evidence.values()) {
    if (ev.bout_id !== boutId) continue;
    if (ev.status !== "recorded") continue;
    (groups[ev.kind] ??= []).push(ev);
  }
  return groups;
}

/** 该场当前有效处罚。 */
export function activePenalties(state, boutId) {
  return [...state.sanctions.values()].filter((s) => s.bout_id === boutId && s.status === "active");
}

/** 设备在指定事实时间是否处于有效校准内。 */
export function calibrationValidAt(device, at) {
  const valid = device.calibrations
    .filter((c) => c.result === "pass" && c.at <= at)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  const latest = valid[0];
  return Boolean(latest && (!latest.valid_until || latest.valid_until > at));
}

/** 裁判与某场比赛是否存在利益冲突。 */
export function judgeConflict(state, officialId, bout) {
  const official = state.officials.get(officialId);
  if (!official) return { conflict: true, reason: "裁判未登记" };
  const teamOf = (athleteId) => state.athletes.get(athleteId)?.team_id;
  for (const c of official.conflicts) {
    if (bout.entries?.includes(c.ref_id)) return { conflict: true, reason: c.reason };
    if (bout.entries?.some((id) => teamOf(id) === c.ref_id)) return { conflict: true, reason: c.reason };
  }
  return { conflict: false };
}

/** 从某场出发沿晋级括号闭包：受申诉冻结影响的所有场次。 */
export function downstreamBouts(state, boutId) {
  const affected = new Set([boutId]);
  let frontier = [boutId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const draw of state.draws.values()) {
        const node = draw.bracket.get(id);
        if (node?.feeds_into && !affected.has(node.feeds_into)) {
          affected.add(node.feeds_into);
          next.push(node.feeds_into);
        }
      }
    }
    frontier = next;
  }
  return [...affected];
}
