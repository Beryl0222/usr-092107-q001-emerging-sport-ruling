import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStore, DuplicateIngestError, ChainIntegrityError } from "../src/events/store.js";
import { hashEvent } from "../src/events/envelope.js";

const fixedClock = () => "2026-10-06T09:30:00Z";

const base = () => ({
  event_type: "RULE_ACTIVATED",
  aggregate_type: "competition_rule",
  aggregate_id: "r1",
  occurred_at: "2026-10-06T08:00:00Z",
  summary: "x",
});

const newStore = () => new EventStore({ clock: fixedClock });

test("全局序号、聚合版本与哈希链随追加增长", () => {
  const store = newStore();
  const e1 = store.append(base()).event;
  const e2 = store.append({ ...base(), summary: "y" }).event;
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e1.version, 1);
  assert.equal(e2.version, 2); // 同一聚合
  assert.match(e1.hash, /^[0-9a-f]{64}$/);
  assert.equal(e2.prev_hash, e1.hash);
  assert.deepEqual(store.verifyChain(), { ok: true, count: 2, head: e2.hash });
});

test("不同聚合各自维护版本号，全局序号仍连续", () => {
  const store = newStore();
  const a1 = store.append({ ...base(), aggregate_id: "A" }).event;
  const b1 = store.append({ ...base(), aggregate_id: "B" }).event;
  const a2 = store.append({ ...base(), aggregate_id: "A", summary: "2" }).event;
  assert.equal(a1.version, 1);
  assert.equal(b1.version, 1);
  assert.equal(a2.version, 2);
  assert.deepEqual([a1.seq, b1.seq, a2.seq], [1, 2, 3]);
});

test("同一幂等键的重复补传只生效一次并返回首条记录", () => {
  const store = newStore();
  const first = store.append({ ...base(), idempotency_key: "dev-msg-7", occurred_at: "2026-10-06T08:00:00Z" });
  assert.equal(first.duplicate, false);
  const again = store.append({ ...base(), idempotency_key: "dev-msg-7", occurred_at: "2026-10-06T08:00:00Z" });
  assert.equal(again.duplicate, true);
  assert.equal(again.event.event_id, first.event.event_id);
  assert.equal(store.all().length, 1);
});

test("同一幂等键但载荷不同视为冲突，拒绝补传", () => {
  const store = newStore();
  store.append({ ...base(), idempotency_key: "k", summary: "原始事实" });
  assert.throws(
    () => store.append({ ...base(), idempotency_key: "k", summary: "被篡改的事实" }),
    DuplicateIngestError,
  );
});

test("乱序补传不影响：按追加顺序形成链，发生时间独立保留", () => {
  const store = newStore();
  const late = store.append({ ...base(), aggregate_id: "s1", occurred_at: "2026-10-06T07:00:00Z", recorded_at: "2026-10-06T09:00:00Z", idempotency_key: "late", summary: "迟到的离线消息" }).event;
  const early = store.append({ ...base(), aggregate_id: "s2", occurred_at: "2026-10-06T08:30:00Z", idempotency_key: "early", summary: "后到的实时消息" }).event;
  assert.ok(Date.parse(late.recorded_at) > Date.parse(late.occurred_at));
  assert.equal(early.seq, late.seq + 1); // 接收顺序决定 seq，不按 occurred_at
  assert.equal(store.verifyChain().ok, true);
});

test("JSONL 持久化后重放得到同一条链", () => {
  const dir = mkdtempSync(join(tmpdir(), "ruling-test-"));
  try {
    const file = join(dir, "events.jsonl");
    const s1 = new EventStore({ file, clock: fixedClock });
    s1.append(base());
    s1.append({ ...base(), summary: "y" });
    const head = s1.verifyChain().head;

    const s2 = new EventStore({ file, clock: fixedClock });
    assert.equal(s2.all().length, 2);
    assert.equal(s2.verifyChain().head, head);
    assert.equal(s2.all()[1].prev_hash, s2.all()[0].hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("改写历史事件导致哈希校验失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "ruling-test-"));
  try {
    const file = join(dir, "events.jsonl");
    const s1 = new EventStore({ file, clock: fixedClock });
    s1.append(base());
    s1.append({ ...base(), summary: "y" });

    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[0]);
    tampered.summary = "事后篡改";
    writeFileSync(file, [JSON.stringify(tampered), lines[1], ""].join("\n"));

    assert.throws(() => new EventStore({ file, clock: fixedClock }), ChainIntegrityError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重排事件顺序导致 prev_hash 断链", () => {
  const dir = mkdtempSync(join(tmpdir(), "ruling-test-"));
  try {
    const file = join(dir, "events.jsonl");
    const s1 = new EventStore({ file, clock: fixedClock });
    s1.append({ ...base(), summary: "one" });
    s1.append({ ...base(), summary: "two" });

    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, [lines[1], lines[0], ""].join("\n"));
    assert.throws(() => new EventStore({ file, clock: fixedClock }), ChainIntegrityError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("事件一经冻结不可突变", () => {
  const store = newStore();
  const e = store.append(base()).event;
  assert.throws(() => {
    e.summary = "改";
  }, TypeError);
});

test("recorded_at 早于 occurred_at 非法（离线只能更晚接收）", () => {
  const store = newStore();
  assert.throws(
    () => store.append({ ...base(), occurred_at: "2026-10-06T09:00:00Z", recorded_at: "2026-10-06T08:00:00Z" }),
    /recorded_at/,
  );
});

test("哈希不包含签名，事后验签不改变事实哈希", () => {
  const store = newStore();
  const e = store.append(base()).event;
  const signed = { ...e, signature: { official_id: "o", role: "jury", alg: "HS256", value: "abc" } };
  assert.equal(hashEvent(signed), e.hash);
});
