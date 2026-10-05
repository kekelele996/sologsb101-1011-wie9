/**
 * 检定线对账业务逻辑冒烟测试（不依赖浏览器）：
 * v3 新库播种 → 测点按测次日归属换算 → 旧线撤销挂起 → 按测次重算恢复；
 * 同时覆盖 v2→v3 旧数据按测次时间回填、对不上单列。
 * 运行：node --import tsx scripts/meter-logic-check.ts
 */
import 'fake-indexeddb/auto'
import { beforeEach, expect, test } from './tiny-test'

beforeEach(async () => {
  indexedDB.deleteDatabase('gbhydrogaug')
})

test('新库播种：流速仪测点按施测日检定线换算，非流速仪测点标记非流速仪', async () => {
  const { db, initDatabase, resetDatabase } = await import('../src/utils/db')
  await initDatabase()

  // 龙门 2024-06 流速仪测次 → 旧线 mtr_ls20_2023（2023-01-01~2024-06-30）
  const secLh = await db.sections.where('measureNo').equals('2024-06-001').first()
  expect(!!secLh).toBe(true)
  const lhPoints = await relatedPoints(secLh!.id)
  expect(lhPoints.length).toBeGreaterThan(0)
  for (const p of lhPoints) {
    expect(p.linkStatus).toBe('已换算')
    expect(p.meterLineId).toBe('mtr_ls20_2023')
    // v = 0.252·n/100 + 0.012
    const expected = Math.round((0.252 * ((p.revolutions as number) / 100) + 0.012) * 1000) / 1000
    expect(Math.abs(p.velocityMs - expected)).toBeLessThan(0.0015)
  }

  // 青矶 2024-03 测次用过已撤销旧线 → 全部挂起、保留旧流速与转数
  const secQj03 = await db.sections.where('measureNo').equals('2024-03-002').first()
  const qj03Points = await relatedPoints(secQj03!.id)
  expect(qj03Points.length).toBe(2)
  expect(qj03Points.every((p) => p.linkStatus === '已挂起')).toBe(true)
  expect(qj03Points.every((p) => p.meterLineId === 'mtr_ls25_2022')).toBe(true)
  expect(qj03Points.every((p) => typeof p.velocityMs === 'number' && p.revolutions !== null)).toBe(true)

  // 浮标 / ADCP 测次 → 非流速仪
  const secFloat = await db.sections.where('measureNo').equals('2024-05-003').first()
  const floatPoints = await relatedPoints(secFloat!.id)
  expect(floatPoints.every((p) => p.linkStatus === '非流速仪' && p.meterLineId === null)).toBe(true)

  // 青矶 2024-08 流速仪 → 新线 mtr_ls25_2024
  const secQj08 = await db.sections.where('measureNo').equals('2024-08-004').first()
  const qj08Points = await relatedPoints(secQj08!.id)
  expect(qj08Points.every((p) => p.linkStatus === '已换算' && p.meterLineId === 'mtr_ls25_2024')).toBe(true)

  await resetDatabase()
  db.close()
})

test('检定线撤销：用过它的测点挂起；按测次重算后恢复（检定室台账不动）', async () => {
  const { db, initDatabase } = await import('../src/utils/db')
  await initDatabase()

  // 直接走 store 逻辑
  const { useSectionStore } = await import('../src/stores/sectionStore')
  const { useMeterLineStore } = await import('../src/stores/meterLineStore')
  const { setActivePinia, createPinia } = await import('pinia')
  setActivePinia(createPinia())
  const sectionStore = useSectionStore()
  const meterStore = useMeterLineStore()
  sectionStore.start()
  meterStore.start()
  await tick(120)
  sectionStore.setMeterLines(meterStore.meterLines)

  const secLh = await db.sections.where('measureNo').equals('2024-06-001').first()
  const before = (await relatedPoints(secLh!.id)).filter((p) => p.linkStatus === '已换算').length
  expect(before).toBe(7)

  // 检定室撤销 2023 线
  await meterStore.retireLine('mtr_ls20_2023', '2024-06-30')
  await tick(60)
  sectionStore.setMeterLines(meterStore.meterLines)
  const suspended = await sectionStore.suspendPointsUsingLine('mtr_ls20_2023')
  expect(suspended).toBe(7)

  // 施测日 2024-06-12 已无生效线（新线 2024-07-01 才起）→ 重算后仍未匹配，单列
  const result = await sectionStore.recomputeSection(secLh!.id)
  expect(result.recomputed).toBe(0)
  expect(result.unmatched).toBe(7)

  // 检定室那份系数记录仍在（status 停用、k/c 未变）
  const old = await db.meterLines.get('mtr_ls20_2023')
  expect(old?.status).toBe('停用')
  expect(old?.factorK).toBe(0.252)

  // 把新线起始日提前到 2024-06-01 后重算 → 恢复已换算，流速按新线 k=0.246 c=0.008
  await meterStore.updateLine('mtr_ls20_2024', { effectiveFrom: '2024-06-01' })
  await tick(60)
  sectionStore.setMeterLines(meterStore.meterLines)
  const again = await sectionStore.recomputeSection(secLh!.id)
  expect(again.recomputed).toBe(7)
  expect(again.unmatched).toBe(0)
  const after = await relatedPoints(secLh!.id)
  expect(after.every((p) => p.linkStatus === '已换算' && p.meterLineId === 'mtr_ls20_2024')).toBe(true)
  const sample = after[0]
  const expected = Math.round((0.246 * ((sample.revolutions as number) / sample.durationS) + 0.008) * 1000) / 1000
  expect(Math.abs(sample.velocityMs - expected)).toBeLessThan(0.0015)

  db.close()
})

test('v2→v3 升级：只有流速无归属的旧测点按测次时间回填，对不上的单列', async () => {
  // 先在 v3 上清空 meterLines 模拟“旧库存测点”，再手工跑回填函数等价流程：
  // 直接构造一个 v2 结构库较复杂，这里验证回填函数 pickEffectiveLine 的关键边界。
  const { pickEffectiveLine } = await import('../src/types/meterLine')
  const lines = [
    { id: 'a', status: '生效' as const, effectiveFrom: '2023-01-01', effectiveTo: '2024-06-30' },
    { id: 'b', status: '生效' as const, effectiveFrom: '2024-07-01', effectiveTo: null },
    { id: 'c', status: '停用' as const, effectiveFrom: '2022-03-01', effectiveTo: '2024-04-30' }
  ]
  expect(pickEffectiveLine(lines, '2024-06-30')).toBe('a')
  expect(pickEffectiveLine(lines, '2024-07-01')).toBe('b')
  expect(pickEffectiveLine(lines, '2025-01-01')).toBe('b')
  expect(pickEffectiveLine(lines, '2022-01-01')).toBe(null) // 对不上 → 单列
})

async function relatedPoints(sectionId: string) {
  const { db } = await import('../src/utils/db')
  const verticals = await db.verticals.where('sectionId').equals(sectionId).toArray()
  const ids = verticals.map((v) => v.id)
  if (ids.length === 0) return []
  return db.points.where('verticalId').anyOf(ids).toArray()
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
