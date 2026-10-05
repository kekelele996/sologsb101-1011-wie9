<script setup lang="ts">
/**
 * 检定线对账台 /meter-lines：
 * - 检定室侧：登记检定线（检定号、生效起止、系数 k/c），支持换新（旧线自动停用）与撤销；
 * - 巡测组侧：两边按测次日期对账——测点流速按施测日生效检定线换算，同一测次的测点须在同一条线上；
 *   检定线换新 / 撤销后用过它的测点先挂起、不参与断面流量，由本侧「按测次重算」恢复，检定室那份不动。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Connection, Refresh, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useMeterLineStore } from '@/stores/meterLineStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useStationStore } from '@/stores/stationStore'
import { METER_LINE_STATUSES, type MeterLine, type MeterLineStatus } from '@/types/meterLine'
import { isLineEffectiveOn } from '@/types/meterLine'
import { velocityByMeterLine } from '@/utils/flow'
import { initDatabase } from '@/utils/db'

const meterStore = useMeterLineStore()
const sectionStore = useSectionStore()
const stationStore = useStationStore()

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  meterStore.start()
})

// 检定室台账变化时注入巡测侧，保证对账与重算拿到最新系数
watch(
  () => meterStore.meterLines,
  (lines) => sectionStore.setMeterLines(lines),
  { immediate: true, deep: false }
)

/* ------------------------------ 检定线台账表单 ------------------------------ */

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const isReplacement = ref(false)
const submitting = ref(false)
const form = reactive({
  certNo: '',
  meterNo: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: '' as string | null,
  factorK: 0.25,
  factorC: 0.01,
  labName: '',
  status: '生效' as MeterLineStatus,
  remark: ''
})

function resetForm(): void {
  form.certNo = ''
  form.meterNo = ''
  form.effectiveFrom = new Date().toISOString().slice(0, 10)
  form.effectiveTo = null
  form.factorK = 0.25
  form.factorC = 0.01
  form.labName = ''
  form.status = '生效'
  form.remark = ''
}

function openCreate(replacement = false): void {
  editingId.value = null
  isReplacement.value = replacement
  resetForm()
  if (replacement) {
    // 预填最近一条在用仪器编号
    const latest = meterStore.sortedLines.find((line) => line.status === '生效')
    if (latest) {
      form.meterNo = latest.meterNo
      form.labName = latest.labName
    }
  }
  dialogVisible.value = true
}

function warn(message: string): void {
  void ElMessage.warning(message)
}
function ok(message: string): void {
  void ElMessage.success(message)
}

function openEdit(line: MeterLine): void {
  editingId.value = line.id
  isReplacement.value = false
  form.certNo = line.certNo
  form.meterNo = line.meterNo
  form.effectiveFrom = line.effectiveFrom
  form.effectiveTo = line.effectiveTo
  form.factorK = line.factorK
  form.factorC = line.factorC
  form.labName = line.labName
  form.status = line.status
  form.remark = line.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.certNo.trim()) return warn('请填写检定号')
  if (!form.meterNo.trim()) return warn('请填写仪器编号')
  if (!form.effectiveFrom) return warn('请选择生效起始日')
  if (form.effectiveTo !== null && form.effectiveTo < form.effectiveFrom) {
    return warn('生效截止日不能早于起始日')
  }
  if (!Number.isFinite(form.factorK) || form.factorK <= 0) return warn('斜率 k 应为正数')
  if (!Number.isFinite(form.factorC)) return warn('常数 c 应为数字')
  const conflicts = meterStore.findOverlapConflicts(form, editingId.value ?? undefined)
  if (conflicts.length > 0 && !isReplacement.value) {
    return warn(`与该仪器检定号 ${conflicts.map((line) => line.certNo).join('、')} 的生效区间重叠，同一架仪器不能两线同时生效`)
  }
  submitting.value = true
  try {
    const payload = {
      certNo: form.certNo.trim(),
      meterNo: form.meterNo.trim(),
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.status === '生效' && !form.effectiveTo ? null : form.effectiveTo,
      factorK: Number(form.factorK.toFixed(4)),
      factorC: Number(form.factorC.toFixed(4)),
      labName: form.labName.trim(),
      status: form.status,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await meterStore.updateLine(editingId.value, payload)
      ElMessage.success('检定线已更新（历史测点换算值不回改）')
    } else if (isReplacement.value) {
      const created = await meterStore.createReplacement(payload, async (oldLine) => {
        // 旧线停用后，巡测侧把用过它的测点挂起；检定室那份旧线记录保持不动
        const suspended = await sectionStore.suspendPointsUsingLine(oldLine.id)
        ElMessage.warning(`检定号 ${oldLine.certNo} 已停用，${suspended} 个用过它的测点已挂起，请到下方按测次重算`)
      })
      ElMessage.success(`新检定线 ${created.certNo} 已登记生效`)
    } else {
      await meterStore.createLine(payload)
      ElMessage.success('检定线已登记')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function retire(line: MeterLine): Promise<void> {
  const day = await ElMessageBox.prompt(
    `检定号 ${line.certNo} 撤销 / 换新的截止日（含当天）：`,
    '撤销检定线',
    { inputValue: new Date().toISOString().slice(0, 10), confirmButtonText: '停用并挂起测点', cancelButtonText: '取消' }
  ).then((res) => String(res.value ?? '').trim()).catch(() => '')
  if (!day) return
  await meterStore.retireLine(line.id, day, `${line.remark ? `${line.remark}；` : ''}${day} 撤销，测点挂起待巡测组重算`)
  const suspended = await sectionStore.suspendPointsUsingLine(line.id)
  ElMessage.warning(`检定线已停用，${suspended} 个用过它的测点已挂起，不参与断面流量`)
}

/* -------------------------------- 对账视图 -------------------------------- */

const stationName = (id: string): string => stationStore.stationById(id)?.name ?? '—'

interface ReconcileRow {
  sectionId: string
  stationId: string
  stationName: string
  measureNo: string
  measuredAt: string
  method: string
  meterNo: string | null
  total: number
  converted: number
  suspended: number
  unmatched: number
  nonMeter: number
  split: boolean
  lineIds: string[]
  expectedLineId: string | null
}

const reconcileRows = computed<ReconcileRow[]>(() =>
  sectionStore.sections
    .slice()
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
    .map((section) => {
      const summary = sectionStore.sectionMeterSummary(section.id)
      return {
        sectionId: section.id,
        stationId: section.stationId,
        stationName: stationName(section.stationId),
        measureNo: section.measureNo,
        measuredAt: section.measuredAt,
        method: section.method,
        meterNo: section.meterNo,
        total: summary.total,
        converted: summary.counts.已换算,
        suspended: summary.counts.已挂起,
        unmatched: summary.counts.未匹配,
        nonMeter: summary.counts.非流速仪,
        split: summary.split,
        lineIds: summary.lineIds,
        expectedLineId: summary.expectedLineId
      }
    })
)

const stats = computed(() => ({
  lineCount: meterStore.meterLines.length,
  activeLineCount: meterStore.meterLines.filter((line) => line.status === '生效').length,
  suspended: sectionStore.points.filter((point) => point.linkStatus === '已挂起').length,
  unmatched: sectionStore.points.filter((point) => point.linkStatus === '未匹配').length
}))

function lineLabel(id: string | null): string {
  if (!id) return '—'
  const line = meterStore.lineById(id)
  return line ? `${line.certNo}（k=${line.factorK}, c=${line.factorC}）` : '检定线已不存在'
}

function expectedLineLabel(measuredAt: string, expectedLineId: string | null): string {
  if (!expectedLineId) return '施测日无生效检定线'
  const line = meterStore.lineById(expectedLineId)
  if (!line) return '施测日无生效检定线'
  return `${line.certNo}（${line.effectiveFrom} 起）`
}

async function recompute(row: ReconcileRow): Promise<void> {
  const result = await sectionStore.recomputeSection(row.sectionId)
  if (result.unmatched > 0) {
    ElMessage.warning(`重算 ${result.recomputed} 点；仍有 ${result.unmatched} 点对不上施测日的生效检定线，已单列`)
  } else {
    ElMessage.success(`已按施测日生效检定线重算 ${result.recomputed} 个测点，恢复参与断面流量`)
  }
}

interface ExceptionRow {
  pointId: string
  sectionId: string
  stationName: string
  measureNo: string
  verticalNo: number
  relativeDepth: number
  revolutions: number | null
  durationS: number
  velocityMs: number
  linkStatus: string
  meterLineId: string | null
}

const exceptionRows = computed<ExceptionRow[]>(() => {
  const rows: ExceptionRow[] = []
  sectionStore.points.forEach((point) => {
    if (point.linkStatus !== '已挂起' && point.linkStatus !== '未匹配') return
    const vertical = sectionStore.verticals.find((item) => item.id === point.verticalId)
    if (!vertical) return
    const section = sectionStore.sectionById(vertical.sectionId)
    if (!section) return
    rows.push({
      pointId: point.id,
      sectionId: section.id,
      stationName: stationName(section.stationId),
      measureNo: section.measureNo,
      verticalNo: vertical.no,
      relativeDepth: point.relativeDepth,
      revolutions: point.revolutions,
      durationS: point.durationS,
      velocityMs: point.velocityMs,
      linkStatus: point.linkStatus,
      meterLineId: point.meterLineId
    })
  })
  return rows
})

/** 挂起 / 未匹配测点可改挂的检定线：优先该测次所用仪器的各条检定线，再补施测日当天生效线 */
function lineOptions(row: ExceptionRow): MeterLine[] {
  const section = sectionStore.sectionById(row.sectionId)
  const current = row.meterLineId ? meterStore.lineById(row.meterLineId) : null
  const preferredMeterNo = section?.meterNo ?? current?.meterNo ?? ''
  const sameMeter = meterStore.sortedLines.filter((line) => line.meterNo === preferredMeterNo)
  const effectiveOnDay = section
    ? meterStore.sortedLines.filter((line) => isLineEffectiveOn(line, section.measuredAt.slice(0, 10)))
    : []
  return sameMeter
    .concat(effectiveOnDay)
    .filter((line, index, arr) => arr.findIndex((item) => item.id === line.id) === index)
}

const previewVelocity = (row: ExceptionRow, lineId: string): string => {
  const line = meterStore.lineById(lineId)
  if (!line || row.revolutions === null) return '—'
  return velocityByMeterLine(row.revolutions, row.durationS, line.factorK, line.factorC).toFixed(3)
}

async function assignLine(row: ExceptionRow, lineId: string): Promise<void> {
  if (!lineId) return
  await sectionStore.assignPointLine(row.pointId, lineId)
  const line = meterStore.lineById(lineId)
  const section = sectionStore.sectionById(row.sectionId)
  const usable = line && section ? line.status === '生效' && isLineEffectiveOn(line, section.measuredAt.slice(0, 10)) : false
  ElMessage.success(
    usable
      ? `测点已改挂 ${line?.certNo} 并按该线重算，恢复参与断面流量`
      : `测点已改挂 ${line?.certNo}；该线在施测日不生效，测点保持挂起`
  )
}

/** el-select change 事件值类型为 unknown，收敛成字符串后改挂 */
function handleSelect(row: ExceptionRow, value: unknown): void {
  if (typeof value === 'string') void assignLine(row, value)
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!meterStore.ready || !sectionStore.ready" :rows="5" animated />

    <template v-else>
      <div class="page__head">
        <div>
          <h2 class="page__title">
            流速仪检定线对账台
            <el-tag size="small" effect="plain">检定室台账 · 巡测组对账</el-tag>
          </h2>
          <p class="gb-hint">
            流速仪每检定一次换一组系数。测点流速按施测日生效的检定线换算；同一测次的测点要在同一条线上。
            检定线换新或撤销后，用过它的测点先挂起、不参与断面流量，由巡测组按测次重算——检定室那份系数记录不动。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="Refresh" @click="openCreate(false)">登记检定线</el-button>
          <el-button type="primary" :icon="Connection" @click="openCreate(true)">检定换新登记</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="检定线" :value="stats.lineCount" suffix="组" icon="Files" />
        <StatBadge label="生效中" :value="stats.activeLineCount" suffix="组" tone="success" icon="CircleCheck" />
        <StatBadge label="挂起测点" :value="stats.suspended" suffix="点" tone="warning" icon="Warning" />
        <StatBadge label="未匹配测点" :value="stats.unmatched" suffix="点" :tone="stats.unmatched ? 'danger' : 'info'" icon="Warning" />
      </div>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>检定室检定线台账</h3>
          <span class="gb-hint">记检定号、生效起止与系数（v = k·n/t + c）；停用 / 撤销不改写任何历史记录</span>
        </div>
        <el-table :data="meterStore.sortedLines" border stripe class="gb-table-compact">
          <el-table-column prop="certNo" label="检定号" min-width="150" />
          <el-table-column prop="meterNo" label="仪器编号" min-width="130" />
          <el-table-column label="生效起" width="120">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.effectiveFrom }}</span>
            </template>
          </el-table-column>
          <el-table-column label="生效止" width="120">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.effectiveTo ?? '至今' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="系数 k" width="100" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.factorK }}</span></template>
          </el-table-column>
          <el-table-column label="常数 c" width="100" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.factorC }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === '生效' ? 'success' : 'info'" effect="plain">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="labName" label="检定单位" min-width="150" show-overflow-tooltip />
          <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip />
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openEdit(row)">编辑</el-button>
              <el-button v-if="row.status === '生效'" size="small" type="warning" plain @click="retire(row)">撤销</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>
            巡测组按测次对账
            <el-tag v-if="stats.suspended + stats.unmatched > 0" type="danger" size="small" effect="plain">
              {{ stats.suspended + stats.unmatched }} 点待处理
            </el-tag>
          </h3>
          <span class="gb-hint">两边按测次日期对账：施测日落在检定线生效区间内才对上；同一测次出现多条线会标黄</span>
        </div>
        <EmptyPanel
          v-if="reconcileRows.length === 0"
          title="还没有测次"
          description="先到测站台账新增断面测次与流速测点，再回来对账。"
          compact
        />
        <el-table v-else :data="reconcileRows" border stripe class="gb-table-compact">
          <el-table-column prop="stationName" label="测站" min-width="120" />
          <el-table-column prop="measureNo" label="测次号" min-width="140" />
          <el-table-column label="施测日" width="110">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.measuredAt.slice(0, 10) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测法" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.method === '流速仪' ? 'primary' : 'info'" effect="plain">{{ row.method }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="流速仪编号" width="140">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.method === '流速仪' ? row.meterNo ?? '未登记' : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测点" width="70" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.total }}</span></template>
          </el-table-column>
          <el-table-column label="已换算" width="80" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.converted }}</span></template>
          </el-table-column>
          <el-table-column label="挂起" width="80" align="right">
            <template #default="{ row }">
              <span class="gb-mono" :class="{ 'page__warn': row.suspended > 0 }">{{ row.suspended }}</span>
            </template>
          </el-table-column>
          <el-table-column label="未匹配" width="80" align="right">
            <template #default="{ row }">
              <span class="gb-mono" :class="{ 'page__danger': row.unmatched > 0 }">{{ row.unmatched }}</span>
            </template>
          </el-table-column>
          <el-table-column label="同线核对" width="100" align="center">
            <template #default="{ row }">
              <el-icon v-if="row.method !== '流速仪'" color="#8194a2"><CircleCheck /></el-icon>
              <el-icon v-else-if="row.split" color="#d68910" size="18"><Warning /></el-icon>
              <el-icon v-else color="#1e8449" size="18"><CircleCheck /></el-icon>
            </template>
          </el-table-column>
          <el-table-column label="施测日应挂检定线" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.method !== '流速仪'" class="gb-hint">不涉及（{{ row.method }}）</span>
              <span v-else :class="{ 'page__danger': !row.expectedLineId }">
                {{ expectedLineLabel(row.measuredAt, row.expectedLineId) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.method === '流速仪'"
                size="small"
                type="primary"
                :icon="Refresh"
                @click="recompute(row)"
              >
                按测次重算
              </el-button>
              <span v-else class="gb-hint">无需对账</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>挂起 / 未匹配测点（单列，不参与断面流量）</h3>
          <span class="gb-hint">检定线撤销或对不上施测日时落到这里；逐点改挂检定线可立即重算</span>
        </div>
        <EmptyPanel
          v-if="exceptionRows.length === 0"
          title="没有挂起或未匹配的测点"
          description="全部流速仪测点都已对上施测日生效的检定线。"
          compact
        />
        <el-table v-else :data="exceptionRows" border class="gb-table-compact">
          <el-table-column prop="stationName" label="测站" width="110" />
          <el-table-column prop="measureNo" label="测次号" width="130" />
          <el-table-column label="垂线" width="70" align="center">
            <template #default="{ row }">#{{ row.verticalNo }}</template>
          </el-table-column>
          <el-table-column label="相对水深" width="90" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.relativeDepth.toFixed(2) }}</span></template>
          </el-table-column>
          <el-table-column label="转数" width="90" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.revolutions ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column label="历时(s)" width="90" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.durationS }}</span></template>
          </el-table-column>
          <el-table-column label="现流速" width="90" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.velocityMs.toFixed(3) }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.linkStatus === '已挂起' ? 'warning' : 'danger'" effect="plain">
                {{ row.linkStatus }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="当前归属" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ lineLabel(row.meterLineId) }}</template>
          </el-table-column>
          <el-table-column label="改挂检定线并重算" min-width="260">
            <template #default="{ row }">
              <el-select
                :model-value="''"
                size="small"
                placeholder="选择检定线"
                filterable
                @change="(value: unknown) => handleSelect(row, value)"
              >
                <el-option
                  v-for="line in lineOptions(row)"
                  :key="line.id"
                  :label="`${line.certNo}｜${line.meterNo}｜${line.effectiveFrom}~${line.effectiveTo ?? '至今'}｜v≈${previewVelocity(row, line.id)}`"
                  :value="line.id"
                />
              </el-select>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑检定线' : isReplacement ? '检定换新登记（旧线自动停用并挂起测点）' : '登记检定线'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-form label-width="104px">
        <el-form-item label="仪器编号" required>
          <el-input v-model="form.meterNo" placeholder="如 LS20-250603" />
        </el-form-item>
        <el-form-item label="检定号" required>
          <el-input v-model="form.certNo" placeholder="如 LS20-2024-118" />
        </el-form-item>
        <el-form-item label="生效起始日" required>
          <el-date-picker v-model="form.effectiveFrom" type="date" placeholder="起始日" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="生效截止日">
          <el-date-picker
            v-model="form.effectiveTo"
            type="date"
            placeholder="留空表示至今生效"
            value-format="YYYY-MM-DD"
          />
        </el-form-item>
        <el-form-item label="斜率 k" required>
          <el-input-number v-model="form.factorK" :min="0.01" :max="5" :step="0.001" :precision="4" controls-position="right" />
        </el-form-item>
        <el-form-item label="常数 c" required>
          <el-input-number v-model="form.factorC" :min="-1" :max="1" :step="0.001" :precision="4" controls-position="right" />
        </el-form-item>
        <el-form-item label="检定单位">
          <el-input v-model="form.labName" placeholder="如 省水文仪器检定中心" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio-button v-for="status in METER_LINE_STATUSES" :key="status" :value="status">{{ status }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : isReplacement ? '登记并停用旧线' : '登记' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__warn {
  color: #d68910;
  font-weight: 700;
}

.page__danger {
  color: #c0392b;
  font-weight: 700;
}
</style>
