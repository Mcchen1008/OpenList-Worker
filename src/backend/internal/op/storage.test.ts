import assert from "node:assert/strict"
import { test } from "node:test"

import type { StorageDriver } from "../driver/base"
import { getDb, saveDb } from "../model/db"
import {
  getItem,
  getDriver,
  getOrCreateDriver,
  scheduleStoragePersistence,
} from "./storage"

test("concurrent driver initialization shares one Promise", async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const driver = {} as StorageDriver
  const cache = new Map<string, Promise<StorageDriver>>()

  const factory = async () => {
    calls++
    await gate
    return driver
  }

  const first = getOrCreateDriver(cache, "189-1", factory)
  const second = getOrCreateDriver(cache, "189-1", factory)
  release()

  assert.equal(await first, driver)
  assert.equal(await second, driver)
  assert.equal(calls, 1)
})

test("Worker persistence is scheduled instead of awaited", async () => {
  let resolvePersistence!: () => void
  const persistence = new Promise<void>(
    (resolve) => (resolvePersistence = resolve),
  )
  let scheduled: Promise<unknown> | undefined

  await scheduleStoragePersistence((task) => {
    scheduled = task
  }, persistence)

  assert.equal(scheduled, persistence)
  resolvePersistence()
  await scheduled
})

test("Node persistence is awaited without waitUntil", async () => {
  let completed = false
  const persistence = Promise.resolve().then(() => {
    completed = true
  })

  await scheduleStoragePersistence(undefined, persistence)
  assert.equal(completed, true)
})

test("mounted storage roots return without initializing the remote driver", async () => {
  // 通过公开 API 写入内存库（无持久化后端时 getDb 使用模块级 memoryDb）
  const db: any = await getDb()
  db.storages = [
    {
      id: "storage-root-fast-path",
      driver: "189Cloud",
      mount_path: "/189",
      addition: JSON.stringify({ root_folder_id: "-11" }),
      modified: "2026-08-23T00:00:00.000Z",
      disabled: false,
    },
  ]
  await saveDb(db)

  const result = await getItem("/189")
  assert.equal(result.provider, "189Cloud")
  assert.equal(result.item.name, "189")
  assert.equal(result.item.is_dir, true)
  assert.equal(result.item.sign, "-11")
})

test("115Open routes to the ported Pan115Driver with correct Open API endpoints (issue #128)", async () => {
  // 回归背景：createDriver 分发链曾存在两个都匹配 "115open" 的分支，
  // 靠前的残缺 Driver115 抢先命中，导致报 "[115] API error ()" 且真实
  // code/message 被丢弃。修复后 115Open 必须路由到 Pan115Driver，
  // 并且只请求正确的 115 Open API 端点。
  const db: any = await getDb()
  db.storages = [
    {
      id: "storage-115open-routing",
      driver: "115Open",
      mount_path: "/115",
      addition: JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        root_id: "0",
      }),
      modified: "2026-10-23T00:00:00.000Z",
      disabled: false,
    },
  ]
  await saveDb(db)

  const realFetch = globalThis.fetch
  const urls: string[] = []
  ;(globalThis as any).fetch = async (input: any) => {
    const url = String(typeof input === "object" ? input.url : input)
    urls.push(url)
    const body = url.includes("/open/user/info")
      ? { state: true, data: { user_id: 1, user_name: "tester" } }
      : { state: true, data: [], count: 0 }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    const driver = await getDriver("115Open", db.storages[0])

    // 必须实例化正确移植的 Pan115Driver（而不是已删除的旧 Driver115）
    const { Pan115Driver } = await import("../../drivers/115open/driver")
    assert.ok(driver instanceof Pan115Driver)

    // init 校验必须请求正确的 Open API user/info 端点
    assert.ok(
      urls.some((u) => u.startsWith("https://proapi.115.com/open/user/info")),
      `init 应请求 proapi.115.com/open/user/info，实际请求: ${urls.join(", ")}`,
    )
    // 旧实现的错误端点 / 双重 /open 前缀不允许再出现
    assert.ok(
      !urls.some((u) => u.includes("passportapi.115.com/user/info")),
      "不允许请求旧实现错误端点 passportapi.115.com/user/info",
    )
    assert.ok(
      !urls.some((u) => u.includes("/open/open/")),
      "不允许出现双重 /open 前缀的端点",
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test("115Share driver name is not swallowed by the 115open routing branch", async () => {
  // 回归背景：Pan115Driver 分支曾用 startsWith("115") 兜底，
  // 把 115share 也吞掉，导致后面 115_share 分支永远不可达。
  const db: any = await getDb()
  db.storages = [
    {
      id: "storage-115share-routing",
      driver: "115Share",
      mount_path: "/115share",
      addition: JSON.stringify({
        share_code: "testsc",
        receive_code: "testrc",
      }),
      modified: "2026-10-23T00:00:00.000Z",
      disabled: false,
    },
  ]
  await saveDb(db)

  const driver = await getDriver("115Share", db.storages[0])

  const { Pan115ShareDriver } = await import("../../drivers/115_share/driver")
  assert.ok(driver instanceof Pan115ShareDriver)
})
