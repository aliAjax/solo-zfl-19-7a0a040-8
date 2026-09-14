"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withService, register, ingest, sample } = require("./helpers");

test("并发上报同一机台：样本不丢失、故障只生成一次", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "C1", { windowSize: 5 });
    const base = clock.now();

    // 20 个批次并发，每批 5 个异常样本，时间窗天然连续
    const tasks = [];
    for (let i = 0; i < 20; i++) {
      const samples = [];
      for (let j = 0; j < 5; j++) {
        const idx = i * 5 + j;
        samples.push(sample(base + (idx + 1) * 1000, { tension: 70 }, idx));
      }
      tasks.push(ingest(service, m.id, `batch-${i}`, samples));
    }
    const results = await Promise.all(tasks);

    const db = await service.store.get();
    assert.equal(db.samples.length, 100);
    assert.equal(db.batches.length, 20);
    // 同一时间只有一个 open 故障；created 只出现一次
    const open = db.faults.filter((f) => f.status === "open");
    assert.equal(open.length, 1);
    assert.equal(results.filter((r) => r.action === "created").length, 1);
    // 其余为补充/升级，不应出现重复新建
    const faultIds = new Set(results.filter((r) => r.faultId).map((r) => r.faultId));
    assert.equal(faultIds.size, 1);
  });
});

test("并发重复批次：所有重放返回同一 faultId，批次只入库一次", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "C2");
    const base = clock.now();
    const payload = [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ];
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ingest(service, m.id, "same-batch", payload))
    );
    const created = results.filter((r) => !r.duplicate);
    assert.equal(created.length, 1);
    const faultId = created[0].faultId;
    for (const r of results) {
      assert.equal(r.faultId, faultId);
      assert.equal(r.action, "created");
    }
    const db = await service.store.get();
    assert.equal(db.samples.length, 3);
    assert.equal(db.batches.length, 1);
    assert.equal(db.faults.length, 1);
  });
});

test("并发注册相同机台编号：恰好一个成功", async () => {
  await withService(async ({ service }) => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => register(service, "DUP"))
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 7);
    const db = await service.store.get();
    assert.equal(db.machines.filter((x) => x.code === "DUP").length, 1);
  });
});

test("并发混合：上报与维修交错，不出现维修期故障", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "C3", { windowSize: 2 });
    const base = clock.now();

    const report = ingest(service, m.id, "x1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1)
    ]);
    const repair = service.store.update((db) =>
      require("../lib/health").startMaintenance(db, { machineId: m.id }, clock)
    );
    await Promise.allSettled([report, repair]);

    const db = await service.store.get();
    const machine = db.machines[0];
    if (machine.maintenance) {
      // 若维修先发生：上报被挂起，无 open 故障
      assert.equal(db.faults.filter((f) => f.status === "open").length, 0);
    } else {
      // 若上报先发生：存在故障后被维修自动关闭
      assert.equal(db.faults.filter((f) => f.status === "open").length, 0);
      assert.equal(db.faults[0].reason, "maintenance_started");
    }
  });
});
