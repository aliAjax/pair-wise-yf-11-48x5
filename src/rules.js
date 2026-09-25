const { makeId } = require("./store");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) fail(400, `缺少字段：${missing.join(", ")}`);
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) fail(404, "拓片不存在");
  return rubbing;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) fail(404, "修补批次不存在");
  return batch;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

function createRubbing(db, body) {
  required(body, ["code", "source", "paperSize"]);
  const rubbing = {
    id: makeId("rubbing"),
    code: body.code,
    source: body.source,
    paperSize: body.paperSize,
    note: body.note || "",
    createdAt: new Date().toISOString()
  };
  db.rubbings.push(rubbing);
  return rubbing;
}

function createDamage(db, rubbingId, body) {
  const rubbing = findRubbing(db, rubbingId);
  required(body, ["position", "type", "beforePhotoUrl"]);
  const damage = {
    id: makeId("damage"),
    rubbingId: rubbing.id,
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
  return damage;
}

function patchDamage(db, damageId, body) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) fail(404, "缺损项不存在");
  Object.assign(damage, {
    position: body.position ?? damage.position,
    type: body.type ?? damage.type,
    beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
    afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
    status: body.status ?? damage.status,
    repairNote: body.repairNote ?? damage.repairNote
  });
  damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
  return damage;
}

function createBatch(db, body) {
  required(body, ["name", "damageIds"]);
  if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) fail(400, "damageIds必须是非空数组");
  const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
  if (invalid.length) fail(400, `缺损项不存在：${invalid.join(", ")}`);
  const locked = body.damageIds.filter((id) => {
    const damage = db.damages.find((item) => item.id === id);
    if (!damage.batchId) return false;
    const owner = db.batches.find((item) => item.id === damage.batchId);
    return owner && owner.status !== "completed";
  });
  if (locked.length) fail(400, `缺损项已被未结项的批次占用，不能领取：${locked.join(", ")}`);
  const batch = {
    id: makeId("batch"),
    name: body.name,
    status: "open",
    damageIds: body.damageIds,
    note: body.note || "",
    createdAt: new Date().toISOString(),
    completedAt: null,
    suspendedAt: null,
    suspendReason: "",
    suspendedBy: "",
    resumedAt: null
  };
  db.batches.push(batch);
  db.damages.forEach((damage) => {
    if (body.damageIds.includes(damage.id)) {
      damage.batchId = batch.id;
      damage.status = "in_repair";
    }
  });
  return batch;
}

// 记账：同一批次同一缺损只记一笔，重复提交返回原记录
function recordResult(db, batch, damage, { afterPhotoUrl, repairNote, operator, resultKey }) {
  const existing = db.repairRecords.find((item) => item.batchId === batch.id && item.damageId === damage.id);
  if (existing) return { record: existing, deduplicated: true };
  if (resultKey) {
    const byKey = db.repairRecords.find((item) => item.resultKey && item.resultKey === resultKey);
    if (byKey) return { record: byKey, deduplicated: true };
  }
  const record = {
    id: makeId("record"),
    batchId: batch.id,
    damageId: damage.id,
    resultKey: resultKey || "",
    afterPhotoUrl,
    repairNote,
    operator: operator || "",
    createdAt: new Date().toISOString()
  };
  db.repairRecords.push(record);
  damage.status = "repaired";
  damage.afterPhotoUrl = afterPhotoUrl;
  damage.repairNote = repairNote;
  damage.repairedAt = record.createdAt;
  return { record, deduplicated: false };
}

function submitResult(db, batchId, body) {
  const batch = findBatch(db, batchId);
  if (batch.status === "suspended") fail(400, "批次暂挂中，请先恢复再提交结果");
  if (batch.status === "completed") fail(400, "批次已结项，不能再提交结果");
  required(body, ["damageId", "afterPhotoUrl", "repairNote"]);
  const damage = db.damages.find((item) => item.id === body.damageId);
  if (!damage || !batch.damageIds.includes(damage.id)) fail(404, "缺损项不在该批次中");
  const { record, deduplicated } = recordResult(db, batch, damage, body);
  return { record, deduplicated, batch: enrichBatch(db, batch) };
}

function suspendBatch(db, batchId, body) {
  const batch = findBatch(db, batchId);
  required(body, ["reason", "operator"]);
  if (batch.status === "suspended") fail(400, "批次已处于暂挂状态");
  if (batch.status === "completed") fail(400, "批次已结项，不能暂挂");
  const now = new Date().toISOString();
  const releasedDamageIds = [];
  db.damages.forEach((damage) => {
    // 正在处理而未提交结果的缺损回到待修，batchId保留作为锁定，其他批次不能领走
    if (batch.damageIds.includes(damage.id) && damage.status === "in_repair") {
      damage.status = "pending";
      releasedDamageIds.push(damage.id);
    }
  });
  batch.status = "suspended";
  batch.suspendedAt = now;
  batch.suspendReason = body.reason;
  batch.suspendedBy = body.operator;
  const event = {
    id: makeId("event"),
    batchId: batch.id,
    type: "suspend",
    reason: body.reason,
    operator: body.operator,
    releasedDamageIds,
    createdAt: now
  };
  db.batchEvents.push(event);
  return { event, batch: enrichBatch(db, batch) };
}

function resumeBatch(db, batchId, body) {
  const batch = findBatch(db, batchId);
  required(body, ["operator"]);
  if (batch.status === "completed") fail(400, "批次已结项，不能恢复");
  if (batch.status !== "suspended") fail(400, "批次未处于暂挂状态");
  const now = new Date().toISOString();
  const resumedDamageIds = [];
  db.damages.forEach((damage) => {
    // 恢复后接着做未完成项：仍挂在该批次下的待修缺损重新进入修补中
    if (damage.batchId === batch.id && damage.status === "pending") {
      damage.status = "in_repair";
      resumedDamageIds.push(damage.id);
    }
  });
  batch.status = "open";
  batch.resumedAt = now;
  const event = {
    id: makeId("event"),
    batchId: batch.id,
    type: "resume",
    operator: body.operator,
    resumedDamageIds,
    createdAt: now
  };
  db.batchEvents.push(event);
  return { event, batch: enrichBatch(db, batch) };
}

function completeBatch(db, batchId, body) {
  const batch = findBatch(db, batchId);
  if (batch.status === "suspended") fail(400, "批次暂挂中，不能结项，请先恢复");
  if (batch.status === "completed") fail(400, "批次已结项");
  const results = Array.isArray(body.results) ? body.results : [];
  db.damages.forEach((damage) => {
    if (!batch.damageIds.includes(damage.id)) return;
    if (damage.status === "repaired") return;
    const result = results.find((item) => item.damageId === damage.id) || {};
    const afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
    const repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
    if (afterPhotoUrl && repairNote) {
      recordResult(db, batch, damage, {
        afterPhotoUrl,
        repairNote,
        operator: result.operator || body.operator,
        resultKey: result.resultKey
      });
    }
  });
  // 逐项核对图片和说明，缺一不可结项
  const incomplete = db.damages
    .filter((damage) => batch.damageIds.includes(damage.id))
    .filter((damage) => damage.status !== "repaired" || !damage.afterPhotoUrl || !damage.repairNote)
    .map((damage) => damage.id);
  if (incomplete.length) fail(400, `以下缺损项缺少修复图片或说明，不能结项：${incomplete.join(", ")}`);
  const now = new Date().toISOString();
  batch.status = "completed";
  batch.completedAt = now;
  batch.note = body.note ?? batch.note;
  const event = {
    id: makeId("event"),
    batchId: batch.id,
    type: "complete",
    operator: body.operator || "",
    createdAt: now
  };
  db.batchEvents.push(event);
  return { event, batch: enrichBatch(db, batch) };
}

function listBatchEvents(db, batchId) {
  findBatch(db, batchId);
  return db.batchEvents
    .filter((event) => event.batchId === batchId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

module.exports = {
  findRubbing,
  findBatch,
  enrichBatch,
  createRubbing,
  createDamage,
  patchDamage,
  createBatch,
  submitResult,
  suspendBatch,
  resumeBatch,
  completeBatch,
  listBatchEvents
};
