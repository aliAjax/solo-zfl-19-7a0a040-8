"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withService, request, register, ingest, sample } = require("./helpers");

// ---------- 路由归属：路径是机台编号的唯一归属 ----------

test("样本上报：请求体机台编号与路径不一致返回 400，且不写入任何机台", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const a = await register(service, "OWN-A");
    const b = await register(service, "OWN-B");
    const now = clock.now();
    const payload = {
      machineId: b.id, // 指向另一台机台
      batchId: "cross-1",
      samples: [
        sample(now, { tension: 70 }, 0),
        sample(now + 1000, { tension: 70 }, 1),
        sample(now + 2000, { tension: 70 }, 2)
      ]
    };

    const res = await request(baseUrl, "POST", `/machines/${a.id}/samples`, payload);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /不一致/);

    // 用 code 指向另一台同样拒绝
    const byCode = await request(baseUrl, "POST", `/machines/${a.id}/samples`, {
      ...payload,
      machineId: "OWN-B"
    });
    assert.equal(byCode.status, 400);

    const db = await service.store.get();
    assert.equal(db.samples.length, 0);
    assert.equal(db.batches.length, 0);
    assert.equal(db.faults.length, 0);
  });
});

test("样本上报：请求体编号指向不存在的机台返回 400", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const a = await register(service, "OWN-C");
    const res = await request(baseUrl, "POST", `/machines/${a.id}/samples`, {
      machineId: "ghost-machine",
      batchId: "g1",
      samples: [sample(clock.now(), {}, 0)]
    });
    assert.equal(res.status, 400);
    assert.equal((await service.store.get()).samples.length, 0);
  });
});

test("维修开始/结束：请求体机台编号与路径不一致返回 400，状态不被改写", async () => {
  await withService(async ({ service, baseUrl }) => {
    const a = await register(service, "OWN-D");
    const b = await register(service, "OWN-E");

    const startBad = await request(baseUrl, "POST", `/machines/${a.id}/maintenance/start`, {
      machineId: b.id,
      reason: "想修A却写B"
    });
    assert.equal(startBad.status, 400);

    let db = await service.store.get();
    assert.equal(db.machines.find((m) => m.id === a.id).maintenance, null);
    assert.equal(db.machines.find((m) => m.id === b.id).maintenance, null);

    // A 正常进入维修
    const startOk = await request(baseUrl, "POST", `/machines/${a.id}/maintenance/start`, { reason: "正常保养" });
    assert.equal(startOk.status, 200);

    const endBad = await request(baseUrl, "POST", `/machines/${a.id}/maintenance/end`, {
      machineId: b.code
    });
    assert.equal(endBad.status, 400);
    db = await service.store.get();
    assert.ok(db.machines.find((m) => m.id === a.id).maintenance, "A 仍应处于维修中");
  });
});

test("请求体机台编号与路径一致（id 或 code）时正常处理", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const a = await register(service, "OWN-F");
    const now = clock.now();
    const samples = [sample(now, {}, 0)];

    const byId = await request(baseUrl, "POST", `/machines/${a.id}/samples`, {
      machineId: a.id,
      batchId: "same-id",
      samples
    });
    assert.equal(byId.status, 200);

    const byCode = await request(baseUrl, "POST", `/machines/${a.code}/samples`, {
      machineId: "OWN-F",
      batchId: "same-code",
      samples: [sample(now + 1000, {}, 1)]
    });
    assert.equal(byCode.status, 200);

    // 路径用 code、body 用 id 也视为一致
    const mixed = await request(baseUrl, "POST", `/machines/OWN-F/samples`, {
      machineId: a.id,
      batchId: "same-mixed",
      samples: [sample(now + 2000, {}, 2)]
    });
    assert.equal(mixed.status, 200);

    const db = await service.store.get();
    assert.equal(db.samples.length, 3);
    assert.ok(db.samples.every((s) => s.machineId === a.id));
  });
});

test("跨机台编号不会误命中：路径不存在时返回 404", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const b = await register(service, "OWN-G");
    // 路径机台不存在，即使 body 指向真实机台，也不能写到 B
    const res = await request(baseUrl, "POST", `/machines/no-such/samples`, {
      machineId: b.id,
      batchId: "x",
      samples: [sample(clock.now(), {}, 0)]
    });
    assert.equal(res.status, 404);
    assert.equal((await service.store.get()).samples.length, 0);
  });
});

// ---------- 掉线判定统一：列表筛选 / 详情 / 样本查询一致 ----------

test("超时未扫描时，离线筛选、机台详情、样本查询看到的状态一致为 offline", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const a = await register(service, "STAT-A", { timeoutMs: 60_000 });
    const online = await register(service, "STAT-B", { timeoutMs: 60_000 });
    const t0 = clock.now();
    await ingest(service, a.id, "a1", [sample(t0, {}, 0)]);
    await ingest(service, online.id, "b1", [sample(t0, {}, 0)]);

    // 时间推进超过 A 的超时阈值，但不调用 sweep（模拟扫描间隔内）
    clock.set(t0 + 61_000);
    // 再给 B 一报，B 保持在线
    await ingest(service, online.id, "b2", [sample(clock.now(), {}, 1)]);

    const db = await service.store.get();
    // 持久化状态此刻仍可能是 online（扫描未跑）
    assert.equal(db.machines.find((m) => m.id === a.id).status, "online");

    // 详情已离线
    const detail = await request(baseUrl, "GET", `/machines/${a.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.status, "offline");

    // 离线筛选必须包含 A（不能出现详情离线而离线条目为空）
    const offlineList = await request(baseUrl, "GET", "/machines?status=offline");
    assert.equal(offlineList.status, 200);
    const offlineIds = offlineList.body.data.map((m) => m.id);
    assert.ok(offlineIds.includes(a.id));
    assert.ok(!offlineIds.includes(online.id));

    // 在线筛选不包含 A、包含 B，两集合对全量互斥完备
    const onlineList = await request(baseUrl, "GET", "/machines?status=online");
    const onlineIds = onlineList.body.data.map((m) => m.id);
    assert.ok(!onlineIds.includes(a.id));
    assert.ok(onlineIds.includes(online.id));

    // 样本查询看到的机台状态同样是 offline
    const samplesRes = await request(baseUrl, "GET", `/samples?machineId=${a.id}`);
    assert.equal(samplesRes.status, 200);
    assert.equal(samplesRes.body.data.length, 1);
    assert.equal(samplesRes.body.data[0].machineStatus, "offline");

    // 全部条目里每个 status 字段都等于其 effectiveStatus（单一事实来源）
    const all = await request(baseUrl, "GET", "/machines");
    for (const m of all.body.data) {
      const expected = require("../lib/health").effectiveStatus(
        db.machines.find((x) => x.id === m.id),
        clock.now()
      );
      assert.equal(m.status, expected);
    }
  });
});

test("超时边界（恰好等于 timeoutMs）三处视图一致为 offline", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const a = await register(service, "STAT-C", { timeoutMs: 60_000 });
    const t0 = clock.now();
    await ingest(service, a.id, "a1", [sample(t0, {}, 0)]);
    clock.set(t0 + 60_000); // 恰好等于阈值：>= 即掉线

    const detail = await request(baseUrl, "GET", `/machines/${a.code}`);
    assert.equal(detail.body.data.status, "offline");
    const offlineList = await request(baseUrl, "GET", "/machines?status=offline");
    assert.ok(offlineList.body.data.some((m) => m.id === a.id));
    const samplesRes = await request(baseUrl, "GET", `/samples?machineId=${a.code}`);
    assert.equal(samplesRes.body.data[0].machineStatus, "offline");
  });
});

test("掉线后重新上报：三处视图一致恢复 online，且状态随批次原子落库", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const a = await register(service, "STAT-D", { timeoutMs: 60_000 });
    const t0 = clock.now();
    await ingest(service, a.id, "a1", [sample(t0, {}, 0)]);
    clock.set(t0 + 70_000);

    // 超时后直接重新上报（不经过 sweep）
    const back = await ingest(service, a.id, "a2", [sample(clock.now(), {}, 1)]);
    assert.equal(back.action, "none");

    // 状态与该批次在同一次写入中持久化为 online
    const db = await service.store.get();
    assert.equal(db.machines[0].status, "online");

    const detail = await request(baseUrl, "GET", `/machines/${a.id}`);
    assert.equal(detail.body.data.status, "online");
    const offlineList = await request(baseUrl, "GET", "/machines?status=offline");
    assert.ok(!offlineList.body.data.some((m) => m.id === a.id));
    const onlineList = await request(baseUrl, "GET", "/machines?status=online");
    assert.ok(onlineList.body.data.some((m) => m.id === a.id));
    const samplesRes = await request(baseUrl, "GET", `/samples?machineId=${a.id}`);
    assert.ok(samplesRes.body.data.every((s) => s.machineStatus === "online"));
  });
});

test("维修状态在列表筛选、详情、样本查询三处一致", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const a = await register(service, "STAT-E");
    const t0 = clock.now();
    await ingest(service, a.id, "a1", [sample(t0, {}, 0)]);
    await request(baseUrl, "POST", `/machines/${a.id}/maintenance/start`, { reason: "保养" });

    const detail = await request(baseUrl, "GET", `/machines/${a.id}`);
    assert.equal(detail.body.data.status, "maintenance");
    const maintList = await request(baseUrl, "GET", "/machines?status=maintenance");
    assert.ok(maintList.body.data.some((m) => m.id === a.id));
    const onlineList = await request(baseUrl, "GET", "/machines?status=online");
    assert.ok(!onlineList.body.data.some((m) => m.id === a.id));
    const samplesRes = await request(baseUrl, "GET", `/samples?machineId=${a.id}`);
    assert.equal(samplesRes.body.data[0].machineStatus, "maintenance");
    assert.equal(samplesRes.body.data[0].judged, false);
  });
});
