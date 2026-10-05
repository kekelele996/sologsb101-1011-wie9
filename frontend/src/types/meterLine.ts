/**
 * 流速仪检定线（检定室台账）。
 * 流速仪每检定一次换一组系数：记录检定号、生效起止与换算系数（v = k·n/t + c）。
 * 测点流速按「施测日」落在生效区间内的检定线换算；检定线状态变更不改动历史台账。
 */

/** 检定线状态：生效 / 停用（换新或撤销后置为停用，检定室那份保留不动） */
export type MeterLineStatus = '生效' | '停用'

export const METER_LINE_STATUSES: MeterLineStatus[] = ['生效', '停用']

export interface MeterLine {
  id: string
  /** 检定号，如 LS20B-2024-017（同仪器每次检定唯一） */
  certNo: string
  /** 仪器编号：同一架流速仪可有多条先后生效的检定线 */
  meterNo: string
  /** 生效起始日（含），ISO 日期，测点按施测日匹配生效区间 */
  effectiveFrom: string
  /** 生效截止日（含）；null 表示至今仍生效 */
  effectiveTo: string | null
  /** 流速仪公式斜率：v = k·n/t + c */
  factorK: number
  /** 流速仪公式常数项 */
  factorC: number
  /** 检定单位 */
  labName: string
  /** 生效 / 停用（检定线换新或撤销后置为停用） */
  status: MeterLineStatus
  remark: string
  createdAt: number
  updatedAt: number
}

/** 日期（yyyy-mm-dd）是否落在检定线生效区间内（起止日均含） */
export function isLineEffectiveOn(line: Pick<MeterLine, 'effectiveFrom' | 'effectiveTo'>, day: string): boolean {
  const date = day.slice(0, 10)
  if (date < line.effectiveFrom.slice(0, 10)) return false
  if (line.effectiveTo !== null && date > line.effectiveTo.slice(0, 10)) return false
  return true
}

/**
 * 按施测日挑出当天生效且状态为「生效」的检定线；多条命中时取生效起始日最晚的一条。
 * 流速仪测次应带仪器编号（meterNo），只在该仪器的检定线里挑；
 * 未登记仪器编号的老数据跨仪器匹配，当天恰有一条生效才对上，多条互相矛盾时返回 null（对不上，单列）。
 */
export function pickEffectiveLine(
  lines: Array<Pick<MeterLine, 'id' | 'meterNo' | 'effectiveFrom' | 'effectiveTo' | 'status'>>,
  measuredDay: string,
  meterNo?: string | null
): string | null {
  const scoped =
    meterNo !== null && meterNo !== undefined && meterNo.trim().length > 0
      ? lines.filter((line) => line.meterNo === meterNo)
      : lines
  const active = scoped.filter((line) => line.status === '生效' && isLineEffectiveOn(line, measuredDay))
  if (active.length === 0) return null
  if (meterNo === null || meterNo === undefined || meterNo.trim().length === 0) {
    // 老数据没记仪器：跨仪器当天唯一才能对上，避免把 A 仪器的测点错挂到 B 仪器线上
    if (active.length > 1) return null
    return active[0].id
  }
  return active.reduce((latest, line) => (line.effectiveFrom > latest.effectiveFrom ? line : latest)).id
}
