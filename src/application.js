// 应用门面：装配事件存储、签署登记与领域后端，对外提供命令与只读视图。
import { EventStore } from "./events/store.js";
import { SigningRegistry } from "./domain/signing.js";
import { RulingBackend } from "./domain/backend.js";
import { replayBout, verifyEventHash } from "./domain/replay.js";
import { delegationView } from "./domain/delegation-view.js";
import { publicResults, publicVerify } from "./domain/public-view.js";

/**
 * @param {object} [opts]
 * @param {string} [opts.file] JSONL 持久化文件
 * @param {() => string} [opts.clock]
 * @param {Array<{id:string, role:string, secret:string, name?:string}>} [opts.officials] 预置签署官员
 */
export function createApplication({ file, clock, officials = [] } = {}) {
  const store = new EventStore({ file, clock });
  const signing = new SigningRegistry();
  for (const o of officials) signing.enroll(o.id, o.role, o.secret, o.name);
  const backend = new RulingBackend({ store, signing, clock });

  // 允许运行时登记签署官员（典型：从密钥管理系统拉取）。
  const enrollOfficial = (id, role, secret, name) => signing.enroll(id, role, secret, name);

  return {
    store,
    signing,
    backend,
    clock: backend.clock.bind(backend),
    enrollOfficial,

    // ---- 命令（统一入口，便于审计日志/API 暴露）----
    command(name, cmd = {}) {
      if (typeof backend[name] !== "function") {
        const err = new Error(`未知命令：${name}`);
        err.code = "UNKNOWN_COMMAND";
        throw err;
      }
      return backend[name](cmd);
    },

    // ---- 三类视图 + 官员重放 ----
    view: {
      replayBout: (boutId) => replayBout(backend, boutId),
      verifyEvent: (eventId) => verifyEventHash(backend, eventId),
      delegation: (delegation) => delegationView(backend, delegation),
      publicResults: (filter) => publicResults(backend, filter),
      publicVerify: (eventId, expectedHash) => publicVerify(backend, eventId, expectedHash),
    },

    // ---- 供运维/查询 ----
    verifyChain: () => store.verifyChain(),
    event: (id) => store.byId(id),
    events: () => store.all(),
  };
}
