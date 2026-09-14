"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withService, request, register, ingest, sample } = require("./helpers");

test("机台注册参数校验", async () => {
  await withService(async ({ service, baseUrl }) => {
    assert.equal((await request(baseUrl, "POST", "/machines", {})).status, 400);
    assert.equal((await request(baseUrl, "POST", "/machines", { code: "坏 编号!" })).status, 400);
    assert.equal((await request(baseUrl, "POST", "/machines", { code: "a".repeat(65) })).status, 400);
    assert.equal((await request(baseUrl, "POST", "/machines", { code: "X1", windowSize: 0 })).status, 400);
    assert.equal((await request(baseUrl, "POST", "/machines", { code: "X2", windowSize: 2.5 })).status, 400);
    assert.equal((await request(baseUrl, "POST", "/machines", { code: "X3", timeoutMs: 500 })).status, 400);
    assert.equal(
      (await request(baseUrl, "POST", "/machines", {
        code: "X4",
        thresholds: { tension: { warning: { min: 100, max: 0 } } }
      })).status,
      400
    );
    assert.equal(
      (await request(baseUrl, "POST", "/machines", {
        code: "X5",
        // warning 区间超出 critical 区间
        thresholds: {
          tension: {
            warning: { min: 10, max: 90 },
            critical: { min: 40, max: 60 }
          }
        }
      })).status,
      400
    );
    assert.equal(
      (await request(baseUrl, "POST", "/machines", { code: "X6", thresholds: [] })).status,
      400
    );

    const ok = await request(baseUrl, "POST", "/machines", { code: "X7", name: "七号机" });
    assert.equal(ok.status, 201);
    // 重复编号 409
    assert.equal((await request(baseUrl, "POST", "/machines", { code: "X7" })).status, 409);
  });
});

test("批次上报参数校验", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    const m = await register(service, "V1");
    const base = clock.now();

    assert.equal(
      (await request(baseUrl, "POST", `/machines/no-such/samples`, {
        batchId: "b",
        samples: [sample(base, {}, 0)]
      })).status,
      404
    );

    const post = (body) => request(baseUrl, "POST", `/machines/${m.id}/samples`, body);

    assert.equal((await post({ samples: [] })).status, 400); // 缺 batchId 与空数组都报400
    assert.equal((await post({ batchId: "b", samples: [] })).status, 400);
    assert.equal((await post({ batchId: "b", samples: "not-array" })).status, 400);

    assert.equal(
      (await post({
        batchId: "b1",
        samples: [{ ts: base, seq: 0, tension: "大", holeDiameter: 5, rpm: 1000 }]
      })).status,
      400
    );
    assert.equal(
      (await post({
        batchId: "b2",
        samples: [{ ts: "not-a-time", seq: 0, tension: 50, holeDiameter: 5, rpm: 1000 }]
      })).status,
      400
    );
    assert.equal(
      (await post({
        batchId: "b3",
        samples: [{ ts: base, seq: -1, tension: 50, holeDiameter: 5, rpm: 1000 }]
      })).status,
      400
    );
    assert.equal(
      (await post({
        batchId: "b4",
        samples: [{ ts: base, seq: 0, tension: NaN, holeDiameter: 5, rpm: 1000 }]
      })).status,
      400
    );
    assert.equal(
      (await post({
        batchId: "b5",
        samples: [{ ts: base, seq: 0, tension: 50, holeDiameter: 5, rpm: 1000, extra: true }]
      })).status,
      200,
      "多余字段应被允许"
    );
  });
});

test("时间边界：±5分钟偏差闭区间，ISO 字符串与数字字符串均可", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "V2");
    const now = clock.now();
    const FIVE_MIN = 5 * 60_000;

    // 边界恰好 ±5 分钟：接受
    await ingest(service, m.id, "edge-past", [sample(now - FIVE_MIN, { tension: 70 }, 0)]);
    await ingest(service, m.id, "edge-future", [sample(now + FIVE_MIN, { tension: 70 }, 1)]);

    // 超出 1ms：拒绝
    await assert.rejects(
      () => ingest(service, m.id, "over", [sample(now - FIVE_MIN - 1, {}, 2)]),
      /时间偏差/
    );

    // ISO 8601 字符串
    const r = await ingest(service, m.id, "iso", [
      { ts: new Date(now + 1000).toISOString(), seq: 3, tension: 70, holeDiameter: 5, rpm: 1000 }
    ]);
    assert.equal(r.accepted, 1);
    // 纯数字字符串
    const r2 = await ingest(service, m.id, "numstr", [
      { ts: String(now + 2000), seq: 4, tension: 70, holeDiameter: 5, rpm: 1000 }
    ]);
    assert.equal(r2.accepted, 1);
  });
});

test("故障与维修接口的状态/时间校验", async () => {
  await withService(async ({ service, baseUrl, clock }) => {
    assert.equal((await request(baseUrl, "GET", "/faults?status=bogus")).status, 400);
    assert.equal((await request(baseUrl, "GET", "/faults?level=bogus")).status, 400);
    assert.equal((await request(baseUrl, "GET", "/faults?from=not-a-time")).status, 400);
    assert.equal((await request(baseUrl, "GET", "/faults/no-such")).status, 404);
    assert.equal((await request(baseUrl, "POST", "/faults/no-such/confirm", {})).status, 404);

    const m = await register(service, "V3");
    const base = clock.now();
    const r = await ingest(service, m.id, "b", [
      sample(base + 1000, { tension: 70 }, 0),
      sample(base + 2000, { tension: 70 }, 1),
      sample(base + 3000, { tension: 70 }, 2)
    ]);

    // 维修结束早于开始：400
    await request(baseUrl, "POST", `/machines/${m.id}/maintenance/start`, { startedTs: base + 5000 });
    const badEnd = await request(baseUrl, "POST", `/machines/${m.id}/maintenance/end`, {
      endedTs: base + 4000
    });
    assert.equal(badEnd.status, 400);
  });
});

test("非法 JSON 与超大请求体", async () => {
  await withService(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/machines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops"
    });
    assert.equal(res.status, 400);

    const big = await fetch(`${baseUrl}/machines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "BIG", name: "x".repeat(2 * 1024 * 1024) })
    });
    assert.equal(big.status, 413);
  });
});

test("阈值边界本身判为正常（闭区间内不算异常）", async () => {
  await withService(async ({ service, clock }) => {
    const m = await register(service, "V4");
    const base = clock.now();
    // 恰好压在 warning/critical 边界上
    const r = await ingest(service, m.id, "b", [
      sample(base + 1000, { tension: 60 }, 0),
      sample(base + 2000, { tension: 65 }, 1),
      sample(base + 3000, { holeDiameter: 4.9 }, 2)
    ]);
    assert.equal(r.action, "none");
    assert.equal((await service.store.get()).faults.length, 0);

    // 超出 0.001 即异常
    const r2 = await ingest(service, m.id, "b2", [
      sample(base + 4000, { tension: 60.001 }, 3),
      sample(base + 5000, { tension: 60.001 }, 4),
      sample(base + 6000, { tension: 60.001 }, 5)
    ]);
    assert.equal(r2.action, "created");
  });
});
