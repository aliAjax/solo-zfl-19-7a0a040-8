"use strict";

const http = require("http");
const path = require("path");
const { JsonStore } = require("./lib/store");
const health = require("./lib/health");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(__dirname, "data", "db.json");
const MAX_BODY_BYTES = 1024 * 1024;

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /machines",
  "POST /machines",
  "GET /machines/:id",
  "POST /machines/:id/samples",
  "POST /machines/:id/maintenance/start",
  "POST /machines/:id/maintenance/end",
  "GET /samples?machineId=&from=&to=",
  "GET /faults?machineId=&status=&level=&from=&to=",
  "GET /faults/:id",
  "POST /faults/:id/confirm",
  "POST /faults/:id/close",
  "POST /admin/sweep"
];

function buildInitialData(clock) {
  const now = new Date(clock.now()).toISOString();
  return {
    tunes: [
      {
        id: "tune_demo",
        title: "雨后圆舞曲",
        composer: "匿名",
        stripSpec: {
          widthMm: 70,
          scale: "20音",
          tempoBpm: 82,
          paperType: "半透明纸带"
        },
        createdAt: now
      }
    ],
    sections: [
      {
        id: "section_demo_1",
        tuneId: "tune_demo",
        startBeat: 1,
        endBeat: 32,
        laneRange: "1-10",
        checked: true,
        note: "开头主题已试奏"
      },
      {
        id: "section_demo_2",
        tuneId: "tune_demo",
        startBeat: 33,
        endBeat: 64,
        laneRange: "4-18",
        checked: false,
        note: "副歌段等待校对"
      }
    ],
    issues: [
      {
        id: "issue_demo",
        tuneId: "tune_demo",
        sectionId: "section_demo_2",
        type: "漏孔",
        beat: 41,
        lane: 12,
        description: "第41拍高音孔漏打",
        status: "open",
        createdAt: now,
        resolvedAt: null
      }
    ],
    ...health.initialHealthData()
  };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true; // 仍要读完剩余请求体，避免客户端连接被重置导致 fetch 挂起
      continue;
    }
    raw += chunk;
  }
  if (tooLarge) {
    const error = new Error("请求体超过1MB限制");
    error.status = 413;
    throw error;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

function createService(options = {}) {
  const clock = options.clock || { now: () => Date.now() };
  const dbFile = options.dbFile || DB_FILE;
  const store = new JsonStore(dbFile, () => buildInitialData(clock), {
    beforeRename: options.beforeRename
  });
  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
  let sweepTimer = null;
  let server = null;

  // 启动即做一次掉线判定并持久化，保证重启后机台状态与时间一致
  const init = (async () => {
    const data = await store.get();
    let missing = false;
    for (const key of Object.keys(health.initialHealthData())) {
      if (!Array.isArray(data[key])) missing = true;
    }
    if (missing) {
      await store.update((db) => {
        health.ensureHealth(db);
        return { migrated: true };
      });
    }
    await sweepNow();
  })();

  async function sweepNow() {
    return store.update((db) => {
      health.ensureHealth(db);
      const changed = health.sweepOffline(db, clock.now());
      return { changed };
    });
  }

  function machineView(machine) {
    // 所有读路径统一用 effectiveStatus（维修 > 超时掉线 > 在线）投影出 status，
    // 持久化状态由 30s 周期扫描和写入路径维护，但筛选/详情/样本查询看到的 status 必须一致：
    // 不能出现详情已离线而 offline 筛选为空。
    return { ...health.publicMachine(machine), status: health.effectiveStatus(machine, clock.now()) };
  }

  async function handle(req, res) {
    const { pathname, searchParams } = parseUrl(req);
    const db = await store.get();
    health.ensureHealth(db);

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
    }

    // ---------- 既有：曲目 / 区间 / 问题（回归保持） ----------

    if (req.method === "GET" && pathname === "/tunes") {
      const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
      return send(res, 200, { data: tunes });
    }

    if (req.method === "POST" && pathname === "/tunes") {
      const body = await parseBody(req);
      required(body, ["title", "stripSpec"]);
      const tune = await store.update((d) => {
        const item = {
          id: makeId("tune"),
          title: body.title,
          composer: body.composer || "",
          stripSpec: body.stripSpec,
          createdAt: new Date(clock.now()).toISOString()
        };
        d.tunes.push(item);
        return item;
      });
      return send(res, 201, { data: tune });
    }

    const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
    if (tuneSectionsMatch && req.method === "GET") {
      const tuneId = tuneSectionsMatch[1];
      findTune(db, tuneId);
      return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
    }

    if (tuneSectionsMatch && req.method === "POST") {
      const tuneId = tuneSectionsMatch[1];
      findTune(db, tuneId);
      const body = await parseBody(req);
      required(body, ["startBeat", "endBeat", "laneRange"]);
      const section = await store.update((d) => {
        const item = {
          id: makeId("section"),
          tuneId,
          startBeat: Number(body.startBeat),
          endBeat: Number(body.endBeat),
          laneRange: body.laneRange,
          checked: Boolean(body.checked),
          note: body.note || ""
        };
        d.sections.push(item);
        return item;
      });
      return send(res, 201, { data: section });
    }

    const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
    if (uncheckedMatch && req.method === "GET") {
      const tuneId = uncheckedMatch[1];
      findTune(db, tuneId);
      return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
    }

    const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
    if (progressMatch && req.method === "GET") {
      return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
    }

    const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
    if (checkMatch && req.method === "PATCH") {
      const existing = db.sections.find((item) => item.id === checkMatch[1]);
      if (!existing) return send(res, 404, { error: "区间不存在" });
      const body = await parseBody(req);
      const section = await store.update((d) => {
        const item = d.sections.find((s) => s.id === checkMatch[1]);
        item.checked = body.checked !== undefined ? Boolean(body.checked) : true;
        item.note = body.note ?? item.note;
        return item;
      });
      return send(res, 200, { data: section });
    }

    if (req.method === "GET" && pathname === "/issues") {
      const tuneId = searchParams.get("tuneId");
      const status = searchParams.get("status");
      const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
      return send(res, 200, { data: issues });
    }

    if (req.method === "POST" && pathname === "/issues") {
      const body = await parseBody(req);
      required(body, ["tuneId", "sectionId", "type", "description"]);
      const issue = await store.update((d) => {
        findTune(d, body.tuneId);
        const section = d.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
        if (!section) {
          const error = new Error("区间不存在或不属于该曲目");
          error.status = 400;
          throw error;
        }
        const item = {
          id: makeId("issue"),
          tuneId: body.tuneId,
          sectionId: body.sectionId,
          type: body.type,
          beat: body.beat === undefined ? null : Number(body.beat),
          lane: body.lane === undefined ? null : Number(body.lane),
          description: body.description,
          status: "open",
          createdAt: new Date(clock.now()).toISOString(),
          resolvedAt: null
        };
        d.issues.push(item);
        return item;
      });
      return send(res, 201, { data: issue });
    }

    const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
    if (issueStatusMatch && req.method === "PATCH") {
      const existing = db.issues.find((item) => item.id === issueStatusMatch[1]);
      if (!existing) return send(res, 404, { error: "问题不存在" });
      const body = await parseBody(req);
      required(body, ["status"]);
      const issue = await store.update((d) => {
        const item = d.issues.find((x) => x.id === issueStatusMatch[1]);
        item.status = body.status;
        item.resolvedAt = body.status === "resolved" ? new Date(clock.now()).toISOString() : null;
        item.note = body.note ?? item.note;
        return item;
      });
      return send(res, 200, { data: issue });
    }

    // ---------- 新增：冲孔机台健康监测 ----------

    if (req.method === "GET" && pathname === "/machines") {
      const status = searchParams.get("status");
      // 筛选用实时投影状态，与详情保持一致：超时后即使扫描还没跑，offline 筛选也能查到该机台
      let machines = db.machines;
      if (status) machines = machines.filter((m) => health.effectiveStatus(m, clock.now()) === status);
      return send(res, 200, { data: machines.map(machineView) });
    }

    if (req.method === "POST" && pathname === "/machines") {
      const body = await parseBody(req);
      const machine = await store.update((d) => health.registerMachine(d, body, clock));
      return send(res, 201, { data: machineView(machine) });
    }

    const machineMatch = pathname.match(/^\/machines\/([^/]+)$/);
    if (machineMatch && req.method === "GET") {
      const machine = health.getMachineOrFail(db, machineMatch[1]);
      return send(res, 200, { data: machineView(machine) });
    }

    const samplesMatch = pathname.match(/^\/machines\/([^/]+)\/samples$/);
    if (samplesMatch && req.method === "POST") {
      const body = await parseBody(req);
      const result = await store.update((d) => {
        // 路径机台编号是唯一归属；body 里带不同编号直接 400
        health.assertPathOwnsMachine(d, samplesMatch[1], body.machineId);
        body.machineId = samplesMatch[1];
        return health.ingestSamples(d, body, clock);
      });
      return send(res, 200, { data: result });
    }

    const maintenanceStartMatch = pathname.match(/^\/machines\/([^/]+)\/maintenance\/start$/);
    if (maintenanceStartMatch && req.method === "POST") {
      const body = await parseBody(req);
      const result = await store.update((d) => {
        health.assertPathOwnsMachine(d, maintenanceStartMatch[1], body.machineId);
        body.machineId = maintenanceStartMatch[1];
        return health.startMaintenance(d, body, clock);
      });
      return send(res, 200, { data: result });
    }

    const maintenanceEndMatch = pathname.match(/^\/machines\/([^/]+)\/maintenance\/end$/);
    if (maintenanceEndMatch && req.method === "POST") {
      const body = await parseBody(req);
      const result = await store.update((d) => {
        health.assertPathOwnsMachine(d, maintenanceEndMatch[1], body.machineId);
        body.machineId = maintenanceEndMatch[1];
        return health.endMaintenance(d, body, clock);
      });
      return send(res, 200, { data: result });
    }

    if (req.method === "GET" && pathname === "/samples") {
      const params = {
        machineId: searchParams.get("machineId") || undefined,
        fromTs: searchParams.get("from") || undefined,
        toTs: searchParams.get("to") || undefined
      };
      let list = health.querySamples(db, params);
      // 机台状态与机台详情/列表筛选同源（effectiveStatus），保证样本查询看到的状态一致
      const statusById = new Map(
        db.machines.map((m) => [m.id, health.effectiveStatus(m, clock.now())])
      );
      const machineById = new Map(db.machines.map((m) => [m.id, m]));
      list = list.map((s) => {
        const machine = machineById.get(s.machineId);
        return {
          ...s,
          machineStatus: statusById.get(s.machineId) ?? "offline",
          judged: machine ? health.publicSample(db, machine, s).judged : false
        };
      });
      return send(res, 200, { data: list });
    }

    if (req.method === "GET" && pathname === "/faults") {
      const list = health.queryFaults(db, {
        machineId: searchParams.get("machineId") || undefined,
        status: searchParams.get("status") || undefined,
        level: searchParams.get("level") || undefined,
        fromTs: searchParams.get("from") || undefined,
        toTs: searchParams.get("to") || undefined
      });
      return send(res, 200, { data: list });
    }

    const faultMatch = pathname.match(/^\/faults\/([^/]+)$/);
    if (faultMatch && req.method === "GET") {
      const fault = db.faults.find((f) => f.id === faultMatch[1]);
      if (!fault) return send(res, 404, { error: "故障不存在" });
      return send(res, 200, { data: health.faultWithMachine(db, fault) });
    }

    const faultConfirmMatch = pathname.match(/^\/faults\/([^/]+)\/confirm$/);
    if (faultConfirmMatch && req.method === "POST") {
      const body = await parseBody(req);
      const fault = await store.update((d) => health.confirmFault(d, faultConfirmMatch[1], body, clock));
      return send(res, 200, { data: fault });
    }

    const faultCloseMatch = pathname.match(/^\/faults\/([^/]+)\/close$/);
    if (faultCloseMatch && req.method === "POST") {
      const body = await parseBody(req);
      const fault = await store.update((d) => health.closeFault(d, faultCloseMatch[1], body, clock));
      return send(res, 200, { data: fault });
    }

    if (req.method === "POST" && pathname === "/admin/sweep") {
      const result = await sweepNow();
      return send(res, 200, { data: result, now: clock.now() });
    }

    return send(res, 404, { error: "接口不存在", routes });
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((error) =>
      send(res, error.status || 500, { error: error.message || "服务器错误" })
    );
  });

  const service = {
    store,
    clock,
    init,
    handle,
    sweepNow,
    listen(port = PORT) {
      return init.then(
        () =>
          new Promise((resolve) => {
            server.listen(port, () => {
              if (sweepIntervalMs > 0) {
                sweepTimer = setInterval(() => {
                  sweepNow().catch(() => {});
                }, sweepIntervalMs);
                sweepTimer.unref();
              }
              resolve(server);
            });
          })
      );
    },
    close() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      return new Promise((resolve) => server.close(resolve));
    },
    port() {
      const addr = server.address();
      return addr ? addr.port : null;
    }
  };
  return service;
}

if (require.main === module) {
  const service = createService();
  service
    .listen(PORT)
    .then(() => {
      console.log(`Organ strip punch API running at http://127.0.0.1:${service.port()}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { createService, routes, send, parseBody };
