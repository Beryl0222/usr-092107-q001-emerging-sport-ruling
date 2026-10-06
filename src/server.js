import { createServer } from "node:http";
import { EventStore } from "./store.js";
import { RulingService, DomainError } from "./services.js";
import { officialReplay, publicView, teamView, verifyEvent } from "./views.js";

/**
 * HTTP 适配层。
 * 写操作统一走命令总线 POST /api/cmd/:command（CQRS），
 * 读操作按角色提供：官员重放、代表队视图、公开可核验成绩、哈希核验。
 * 离线设备补传可带 Idempotency-Key 请求头去重。
 */

const COMMANDS = new Set(Object.getOwnPropertyNames(RulingService.prototype).filter(
  (name) => name !== "constructor" && !name.startsWith("_") && name !== "state",
));

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  BOUT_NOT_FOUND: 404,
  FORBIDDEN: 403,
  VERSION_CONFLICT: 409,
  VERSION_GAP: 409,
  ADVANCEMENT_FROZEN: 409,
  OLYMPIC_LOCKED: 409,
};
const statusFor = (code) =>
  STATUS_BY_CODE[code] ?? (code?.endsWith("_NOT_FOUND") ? 404 : 422);

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.code = "BAD_JSON";
    throw err;
  }
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

export function createApp(service) {
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "POST" && path.startsWith("/api/cmd/")) {
      const command = path.slice("/api/cmd/".length);
      if (!COMMANDS.has(command)) return send(res, 404, { error: "UNKNOWN_COMMAND", command });
      const body = await readJson(req);
      const idemKey = req.headers["idempotency-key"];
      if (idemKey) body.idempotency_key ??= idemKey;
      if (typeof service[command] !== "function") {
        return send(res, 404, { error: "UNKNOWN_COMMAND", command });
      }
      const result = service[command](body);
      return send(res, 200, { ok: true, command, result });
    }

    if (req.method === "GET" && /^\/api\/bouts\/[^/]+\/replay$/.test(path)) {
      const boutId = decodeURIComponent(path.split("/")[3]);
      const replay = officialReplay(service.store, boutId);
      return replay ? send(res, 200, replay) : send(res, 404, { error: "BOUT_NOT_FOUND" });
    }

    if (req.method === "GET" && path.startsWith("/api/teams/")) {
      const teamId = decodeURIComponent(path.slice("/api/teams/".length).split("/")[0]);
      return send(res, 200, teamView(service.store, teamId));
    }

    if (req.method === "GET" && path === "/api/public/results") {
      return send(res, 200, publicView(service.store));
    }

    if (req.method === "GET" && /^\/api\/events\/[^/]+\/verify$/.test(path)) {
      const eventId = decodeURIComponent(path.split("/")[3]);
      const verdict = verifyEvent(service.store, eventId);
      return verdict ? send(res, 200, verdict) : send(res, 404, { error: "EVENT_NOT_FOUND" });
    }

    if (req.method === "GET" && path === "/api/chain/verify") {
      return send(res, 200, service.store.verifyChain());
    }

    if (req.method === "GET" && path === "/api/events") {
      return send(res, 200, { events: service.store.all() });
    }

    if (req.method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, event_count: service.store.all().length });
    }

    send(res, 404, { error: "NOT_FOUND" });
  } catch (err) {
    if (err instanceof DomainError || err.code) {
      return send(res, statusFor(err.code), { error: err.code, message: err.message });
    }
    send(res, 500, { error: "INTERNAL", message: err.message });
  };
}
}

function start() {
  const file = process.env.EVENT_LOG_FILE; // 缺省为内存存储
  const store = new EventStore(file ? { file } : undefined);
  const service = new RulingService(store);
  const port = Number(process.env.PORT ?? 8080);
  createServer(createApp(service)).listen(port, () => {
    console.log(`新兴赛项裁判与成绩后端已启动：http://localhost:${port}（存储：${file ?? "内存"}）`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
