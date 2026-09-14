"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { withService, request } = require("./helpers");

test("回归：/health 与演示数据保持不变", async () => {
  await withService(async ({ baseUrl }) => {
    const h = await request(baseUrl, "GET", "/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.equal(h.body.service, "organ-strip-punch-api");
    for (const r of [
      "GET /tunes",
      "POST /issues",
      "PATCH /issues/:id/status",
      "GET /machines"
    ]) {
      assert.ok(h.body.routes.includes(r), `routes 应包含 ${r}`);
    }

    const tunes = await request(baseUrl, "GET", "/tunes");
    const demo = tunes.body.data.find((t) => t.id === "tune_demo");
    assert.ok(demo);
    assert.equal(demo.title, "雨后圆舞曲");
    assert.equal(demo.progress.totalSections, 2);
    assert.equal(demo.progress.checkedSections, 1);
    assert.equal(demo.progress.openIssues, 1);
    assert.equal(demo.progress.percent, 50);
  });
});

test("回归：曲目 CRUD 与进度", async () => {
  await withService(async ({ baseUrl }) => {
    const created = await request(baseUrl, "POST", "/tunes", {
      title: "新曲",
      composer: "甲",
      stripSpec: { widthMm: 70 }
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    assert.match(id, /^tune_/);

    assert.equal((await request(baseUrl, "POST", "/tunes", { title: "缺规格" })).status, 400);

    const sec = await request(baseUrl, "POST", `/tunes/${id}/sections`, {
      startBeat: 1,
      endBeat: 8,
      laneRange: "1-5"
    });
    assert.equal(sec.status, 201);
    const sectionId = sec.body.data.id;
    assert.equal(sec.body.data.checked, false);

    const list = await request(baseUrl, "GET", `/tunes/${id}/sections`);
    assert.equal(list.body.data.length, 1);

    const unchecked = await request(baseUrl, "GET", `/tunes/${id}/unchecked-sections`);
    assert.equal(unchecked.body.data.length, 1);

    const checked = await request(baseUrl, "PATCH", `/sections/${sectionId}/check`, {
      checked: true,
      note: "已校对"
    });
    assert.equal(checked.body.data.checked, true);
    assert.equal(checked.body.data.note, "已校对");

    const progress = await request(baseUrl, "GET", `/tunes/${id}/progress`);
    assert.equal(progress.body.data.percent, 100);

    assert.equal((await request(baseUrl, "GET", "/tunes/no-such/progress")).status, 404);
  });
});

test("回归：问题创建、过滤、状态流转", async () => {
  await withService(async ({ baseUrl }) => {
    // 缺少字段
    assert.equal((await request(baseUrl, "POST", "/issues", { tuneId: "tune_demo" })).status, 400);
    // 区间不属于曲目
    assert.equal(
      (
        await request(baseUrl, "POST", "/issues", {
          tuneId: "tune_demo",
          sectionId: "ghost",
          type: "错孔",
          description: "x"
        })
      ).status,
      400
    );

    const created = await request(baseUrl, "POST", "/issues", {
      tuneId: "tune_demo",
      sectionId: "section_demo_1",
      type: "错孔",
      beat: 8,
      lane: 3,
      description: "第8拍第3轨错孔"
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, "open");
    assert.equal(created.body.data.resolvedAt, null);
    const issueId = created.body.data.id;

    const open = await request(baseUrl, "GET", "/issues?tuneId=tune_demo&status=open");
    assert.ok(open.body.data.some((i) => i.id === issueId));
    assert.equal(open.body.data.every((i) => i.status === "open"), true);

    const patched = await request(baseUrl, "PATCH", `/issues/${issueId}/status`, {
      status: "resolved",
      note: "已修正"
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.status, "resolved");
    assert.ok(patched.body.data.resolvedAt);
    assert.equal(patched.body.data.note, "已修正");

    const resolved = await request(baseUrl, "GET", "/issues?status=resolved");
    assert.ok(resolved.body.data.some((i) => i.id === issueId));

    assert.equal(
      (await request(baseUrl, "PATCH", "/issues/no-such/status", { status: "open" })).status,
      404
    );
  });
});

test("回归：未知路由返回 404 与路由清单", async () => {
  await withService(async ({ baseUrl }) => {
    const r = await request(baseUrl, "GET", "/nope");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "接口不存在");
    assert.ok(Array.isArray(r.body.routes));
  });
});
