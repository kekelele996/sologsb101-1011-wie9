/**
 * 检定线归属与重算工具：
 * - 旧测点只存了流速没归属，升级时按测次时间回填检定线（attributePoints）
 * - 检定线换新 / 撤销后，用过它的测点挂起，由巡测组重算（recalcSuspended）
 * 纯函数，不触库；迁移、播种与 store 共用同一套算法。
 *
 * 关联链路：point.verticalId → vertical.sectionId → section(meterNo, measuredAt)
 */
import type { CalibrationLine } from '@/types/calibration'
import { findEffectiveLine, convertVelocity } from '@/types/calibration'
import type { Point } from '@/types/point'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'

/** 测点归属回填结果统计 */
export interface AttributeResult {
  points: Point[]
  /** 成功匹配到检定线的测点数 */
  matched: number
  /** 对不上检定线而挂起的测点数 */
  unmatched: number
}

/** 由测点出发，经垂线找到所属测次 */
function sectionOfPoint(
  point: Point,
  verticalMap: Map<string, Vertical>,
  sectionMap: Map<string, Section>
): Section | null {
  const vertical = verticalMap.get(point.verticalId)
  if (!vertical) return null
  return sectionMap.get(vertical.sectionId) ?? null
}

/**
 * 按测次时间回填测点归属：
 * - 流速仪法测次：按「仪号 + 施测日」找生效检定线，命中则记 calibrationId 并置正常；
 *   对不上（无仪号 / 当日无线 / 线已撤销）则置挂起，列入对不上清单。
 * - 浮标 / ADCP 法测次：流速直接测得，无转数与检定线归属，置正常。
 * 回填只写归属与状态，不改动已存的流速值。
 */
export function attributePoints(
  points: Point[],
  verticals: Vertical[],
  sections: Section[],
  lines: CalibrationLine[]
): AttributeResult {
  const verticalMap = new Map(verticals.map((vertical) => [vertical.id, vertical]))
  const sectionMap = new Map(sections.map((section) => [section.id, section]))
  let matched = 0
  let unmatched = 0
  const now = Date.now()

  const result = points.map((point) => {
    const section = sectionOfPoint(point, verticalMap, sectionMap)
    const isMeter = section?.method === '流速仪'
    const line = isMeter ? findEffectiveLine(lines, section?.meterNo, section?.measuredAt) : null
    const next: Point = { ...point, updatedAt: now }
    if (isMeter) {
      if (line) {
        next.calibrationId = line.id
        next.status = 'active'
        matched += 1
      } else {
        next.calibrationId = null
        next.status = 'suspended'
        unmatched += 1
      }
    } else {
      // 浮标 / ADCP：无检定线归属，流速直接参与
      next.calibrationId = null
      next.status = 'active'
    }
    return next
  })

  return { points: result, matched, unmatched }
}

/** 重算结果统计 */
export interface RecalcResult {
  points: Point[]
  /** 重算后恢复正常的测点数 */
  reactivated: number
  /** 仍对不上检定线、保持挂起的测点数 */
  stillSuspended: number
  /** 重算中按线系数换算流速的测点数 */
  recomputed: number
}

/**
 * 巡测组重算挂起测点：
 * - 按测次「仪号 + 施测日」重新找生效检定线；
 * - 命中且测点有转数：按线系数重算流速（v = k·转数/历时 + c），恢复正常；
 * - 命中但无转数（旧数据只存了流速）：保留原流速，记归属并恢复正常；
 * - 仍对不上：保持挂起，留在对不上清单。
 * 检定室的检定线记录不在此改动。
 */
export function recalcSuspendedPoints(
  points: Point[],
  verticals: Vertical[],
  sections: Section[],
  lines: CalibrationLine[]
): RecalcResult {
  const verticalMap = new Map(verticals.map((vertical) => [vertical.id, vertical]))
  const sectionMap = new Map(sections.map((section) => [section.id, section]))
  const lineMap = new Map(lines.map((line) => [line.id, line]))
  let reactivated = 0
  let stillSuspended = 0
  let recomputed = 0
  const now = Date.now()

  const result = points.map((point) => {
    if (point.status !== 'suspended') return point
    const section = sectionOfPoint(point, verticalMap, sectionMap)
    const isMeter = section?.method === '流速仪'
    const line = isMeter ? findEffectiveLine(lines, section?.meterNo, section?.measuredAt) : null
    if (!line) {
      stillSuspended += 1
      return point
    }
    const next: Point = {
      ...point,
      calibrationId: line.id,
      status: 'active',
      updatedAt: now
    }
    if (next.revolutions !== null && Number.isFinite(next.revolutions)) {
      next.velocityMs = convertVelocity(next.revolutions, next.durationS, line)
      recomputed += 1
    }
    reactivated += 1
    return next
  })

  return { points: result, reactivated, stillSuspended, recomputed }
}

/** 测次对账行：每个流速仪测次的仪号、施测日、生效线与归属状态 */
export interface SectionReconRow {
  section: Section
  /** 生效检定线（对不上为 null） */
  line: CalibrationLine | null
  /** 该测次下的测点是否都挂同一条线 */
  consistent: boolean
  /** 挂起测点数 */
  suspendedCount: number
  /** 正常测点数 */
  activeCount: number
}

/** 按测次生成对账行（流速仪测次） */
export function buildSectionRecon(
  sections: Section[],
  verticals: Vertical[],
  points: Point[],
  lines: CalibrationLine[]
): SectionReconRow[] {
  const verticalMap = new Map(verticals.map((vertical) => [vertical.id, vertical]))
  return sections
    .filter((section) => section.method === '流速仪')
    .map((section) => {
      const line = findEffectiveLine(lines, section.meterNo, section.measuredAt)
      const sectionVerticals = verticals.filter((vertical) => vertical.sectionId === section.id)
      const sectionVerticalIds = new Set(sectionVerticals.map((vertical) => vertical.id))
      const sectionPoints = points.filter((point) => sectionVerticalIds.has(point.verticalId))
      const calibrationIds = new Set(
        sectionPoints.map((point) => point.calibrationId).filter((id): id is string => id !== null)
      )
      const consistent = calibrationIds.size <= 1
      return {
        section,
        line,
        consistent,
        suspendedCount: sectionPoints.filter((point) => point.status === 'suspended').length,
        activeCount: sectionPoints.filter((point) => point.status === 'active').length
      }
    })
    .sort((a, b) => Date.parse(b.section.measuredAt) - Date.parse(a.section.measuredAt))
}
