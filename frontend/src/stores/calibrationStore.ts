/**
 * 检定线 store：维护检定室的流速仪检定线台账，以及换新 / 撤销后的测点挂起与巡测组重算。
 * 检定室只管线（记检定号、生效起止、系数）；线变动后用过它的测点挂起，
 * 由巡测组本侧重算恢复，检定室那份记录不动。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { CalibrationLine, CalibrationStatus } from '@/types/calibration'
import { findEffectiveLine } from '@/types/calibration'
import type { Point, PointStatus } from '@/types/point'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import {
  attributePoints,
  recalcSuspendedPoints,
  buildSectionRecon,
  type SectionReconRow
} from '@/utils/calibration'

export const useCalibrationStore = defineStore('calibration', () => {
  const lines = ref<CalibrationLine[]>([])
  const sections = ref<Section[]>([])
  const verticals = ref<Vertical[]>([])
  const points = ref<Point[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<CalibrationLine>(() => db.calibrations).subscribe((rows) => {
      lines.value = rows
      ready.value = true
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
    watchTable<Vertical>(() => db.verticals).subscribe((rows) => {
      verticals.value = rows
    })
    watchTable<Point>(() => db.points).subscribe((rows) => {
      points.value = rows
    })
  }

  /** 全部流速仪编号（去重、排序） */
  const meters = computed<string[]>(() =>
    Array.from(new Set(lines.value.map((line) => line.meterNo).filter((no) => no.length > 0))).sort()
  )

  /** 挂起测点：无有效线或线已撤销，不参与断面流量 */
  const suspendedPoints = computed<Point[]>(() =>
    points.value.filter((point) => point.status === 'suspended')
  )

  /** 挂起测点数（导航徽标用） */
  const suspendedCount = computed<number>(() => suspendedPoints.value.length)

  /** 某流速仪的全部检定线（按生效起始倒序） */
  function linesOfMeter(meterNo: string | null | undefined): CalibrationLine[] {
    if (!meterNo) return []
    return lines.value
      .filter((line) => line.meterNo === meterNo)
      .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())
  }

  /** 某仪号在某施测日生效的检定线 */
  function effectiveLine(meterNo: string | null | undefined, measuredAt: string): CalibrationLine | null {
    return findEffectiveLine(lines.value, meterNo, measuredAt)
  }

  function lineById(id: string | null | undefined): CalibrationLine | null {
    if (!id) return null
    return lines.value.find((line) => line.id === id) ?? null
  }

  /** 按测次对账：每个流速仪测次的生效线与挂起情况 */
  const reconRows = computed<SectionReconRow[]>(() =>
    buildSectionRecon(sections.value, verticals.value, points.value, lines.value)
  )

  /* ------------------------------- 检定线台账 ------------------------------- */

  async function createLine(
    payload: Omit<CalibrationLine, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
      status?: CalibrationStatus
    }
  ): Promise<CalibrationLine> {
    const now = Date.now()
    const row: CalibrationLine = {
      ...payload,
      id: createId('cal'),
      status: payload.status ?? 'active',
      createdAt: now,
      updatedAt: now
    }
    await db.calibrations.put(row)
    return row
  }

  async function updateLine(id: string, patch: Partial<CalibrationLine>): Promise<void> {
    await db.calibrations.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeLine(id: string): Promise<void> {
    await db.calibrations.delete(id)
  }

  /**
   * 换新：以一条新线替代旧线。
   * 旧线置「已换新」并把生效截止落到新线生效前一日；
   * 用过旧线的测点先挂起，由巡测组重算（检定室记录不动）。
   */
  async function replaceLine(
    oldId: string,
    newLine: Omit<CalibrationLine, 'id' | 'createdAt' | 'updatedAt' | 'status'>
  ): Promise<{ suspendedCount: number }> {
    const old = lineById(oldId)
    if (!old) return { suspendedCount: 0 }
    const now = Date.now()
    const newRow: CalibrationLine = {
      ...newLine,
      id: createId('cal'),
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
    const oldEffectiveTo = new Date(newLine.effectiveFrom)
    oldEffectiveTo.setDate(oldEffectiveTo.getDate() - 1)
    const affected = points.value.filter((point) => point.calibrationId === oldId)
    await db.transaction('rw', [db.calibrations, db.points], async () => {
      await db.calibrations.put(newRow)
      await db.calibrations.update(oldId, {
        status: 'replaced',
        effectiveTo: oldEffectiveTo.toISOString().slice(0, 10),
        updatedAt: now
      } as never)
      if (affected.length > 0) {
        await db.points.bulkPut(
          affected.map((point) => ({ ...point, status: 'suspended' as PointStatus, updatedAt: now }))
        )
      }
    })
    return { suspendedCount: affected.length }
  }

  /**
   * 撤销：把线置「已撤销」；用过它的测点挂起，由巡测组重算。
   */
  async function revokeLine(id: string): Promise<{ suspendedCount: number }> {
    const line = lineById(id)
    if (!line) return { suspendedCount: 0 }
    const now = Date.now()
    const affected = points.value.filter((point) => point.calibrationId === id)
    await db.transaction('rw', [db.calibrations, db.points], async () => {
      await db.calibrations.update(id, { status: 'revoked', updatedAt: now } as never)
      if (affected.length > 0) {
        await db.points.bulkPut(
          affected.map((point) => ({ ...point, status: 'suspended' as PointStatus, updatedAt: now }))
        )
      }
    })
    return { suspendedCount: affected.length }
  }

  /* ------------------------------- 巡测组重算 ------------------------------- */

  /**
   * 重算全部挂起测点：按测次「仪号 + 施测日」重新找生效线，
   * 有转数的按线系数换算流速，恢复正常；对不上的保持挂起。
   * 检定室的线记录不在此改动。
   */
  async function recalculateAll(): Promise<{ reactivated: number; stillSuspended: number; recomputed: number }> {
    const result = recalcSuspendedPoints(points.value, verticals.value, sections.value, lines.value)
    // 只写回「原挂起 → 现正常」的测点，避免扰动已正常的点
    const suspendedIds = new Set(points.value.filter((point) => point.status === 'suspended').map((point) => point.id))
    const changed = result.points.filter((point) => point.status === 'active' && suspendedIds.has(point.id))
    if (changed.length > 0) {
      await db.transaction('rw', [db.points], async () => {
        await db.points.bulkPut(changed)
      })
    }
    return {
      reactivated: result.reactivated,
      stillSuspended: result.stillSuspended,
      recomputed: result.recomputed
    }
  }

  /**
   * 重新回填全部测点归属（测次补选仪号后使用）：
   * 按测次时间重新找生效线，命中且有转数的换算流速，对不上的挂起。
   */
  async function backfillAll(): Promise<{ matched: number; unmatched: number }> {
    const result = attributePoints(points.value, verticals.value, sections.value, lines.value)
    await db.transaction('rw', [db.points], async () => {
      await db.points.bulkPut(result.points)
    })
    return { matched: result.matched, unmatched: result.unmatched }
  }

  return {
    lines,
    sections,
    verticals,
    points,
    ready,
    meters,
    suspendedPoints,
    suspendedCount,
    reconRows,
    start,
    linesOfMeter,
    effectiveLine,
    lineById,
    createLine,
    updateLine,
    removeLine,
    replaceLine,
    revokeLine,
    recalculateAll,
    backfillAll
  }
})
