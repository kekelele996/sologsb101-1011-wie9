/**
 * 检定线：流速仪每检定一次换一组系数，由检定室统一管理。
 * 每条线记录检定号、生效起止与系数；测点流速按施测日生效的那条线换算。
 */

/** 检定线状态：在用 / 已换新（被后续检定替代）/ 已撤销（检定作废） */
export type CalibrationStatus = 'active' | 'replaced' | 'revoked'

/** 测点状态：参与流量的正常点 / 挂起（无有效线或线已撤销，不参与断面流量） */
export type PointStatus = 'active' | 'suspended'

export const CALIBRATION_STATUS_META: Record<
  CalibrationStatus,
  { label: string; type: 'success' | 'info' | 'danger' | 'warning' }
> = {
  active: { label: '在用', type: 'success' },
  replaced: { label: '已换新', type: 'info' },
  revoked: { label: '已撤销', type: 'danger' }
}

export const POINT_STATUS_META: Record<PointStatus, { label: string; type: 'success' | 'warning' | 'info' }> = {
  active: { label: '正常', type: 'success' },
  suspended: { label: '挂起', type: 'warning' }
}

/** 流速仪检定线：v = k · 转数/历时 + c */
export interface CalibrationLine {
  id: string
  /** 检定号，如 检字 2024-018 */
  certNo: string
  /** 流速仪编号，如 LS25-1/08# */
  meterNo: string
  /** 生效起始（ISO 日期） */
  effectiveFrom: string
  /** 生效截止（ISO 日期）；null 表示长期有效 / 当前在用 */
  effectiveTo: string | null
  /** 系数 k：转数/历时 → 流速 的斜率 */
  k: number
  /** 系数 c：截距 */
  c: number
  status: CalibrationStatus
  /** 备注（检定机构、有效期说明等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 检定线表单草稿 */
export interface CalibrationDraft {
  certNo: string
  meterNo: string
  effectiveFrom: string
  effectiveTo: string
  k: number
  c: number
  remark: string
}

export function createEmptyCalibrationDraft(): CalibrationDraft {
  return {
    certNo: '',
    meterNo: '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveTo: '',
    k: 0.25,
    c: 0.01,
    remark: ''
  }
}

/**
 * 按「仪号 + 施测日期」找生效的检定线：
 * 未撤销、仪号匹配、生效起始 ≤ 施测日、且（无截止或施测日 ≤ 截止），
 * 取生效起始最晚的一条（即施测当日真正在用的系数）。
 */
export function findEffectiveLine(
  lines: CalibrationLine[],
  meterNo: string | null | undefined,
  measuredAt: string | number | Date
): CalibrationLine | null {
  if (!meterNo) return null
  const measureTime = new Date(measuredAt).getTime()
  if (!Number.isFinite(measureTime)) return null
  const candidates = lines
    .filter((line) => line.meterNo === meterNo && line.status !== 'revoked')
    .filter((line) => {
      const from = new Date(line.effectiveFrom).getTime()
      if (!Number.isFinite(from) || from > measureTime) return false
      if (line.effectiveTo) {
        const to = new Date(line.effectiveTo).getTime()
        if (Number.isFinite(to) && to < measureTime) return false
      }
      return true
    })
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())
  return candidates[0] ?? null
}

/** 由转数、测速历时与检定线系数换算流速：v = k · n/T + c */
export function convertVelocity(revolutions: number, durationS: number, line: CalibrationLine): number {
  if (!Number.isFinite(revolutions) || !Number.isFinite(durationS) || durationS <= 0) return 0
  const value = line.k * (revolutions / durationS) + line.c
  return Number(value.toFixed(3))
}

/** 检定线生效区间的可读文本 */
export function formatEffectiveRange(line: CalibrationLine): string {
  const to = line.effectiveTo ? line.effectiveTo.slice(0, 10) : '长期'
  return `${line.effectiveFrom.slice(0, 10)} ~ ${to}`
}
