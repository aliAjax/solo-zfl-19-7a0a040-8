"use strict";

// 冲孔机台健康监测领域逻辑（零依赖）。
//
// 核心语义：
// - 机台按批次上报张力 tension / 孔径 holeDiameter / 转速 rpm
// - 异常连续达到窗口大小才生成“未确认”故障（避免抖动误报）
// - 批次 batchId 幂等；同一 (机台, 样本时间, seq) 天然去重，乱序样本按时间归位后重算
// - 掉线超过 timeoutMs 自动降级为 offline
// - 维修期间暂停告警；维修结束后只判断维修结束之后的新样本
// - 同一未确认故障可以补充样本/升级严重度，绝不重复新建；连续中断则自动关闭
const crypto = require("crypto");

const METRICS = ["tension", "holeDiameter", "rpm"];
const METRIC_LABELS = {
  tension: "张力",
  holeDiameter: "孔径",
  rpm: "转速"
};
// 同一时刻多个指标异常时，按固定顺序归并，保证结果确定
const METRIC_ORDER = { tension: 0, holeDiameter: 1, rpm: 2 };
const SEVERITY_RANK = { warning: 1, critical: 2 };

const DEFAULTS = {
  windowSize: 3,
  timeoutMs: 60_000,
  maxSkewMs: 5 * 60_000, // 样本时间相对服务器时间允许的前后偏移
  thresholds: {
    tension: {
      unit: "N",
      warning: { min: 40, max: 60 },
      critical: { min: 35, max: 65 }
    },
    holeDiameter: {
      unit: "mm",
      warning: { min: 4.9, max: 5.1 },
      critical: { min: 4.8, max: 5.2 }
    },
    rpm: {
      unit: "rpm",
      warning: { min: 900, max: 1100 },
      critical: { min: 800, max: 1200 }
    }
  }
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function stamp(now) {
  return { ts: now, at: new Date(now).toISOString() };
}

function initialHealthData() {
  return {
    machines: [],
    samples: [],
    faults: [],
    batches: []
  };
}

// 旧 db.json 没有健康监测的集合时补齐（不覆盖既有数据）
function ensureHealth(data) {
  for (const [key, value] of Object.entries(initialHealthData())) {
    if (!Array.isArray(data[key])) data[key] = value;
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}

// 时间入参接受毫秒时间戳（数字或纯数字字符串）或 ISO 8601 字符串
function parseTs(value, field) {
  if (value === undefined || value === null || value === "") {
    throw httpError(400, `缺少字段：${field}`);
  }
  let ms;
  if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    ms = Number(value.trim());
  } else if (typeof value === "string") {
    ms = Date.parse(value);
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) throw httpError(400, `${field} 必须是毫秒时间戳或 ISO 8601 时间`);
  return ms;
}

function validateThresholds(thresholds) {
  const out = structuredClone(DEFAULTS.thresholds);
  if (thresholds === undefined || thresholds === null) return out;
  if (typeof thresholds !== "object" || Array.isArray(thresholds)) {
    throw httpError(400, "thresholds 必须是对象");
  }
  for (const metric of METRICS) {
    const input = thresholds[metric];
    if (input === undefined) continue;
    if (typeof input !== "object" || Array.isArray(input)) {
      throw httpError(400, `thresholds.${metric} 必须是对象`);
    }
    for (const level of ["warning", "critical"]) {
      const range = input[level];
      if (range === undefined) continue;
      if (
        typeof range !== "object" ||
        !isFiniteNumber(range.min) ||
        !isFiniteNumber(range.max) ||
        range.min >= range.max
      ) {
        throw httpError(400, `thresholds.${metric}.${level} 需要 min < max 的数值区间`);
      }
    }
    const w = input.warning ? { ...out[metric].warning, ...input.warning } : out[metric].warning;
    const c = input.critical ? { ...out[metric].critical, ...input.critical } : out[metric].critical;
    // critical 区间必须包含 warning 区间，否则升级语义不成立
    if (!(c.min <= w.min && w.max <= c.max)) {
      throw httpError(400, `thresholds.${metric} 的 critical 区间必须包含 warning 区间`);
    }
    out[metric] = { unit: input.unit ?? out[metric].unit, warning: w, critical: c };
  }
  return out;
}

// 返回某指标在给定取值下的异常等级；正常返回 null
function classifyMetric(value, spec) {
  if (value < spec.critical.min || value > spec.critical.max) return "critical";
  if (value < spec.warning.min || value > spec.warning.max) return "warning";
  return null;
}

// 一个样本上最严重的异常：{ level, metric } 或 null
function classifySample(sample, thresholds) {
  let worst = null;
  for (const metric of METRICS) {
    const level = classifyMetric(sample[metric], thresholds[metric]);
    if (!level) continue;
    if (!worst || SEVERITY_RANK[level] > SEVERITY_RANK[worst.level] ||
      (SEVERITY_RANK[level] === SEVERITY_RANK[worst.level] && METRIC_ORDER[metric] < METRIC_ORDER[worst.metric])) {
      worst = { level, metric };
    }
  }
  return worst;
}

// ---------- 机台 ----------

function registerMachine(data, body, clock) {
  if (!body || typeof body !== "object") throw httpError(400, "请求体必须是JSON对象");
  const code = body.code;
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    throw httpError(400, "code 必须是1-64位字母、数字、下划线或短横线");
  }
  if (data.machines.some((m) => m.code === code)) {
    throw httpError(409, "机台编号已存在");
  }
  const name = body.name === undefined ? code : String(body.name);
  if (!name.trim()) throw httpError(400, "name 不能为空");
  const config = {};
  if (body.windowSize !== undefined) {
    if (!isInteger(body.windowSize) || body.windowSize < 1 || body.windowSize > 1000) {
      throw httpError(400, "windowSize 必须是 1-1000 的整数");
    }
    config.windowSize = body.windowSize;
  }
  if (body.timeoutMs !== undefined) {
    if (!isInteger(body.timeoutMs) || body.timeoutMs < 1000) {
      throw httpError(400, "timeoutMs 必须是不小于1000的整数毫秒");
    }
    config.timeoutMs = body.timeoutMs;
  }
  config.thresholds = validateThresholds(body.thresholds);

  const now = clock.now();
  const machine = {
    id: makeId("machine"),
    code,
    name: name.trim(),
    windowSize: config.windowSize ?? DEFAULTS.windowSize,
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    thresholds: config.thresholds,
    status: "offline", // 尚未上报，初始即掉线降级
    lastSampleAt: null,
    lastReportAt: null,
    maintenance: null, // { startedAt, startedTs, reason, batchId }
    maintenanceEndedAt: null, // 最近一次维修结束时间（毫秒），评估下界
    history: [],
    createdAt: now,
    at: new Date(now).toISOString()
  };
  data.machines.push(machine);
  return machine;
}

function getMachineOrFail(data, idOrCode) {
  const machine =
    data.machines.find((m) => m.id === idOrCode) ||
    data.machines.find((m) => m.code === idOrCode);
  if (!machine) throw httpError(404, "机台不存在");
  return machine;
}

// 故障确认/维修之后，连续窗口只评估这些时间点之后的样本。
// 下界取“确认时间”与“确认时已见的最新样本时间”的较大值，防止确认前的乱序迟到样本复活旧计数。
function evaluationCutoff(data, machine) {
  let cutoff = machine.maintenanceEndedAt ?? -Infinity;
  for (const fault of data.faults) {
    if (fault.machineId === machine.id && (fault.status === "confirmed" || fault.status === "closed") &&
      fault.reason !== "streak_broken" && fault.reason !== "maintenance_started") {
      cutoff = Math.max(cutoff, fault.acknowledgedAt ?? fault.createdAt, fault.lastAt ?? -Infinity);
    }
  }
  return cutoff;
}

function sampleJudged(data, machine, sample) {
  if (machine.maintenance && sample.ts >= machine.maintenance.startedTs) return false;
  return sample.ts > evaluationCutoff(data, machine);
}

function publicSample(data, machine, sample) {
  return { ...sample, judged: sampleJudged(data, machine, sample) };
}

function publicMachine(machine) {
  return machine;
}

// ---------- 核心：按时间归位后重算连续异常窗口 ----------

function evaluateMachine(data, machine, now) {
  // 维修期间暂停告警
  if (machine.maintenance) {
    return { evaluated: false, maintenance: true, fault: null, action: "deferred" };
  }

  const cutoff = evaluationCutoff(data, machine);
  const candidates = data.samples
    .filter((s) => s.machineId === machine.id && s.ts > cutoff)
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq || (a.id < b.id ? -1 : 1));

  // 归并连续异常段：相邻样本只要有异常即连续；正常样本断段
  const runs = [];
  let current = null;
  for (const sample of candidates) {
    const hit = classifySample(sample, machine.thresholds);
    if (hit) {
      if (!current) current = { samples: [], level: "warning", metric: hit.metric };
      current.samples.push(sample);
      if (SEVERITY_RANK[hit.level] > SEVERITY_RANK[current.level]) current.level = hit.level;
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);

  const tail = runs.length ? runs[runs.length - 1] : null;
  const openFault = data.faults.find((f) => f.machineId === machine.id && f.status === "open");
  // 最新时间点的样本为正常，说明连续异常已被打断
  const latestSample = candidates.length ? candidates[candidates.length - 1] : null;
  const streakAlive = latestSample ? classifySample(latestSample, machine.thresholds) !== null : false;

  // 最新连续段未达窗口，或最新样本已是正常值：已开故障自动关闭
  if (!tail || tail.samples.length < machine.windowSize || !streakAlive) {
    if (openFault) closeFaultInternal(openFault, "streak_broken", "连续异常被正常样本打断", now);
    return { evaluated: true, fault: null, action: openFault ? "fault_auto_closed" : "none" };
  }

  const faultMetric = tail.metric;
  const faultLevel = tail.level;
  const startedAt = tail.samples[0].ts;
  const lastAt = tail.samples[tail.samples.length - 1].ts;

  if (openFault) {
    const added = tail.samples.filter((s) => !openFault.sampleIds.includes(s.id));
    if (!added.length) {
      return { evaluated: true, fault: openFault, action: "unchanged" };
    }
    openFault.sampleIds = tail.samples.map((s) => s.id);
    openFault.metric = faultMetric;
    openFault.startedAt = startedAt;
    openFault.lastAt = lastAt;
    const previousLevel = openFault.level;
    if (SEVERITY_RANK[faultLevel] > SEVERITY_RANK[openFault.level]) openFault.level = faultLevel;
    openFault.history.push({
      type: "supplement",
      level: faultLevel,
      upgraded: openFault.level !== previousLevel,
      sampleIds: added.map((s) => s.id),
      sampleCount: tail.samples.length,
      ...stamp(now)
    });
    return { evaluated: true, fault: openFault, action: openFault.level !== previousLevel ? "upgraded" : "supplemented" };
  }

  const fault = {
    id: makeId("fault"),
    machineId: machine.id,
    machineName: machine.name,
    metric: faultMetric,
    level: faultLevel,
    status: "open",
    sampleIds: tail.samples.map((s) => s.id),
    startedAt,
    lastAt,
    batchId: tail.samples[tail.samples.length - 1].batchId,
    reason: null,
    createdAt: now,
    acknowledgedAt: null,
    closedAt: null,
    history: [
      {
        type: "created",
        level: faultLevel,
        sampleCount: tail.samples.length,
        ...stamp(now)
      }
    ]
  };
  data.faults.push(fault);
  return { evaluated: true, fault, action: "created" };
}

function closeFaultInternal(fault, reason, note, now) {
  fault.status = "closed";
  fault.reason = reason;
  fault.closeNote = note;
  fault.closedAt = now;
  fault.history.push({ type: "closed", reason, note, ...stamp(now) });
}

// ---------- 批次上报 ----------

function ingestSamples(data, body, clock) {
  if (!body || typeof body !== "object") throw httpError(400, "请求体必须是JSON对象");
  const machine = getMachineOrFail(data, body.machineId);
  const batchId = body.batchId;
  if (typeof batchId !== "string" || !/^[A-Za-z0-9_:.-]{1,64}$/.test(batchId)) {
    throw httpError(400, "batchId 必须是1-64位字母、数字或 _:.- 字符");
  }
  const existing = data.batches.find((b) => b.machineId === machine.id && b.batchId === batchId);
  if (existing) {
    // 重复上报：原样返回首次结果，绝不重复落样本/故障
    return {
      duplicate: true,
      action: existing.result.action,
      faultId: existing.result.faultId,
      accepted: existing.count,
      rejected: 0,
      samples: []
    };
  }
  const samples = body.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw httpError(400, "samples 必须是非空数组");
  }
  if (data.batches.length + samples.length > 1_000_000) {
    throw httpError(400, "样本数量超出上限");
  }

  const now = clock.now();
  const accepted = [];
  let maxTs = -Infinity;
  samples.forEach((item, index) => {
    if (!item || typeof item !== "object") throw httpError(400, `samples[${index}] 必须是对象`);
    const ts = parseTs(item.ts ?? item.time, "samples[].ts");
    if (Math.abs(ts - now) > DEFAULTS.maxSkewMs) {
      throw httpError(400, `samples[${index}].ts 超出允许的时间偏差范围（±5分钟）`);
    }
    const seq = item.seq ?? index;
    if (!isInteger(seq) || seq < 0) throw httpError(400, `samples[${index}].seq 必须是非负整数`);
    for (const metric of METRICS) {
      if (!isFiniteNumber(item[metric])) {
        throw httpError(400, `samples[${index}].${metric} 必须是有限数值`);
      }
    }
    // 跨批次的天然重复（乱序重传相同时间点与序号）幂等跳过
    const naturalDuplicate = data.samples.some(
      (s) => s.machineId === machine.id && s.ts === ts && s.seq === seq
    ) || accepted.some((s) => s.ts === ts && s.seq === seq);
    if (naturalDuplicate) return;

    const sample = {
      id: makeId("sample"),
      machineId: machine.id,
      batchId,
      ts,
      at: new Date(ts).toISOString(),
      seq,
      tension: item.tension,
      holeDiameter: item.holeDiameter,
      rpm: item.rpm
    };
    data.samples.push(sample);
    accepted.push(sample);
    if (ts > maxTs) maxTs = ts;
  });

  if (!accepted.length) {
    throw httpError(400, "批次内样本全部为重复样本");
  }

  machine.lastReportAt = now;
  if (maxTs > (machine.lastSampleAt ?? -Infinity)) machine.lastSampleAt = maxTs;
  // 收到上报即恢复在线（掉线降级只由超时扫描驱动）
  if (machine.status === "offline") {
    machine.status = "online";
    machine.history.push({ type: "back_online", ...stamp(now) });
  }

  const result = evaluateMachine(data, machine, now);

  data.batches.push({
    machineId: machine.id,
    batchId,
    receivedAt: now,
    count: accepted.length,
    result: { action: result.action, faultId: result.fault ? result.fault.id : null }
  });

  return {
    duplicate: false,
    action: result.action,
    faultId: result.fault ? result.fault.id : null,
    accepted: accepted.length,
    rejected: samples.length - accepted.length,
    samples: accepted.map((s) => publicSample(data, machine, s))
  };
}

// ---------- 掉线降级 ----------

function effectiveStatus(machine, now) {
  if (machine.maintenance) return "maintenance";
  if (machine.lastReportAt === null) return "offline";
  return now - machine.lastReportAt >= machine.timeoutMs ? "offline" : "online";
}

// 超时扫描：掉线机台状态与可能的状态变化一起落库
function sweepOffline(data, now) {
  const changed = [];
  for (const machine of data.machines) {
    const next = effectiveStatus(machine, now);
    if (machine.status !== next) {
      machine.status = next;
      machine.history.push({
        type: next === "offline" ? "offline_timeout" : "back_online",
        ...stamp(now)
      });
      changed.push({ id: machine.id, code: machine.code, status: next });
    }
  }
  return changed;
}

// ---------- 维修 ----------

function startMaintenance(data, body, clock) {
  if (!body || typeof body !== "object") throw httpError(400, "请求体必须是JSON对象");
  const machine = getMachineOrFail(data, body.machineId);
  if (machine.maintenance) throw httpError(409, "机台已在维修中");
  const now = clock.now();
  machine.maintenance = {
    startedAt: now,
    startedTs: parseTs(body.startedTs ?? now, "startedTs"),
    reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : "",
    batchId: null
  };
  machine.status = "maintenance";
  machine.history.push({ type: "maintenance_started", ...stamp(now) });

  // 维修开始即暂停告警：未确认故障自动关闭，维修后从干净状态开始
  const closed = [];
  for (const fault of data.faults) {
    if (fault.machineId === machine.id && fault.status === "open") {
      closeFaultInternal(fault, "maintenance_started", "维修开始，未确认故障自动关闭", now);
      closed.push(fault.id);
    }
  }
  return { machineId: machine.id, status: "maintenance", closedFaultIds: closed };
}

function endMaintenance(data, body, clock) {
  if (!body || typeof body !== "object") throw httpError(400, "请求体必须是JSON对象");
  const machine = getMachineOrFail(data, body.machineId);
  if (!machine.maintenance) throw httpError(409, "机台不在维修中");
  const now = clock.now();
  const endedTs = parseTs(body.endedTs ?? now, "endedTs");
  if (endedTs < machine.maintenance.startedTs) {
    throw httpError(400, "endedTs 不能早于维修开始时间");
  }
  machine.maintenance = null;
  machine.maintenanceEndedAt = endedTs;
  machine.status = effectiveStatus(machine, now);
  machine.history.push({ type: "maintenance_ended", endedTs, ...stamp(now) });
  // 恢复后只判断维修结束之后的新样本
  return { machineId: machine.id, status: machine.status, evaluateAfterTs: endedTs };
}

// ---------- 故障确认 / 关闭 / 查询 ----------

function confirmFault(data, faultId, body, clock) {
  const fault = data.faults.find((f) => f.id === faultId);
  if (!fault) throw httpError(404, "故障不存在");
  if (fault.status !== "open") throw httpError(409, `故障当前状态为 ${fault.status}，不能确认`);
  const now = clock.now();
  fault.status = "confirmed";
  fault.acknowledgedAt = now;
  if (body && typeof body.note === "string") fault.confirmNote = body.note.slice(0, 200);
  fault.history.push({ type: "confirmed", ...stamp(now) });
  // 确认后窗口重新计数：后续样本组成新的连续段
  return fault;
}

function closeFault(data, faultId, body, clock) {
  const fault = data.faults.find((f) => f.id === faultId);
  if (!fault) throw httpError(404, "故障不存在");
  if (fault.status === "closed") throw httpError(409, "故障已关闭");
  const now = clock.now();
  closeFaultInternal(fault, "manual", body && typeof body.note === "string" ? body.note.slice(0, 200) : "人工关闭", now);
  if (fault.status === "closed" && fault.acknowledgedAt === null) fault.acknowledgedAt = now;
  return fault;
}

function faultWithMachine(data, fault) {
  const machine = data.machines.find((m) => m.id === fault.machineId);
  return { ...fault, machineCode: machine ? machine.code : null };
}

function queryFaults(data, params = {}) {
  let list = data.faults.slice();
  if (params.machineId) {
    const machine = data.machines.find((m) => m.id === params.machineId || m.code === params.machineId);
    if (!machine) throw httpError(404, "机台不存在");
    list = list.filter((f) => f.machineId === machine.id);
  }
  if (params.status) {
    if (!["open", "confirmed", "closed"].includes(params.status)) {
      throw httpError(400, "status 只支持 open/confirmed/closed");
    }
    list = list.filter((f) => f.status === params.status);
  }
  if (params.level) {
    if (!["warning", "critical"].includes(params.level)) {
      throw httpError(400, "level 只支持 warning/critical");
    }
    list = list.filter((f) => f.level === params.level);
  }
  if (params.fromTs !== undefined) {
    const from = parseTs(params.fromTs, "from");
    list = list.filter((f) => f.lastAt >= from);
  }
  if (params.toTs !== undefined) {
    const to = parseTs(params.toTs, "to");
    list = list.filter((f) => f.startedAt <= to);
  }
  list.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  return list.map((f) => faultWithMachine(data, f));
}

function querySamples(data, params = {}) {
  let list = data.samples.slice();
  if (params.machineId) {
    const machine = data.machines.find((m) => m.id === params.machineId || m.code === params.machineId);
    if (!machine) throw httpError(404, "机台不存在");
    list = list.filter((s) => s.machineId === machine.id);
  }
  if (params.fromTs !== undefined) list = list.filter((s) => s.ts >= parseTs(params.fromTs, "from"));
  if (params.toTs !== undefined) list = list.filter((s) => s.ts <= parseTs(params.toTs, "to"));
  list.sort((a, b) => a.ts - b.ts || a.seq - b.seq || (a.id < b.id ? -1 : 1));
  return list;
}

module.exports = {
  METRICS,
  METRIC_LABELS,
  DEFAULTS,
  initialHealthData,
  ensureHealth,
  parseTs,
  classifySample,
  registerMachine,
  getMachineOrFail,
  ingestSamples,
  evaluateMachine,
  sweepOffline,
  effectiveStatus,
  startMaintenance,
  endMaintenance,
  confirmFault,
  closeFault,
  queryFaults,
  querySamples,
  publicSample,
  publicMachine,
  faultWithMachine,
  httpError
};
