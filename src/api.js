const { readDb, writeDb } = require("./store");
const rules = require("./rules");

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/results",
  "POST /batches/:id/suspend",
  "POST /batches/:id/resume",
  "POST /batches/:id/complete",
  "GET /batches/:id/events"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const rubbing = rules.createRubbing(db, await parseBody(req));
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbing = rules.findRubbing(db, rubbingDamagesMatch[1]);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbing.id) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const damage = rules.createDamage(db, rubbingDamagesMatch[1], await parseBody(req));
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = rules.patchDamage(db, damagePatchMatch[1], await parseBody(req));
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => rules.enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const batch = rules.createBatch(db, await parseBody(req));
    await writeDb(db);
    return send(res, 201, { data: rules.enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = rules.findBatch(db, batchMatch[1]);
    return send(res, 200, { data: rules.enrichBatch(db, batch) });
  }

  const resultsMatch = pathname.match(/^\/batches\/([^/]+)\/results$/);
  if (resultsMatch && req.method === "POST") {
    const { record, deduplicated, batch } = rules.submitResult(db, resultsMatch[1], await parseBody(req));
    await writeDb(db);
    return send(res, deduplicated ? 200 : 201, { data: { record, deduplicated, batch } });
  }

  const suspendMatch = pathname.match(/^\/batches\/([^/]+)\/suspend$/);
  if (suspendMatch && req.method === "POST") {
    const { event, batch } = rules.suspendBatch(db, suspendMatch[1], await parseBody(req));
    await writeDb(db);
    return send(res, 200, { data: { event, batch } });
  }

  const resumeMatch = pathname.match(/^\/batches\/([^/]+)\/resume$/);
  if (resumeMatch && req.method === "POST") {
    const { event, batch } = rules.resumeBatch(db, resumeMatch[1], await parseBody(req));
    await writeDb(db);
    return send(res, 200, { data: { event, batch } });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const { event, batch } = rules.completeBatch(db, completeMatch[1], await parseBody(req));
    await writeDb(db);
    return send(res, 200, { data: { event, batch } });
  }

  const eventsMatch = pathname.match(/^\/batches\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    return send(res, 200, { data: rules.listBatchEvents(db, eventsMatch[1]) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

async function handle(req, res) {
  try {
    await route(req, res);
  } catch (error) {
    send(res, error.status || 500, { error: error.message || "服务器错误" });
  }
}

module.exports = { handle, routes };
