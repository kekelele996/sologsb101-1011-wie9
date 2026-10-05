/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 断面测次：一次完整的流量测验 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /** 水位（m） */
  stageM: number
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /**
   * 使用的流速仪仪器编号（method 为流速仪时必填）：
   * 测点按「仪器编号 + 施测日」匹配该仪器当天生效的检定线换算。
   */
  meterNo: string | null
  /** 测流时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
