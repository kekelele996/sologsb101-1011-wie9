/**
 * 检定室 store：维护流速仪检定线台账（检定号、生效起止、系数 k/c）。
 * 本侧只负责台账增删改与换新 / 撤销；历史测点的挂起与重算由巡测组（sectionStore）负责，
 * 检定室这份系数记录不改写、不删除历史换算值。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { MeterLine, MeterLineStatus } from '@/types/meterLine'
import { isLineEffectiveOn, pickEffectiveLine } from '@/types/meterLine'

/** 检定线录入草稿 */
export interface MeterLineDraft {
  certNo: string
  meterNo: string
  effectiveFrom: string
  effectiveTo: string | null
  factorK: number
  factorC: number
  labName: string
  status: MeterLineStatus
  remark: string
}

export function createEmptyMeterLineDraft(): MeterLineDraft {
  return {
    certNo: '',
    meterNo: '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveTo: null,
    factorK: 0.25,
    factorC: 0.01,
    labName: '',
    status: '生效',
    remark: ''
  }
}

export const useMeterLineStore = defineStore('meterLine', () => {
  const meterLines = ref<MeterLine[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<MeterLine>(() => db.meterLines).subscribe((rows) => {
      meterLines.value = rows
      ready.value = true
    })
  }

  const sortedLines = computed<MeterLine[]>(() =>
    [...meterLines.value].sort((a, b) =>
      a.meterNo === b.meterNo ? b.effectiveFrom.localeCompare(a.effectiveFrom) : a.meterNo.localeCompare(b.meterNo)
    )
  )

  const lineById = (id: string | null | undefined): MeterLine | null =>
    id ? meterLines.value.find((line) => line.id === id) ?? null : null

  /** 施测日当天生效（状态为生效且落在生效区间）的检定线，按仪器编号过滤；多条取最近检定 */
  function lineForDay(measuredDay: string, meterNo?: string | null): MeterLine | null {
    const id = pickEffectiveLine(meterLines.value, measuredDay, meterNo)
    return id ? lineById(id) : null
  }

  /** 同仪器、生效区间与目标区间重叠的其他检定线（防同一架仪器两线同时生效） */
  function findOverlapConflicts(draft: MeterLineDraft, excludeId?: string): MeterLine[] {
    if (!draft.effectiveFrom) return []
    const to = draft.effectiveTo ?? '9999-12-31'
    return meterLines.value.filter((line) => {
      if (line.id === excludeId) return false
      if (line.status !== '生效' || line.meterNo !== draft.meterNo) return false
      const lineTo = line.effectiveTo ?? '9999-12-31'
      return lineTo >= draft.effectiveFrom && line.effectiveFrom <= to
    })
  }

  /** 用过某检定线的测点被挂起后，检定线本身不动，仅在此给出台账视角的提示 */
  function isUsableNow(line: MeterLine, day: string): boolean {
    return line.status === '生效' && isLineEffectiveOn(line, day)
  }

  async function createLine(payload: MeterLineDraft): Promise<MeterLine> {
    const now = Date.now()
    const row: MeterLine = { ...payload, id: createId('mtr'), createdAt: now, updatedAt: now }
    await db.meterLines.put(row)
    return row
  }

  async function updateLine(id: string, patch: Partial<MeterLine>): Promise<void> {
    await db.meterLines.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /**
   * 检定线换新或撤销：检定室只把旧线置为停用并截到撤销日。
   * 用过它的测点由巡测组侧挂起 / 重算，本台账的历史系数记录保持不动。
   */
  async function retireLine(id: string, retiredAt: string, remark?: string): Promise<void> {
    await db.meterLines.update(id, {
      status: '停用',
      effectiveTo: retiredAt,
      ...(remark !== undefined ? { remark } : {}),
      updatedAt: Date.now()
    } as never)
  }

  /**
   * 登记新检定线：同仪器若有仍在生效的旧线，自动把旧线截至新线生效前一天并停用，
   * 然后挂起用过旧线的测点（由调用方传入挂起回调，避免检定室直接改巡测数据）。
   */
  async function createReplacement(
    payload: MeterLineDraft,
    onRetire?: (oldLine: MeterLine) => Promise<void> | void
  ): Promise<MeterLine> {
    const created = await createLine(payload)
    if (payload.status === '生效') {
      const previous = meterLines.value.filter(
        (line) =>
          line.id !== created.id &&
          line.meterNo === payload.meterNo &&
          line.status === '生效' &&
          line.effectiveFrom < payload.effectiveFrom &&
          (line.effectiveTo === null || line.effectiveTo >= payload.effectiveFrom)
      )
      for (const oldLine of previous) {
        await retireLine(oldLine.id, payload.effectiveFrom, `已由检定号 ${payload.certNo} 于 ${payload.effectiveFrom} 换新`)
        if (onRetire) await onRetire(oldLine)
      }
    }
    return created
  }

  return {
    meterLines,
    sortedLines,
    ready,
    start,
    lineById,
    lineForDay,
    findOverlapConflicts,
    isUsableNow,
    createLine,
    updateLine,
    retireLine,
    createReplacement
  }
})
