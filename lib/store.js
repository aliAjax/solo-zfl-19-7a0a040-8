"use strict";

// 原子 JSON 存储：
// - 进程内互斥：所有更新串行化，杜绝并发读-改-写丢失（并发测试要求）
// - 落盘原子性：写临时文件 -> fsync -> rename，rename 在同一文件系统上是原子的，
//   写入失败不会在 db.json 上留下半个事件
// - mutate 失败时回滚内存缓存，保证进程内状态与磁盘一致（重启一致性要求）
const { readFile, writeFile, rename, open, rm, mkdir } = require("fs/promises");
const { existsSync } = require("fs");
const path = require("path");

class JsonStore {
  constructor(file, createDefault, options = {}) {
    this.file = file;
    this.createDefault = createDefault;
    // 注入点：rename 前回调，测试可在此抛错模拟“写入失败”
    this.beforeRename = options.beforeRename || null;
    this.cache = null;
    this.chain = Promise.resolve();
  }

  async load() {
    if (this.cache) return this.cache;
    await mkdir(path.dirname(this.file), { recursive: true });
    let data;
    try {
      data = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      data = this.createDefault();
      await this.#persist(data);
    }
    this.cache = data;
    return data;
  }

  async get() {
    return this.load();
  }

  // mutate 必须是同步函数，返回值作为 update 的结果。
  update(mutate) {
    const run = this.chain.then(async () => {
      const data = await this.load();
      const snapshot = structuredClone(data);
      let result;
      try {
        result = mutate(data);
      } catch (error) {
        // 领域校验失败：内存回滚，不落盘
        this.cache = snapshot;
        throw error;
      }
      try {
        await this.#persist(data);
      } catch (error) {
        // 磁盘写入失败：内存同样回滚，绝不允许缓存领先于磁盘
        this.cache = snapshot;
        throw error;
      }
      return result;
    });
    // 互斥链不被单个失败打断
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #persist(data) {
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    let handle;
    try {
      handle = await open(tmp, "wx");
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      // 尽量 fsync 内容；某些文件系统不支持，失败不影响 rename 的原子性
      try {
        await handle.sync();
      } catch {
        /* ignore */
      }
      await handle.close();
      handle = null;
      if (this.beforeRename) await this.beforeRename(tmp, data);
      await rename(tmp, this.file);
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      if (existsSync(tmp)) {
        await rm(tmp, { force: true });
      }
      throw error;
    }
  }
}

module.exports = { JsonStore };
