/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table, type Transaction } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point, PointLinkStatus } from '@/types/point'
import { isSuspendedStatus } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { MeterLine } from '@/types/meterLine'
import { isLineEffectiveOn as isEffectiveOn, pickEffectiveLine } from '@/types/meterLine'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round, velocityByMeterLine } from '@/utils/flow'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  meterLines: MeterLine[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  meterLines!: Table<MeterLine, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与判定结论，避免列表排序与筛选拿到 undefined
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString(), meterNo: null })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }
      })

    // v3：检定室新增「流速仪检定线」表；测点增加转数 / 检定线归属 / 对账状态。
    // 旧数据只存了流速没归属，升级时按测次时间回填，对不上的单列（未匹配）。
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, meterLineId, linkStatus, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt',
        meterLines: 'id, certNo, meterNo, status, effectiveFrom, effectiveTo'
      })
      .upgrade(async (tx) => {
        await backfillPointMeterLinks(tx)
      })
  }
}

/* --------------------------- 检定线与测点回填迁移 --------------------------- */

/**
 * 演示用检定线台账（升级回填与新库播种共用）：
 * LS20-250603 先后两组系数（2024-07-01 换新）；LS25-110428 旧线已撤销换新，
 * 青矶 2024-03 测次用过它，用于演示「旧线撤销 → 测点挂起 → 巡测组重算」。
 */
const METER_LINE_SEED_ROWS: Array<Omit<MeterLine, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'mtr_ls20_2023',
    certNo: 'LS20-2023-102',
    meterNo: 'LS20-250603',
    effectiveFrom: '2023-01-01',
    effectiveTo: '2024-06-30',
    factorK: 0.252,
    factorC: 0.012,
    labName: '省水文仪器检定中心',
    status: '生效',
    remark: '2024-07 到期前的检定系数'
  },
  {
    id: 'mtr_ls20_2024',
    certNo: 'LS20-2024-118',
    meterNo: 'LS20-250603',
    effectiveFrom: '2024-07-01',
    effectiveTo: null,
    factorK: 0.246,
    factorC: 0.008,
    labName: '省水文仪器检定中心',
    status: '生效',
    remark: '换检定后现行系数'
  },
  {
    id: 'mtr_ls25_2022',
    certNo: 'LS25-2022-077',
    meterNo: 'LS25-110428',
    effectiveFrom: '2022-03-01',
    effectiveTo: '2024-04-30',
    factorK: 0.255,
    factorC: 0.015,
    labName: '流域局检定室',
    status: '停用',
    remark: '2024-05 换新后旧线撤销，用过它的测点挂起待重算'
  },
  {
    id: 'mtr_ls25_2024',
    certNo: 'LS25-2024-131',
    meterNo: 'LS25-110428',
    effectiveFrom: '2024-05-01',
    effectiveTo: null,
    factorK: 0.25,
    factorC: 0.01,
    labName: '流域局检定室',
    status: '生效',
    remark: '换检定后现行系数'
  }
]

/**
 * v3 升级回填：旧测点只存了流速没有检定线归属。
 * 按测点所属测次的施测日匹配当天生效检定线：对上记「已换算」（保留原流速，
 * 转数缺失不反推）；对不上单列「未匹配」；非流速仪测次记「非流速仪」。
 */
async function backfillPointMeterLinks(tx: Transaction): Promise<void> {
  const meterTable = tx.table<MeterLine, string>('meterLines')
  // 老库升级时检定线表为空，先补演示检定线，历史测点才可能按测次时间对上
  if ((await meterTable.count()) === 0) {
    const now = Date.now()
    await meterTable.bulkAdd(
      METER_LINE_SEED_ROWS.map((row, index) => ({ ...row, createdAt: now + index, updatedAt: now + index }))
    )
  }
  const meterLines = await meterTable.toArray()
  const sections: Section[] = await tx.table<Section, string>('sections').toArray()
  const verticals: Vertical[] = await tx.table<Vertical, string>('verticals').toArray()

  // 老断面没有仪器编号：v3 升级按施测日落在哪个仪器的检定区间补记；补不出来的留空，
  // 测点仍按当天唯一生效线匹配，对不上的单列（不猜测、不跨仪器乱挂）。
  const meterNos = Array.from(new Set(meterLines.map((line) => line.meterNo)))
  for (const section of sections) {
    if (section.method !== '流速仪' || section.meterNo) continue
    const day = section.measuredAt.slice(0, 10)
    const matched = meterNos.filter((meterNo) =>
      meterLines.some((line) => line.meterNo === meterNo && line.status === '生效' && isEffectiveOn(line, day))
    )
    if (matched.length === 1) {
      section.meterNo = matched[0]
      await tx.table<Section, string>('sections').put(section)
    }
  }

  const sectionById = new Map(sections.map((section) => [section.id, section]))
  const verticalSectionId = new Map(verticals.map((vertical) => [vertical.id, vertical.sectionId]))

  await tx
    .table<Point, string>('points')
    .toCollection()
    .modify((point: Point) => {
      if (point.revolutions === undefined) point.revolutions = null
      if (point.meterLineId === undefined) point.meterLineId = null
      const sectionId = verticalSectionId.get(point.verticalId)
      const section = sectionId ? sectionById.get(sectionId) : undefined
      if (!section || section.method !== '流速仪') {
        point.linkStatus = '非流速仪'
        point.meterLineId = null
        return
      }
      // 升级只回填无归属的老数据；已有归属不动
      if (point.linkStatus !== undefined && point.linkStatus !== null) return
      const lineId = pickEffectiveLine(meterLines, section.measuredAt, section.meterNo)
      if (lineId) {
        point.meterLineId = lineId
        point.linkStatus = '已换算'
      } else {
        point.meterLineId = null
        point.linkStatus = '未匹配'
      }
    })
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  /** 播种测点暂不含检定线归属字段，入库时按测法与测次时间统一补齐 */
  points: Array<
    Omit<Point, 'createdAt' | 'updatedAt' | 'revolutions' | 'meterLineId' | 'linkStatus'> & {
      /** 流速仪测次可直接给转数，由检定线系数换算流速 */
      revolutions?: number
    }
  >
}

/**
 * 播种演示数据：3 个测站 → 4 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并据此生成水位流量关系点据与比测记录，保证父 → 子 → 孙三层链路可点开。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          meterNo: 'LS20-250603',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          meterNo: null,
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100, revolutions: 241 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100, revolutions: 186 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100, revolutions: 559 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100, revolutions: 463 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100, revolutions: 376 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100, revolutions: 321 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100, revolutions: 249 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2403',
          stationId: 'stn_qj02',
          measureNo: '2024-03-002',
          startDistanceM: 4.2,
          stageM: 2.96,
          method: '流速仪',
          meterNo: 'LS25-110428',
          measuredAt: '2024-03-15T08:05:00.000Z'
        },
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          meterNo: null,
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          meterNo: 'LS25-110428',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_0', sectionId: 'sec_qj_2403', no: 1, startDistanceM: 2.6, depthM: 1.0, pointCount: 2, bedNote: '旧线 LS25-2022-077 已撤销，测点挂起待重算' },
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_01', verticalId: 'vrt_qj_0', relativeDepth: 0.2, velocityMs: 0.46, weight: 0.5, durationS: 100, revolutions: 175 },
        { id: 'pnt_qj_02', verticalId: 'vrt_qj_0', relativeDepth: 0.8, velocityMs: 0.38, weight: 0.5, durationS: 100, revolutions: 143 },
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100, revolutions: 420 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100, revolutions: 364 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100, revolutions: 308 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100, revolutions: 532 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100, revolutions: 476 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100, revolutions: 412 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          meterNo: null,
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z' },
    // C 线：含两个明显偏离点，用于演示超限挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' }
  ]

  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.meterLines],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        )
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.meterLines.bulkPut(METER_LINE_SEED_ROWS.map((line, index) => ({ ...line, createdAt: now + index, updatedAt: now + index })))

      // 测点检定线归属与流速换算：
      // 流速仪测次按施测日挑当天生效检定线，提供转数时以 v = k·n/t + c 换算；
      // sec_qj_2403 特意挂在已撤销的旧线上（演示旧线撤销 → 测点挂起 → 巡测组重算）。
      const allSections = stationBundles.flatMap((bundle) => bundle.sections)
      const sectionById = new Map(allSections.map((section) => [section.id, section]))
      const verticalSectionId = new Map(
        stationBundles.flatMap((bundle) => bundle.verticals.map((vertical) => [vertical.id, vertical.sectionId] as const))
      )
      const meterById = new Map(METER_LINE_SEED_ROWS.map((line) => [line.id, line]))
      /** 演示：旧线撤销后用过它的测点保持挂起，不随新线自动换算 */
      const forcedLineBySection: Record<string, string> = { sec_qj_2403: 'mtr_ls25_2022' }

      const enrichedPoints: Point[] = stationBundles.flatMap((bundle) =>
        bundle.points.map((point) => {
          const base = stamp(point)
          const sectionId = verticalSectionId.get(point.verticalId)
          const section = sectionId ? sectionById.get(sectionId) : undefined
          if (!section || section.method !== '流速仪') {
            return {
              ...point,
              ...base,
              revolutions: null,
              meterLineId: null,
              linkStatus: '非流速仪' as const
            }
          }
          const forcedId = sectionId ? forcedLineBySection[sectionId] : undefined
          const lineId = forcedId ?? pickEffectiveLine(METER_LINE_SEED_ROWS, section.measuredAt, section.meterNo)
          const line = lineId ? meterById.get(lineId) : undefined
          let linkStatus: Point['linkStatus']
          if (line && line.status === '生效' && isEffectiveOn(line, section.measuredAt)) {
            linkStatus = '已换算'
          } else if (line) {
            linkStatus = '已挂起'
          } else {
            linkStatus = '未匹配'
          }
          const velocityMs =
            point.revolutions !== undefined && line
              ? velocityByMeterLine(point.revolutions, point.durationS, line.factorK, line.factorC)
              : point.velocityMs
          return {
            ...point,
            ...base,
            velocityMs,
            revolutions: point.revolutions ?? null,
            meterLineId: lineId,
            linkStatus
          }
        })
      )
      await db.points.bulkPut(enrichedPoints)

      await db.ratings.bulkPut(ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))

      // 比测记录：按定线拟合出曲线流量后计算偏差与判定，保证与页面展示一致
      const compares: Compare[] = []
      const lineGroups = new Map<string, Array<{ stageM: number; flowM3s: number }>>()
      ratingSeeds.forEach((rating) => {
        const list = lineGroups.get(rating.lineNo) ?? []
        list.push({ stageM: rating.stageM, flowM3s: rating.flowM3s })
        lineGroups.set(rating.lineNo, list)
      })
      ratingSeeds.forEach((rating) => {
        const fit = fitPowerCurve(lineGroups.get(rating.lineNo) ?? [], rating.lineNo)
        if (!fit.valid) return
        const predicted = round(fit.a * Math.pow(Math.max(rating.stageM - fit.h0, 1e-6), fit.b), 2)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        compares.push({
          id: `cmp_${rating.id}`,
          ratingId: rating.id,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: rating.lineNo === 'C' ? '周渝' : '林昭',
          comparedAt: rating.measuredAt,
          createdAt: now,
          updatedAt: now
        })
      })
      await db.compares.bulkPut(compares)
      if (compares.length === 0) {
        await db.compares.put({
          id: 'cmp_fallback',
          ratingId: 'rat_lh_a1',
          measuredFlow: 97.5,
          curveFlow: 100.2,
          deviationPct: calcDeviationPct(97.5, 100.2),
          verdict: judgeDeviation(calcDeviationPct(97.5, 100.2)),
          operator: '林昭',
          comparedAt: iso,
          createdAt: now,
          updatedAt: now
        })
      }
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.meterLines],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.compares.clear(),
        db.meterLines.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, compares, meterLines] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.compares.count(),
    db.meterLines.count()
  ])
  return { stations, sections, verticals, points, ratings, compares, meterLines }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法；挂起 / 未匹配测点不参与） */
export function verticalMeanVelocity(points: Point[]): number {
  const active = points.filter((point) => !isSuspendedStatus(point.linkStatus))
  return calcMeanVelocity(active.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
