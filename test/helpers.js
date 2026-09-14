"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const { createService } = require("../server");

// 可调时钟
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    set(ms) {
      t = ms;
    },
    tick(ms = 1) {
      t += ms;
      return t;
    }
  };
}

async function withService(fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-health-"));
  const dbFile = path.join(dir, "db.json");
  const clock = options.clock || makeClock(options.startTime);
  const service = createService({
    dbFile,
    clock,
    sweepIntervalMs: options.sweepIntervalMs ?? 0,
    beforeRename: options.beforeRename
  });
  await service.listen(0);
  const baseUrl = `http://127.0.0.1:${service.port()}`;
  try {
    await fn({ service, clock, dbFile, dir, baseUrl });
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function request(baseUrl, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

// 直接走领域函数（经存储互斥），比 HTTP 更适合高频并发
const health = require("../lib/health");

async function register(service, code, extra = {}) {
  return service.store.update((db) =>
    health.registerMachine(db, { code, ...extra }, service.clock)
  );
}

async function ingest(service, machineId, batchId, samples, extra = {}) {
  return service.store.update((db) =>
    health.ingestSamples(db, { machineId, batchId, samples, ...extra }, service.clock)
  );
}

// 生成正常/异常样本
function sample(ts, overrides = {}, seq) {
  return {
    ts,
    seq,
    tension: 50,
    holeDiameter: 5.0,
    rpm: 1000,
    ...overrides
  };
}

module.exports = { makeClock, withService, request, register, ingest, sample, health };
