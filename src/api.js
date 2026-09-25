const store = require("./store");
const rules = require("./batchRules");

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
  "POST /batches/:id/suspend",
  "POST /batches/:id/resume",
  "POST /batches/:id/complete",
  "GET /batches/:id/events",
  "GET /events?batchId=&action="
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

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await store.readDb();

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
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: store.makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await store.writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: store.makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await store.writeDb(db);
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
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    rules.assertDamageEditable(db, damage);
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await store.writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => rules.enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    const batch = rules.createBatch(db, body);
    await store.writeDb(db);
    return send(res, 201, { data: rules.enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = rules.findBatch(db, batchMatch[1]);
    return send(res, 200, { data: rules.enrichBatch(db, batch, { withEvents: true }) });
  }

  const suspendMatch = pathname.match(/^\/batches\/([^/]+)\/suspend$/);
  if (suspendMatch && req.method === "POST") {
    const body = await parseBody(req);
    const outcome = rules.suspendBatch(db, suspendMatch[1], body);
    await store.writeDb(db);
    return send(res, 200, { data: rules.enrichBatch(db, outcome.batch, { withEvents: true }), event: outcome.event });
  }

  const resumeMatch = pathname.match(/^\/batches\/([^/]+)\/resume$/);
  if (resumeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const outcome = rules.resumeBatch(db, resumeMatch[1], body);
    await store.writeDb(db);
    return send(res, 200, { data: rules.enrichBatch(db, outcome.batch, { withEvents: true }), event: outcome.event });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const outcome = rules.completeBatch(db, completeMatch[1], body);
    if (outcome.changed) await store.writeDb(db);
    return send(res, 200, { data: rules.enrichBatch(db, outcome.batch, { withEvents: true }), event: outcome.event });
  }

  const batchEventsMatch = pathname.match(/^\/batches\/([^/]+)\/events$/);
  if (batchEventsMatch && req.method === "GET") {
    const batch = rules.findBatch(db, batchEventsMatch[1]);
    return send(res, 200, { data: rules.getBatchEvents(db, batch.id) });
  }

  if (req.method === "GET" && pathname === "/events") {
    const batchId = url.searchParams.get("batchId");
    const action = url.searchParams.get("action");
    const data = db.batchEvents
      .filter((event) => (!batchId || event.batchId === batchId) && (!action || event.action === action))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return send(res, 200, { data });
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

module.exports = { handle };
