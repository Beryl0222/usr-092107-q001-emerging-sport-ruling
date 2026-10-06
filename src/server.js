// 零依赖 HTTP 适配层：POST 命令、GET 三类只读视图。
// 身份认证假定由网关完成并在头部注入调用方；签署密钥从不出现在请求体里，
// 请求只携带签署人标识，签名由服务端用登记密钥对事件哈希即时生成并验签。
import { createServer } from "node:http";
import { DomainError } from "./domain/errors.js";
import { DuplicateIngestError, ChainIntegrityError } from "./events/store.js";

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });

export function createHttpServer(app) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, chain: app.verifyChain() });
      }

      if (req.method === "GET" && path === "/public/results") {
        return json(res, 200, app.view.publicResults({ sport: url.searchParams.get("sport") ?? undefined }));
      }

      let m;
      if (req.method === "GET" && (m = path.match(/^\/public\/verify\/([^/]+)$/))) {
        const result = app.view.publicVerify(decodeURIComponent(m[1]), url.searchParams.get("hash") ?? undefined);
        return json(res, result.verifiable ? 200 : 409, result);
      }

      if (req.method === "GET" && (m = path.match(/^\/delegation\/([^/]+)\/appeals$/))) {
        return json(res, 200, app.view.delegation(decodeURIComponent(m[1])));
      }

      if (req.method === "GET" && (m = path.match(/^\/official\/bouts\/([^/]+)\/replay$/))) {
        const report = app.view.replayBout(decodeURIComponent(m[1]));
        return json(res, report.ok ? 200 : 422, report);
      }

      if (req.method === "GET" && path === "/official/chain") {
        return json(res, 200, app.verifyChain());
      }

      if (req.method === "GET" && (m = path.match(/^\/events\/([^/]+)$/))) {
        const event = app.event(decodeURIComponent(m[1]));
        if (!event) return json(res, 404, { error: "EVENT_NOT_FOUND" });
        return json(res, 200, event);
      }

      if (req.method === "POST" && (m = path.match(/^\/commands\/([A-Za-z_]+)$/))) {
        const name = m[1];
        const body = await readBody(req);
        const actorHeader = req.headers["x-actor-id"];
        const roleHeader = req.headers["x-actor-role"];
        if (actorHeader && !body.actor) body.actor = { id: String(actorHeader), role: String(roleHeader ?? "service") };
        const output = app.command(name, body);
        return json(res, 201, { ok: true, command: name, output });
      }

      return json(res, 404, { error: "NOT_FOUND", path });
    } catch (err) {
      if (err instanceof DomainError) {
        const status = {
          NOT_FOUND: 404, RESULT_NOT_FOUND: 404, BOUT_NOT_FOUND: 404, RULE_NOT_FOUND: 404,
          DEVICE_NOT_FOUND: 404, APPEAL_NOT_FOUND: 404, CHAIN_NOT_FOUND: 404, EVENT_NOT_FOUND: 404,
          ORIGINAL_NOT_FOUND: 404, JUDGE_NOT_ASSIGNED: 409,
        }[err.code] ?? (err.code === "SIGNATURE_REQUIRED" || err.code?.startsWith("SIGNATURE") ? 403 : 422);
        return json(res, status, { ok: false, code: err.code, message: err.message, ...(err.conflicts ? { conflicts: err.conflicts } : {}) });
      }
      if (err instanceof DuplicateIngestError) {
        return json(res, 409, { ok: false, code: "DUPLICATE_CONFLICT", message: err.message, first_event_id: err.conflicting_event?.event_id });
      }
      if (err instanceof ChainIntegrityError) {
        return json(res, 500, { ok: false, code: "CHAIN_INTEGRITY", message: err.message });
      }
      if (err.code === "UNKNOWN_COMMAND") return json(res, 404, { ok: false, code: "UNKNOWN_COMMAND", message: err.message });
      return json(res, 400, { ok: false, code: "BAD_REQUEST", message: err.message });
    }
  });
}
