/** 极简测试框架（零依赖）：供 scripts/ 下的业务逻辑冒烟测试使用 */
type TestFn = () => Promise<void> | void
const queue: Array<{ name: string; fn: TestFn }> = []
const hooks: TestFn[] = []

export function test(name: string, fn: TestFn): void {
  queue.push({ name, fn })
}
export function beforeEach(fn: TestFn): void {
  hooks.push(fn)
}

class AssertionError extends Error {}

export function expect<T>(actual: T) {
  return {
    toBe(expected: unknown): void {
      if (actual !== expected) throw new AssertionError(`期望 ${String(expected)}，实际 ${String(actual)}`)
    },
    toBeGreaterThan(n: number): void {
      if (!(Number(actual) > n)) throw new AssertionError(`期望 > ${n}，实际 ${String(actual)}`)
    },
    toBeLessThan(n: number): void {
      if (!(Number(actual) < n)) throw new AssertionError(`期望 < ${n}，实际 ${String(actual)}`)
    }
  }
}

void (async () => {
  // 等调用方模块完成 test() 注册（顶层导入阶段结束后再跑）
  await new Promise((resolve) => setTimeout(resolve, 0))
  let passed = 0
  for (const item of queue) {
    for (const hook of hooks) await hook()
    try {
      await item.fn()
      passed += 1
      console.log(`✓ ${item.name}`)
    } catch (err) {
      console.error(`✗ ${item.name}`)
      console.error(err instanceof Error ? err.stack : err)
      process.exitCode = 1
    }
  }
  console.log(`\n${passed}/${queue.length} 通过`)
})()
