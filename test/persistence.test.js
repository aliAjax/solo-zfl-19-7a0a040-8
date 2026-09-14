"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createService } = require("../server");
const { makeClock, register, ingest, sample } = require("./helpers");

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-restart-"));
  return { dir, dbFile: path.join(dir, "db.json") };
}

test("写入失败：不落半个事件且内存回滚，磁盘保持上一个一致版本", async () => {
  const { dir, dbFile } = tmpDb();
  const clock = makeClock();
  let failNextWrite = false;
  const service = createService({
    dbFile,
    clock,
    sweepIntervalMs: 0,
    beforeRename: () => {
      if (failNextWrite) throw new Error("ENOSPC simulated");
    }
  });
  await service.listen(0);
  try {
    const m = await register(service, "F1");
    const base = clock.now();
    await ingest(service, m.id, "ok1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);

    const before = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    assert.equal(before.faults.length, 1);

    failNextWrite = true;
    await assert.rejects(
      () => ingest(service, m.id, "failing", [sample(base + 4000, { tension: 70 }, 3)]),
      /ENOSPC/
    );

    // 磁盘仍是上一个完整版本
    const onDisk = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    assert.equal(onDisk.faults.length, 1);
    assert.equal(onDisk.samples.length, 3);
    assert.equal(onDisk.batches.length, 1);

    // 内存已回滚：再成功写一次，状态与磁盘一致，不出现幽灵样本
    failNextWrite = false;
    const r = await ingest(service, m.id, "ok2", [sample(base + 4000, { tension: 70 }, 3)]);
    assert.equal(r.action, "supplemented");
    const after = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    assert.equal(after.samples.length, 4);
    assert.equal(after.faults.length, 1);
    assert.equal(after.faults[0].sampleIds.length, 4);

    // 临时文件已清理
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("重启一致性：重新创建服务后机台、样本、故障、状态都保持", async () => {
  const { dir, dbFile } = tmpDb();
  const clock = makeClock();

  let service = createService({ dbFile, clock, sweepIntervalMs: 0 });
  await service.listen(0);
  const m = await register(service, "F2", { timeoutMs: 60_000 });
  const base = clock.now();
  const ing = await ingest(service, m.id, "b1", [
    sample(base + 1000, { tension: 80 }, 0),
    sample(base + 2000, { tension: 80 }, 1),
    sample(base + 3000, { tension: 80 }, 2)
  ]);
  const faultId = ing.faultId;
  await service.close();

  // 重启：时钟前进到超时之后，启动 sweep 应把机台持久化为 offline
  clock.set(base + 120_000);
  service = createService({ dbFile, clock, sweepIntervalMs: 0 });
  await service.init;
  try {
    const db = await service.store.get();
    assert.equal(db.machines.length, 1);
    assert.equal(db.machines[0].code, "F2");
    assert.equal(db.machines[0].status, "offline");
    assert.equal(db.samples.length, 3);
    assert.equal(db.faults.length, 1);
    assert.equal(db.faults[0].id, faultId);
    assert.equal(db.faults[0].level, "critical");

    // 重启后窗口判定仍连续：迟到的补充样本补进同一故障
    const r = await ingest(service, m.id, "b2", [sample(clock.now() + 1000, { tension: 80 }, 3)]);
    assert.equal(r.faultId, faultId);
    assert.equal(r.action, "supplemented");
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("旧结构 db.json（无健康集合）启动时自动迁移，旧数据不丢", async () => {
  const { dir, dbFile } = tmpDb();
  fs.writeFileSync(
    dbFile,
    JSON.stringify({
      tunes: [{ id: "t_x", title: "旧曲", composer: "", stripSpec: {}, createdAt: "2026-01-01T00:00:00.000Z" }],
      sections: [],
      issues: []
    })
  );
  const service = createService({ dbFile: dbFile, sweepIntervalMs: 0 });
  await service.init;
  try {
    const db = await service.store.get();
    assert.equal(db.tunes[0].id, "t_x");
    assert.deepEqual(db.machines, []);
    assert.deepEqual(db.samples, []);
    assert.deepEqual(db.faults, []);
    assert.deepEqual(db.batches, []);
    // 迁移结果已落盘
    const onDisk = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    assert.ok(Array.isArray(onDisk.faults));
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏的 db.json 启动时重建为含演示数据的默认库", async () => {
  const { dir, dbFile } = tmpDb();
  fs.writeFileSync(dbFile, "{ not json");
  const service = createService({ dbFile, sweepIntervalMs: 0 });
  await service.init;
  try {
    const db = await service.store.get();
    assert.ok(db.tunes.some((t) => t.id === "tune_demo"));
    assert.ok(Array.isArray(db.faults));
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
