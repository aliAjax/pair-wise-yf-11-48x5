const { makeId } = require("./store");

// 批次状态：open（进行中）→ suspended（暂挂）→ open（恢复）→ completed（已结项）
// 缺损状态：pending（待修）→ in_repair（处理中）→ repaired（已修复）

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw httpError(404, "修补批次不存在");
  return batch;
}

function getBatchEvents(db, batchId) {
  return db.batchEvents
    .filter((event) => event.batchId === batchId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function recordEvent(db, batch, action, { operator = "", reason = "", note = "" } = {}) {
  const event = {
    id: makeId("event"),
    batchId: batch.id,
    action,
    operator,
    reason,
    note,
    createdAt: new Date().toISOString()
  };
  db.batchEvents.push(event);
  return event;
}

// 缺损被某个未结项批次（含暂挂中）占用时，其他批次不能领走
function activeHolderOf(db, damage) {
  if (!damage.batchId) return null;
  const holder = db.batches.find((batch) => batch.id === damage.batchId);
  return holder && holder.status !== "completed" ? holder : null;
}

function assertDamagesClaimable(db, damageIds) {
  const invalid = damageIds.filter((id) => !db.damages.some((damage) => damage.id === id));
  if (invalid.length) throw httpError(400, `缺损项不存在：${invalid.join(", ")}`);
  const repaired = [];
  const occupied = [];
  damageIds.forEach((id) => {
    const damage = db.damages.find((item) => item.id === id);
    if (damage.status === "repaired") {
      repaired.push(id);
      return;
    }
    const holder = activeHolderOf(db, damage);
    if (holder) {
      occupied.push(`${id}（批次${holder.id}${holder.status === "suspended" ? "暂挂中" : "处理中"}）`);
    }
  });
  if (repaired.length) throw httpError(409, `缺损项已修复：${repaired.join(", ")}`);
  if (occupied.length) throw httpError(409, `缺损项已被其他批次占用，不能领走：${occupied.join(", ")}`);
}

function assertDamageEditable(db, damage) {
  const holder = activeHolderOf(db, damage);
  if (holder && holder.status === "suspended") {
    throw httpError(409, `缺损所属批次${holder.id}暂挂中，恢复前不能修改`);
  }
}

function createBatch(db, { name, damageIds, note = "", operator = "" }) {
  if (!Array.isArray(damageIds) || damageIds.length === 0) {
    throw httpError(400, "damageIds必须是非空数组");
  }
  const ids = [...new Set(damageIds)];
  assertDamagesClaimable(db, ids);
  const batch = {
    id: makeId("batch"),
    name,
    status: "open",
    damageIds: ids,
    note,
    operator,
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  db.batches.push(batch);
  db.damages.forEach((damage) => {
    if (ids.includes(damage.id)) {
      damage.batchId = batch.id;
      damage.status = "in_repair";
    }
  });
  return batch;
}

// 暂挂：必须记录原因和操作人；正在处理的缺损回到待修（仍锁定在本批次），
// 已提交成功的结果继续保留
function suspendBatch(db, batchId, { reason, operator } = {}) {
  const batch = findBatch(db, batchId);
  if (!reason) throw httpError(400, "暂挂必须记录原因");
  if (!operator) throw httpError(400, "暂挂必须记录操作人");
  if (batch.status === "suspended") throw httpError(409, "批次已处于暂挂状态");
  if (batch.status === "completed") throw httpError(409, "批次已结项，不能暂挂");
  batch.status = "suspended";
  db.damages.forEach((damage) => {
    if (damage.batchId === batch.id && damage.status === "in_repair") {
      damage.status = "pending";
    }
  });
  const event = recordEvent(db, batch, "suspend", { reason, operator });
  return { batch, event, changed: true };
}

// 恢复：记录操作人；未完成的缺损回到处理中，接着做
function resumeBatch(db, batchId, { operator } = {}) {
  const batch = findBatch(db, batchId);
  if (!operator) throw httpError(400, "恢复必须记录操作人");
  if (batch.status === "completed") throw httpError(409, "批次已结项，不能恢复");
  if (batch.status !== "suspended") throw httpError(409, "批次未处于暂挂状态");
  batch.status = "open";
  db.damages.forEach((damage) => {
    if (damage.batchId === batch.id && damage.status === "pending") {
      damage.status = "in_repair";
    }
  });
  const event = recordEvent(db, batch, "resume", { operator });
  return { batch, event, changed: true };
}

// 已入账（repaired）的缺损若再次提交结果：内容一致则不重复记账，不一致则冲突
function findResultConflicts(damages, results) {
  const conflicts = [];
  for (const result of results) {
    const damage = damages.find((item) => item.id === result.damageId);
    if (!damage || damage.status !== "repaired") continue;
    const photoConflict = result.afterPhotoUrl && result.afterPhotoUrl !== damage.afterPhotoUrl;
    const noteConflict = result.repairNote && result.repairNote !== damage.repairNote;
    if (photoConflict || noteConflict) conflicts.push(damage.id);
  }
  return conflicts;
}

// 结项：暂挂中不能结项；逐项核对修复后图片和修复说明；
// 重复提交同一结果幂等返回，不重复记账、不重复记事件
function completeBatch(db, batchId, payload = {}) {
  const batch = findBatch(db, batchId);
  if (batch.status === "suspended") {
    throw httpError(409, "批次暂挂中，不能结项，请先恢复批次");
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  const outsiders = results.filter((item) => !item || !batch.damageIds.includes(item.damageId));
  if (outsiders.length) {
    throw httpError(400, `结果包含不属于本批次的缺损：${outsiders.map((item) => item && item.damageId).join(", ")}`);
  }
  const damages = db.damages.filter((damage) => batch.damageIds.includes(damage.id));
  const conflicts = findResultConflicts(damages, results);
  if (conflicts.length) {
    throw httpError(409, `提交结果与已入账结果不一致：${conflicts.join(", ")}`);
  }
  if (batch.status === "completed") {
    return { batch, event: null, changed: false };
  }

  const missing = [];
  const plan = [];
  for (const damage of damages) {
    if (damage.status === "repaired") continue;
    const result = results.find((item) => item.damageId === damage.id) || {};
    const afterPhotoUrl = result.afterPhotoUrl || payload.defaultAfterPhotoUrl || damage.afterPhotoUrl;
    const repairNote = result.repairNote || payload.defaultRepairNote || damage.repairNote;
    const lacks = [];
    if (!afterPhotoUrl) lacks.push("缺修复后图片");
    if (!repairNote) lacks.push("缺修复说明");
    if (lacks.length) {
      missing.push(`${damage.id}（${lacks.join("、")}）`);
    } else {
      plan.push({ damage, afterPhotoUrl, repairNote });
    }
  }
  if (missing.length) {
    throw httpError(400, `逐项核对未通过：${missing.join("；")}`);
  }

  const now = new Date().toISOString();
  plan.forEach(({ damage, afterPhotoUrl, repairNote }) => {
    damage.status = "repaired";
    damage.afterPhotoUrl = afterPhotoUrl;
    damage.repairNote = repairNote;
    damage.repairedAt = now;
  });
  batch.status = "completed";
  batch.completedAt = now;
  if (payload.note !== undefined) batch.note = payload.note;
  const event = recordEvent(db, batch, "complete", {
    operator: payload.operator || "",
    note: payload.note || ""
  });
  return { batch, event, changed: true };
}

function enrichBatch(db, batch, { withEvents = false } = {}) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const enriched = {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    inRepair: damages.filter((item) => item.status === "in_repair").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
  if (withEvents) enriched.events = getBatchEvents(db, batch.id);
  return enriched;
}

module.exports = {
  findBatch,
  getBatchEvents,
  createBatch,
  suspendBatch,
  resumeBatch,
  completeBatch,
  assertDamageEditable,
  enrichBatch
};
