"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { withService, request, register, ingest, sample, health } = require("./helpers");

// ---------- 窗口判定：异常连续达到窗口才生成故障 ----------

test("连续异常达到窗口才生成 open 故障", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P01");
    const base = service.clock.now();

    const r1 = await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1)
    ]);
    assert.equal(r1.action, "none");
    assert.equal(r1.faultId, null);

    const r2 = await ingest(service, m.id, "b2", [sample(base + 3000, { tension: 70 }, 2)]);
    assert.equal(r2.action, "created");
    assert.ok(r2.faultId);

    const db = await service.store.get();
    assert.equal(db.faults.length, 1);
    const fault = db.faults[0];
    assert.equal(fault.status, "open");
    assert.equal(fault.metric, "tension");
    assert.equal(fault.sampleIds.length, 3);
    assert.equal(fault.startedAt, base + 1000);
    assert.equal(fault.lastAt, base + 3000);
  });
});

test("异常未连续（被正常样本打断）不生成故障；已生成的故障自动关闭", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P02");
    const base = service.clock.now();

    await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);
    let db = await service.store.get();
    assert.equal(db.faults.length, 1);

    // 正常样本打断连续段
    const r = await ingest(service, m.id, "b2", [sample(base + 4000, {}, 3)]);
    assert.equal(r.action, "fault_auto_closed");
    db = await service.store.get();
    assert.equal(db.faults[0].status, "closed");
    assert.equal(db.faults[0].reason, "streak_broken");
  });
});

test("自定义 windowSize 生效", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P03", { windowSize: 2 });
    const base = service.clock.now();
    const r = await ingest(service, m.id, "b1", [
      sample(base + 1000, { rpm: 1300 }, 0),
      sample(base + 2000, { rpm: 1300 }, 1)
    ]);
    assert.equal(r.action, "created");
  });
});

// ---------- 严重度：补充与升级，不重复新建 ----------

test("同一未确认故障只补充不新建；达到 critical 时升级", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P04");
    const base = service.clock.now();

    await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 62 }, 0), // warning
      sample(base + 2000, { tension: 62 }, 1),
      sample(base + 3000, { tension: 62 }, 2)
    ]);
    let db = await service.store.get();
    assert.equal(db.faults.length, 1);
    const faultId = db.faults[0].id;
    assert.equal(db.faults[0].level, "warning");

    const r = await ingest(service, m.id, "b2", [sample(base + 4000, { tension: 62 }, 3)]);
    assert.equal(r.action, "supplemented");
    assert.equal(r.faultId, faultId);

    const r2 = await ingest(service, m.id, "b3", [sample(base + 5000, { tension: 80 }, 4)]); // critical
    assert.equal(r2.action, "upgraded");
    assert.equal(r2.faultId, faultId);

    db = await service.store.get();
    assert.equal(db.faults.length, 1);
    assert.equal(db.faults[0].level, "critical");
    assert.equal(db.faults[0].sampleIds.length, 5);
    const types = db.faults[0].history.map((h) => h.type);
    assert.deepEqual(types, ["created", "supplement", "supplement"]);
  });
});

// ---------- 幂等：重复批次 ----------

test("同一 batchId 重复上报幂等：不新增样本/故障，返回一致结果", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P05");
    const base = service.clock.now();
    const payload = [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ];
    const first = await ingest(service, m.id, "dup-batch", payload);
    assert.equal(first.action, "created");
    assert.equal(first.accepted, 3);

    const again = await ingest(service, m.id, "dup-batch", payload);
    assert.equal(again.duplicate, true);
    assert.equal(again.action, "created");
    assert.equal(again.faultId, first.faultId);
    assert.equal(again.accepted, 3);

    const db = await service.store.get();
    assert.equal(db.samples.length, 3);
    assert.equal(db.faults.length, 1);
    assert.equal(db.batches.length, 1);
  });
});

test("跨批次的相同(ts,seq)天然去重", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P06");
    const base = service.clock.now();
    await ingest(service, m.id, "bA", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1)
    ]);
    await assert.rejects(
      () => ingest(service, m.id, "bB", [sample(base + 1000, { tension: 70 }, 0)]),
      /全部为重复样本/
    );
    const db = await service.store.get();
    assert.equal(db.samples.length, 2);
    assert.equal(db.batches.length, 1);
  });
});

// ---------- 乱序样本按时间归位 ----------

test("乱序样本按时间归位后重算窗口", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P07");
    const base = service.clock.now();

    // 先到两个异常
    await ingest(service, m.id, "b1", [
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);
    let db = await service.store.get();
    assert.equal(db.faults.length, 0);

    // 迟到一个更早的异常，归位后连续段恰好达到窗口
    const r = await ingest(service, m.id, "b2", [sample(base + 1000, { tension: 70 }, 0)]);
    assert.equal(r.action, "created");
    db = await service.store.get();
    assert.equal(db.faults[0].startedAt, base + 1000);
  });
});

test("乱序插入正常样本打断已确认前的连续段，自动关闭故障", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P08");
    const base = service.clock.now();
    await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 4000, { tension: 70 }, 3) // 中间缺 t3
    ]);
    assert.equal((await service.store.get()).faults.length, 1);

    // t3 迟到且正常：连续段被切成 2 + 1，尾部不足窗口
    const r = await ingest(service, m.id, "b2", [sample(base + 3000, {}, 2)]);
    assert.equal(r.action, "fault_auto_closed");
    const fault = (await service.store.get()).faults[0];
    assert.equal(fault.status, "closed");
    assert.equal(fault.reason, "streak_broken");
  });
});

test("乱序迟到的异常样本补充进已开故障，不重复新建", async () => {
  await withService(async ({ service }) => {
    const m = await register(service, "P08b");
    const base = service.clock.now();
    // t1,t2,t4 异常 -> 连续段 [t1,t2,t4] 达窗口，开故障
    const first = await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 4000, { tension: 70 }, 3)
    ]);
    assert.equal(first.action, "created");
    // t3 迟到且异常：连续段仍是同一段，仅补充
    const later = await ingest(service, m.id, "b2", [sample(base + 3000, { tension: 70 }, 2)]);
    assert.equal(later.action, "supplemented");
    assert.equal(later.faultId, first.faultId);
    const db = await service.store.get();
    assert.equal(db.faults.length, 1);
    assert.equal(db.faults[0].sampleIds.length, 4);
  });
});

test("真实 HTTP 并发上报：只有一个故障", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const reg = await request(baseUrl, "POST", "/machines", { code: "P08c" });
    const machineId = reg.body.data.id;
    const base = clock.now();
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(baseUrl, "POST", `/machines/${machineId}/samples`, {
          batchId: `http-conc-${i}`,
          samples: [
            sample(base + i * 1000 + 1, { tension: 70 }, i)
          ]
        })
      )
    );
    for (const r of responses) assert.equal(r.status, 200);
    assert.equal(responses.filter((r) => r.body.data.action === "created").length, 1);
    const list = await request(baseUrl, "GET", `/faults?machineId=${machineId}`);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].sampleIds.length, 6);
  });
});

// ---------- 维修：暂停告警，恢复后只看新样本 ----------
test("维修期间上报不产生告警；维修结束后旧样本不参与窗口", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "P09");
    const base = clock.now();

    await service.store.update((db) =>
      health.startMaintenance(db, { machineId: m.id, reason: "换模" }, clock)
    );

    const during = await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);
    assert.equal(during.action, "deferred");
    assert.equal((await service.store.get()).faults.length, 0);

    clock.tick(10_000);
    const endAt = clock.now();
    await service.store.update((db) =>
      health.endMaintenance(db, { machineId: m.id, endedTs: endAt }, clock)
    );

    // 维修窗口内的样本仍在库里，但 judged=false
    const db1 = await service.store.get();
    for (const s of db1.samples) {
      assert.equal(health.publicSample(db1, m, s).judged, false);
    }

    // 维修后只上报 2 个异常，不应把维修前 3 个算进连续段
    const after = await ingest(service, m.id, "b2", [
      sample(endAt + 1000, { tension: 70 }, 3),
      sample(endAt + 2000, { tension: 70 }, 4)
    ]);
    assert.equal(after.action, "none");

    const third = await ingest(service, m.id, "b3", [sample(endAt + 3000, { tension: 70 }, 5)]);
    assert.equal(third.action, "created");
  });
});

test("维修开始时未确认故障自动关闭", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "P10");
    const base = clock.now();
    await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);
    const result = await service.store.update((db) =>
      health.startMaintenance(db, { machineId: m.id }, clock)
    );
    assert.equal(result.closedFaultIds.length, 1);
    const fault = (await service.store.get()).faults[0];
    assert.equal(fault.status, "closed");
    assert.equal(fault.reason, "maintenance_started");
  });
});

test("重复开始/结束维修返回 409", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "P11");
    await service.store.update((db) => health.startMaintenance(db, { machineId: m.id }, clock));
    await assert.rejects(
      () => service.store.update((db) => health.startMaintenance(db, { machineId: m.id }, clock)),
      /已在维修/
    );
    await service.store.update((db) => health.endMaintenance(db, { machineId: m.id }, clock));
    await assert.rejects(
      () => service.store.update((db) => health.endMaintenance(db, { machineId: m.id }, clock)),
      /不在维修/
    );
  });
});

// ---------- 掉线超时自动降级 ----------

test("超时未上报经 sweep 自动降级 offline，再次上报恢复 online", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "P12", { timeoutMs: 60_000 });
    const base = clock.now();
    await ingest(service, m.id, "b1", [sample(base, {}, 0)]);
    let db = await service.store.get();
    assert.equal(db.machines[0].status, "online");

    clock.set(base + 61_001);
    const changed = await service.sweepNow();
    assert.deepEqual(changed.changed.map((c) => c.status), ["offline"]);
    db = await service.store.get();
    assert.equal(db.machines[0].status, "offline");

    // 重新上报（样本时间与当前时钟一致）即恢复 online
    const r = await ingest(service, m.id, "b2", [sample(clock.now(), {}, 1)]);
    assert.equal(r.action, "none");
    assert.equal((await service.store.get()).machines[0].status, "online");
  });
});

test("超时边界 now-lastReport == timeoutMs 即降级", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "P13", { timeoutMs: 60_000 });
    await ingest(service, m.id, "b1", [sample(clock.now(), {}, 0)]);
    const lastReport = clock.now();
    clock.set(lastReport + 60_000);
    const changed = await service.sweepNow();
    assert.equal(changed.changed.length, 1);
    assert.equal(changed.changed[0].status, "offline");
  });
});

// ---------- 确认后重新计数 ----------

test("故障确认后窗口重新计数，新连续段生成新故障而非补充旧故障", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "P14");
    const base = clock.now();
    const r = await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);
    clock.tick(60_000); // 确认时刻晚于已上报的样本时间
    await service.store.update((db) => health.confirmFault(db, r.faultId, {}, clock));

    // 确认后再报更多异常样本（时间在确认之后），需要新的 3 连异常
    const ackAt = clock.now();
    let result = await ingest(service, m.id, "b2", [
      sample(ackAt + 1000, { tension: 70 }, 3),
      sample(ackAt + 2000, { tension: 70 }, 4)
    ]);
    assert.equal(result.action, "none");
    result = await ingest(service, m.id, "b3", [sample(ackAt + 3000, { tension: 70 }, 5)]);
    assert.equal(result.action, "created");
    assert.notEqual(result.faultId, r.faultId);

    const db = await service.store.get();
    assert.equal(db.faults.length, 2);
    assert.equal(db.faults.find((f) => f.id === r.faultId).status, "confirmed");
  });
});

test("重复确认/关闭返回 409", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "P15");
    const base = clock.now();
    const r = await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);
    await service.store.update((db) => health.confirmFault(db, r.faultId, {}, clock));
    await assert.rejects(
      () => service.store.update((db) => health.confirmFault(db, r.faultId, {}, clock)),
      /不能确认/
    );
    await service.store.update((db) => health.closeFault(db, r.faultId, {}, clock));
    await assert.rejects(
      () => service.store.update((db) => health.closeFault(db, r.faultId, {}, clock)),
      /已关闭/
    );
  });
});

// ---------- 查询 ----------

test("故障查询支持 machine/status/level/时间边界过滤，按创建时间倒序", async () => {
  await withService(async ({ service, clock }) => {
    const m1 = await register(service, "Q1");
    const m2 = await register(service, "Q2");
    const base = clock.now();
    await ingest(service, m1.id, "a", [
      sample(base + 1000, { tension: 80 }, 0),
      sample(base + 2000, { tension: 80 }, 1),
      sample(base + 3000, { tension: 80 }, 2)
    ]);
    clock.tick(1000);
    const m2base = clock.now();
    await ingest(service, m2.id, "b", [
      sample(m2base + 1000, { rpm: 1250 }, 0),
      sample(m2base + 2000, { rpm: 1250 }, 1),
      sample(m2base + 3000, { rpm: 1250 }, 2)
    ]);

    const db = await service.store.get();
    assert.equal(health.queryFaults(db, { machineId: m1.id }).length, 1);
    assert.equal(health.queryFaults(db, { status: "open" }).length, 2);
    assert.equal(health.queryFaults(db, { level: "critical" }).length, 2);

    // 时间边界（闭区间）：from 按 lastAt，to 按 startedAt
    // m1 样本区间 base+1s..base+3s；m2 在 base+1s 之后创建，样本区间 base+2s..base+4s
    const windowed = health.queryFaults(db, { fromTs: base + 3500, toTs: base + 100_000 });
    assert.equal(windowed.length, 1);
    assert.equal(windowed[0].machineCode, "Q2");
    // 倒序
    const all = health.queryFaults(db, {});
    assert.ok(all[0].createdAt >= all[1].createdAt);
    // 附单机台编码
    assert.ok(all[0].machineCode);
  });
});

test("样本查询支持机台与时间边界，乱序写入按时间顺序返回", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "Q3");
    const base = clock.now();
    await ingest(service, m.id, "a", [
      sample(base + 3000, {}, 2),
      sample(base + 1000, {}, 0),
      sample(base + 2000, {}, 1)
    ]);
    const db = await service.store.get();
    const list = health.querySamples(db, {
      machineId: m.id,
      fromTs: base + 2000,
      toTs: base + 2000
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].ts, base + 2000);
    const all = health.querySamples(db, { machineId: m.id });
    assert.deepEqual(all.map((s) => s.ts), [base + 1000, base + 2000, base + 3000]);
  });
});

// ---------- HTTP 端到端 ----------

test("HTTP：注册 -> 上报 -> 查询 -> 确认/关闭闭环", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const reg = await request(baseUrl, "POST", "/machines", { code: "H1", windowSize: 2 });
    assert.equal(reg.status, 201);
    const machineId = reg.body.data.id;

    const base = clock.now();
    const ing = await request(baseUrl, "POST", `/machines/${machineId}/samples`, {
      batchId: "http-1",
      samples: [
        sample(base + 1000, { tension: 70 }, 0),
        sample(base + 2000, { tension: 70 }, 1)
      ]
    });
    assert.equal(ing.status, 200);
    assert.equal(ing.body.data.action, "created");
    const faultId = ing.body.data.faultId;

    const list = await request(baseUrl, "GET", `/faults?machineId=${machineId}`);
    assert.equal(list.body.data.length, 1);

    const confirm = await request(baseUrl, "POST", `/faults/${faultId}/confirm`, { note: "已派工" });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.data.status, "confirmed");

    const close = await request(baseUrl, "POST", `/faults/${faultId}/close`, { note: "更换张力计" });
    assert.equal(close.status, 200);
    assert.equal(close.body.data.status, "closed");

    const sweep = await request(baseUrl, "POST", "/admin/sweep", {});
    assert.equal(sweep.status, 200);

    // /health 包含新路由
    const h = await request(baseUrl, "GET", "/health");
    assert.ok(h.body.routes.some((r) => r.includes("/faults")));
  });
});

test("HTTP：维修开始/结束接口", async () => {
  await withService(async ({ service, baseUrl }) => {
    const reg = await request(baseUrl, "POST", "/machines", { code: "H2" });
    const id = reg.body.data.id;
    const start = await request(baseUrl, "POST", `/machines/${id}/maintenance/start`, { reason: "保养" });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.data.closedFaultIds, []);
    const end = await request(baseUrl, "POST", `/machines/${id}/maintenance/end`, {});
    assert.equal(end.status, 200);
    assert.ok(end.body.data.evaluateAfterTs);
  });
});

test("重启后数据仍在文件中（直接读 JSON 校验结构）", async () => {
  await withService(async ({ service, dbFile, clock }) => {
    const m = await register(service, "R1");
    const base = clock.now();
    await ingest(service, m.id, "b1", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);
    const onDisk = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    assert.ok(Array.isArray(onDisk.machines));
    assert.equal(onDisk.faults.length, 1);
    assert.equal(onDisk.samples.length, 3);
    // 旧数据仍在
    assert.ok(onDisk.tunes.some((t) => t.id === "tune_demo"));
  });
});
