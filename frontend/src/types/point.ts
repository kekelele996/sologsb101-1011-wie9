/**
 * 流速测点：垂线上按相对水深布设的测速点。
 * 流速仪法测点以「转数 + 测速历时」为原始记录，流速由施测日生效的检定线换算；
 * 浮标 / ADCP 法测点直接录入流速，转数与检定线归属为空。
 */

/**
 * 测点对账状态（巡测组侧）：
 * - 已换算：已归属到施测日生效的检定线，流速按该线系数换算
 * - 已挂起：检定线换新或撤销，旧线停用，测点暂不参与断面流量，待重算
 * - 未匹配：按施测日找不到生效检定线，对不上，单列
 * - 非流速仪：浮标 / ADCP 测点，直接录入流速，不参与检定线对账
 */
export type PointLinkStatus = '已换算' | '已挂起' | '未匹配' | '非流速仪'

export const POINT_LINK_STATUSES: PointLinkStatus[] = ['已换算', '已挂起', '未匹配', '非流速仪']

/** 需要挂起、不参与断面流量的对账状态 */
export const SUSPENDED_LINK_STATUSES: PointLinkStatus[] = ['已挂起', '未匹配']

export function isSuspendedStatus(status: PointLinkStatus | null | undefined): boolean {
  return status !== null && status !== undefined && SUSPENDED_LINK_STATUSES.includes(status)
}

export interface Point {
  id: string
  /** 所属垂线 */
  verticalId: string
  /** 相对水深：0 为水面、1 为河底 */
  relativeDepth: number
  /**
   * 测点流速（m/s）：
   * - 流速仪法：由 meterLineId 检定线按转数/历时换算
   * - 浮标 / ADCP：直接录入
   */
  velocityMs: number
  /** 计算权重（垂直流速分布加权系数） */
  weight: number
  /** 测速历时（s） */
  durationS: number
  /** 流速仪测速历时内的总转数（转）；非流速仪法为 null */
  revolutions: number | null
  /** 归属检定线 id；流速仪法未对上时为 null */
  meterLineId: string | null
  /** 检定线对账状态；历史无归属数据升级回填前为 null */
  linkStatus: PointLinkStatus | null
  createdAt: number
  updatedAt: number
}

/** 批量粘贴解析出的一行测点草稿 */
export interface PointDraftRow {
  relativeDepth: number
  velocityMs: number
  durationS: number
  /** 可选转数：提供时流速仪测次可按检定线换算 */
  revolutions?: number
}

/**
 * 解析批量粘贴文本：每行「相对水深,流速[,历时[,转数]]」，逗号 / 空格 / 制表符均可作分隔。
 * 流速列对流速仪测次可留空（填 0 或 -），由转数按检定线换算。
 * 返回可导入的测点草稿与逐行错误说明。
 */
export function parsePointPaste(text: string): { rows: PointDraftRow[]; errors: string[] } {
  const rows: PointDraftRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；\s]+/).filter((cell) => cell.length > 0)
    if (cells.length < 2) {
      errors.push(`第 ${index + 1} 行「${line}」缺少相对水深或流速`)
      return
    }
    const relativeDepth = Number(cells[0])
    const velocityCell = cells[1]
    const velocityMs = velocityCell === '-' || velocityCell === '空' ? 0 : Number(velocityCell)
    const durationS = cells.length >= 3 ? Number(cells[2]) : 100
    const revolutionsCell = cells.length >= 4 ? cells[3] : ''
    const revolutions = revolutionsCell === '' || revolutionsCell === '-' || revolutionsCell === '空' ? undefined : Number(revolutionsCell)
    if (!Number.isFinite(relativeDepth) || relativeDepth < 0 || relativeDepth > 1) {
      errors.push(`第 ${index + 1} 行相对水深应为 0~1 之间的小数`)
      return
    }
    if (!Number.isFinite(velocityMs) || velocityMs < 0) {
      errors.push(`第 ${index + 1} 行流速应为非负数字（流速仪法可填 - 由转数换算）`)
      return
    }
    if (!Number.isFinite(durationS) || durationS <= 0) {
      errors.push(`第 ${index + 1} 行测速历时应为正数`)
      return
    }
    if (revolutions !== undefined && (!Number.isFinite(revolutions) || revolutions < 0)) {
      errors.push(`第 ${index + 1} 行转数应为非负数字`)
      return
    }
    rows.push({
      relativeDepth: Number(relativeDepth.toFixed(2)),
      velocityMs: Number(velocityMs.toFixed(3)),
      durationS,
      revolutions: revolutions === undefined ? undefined : Number(revolutions.toFixed(1))
    })
  })
  return { rows, errors }
}
