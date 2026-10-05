/**
 * 断面 store：维护断面测次、垂线集合、测点缓存与录入草稿。
 * 巡测组侧：管测次、转数与测点；测点检定线归属、挂起与重算也在本侧完成，
 * 检定室检定线台账（meterLineStore）换新 / 撤销不影响这里的历史换算值。
 * 垂线排序按起点距升序，页面展示与流量计算共用同一顺序。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Section } from '@/types/section'
import { createEmptySectionFilter, type SectionFilterState } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import { buildRelativeDepths } from '@/types/vertical'
import type { Point, PointLinkStatus } from '@/types/point'
import { isSuspendedStatus } from '@/types/point'
import type { MeterLine } from '@/types/meterLine'
import { isLineEffectiveOn, pickEffectiveLine } from '@/types/meterLine'
import { velocityByMeterLine } from '@/utils/flow'

/** 垂线录入草稿（新增/编辑表单共享结构） */
export interface VerticalDraft {
  no: number
  startDistanceM: number
  depthM: number
  bedNote: string
  /** 测点数：录入测深后按相对水深自动生成测点行 */
  pointCount: number
}

/** 测点录入草稿 */
export interface PointDraft {
  relativeDepth: number
  velocityMs: number
  weight: number
  durationS: number
  /** 流速仪法的总转数；浮标 / ADCP 为 null */
  revolutions: number | null
  /** 归属检定线 id */
  meterLineId: string | null
  /** 对账状态 */
  linkStatus: PointLinkStatus | null
}

export function createEmptyVerticalDraft(nextNo = 1): VerticalDraft {
  return { no: nextNo, startDistanceM: 0, depthM: 1, bedNote: '', pointCount: 2 }
}

export function createEmptyPointDraft(): PointDraft {
  return { relativeDepth: 0.6, velocityMs: 0.5, weight: 1, durationS: 100, revolutions: null, meterLineId: null, linkStatus: null }
}

/** 测点重算时从外部（对账页）传入的检定线上下文，避免 store 间循环依赖 */
export interface RecomputeContext {
  meterLines: MeterLine[]
}

export const useSectionStore = defineStore('section', () => {
  const sections = ref<Section[]>([])
  const verticals = ref<Vertical[]>([])
  const points = ref<Point[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentSectionId = ref<string | null>(null)
  const currentVerticalId = ref<string | null>(null)
  const filter = ref<SectionFilterState>(createEmptySectionFilter())
  const verticalDraft = ref<VerticalDraft>(createEmptyVerticalDraft())
  const pointDraft = ref<PointDraft>(createEmptyPointDraft())
  /** 批量粘贴文本（跨页面保留录入草稿） */
  const pasteText = ref<string>('')

  /**
   * 检定线台账快照：由 meterLineStore 启动时通过 setMeterLines 注入，
   * 避免巡测 store 反向依赖检定室 store；对账动作一律以最新快照为准。
   */
  const meterLinesRef = ref<MeterLine[]>([])

  function setMeterLines(lines: MeterLine[]): void {
    meterLinesRef.value = lines
  }

  function sectionOfVertical(verticalId: string): Section | null {
    const vertical = verticals.value.find((item) => item.id === verticalId)
    return vertical ? sections.value.find((item) => item.id === vertical.sectionId) ?? null : null
  }

  /** 非流速仪测点的固定归属字段 */
  function nonMeterFields(): Pick<Point, 'revolutions' | 'meterLineId' | 'linkStatus'> {
    return { revolutions: null, meterLineId: null, linkStatus: '非流速仪' }
  }

  /**
   * 新建测点行的默认归属：
   * - 非流速仪测次 → 非流速仪；
   * - 流速仪测次 → 按施测日取当天生效检定线；对不上单列「未匹配」。
   */
  function resolveFreshPointFields(
    section: Section | null | undefined,
    forcedLineId: string | null
  ): Pick<Point, 'revolutions' | 'meterLineId' | 'linkStatus'> {
    if (!section || section.method !== '流速仪') return nonMeterFields()
    const lineId = forcedLineId ?? pickEffectiveLine(meterLinesRef.value, section.measuredAt, section.meterNo)
    return {
      revolutions: null,
      meterLineId: lineId,
      linkStatus: lineId ? '已换算' : '未匹配'
    }
  }

  /** 判定某测点归属检定线在施测日的对账状态 */
  function statusFor(section: Section | null, lineId: string | null): PointLinkStatus {
    if (!section || section.method !== '流速仪') return '非流速仪'
    if (!lineId) return '未匹配'
    const line = meterLinesRef.value.find((item) => item.id === lineId)
    if (!line) return '未匹配'
    return line.status === '生效' && isLineEffectiveOn(line, section.measuredAt) ? '已换算' : '已挂起'
  }

  /** 单测点重算：按归属检定线系数与转数换算流速，刷新对账状态（检定室台账不动） */
  function computeVelocity(point: Point, line: MeterLine | null): number {
    if (point.revolutions === null || !line) return point.velocityMs
    return velocityByMeterLine(point.revolutions, point.durationS, line.factorK, line.factorC)
  }

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Vertical>(() => db.verticals).subscribe((rows) => {
      verticals.value = rows
    })
    watchTable<Point>(() => db.points).subscribe((rows) => {
      points.value = rows
    })
  }

  /** 某测站下的断面测次（按测流时间倒序） */
  function sectionsOfStation(stationId: string | null | undefined): Section[] {
    if (!stationId) return []
    return sections.value
      .filter((section) => section.stationId === stationId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  }

  /** 按筛选条件过滤某测站的断面 */
  const filteredSections = computed<Section[]>(() =>
    sections.value
      .filter((section) => {
        if (currentSectionId.value && section.id === currentSectionId.value) return true
        const keyword = filter.value.keyword.trim()
        if (keyword.length > 0) {
          const haystack = `${section.measureNo}${section.method}`
          if (!haystack.includes(keyword)) return false
        }
        if (filter.value.methods.length > 0 && !filter.value.methods.includes(section.method)) return false
        if (filter.value.minStageM !== null && section.stageM < filter.value.minStageM) return false
        return true
      })
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  const sectionById = (id: string | null | undefined): Section | null =>
    id ? sections.value.find((section) => section.id === id) ?? null : null

  /** 某断面下的垂线：按起点距升序（起点距排序校验的基础） */
  function verticalsOfSection(sectionId: string | null | undefined): Vertical[] {
    if (!sectionId) return []
    return verticals.value
      .filter((vertical) => vertical.sectionId === sectionId)
      .sort((a, b) => a.startDistanceM - b.startDistanceM)
  }

  const currentVertical = computed<Vertical | null>(() =>
    currentVerticalId.value
      ? verticals.value.find((vertical) => vertical.id === currentVerticalId.value) ?? null
      : null
  )

  /** 某垂线下的测点：按相对水深升序 */
  function pointsOfVertical(verticalId: string | null | undefined): Point[] {
    if (!verticalId) return []
    return points.value
      .filter((point) => point.verticalId === verticalId)
      .sort((a, b) => a.relativeDepth - b.relativeDepth)
  }

  /** 参与垂线平均流速 / 断面流量的测点：挂起与未匹配测点排除在外 */
  function participatingPointsOfVertical(verticalId: string | null | undefined): Point[] {
    return pointsOfVertical(verticalId).filter((point) => !isSuspendedStatus(point.linkStatus))
  }

  /** 某测次下的全部测点（巡测组按测次与检定线对账的单位） */
  function pointsOfSection(sectionId: string | null | undefined): Point[] {
    if (!sectionId) return []
    const verticalIds = new Set(
      verticals.value.filter((vertical) => vertical.sectionId === sectionId).map((vertical) => vertical.id)
    )
    return points.value.filter((point) => verticalIds.has(point.verticalId))
  }

  /** 垂线 id → 测点数与最深水深，供断面列表与垂线页回显 */
  const verticalStats = computed<Record<string, { pointCount: number; depthM: number }>>(() => {
    const stats: Record<string, { pointCount: number; depthM: number }> = {}
    verticals.value.forEach((vertical) => {
      stats[vertical.id] = { pointCount: vertical.pointCount, depthM: vertical.depthM }
    })
    return stats
  })

  /** 断面 id → 垂线条数汇总 */
  const sectionVerticalCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    verticals.value.forEach((vertical) => {
      counts[vertical.sectionId] = (counts[vertical.sectionId] ?? 0) + 1
    })
    return counts
  })

  /** 起点距排序校验：返回重复起点距的垂线号清单 */
  function findDistanceConflicts(sectionId: string): number[] {
    const seen = new Map<number, number>()
    const conflicts: number[] = []
    verticalsOfSection(sectionId).forEach((vertical) => {
      const key = Number(vertical.startDistanceM.toFixed(3))
      if (seen.has(key)) {
        conflicts.push(vertical.no)
      } else {
        seen.set(key, vertical.no)
      }
    })
    return conflicts
  }

  function patchFilter(patch: Partial<SectionFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySectionFilter()
  }

  function selectSection(id: string | null): void {
    currentSectionId.value = id
  }

  function selectVertical(id: string | null): void {
    currentVerticalId.value = id
  }

  function resetVerticalDraft(nextNo = 1): void {
    verticalDraft.value = createEmptyVerticalDraft(nextNo)
  }

  function resetPointDraft(): void {
    pointDraft.value = createEmptyPointDraft()
  }

  /* ------------------------------ 断面测次 ------------------------------ */

  async function createSection(
    payload: Omit<Section, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Section> {
    const now = Date.now()
    const row: Section = { ...payload, id: createId('sec'), createdAt: now, updatedAt: now }
    await db.sections.put(row)
    return row
  }

  async function updateSection(id: string, patch: Partial<Section>): Promise<void> {
    await db.sections.update(id, { ...patch, updatedAt: Date.now() } as never)
    // 测次日期或测法变化后按新日期重新对账该测次测点（两边按测次日期对账）
    if (patch.measuredAt !== undefined || patch.method !== undefined) {
      await resyncSectionPoints(id)
    }
  }

  async function removeSection(id: string): Promise<void> {
    await db.transaction('rw', [db.sections, db.verticals, db.points], async () => {
      const verticalIds = (await db.verticals.where('sectionId').equals(id).toArray()).map((row) => row.id)
      if (verticalIds.length > 0) {
        await db.points.where('verticalId').anyOf(verticalIds).delete()
        await db.verticals.bulkDelete(verticalIds)
      }
      await db.sections.delete(id)
    })
  }

  /* ------------------------------- 垂线 ------------------------------- */

  async function createVertical(
    sectionId: string,
    payload: Omit<Vertical, 'id' | 'createdAt' | 'updatedAt' | 'sectionId'>
  ): Promise<Vertical> {
    const now = Date.now()
    const row: Vertical = { ...payload, sectionId, id: createId('vrt'), createdAt: now, updatedAt: now }
    await db.verticals.put(row)
    // 录入测深后按相对水深自动生成测点行
    const depths = buildRelativeDepths(payload.pointCount)
    const section = sections.value.find((item) => item.id === sectionId)
    const pointRows: Point[] = depths.map((relativeDepth, index) => ({
      id: createId('pnt'),
      verticalId: row.id,
      relativeDepth,
      velocityMs: 0.5,
      weight: Number((1 / depths.length).toFixed(4)),
      durationS: 100,
      ...(resolveFreshPointFields(section, null)),
      createdAt: now + index,
      updatedAt: now + index
    }))
    if (pointRows.length > 0) await db.points.bulkPut(pointRows)
    return row
  }

  async function updateVertical(id: string, patch: Partial<Vertical>): Promise<void> {
    await db.verticals.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeVertical(id: string): Promise<void> {
    await db.transaction('rw', [db.verticals, db.points], async () => {
      await db.points.where('verticalId').equals(id).delete()
      await db.verticals.delete(id)
    })
  }

  /** 按测点数重排该垂线的测点行（尽量保持已有流速、转数与检定线归属，缺失的补默认） */
  async function regeneratePoints(verticalId: string, pointCount: number): Promise<number> {
    const existing = pointsOfVertical(verticalId)
    const depths = buildRelativeDepths(pointCount)
    const now = Date.now()
    const section = sectionOfVertical(verticalId)
    const rows: Point[] = depths.map((relativeDepth, index) => {
      const match = existing.find((point) => Math.abs(point.relativeDepth - relativeDepth) < 0.001)
      const base: Point = {
        id: match?.id ?? createId('pnt'),
        verticalId,
        relativeDepth,
        velocityMs: match?.velocityMs ?? 0.5,
        weight: Number((1 / depths.length).toFixed(4)),
        durationS: match?.durationS ?? 100,
        revolutions: match?.revolutions ?? null,
        meterLineId: match?.meterLineId ?? null,
        linkStatus: match?.linkStatus ?? null,
        createdAt: match?.createdAt ?? now + index,
        updatedAt: now + index
      }
      return match ? base : { ...base, ...resolveFreshPointFields(section, null) }
    })
    await db.transaction('rw', [db.verticals, db.points], async () => {
      await db.points.where('verticalId').equals(verticalId).delete()
      if (rows.length > 0) await db.points.bulkPut(rows)
      await db.verticals.update(verticalId, { pointCount: rows.length, updatedAt: now } as never)
    })
    return rows.length
  }

  /* ------------------------------- 测点 ------------------------------- */

  async function createPoint(
    verticalId: string,
    payload: Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'verticalId'>
  ): Promise<Point> {
    const now = Date.now()
    const section = sectionOfVertical(verticalId)
    // 未显式给归属时按测法与施测日解析；流速仪测点的流速最终以检定线换算为准
    const fields =
      payload.linkStatus !== null && payload.linkStatus !== undefined
        ? {}
        : resolveFreshPointFields(section, payload.meterLineId ?? null)
    const merged: Point = { ...payload, ...fields, verticalId, id: createId('pnt'), createdAt: now, updatedAt: now }
    const line = merged.meterLineId ? meterLinesRef.value.find((item) => item.id === merged.meterLineId) ?? null : null
    if (merged.linkStatus === '已换算') merged.velocityMs = computeVelocity(merged, line)
    await db.points.put(merged)
    await syncVerticalPointCount(verticalId)
    return merged
  }

  /**
   * 编辑测点：转数 / 历时 / 检定线变化时按归属检定线重算流速并刷新对账状态；
   * 非流速仪测点（浮标 / ADCP）可直接改流速。
   */
  async function updatePoint(id: string, patch: Partial<Point>): Promise<void> {
    const current = points.value.find((item) => item.id === id)
    if (!current) {
      await db.points.update(id, { ...patch, updatedAt: Date.now() } as never)
      return
    }
    const merged: Point = { ...current, ...patch }
    const section = sectionOfVertical(current.verticalId)
    if (section && section.method === '流速仪') {
      if (patch.meterLineId !== undefined || patch.linkStatus !== undefined) {
        merged.linkStatus = statusFor(section, merged.meterLineId)
      }
      if (merged.linkStatus === '已换算') {
        const line = merged.meterLineId ? meterLinesRef.value.find((item) => item.id === merged.meterLineId) ?? null : null
        merged.velocityMs = computeVelocity(merged, line)
      }
    } else {
      Object.assign(merged, nonMeterFields())
    }
    await db.points.put({ ...merged, updatedAt: Date.now() })
  }

  async function removePoint(id: string): Promise<void> {
    const point = points.value.find((item) => item.id === id)
    await db.points.delete(id)
    if (point) await syncVerticalPointCount(point.verticalId)
  }

  /** 批量改写流速：仅对非流速仪测点（浮标 / ADCP）直接生效；流速仪测点改转数后重算 */
  async function bulkSetVelocity(verticalId: string, velocityMs: number): Promise<number> {
    const now = Date.now()
    let count = 0
    await db.points
      .where('verticalId')
      .equals(verticalId)
      .modify((point) => {
        if (isSuspendedStatus(point.linkStatus) || (point.linkStatus === '已换算')) return
        point.velocityMs = velocityMs
        point.updatedAt = now
        count += 1
      })
    return count
  }

  /** 批量导入解析后的测点草稿（先清空该垂线旧测点行，按测法解析检定线归属并换算） */
  async function importPointDrafts(
    verticalId: string,
    rows: Array<{ relativeDepth: number; velocityMs: number; durationS: number; revolutions?: number }>
  ): Promise<number> {
    const now = Date.now()
    const section = sectionOfVertical(verticalId)
    const isMeter = section?.method === '流速仪'
    const records: Point[] = rows.map((row, index) => {
      const fields = resolveFreshPointFields(section, null)
      const base: Point = {
        id: createId('pnt'),
        verticalId,
        relativeDepth: row.relativeDepth,
        velocityMs: row.velocityMs,
        weight: Number((1 / rows.length).toFixed(4)),
        durationS: row.durationS,
        revolutions: isMeter ? (row.revolutions ?? null) : null,
        meterLineId: fields.meterLineId,
        linkStatus: isMeter ? fields.linkStatus : '非流速仪',
        createdAt: now + index,
        updatedAt: now + index
      }
      if (isMeter && base.linkStatus === '已换算') {
        const line = base.meterLineId ? meterLinesRef.value.find((item) => item.id === base.meterLineId) ?? null : null
        base.velocityMs = computeVelocity(base, line)
      }
      return base
    })
    await db.transaction('rw', [db.verticals, db.points], async () => {
      await db.points.where('verticalId').equals(verticalId).delete()
      await db.points.bulkPut(records)
      await db.verticals.update(verticalId, { pointCount: records.length, updatedAt: now } as never)
    })
    return records.length
  }

  async function syncVerticalPointCount(verticalId: string): Promise<void> {
    const count = await db.points.where('verticalId').equals(verticalId).count()
    await db.verticals.update(verticalId, { pointCount: count, updatedAt: Date.now() } as never)
  }

  /** 权重归一化：按测点数平均分配计算权重（挂起测点不改变其挂起状态） */
  async function normalizeWeights(verticalId: string): Promise<number> {
    const rows = pointsOfVertical(verticalId)
    if (rows.length === 0) return 0
    const weight = Number((1 / rows.length).toFixed(4))
    await db.points.bulkPut(rows.map((row) => ({ ...row, weight, updatedAt: Date.now() })))
    return rows.length
  }

  /* --------------------------- 检定线对账（巡测组侧） --------------------------- */

  /**
   * 测次日期变化后重新对账该测次全部测点：
   * 非流速仪测点固定「非流速仪」；流速仪测点按新施测日重新挑生效检定线，
   * 已归属且新日期仍有效的保持「已换算」，对不上的单列「未匹配」。
   */
  async function resyncSectionPoints(sectionId: string): Promise<void> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) return
    const rows = pointsOfSection(sectionId)
    if (rows.length === 0) return
    if (section.method !== '流速仪') {
      await db.points.bulkPut(
        rows.map((row) => ({ ...row, ...nonMeterFields(), updatedAt: Date.now() }))
      )
      return
    }
    const expected = pickEffectiveLine(meterLinesRef.value, section.measuredAt, section.meterNo)
    const now = Date.now()
    await db.points.bulkPut(
      rows.map((row) => {
        const lineId = row.meterLineId ?? expected
        const status = statusFor(section, lineId)
        const line = lineId ? meterLinesRef.value.find((item) => item.id === lineId) ?? null : null
        return {
          ...row,
          meterLineId: lineId,
          linkStatus: status,
          velocityMs: status === '已换算' ? computeVelocity({ ...row, meterLineId: lineId, linkStatus: status }, line) : row.velocityMs,
          updatedAt: now
        }
      })
    )
  }

  /** 手动指定某测点使用的检定线并立即按该线重算（巡测组本侧重算，检定室台账不动） */
  async function assignPointLine(pointId: string, meterLineId: string): Promise<void> {
    await updatePoint(pointId, { meterLineId })
  }

  /**
   * 按测次整体重算：把该测次流速仪测点统一指到当前施测日生效检定线，
   * 已挂起 / 未匹配的测点重新换算后恢复参与断面流量。
   * 返回重算点数与仍未对上的点数。
   */
  async function recomputeSection(sectionId: string): Promise<{ recomputed: number; unmatched: number }> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section || section.method !== '流速仪') return { recomputed: 0, unmatched: 0 }
    const rows = pointsOfSection(sectionId)
    const expected = pickEffectiveLine(meterLinesRef.value, section.measuredAt, section.meterNo)
    const now = Date.now()
    let recomputed = 0
    let unmatched = 0
    await db.points.bulkPut(
      rows.map((row) => {
        const lineId = expected
        const status = statusFor(section, lineId)
        if (status === '已换算') recomputed += 1
        if (status === '未匹配') unmatched += 1
        const line = lineId ? meterLinesRef.value.find((item) => item.id === lineId) ?? null : null
        return {
          ...row,
          meterLineId: lineId,
          linkStatus: status,
          velocityMs: status === '已换算' ? computeVelocity({ ...row, meterLineId: lineId, linkStatus: status }, line) : row.velocityMs,
          updatedAt: now
        }
      })
    )
    return { recomputed, unmatched }
  }

  /**
   * 检定线换新 / 撤销后调用：用过该线的测点全部挂起（流速与转数保留），
   * 不再参与断面流量，等待巡测组按测次重算。检定室那份检定线记录不动。
   */
  async function suspendPointsUsingLine(retiredLineId: string): Promise<number> {
    const targets = points.value.filter((point) => point.meterLineId === retiredLineId && point.linkStatus === '已换算')
    if (targets.length === 0) return 0
    const now = Date.now()
    await db.points.bulkPut(targets.map((point) => ({ ...point, linkStatus: '已挂起', updatedAt: now })))
    return targets.length
  }

  /** 某测次的对账汇总：同一测次的测点必须在同一条检定线上 */
  function sectionMeterSummary(sectionId: string) {
    const section = sections.value.find((item) => item.id === sectionId) ?? null
    const rows = pointsOfSection(sectionId)
    const meterRows = rows.filter((point) => point.linkStatus !== '非流速仪')
    const lineIds = new Set(meterRows.map((point) => point.meterLineId).filter((id): id is string => id !== null))
    const counts: Record<PointLinkStatus, number> = {
      已换算: 0,
      已挂起: 0,
      未匹配: 0,
      非流速仪: rows.length - meterRows.length
    }
    rows.forEach((point) => {
      if (point.linkStatus) counts[point.linkStatus] += 1
    })
    const expectedLineId = section ? pickEffectiveLine(meterLinesRef.value, section.measuredAt, section.meterNo) : null
    return {
      section,
      total: rows.length,
      meterTotal: meterRows.length,
      counts,
      lineIds: Array.from(lineIds),
      /** 同一测次出现多条检定线归属 */
      split: lineIds.size > 1,
      suspendedPoints: counts.已挂起 + counts.未匹配,
      expectedLineId
    }
  }

  return {
    sections,
    verticals,
    points,
    ready,
    error,
    currentSectionId,
    currentVerticalId,
    currentVertical,
    filter,
    filteredSections,
    verticalDraft,
    pointDraft,
    pasteText,
    start,
    sectionsOfStation,
    sectionById,
    verticalsOfSection,
    pointsOfVertical,
    participatingPointsOfVertical,
    pointsOfSection,
    setMeterLines,
    sectionOfVertical,
    resolveFreshPointFields,
    statusFor,
    verticalStats,
    sectionVerticalCounts,
    findDistanceConflicts,
    patchFilter,
    resetFilter,
    selectSection,
    selectVertical,
    resetVerticalDraft,
    resetPointDraft,
    createSection,
    updateSection,
    removeSection,
    createVertical,
    updateVertical,
    removeVertical,
    regeneratePoints,
    createPoint,
    updatePoint,
    removePoint,
    bulkSetVelocity,
    importPointDrafts,
    syncVerticalPointCount,
    normalizeWeights,
    resyncSectionPoints,
    assignPointLine,
    recomputeSection,
    suspendPointsUsingLine,
    sectionMeterSummary
  }
})
