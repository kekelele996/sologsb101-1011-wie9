<script setup lang="ts">
/**
 * 模块 4：/verticals/:id/points 流速测点录入
 * 逐点录入流速与相对水深、批量粘贴导入、按垂线加权算平均流速；
 * 深链访问时垂线不存在给出友好空态。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Edit, MagicStick, Plus, TrendCharts, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useCalibrationStore } from '@/stores/calibrationStore'
import { parsePointPaste } from '@/types/point'
import type { Point } from '@/types/point'
import { convertVelocity, POINT_STATUS_META } from '@/types/calibration'
import { calcMeanVelocity, calcSectionDischarge, activePointRows } from '@/utils/flow'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const calibrationStore = useCalibrationStore()

const verticalId = computed(() => String(route.params.id ?? ''))
const vertical = computed(() => sectionStore.verticals.find((item) => item.id === verticalId.value) ?? null)
const section = computed(() => (vertical.value ? sectionStore.sectionById(vertical.value.sectionId) : null))
const station = computed(() => (section.value ? stationStore.stationById(section.value.stationId) : null))

/** 本测次施测日生效的检定线（流速仪法） */
const effectiveLine = computed(() =>
  section.value && section.value.method === '流速仪'
    ? calibrationStore.effectiveLine(section.value.meterNo, section.value.measuredAt)
    : null
)
const isMeterMethod = computed(() => section.value?.method === '流速仪')

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  relativeDepth: 0.6,
  velocityMs: 0.5,
  weight: 1,
  durationS: 100,
  revolutions: null as number | null
})

const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])

const bulkVelocity = ref<number | null>(null)

const points = computed(() => sectionStore.pointsOfVertical(verticalId.value))
/** 挂起测点不参与垂线平均流速 */
const activePoints = computed(() => points.value.filter((point) => point.status !== 'suspended'))
const meanVelocityMs = computed(() => calcMeanVelocity(activePointRows(points.value)))
const suspendedCount = computed(() => points.value.filter((point) => point.status === 'suspended').length)

/** 由转数按生效检定线换算的流速（流速仪法） */
const convertedVelocity = computed(() => {
  if (!effectiveLine.value || form.revolutions === null || !Number.isFinite(form.revolutions)) return null
  return convertVelocity(form.revolutions, form.durationS, effectiveLine.value)
})

/** 该垂线所在断面的流量成果（挂起测点不参与） */
const discharge = computed(() => {
  if (!section.value) return null
  const rows = sectionStore.verticalsOfSection(section.value.id).map((item) => {
    const itemPoints = sectionStore.pointsOfVertical(item.id)
    return {
      id: item.id,
      no: item.no,
      startDistanceM: item.startDistanceM,
      depthM: item.depthM,
      meanVelocityMs: calcMeanVelocity(activePointRows(itemPoints))
    }
  })
  return calcSectionDischarge(rows)
})

/** 本垂线的部分流量 */
const verticalPartialFlow = computed(() => {
  if (!discharge.value || !vertical.value) return 0
  const slice = discharge.value.slices.find((item) => item.id === vertical.value?.id)
  return slice ? slice.partialFlow : 0
})

/** 流速分布图坐标：相对水深为纵轴、流速为横轴（挂起点不参与） */
const chartPoints = computed(() => {
  const rows = activePoints.value
  const maxVelocity = Math.max(0.1, ...rows.map((point) => point.velocityMs))
  const width = 320
  const height = 200
  return rows.map((point) => ({
    ...point,
    cx: 40 + (point.velocityMs / maxVelocity) * (width - 60),
    cy: 20 + point.relativeDepth * (height - 50)
  }))
})

function openCreate(): void {
  editingId.value = null
  const used = points.value.map((point) => point.relativeDepth)
  const candidates = [0.2, 0.6, 0.8, 0.4, 1.0, 0.0]
  form.relativeDepth = candidates.find((value) => !used.some((item) => Math.abs(item - value) < 0.001)) ?? 0.5
  form.velocityMs = points.value.length > 0 ? points.value[0].velocityMs : 0.5
  form.weight = Number((1 / Math.max(1, points.value.length + 1)).toFixed(4))
  form.durationS = 100
  form.revolutions = null
  dialogVisible.value = true
}

function openEdit(point: Point): void {
  editingId.value = point.id
  form.relativeDepth = point.relativeDepth
  form.velocityMs = point.velocityMs
  form.weight = point.weight
  form.durationS = point.durationS
  form.revolutions = point.revolutions
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!Number.isFinite(form.relativeDepth) || form.relativeDepth < 0 || form.relativeDepth > 1) {
    ElMessage.warning('相对水深应在 0 ~ 1 之间（0 为水面、1 为河底）')
    return
  }
  if (!Number.isFinite(form.velocityMs) || form.velocityMs < 0 || form.velocityMs > 12) {
    ElMessage.warning('流速应在 0 ~ 12 m/s 之间')
    return
  }
  if (!Number.isFinite(form.durationS) || form.durationS <= 0) {
    ElMessage.warning('测速历时应为正数（s）')
    return
  }
  if (isMeterMethod.value && (form.revolutions === null || !Number.isFinite(form.revolutions))) {
    ElMessage.warning('流速仪法请填写转数，流速按施测日生效检定线换算')
    return
  }
  submitting.value = true
  try {
    // 流速仪法：流速由转数按生效线换算，覆盖表单手填值
    const payload = { ...form, calibrationId: null, status: 'active' as const }
    if (isMeterMethod.value && effectiveLine.value && form.revolutions !== null) {
      payload.velocityMs = convertVelocity(form.revolutions, form.durationS, effectiveLine.value)
    }
    if (editingId.value) {
      await sectionStore.updatePoint(editingId.value, { ...payload })
      ElMessage.success('测点已更新')
    } else {
      await sectionStore.createPoint(verticalId.value, { ...payload })
      ElMessage.success('测点已新增')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removePoint(point: Point): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除相对水深 ${point.relativeDepth} 处的测点？删除后垂线平均流速与断面流量会重新计算。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.removePoint(point.id)
  ElMessage.success('测点已删除')
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteVisible.value = true
}

/** 解析并预览批量粘贴内容 */
function previewPaste(): void {
  const parsed = parsePointPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「相对水深,流速[,历时]」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parsePointPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行数据覆盖该垂线现有 ${points.value.length} 个测点，确认导入？`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await sectionStore.importPointDrafts(verticalId.value, parsed.rows)
  pasteVisible.value = false
  ElMessage.success(`已导入 ${count} 个测点，垂线平均流速已重算`)
}

async function applyBulkVelocity(): Promise<void> {
  if (bulkVelocity.value === null || !Number.isFinite(bulkVelocity.value)) {
    ElMessage.warning('请填写要批量写入的流速值')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将该垂线全部 ${points.value.length} 个测点的流速统一改写为 ${bulkVelocity.value} m/s？`,
      '批量改写确认',
      { type: 'warning', confirmButtonText: '改写', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await sectionStore.bulkSetVelocity(verticalId.value, bulkVelocity.value)
  ElMessage.success(`已改写 ${count} 个测点流速`)
}

async function doNormalize(): Promise<void> {
  const count = await sectionStore.normalizeWeights(verticalId.value)
  ElMessage.success(`已按 ${count} 个测点平均分配计算权重`)
}

/** 挂起行高亮 */
function rowClassName({ row }: { row: Point }): string {
  return row.status === 'suspended' ? 'gb-row-suspended' : ''
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  sectionStore.selectVertical(verticalId.value)
  calibrationStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!sectionStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!vertical"
      entity-label="垂线"
      :missing-id="verticalId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        sectionStore.verticals.slice(0, 3).map((item) => ({
          id: item.id,
          label: `垂线 ${item.no} 的测点`,
          path: `/verticals/${item.id}/points`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="section" :to="{ path: `/stations/${section.stationId}/sections` }">
              {{ station?.name ?? '测站' }} 断面测次
            </el-breadcrumb-item>
            <el-breadcrumb-item v-if="section" :to="{ path: `/sections/${section.id}/verticals` }">
              测次 {{ section.measureNo }} 垂线
            </el-breadcrumb-item>
            <el-breadcrumb-item>流速测点</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            垂线 {{ vertical.no }} · 流速测点录入
            <el-tag size="small" effect="plain">起点距 {{ vertical.startDistanceM.toFixed(1) }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">水深 {{ vertical.depthM.toFixed(2) }} m</el-tag>
          </h2>
          <p class="gb-hint">
            逐点录入相对水深与转数，流速按施测日生效检定线换算；挂起测点不参与垂线平均流速与断面流量。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="MagicStick" @click="doNormalize">权重归一</el-button>
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增测点</el-button>
        </div>
      </div>

      <el-alert
        v-if="isMeterMethod"
        class="page__line-bar"
        :type="effectiveLine ? 'success' : 'warning'"
        :closable="false"
        show-icon
      >
        <template #title>
          <template v-if="effectiveLine">
            本测次施测日（{{ section?.measuredAt.slice(0, 10) }}）生效检定线：
            <span class="gb-mono">{{ effectiveLine.certNo }}</span>
            （{{ effectiveLine.meterNo }}，{{ effectiveLine.effectiveFrom.slice(0, 10) }} ~
            {{ effectiveLine.effectiveTo ? effectiveLine.effectiveTo.slice(0, 10) : '长期' }}），
            系数 k={{ effectiveLine.k }}、c={{ effectiveLine.c }}，流速 v = k·转数/历时 + c。
          </template>
          <template v-else>
            本测次（{{ section?.meterNo || '未填流速仪编号' }}）在施测日没有生效的检定线，
            测点将挂起、不参与断面流量；请先到「流速仪检定线」核对或补录，再由巡测组重算。
          </template>
        </template>
      </el-alert>

      <div class="gb-stats-row">
        <StatBadge label="测点数" :value="points.length" suffix="点" icon="DataLine" />
        <StatBadge label="垂线平均流速" :value="meanVelocityMs.toFixed(3)" suffix="m/s" tone="success" icon="TrendCharts" />
        <StatBadge label="部分流量" :value="verticalPartialFlow.toFixed(3)" suffix="m³/s" tone="info" icon="Histogram" />
        <StatBadge
          label="断面流量"
          :value="discharge ? discharge.flowM3s.toFixed(2) : '—'"
          suffix="m³/s"
          tone="warning"
          icon="Odometer"
        />
        <StatBadge
          v-if="suspendedCount > 0"
          label="挂起测点"
          :value="suspendedCount"
          suffix="点"
          tone="warning"
          icon="Warning"
        />
      </div>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>批量录入</h3>
          <span class="gb-hint">适合野外手记数据一次性录入：改写流速或按「相对水深,流速[,历时]」整行导入。</span>
        </div>
        <div class="page__bulk">
          <el-input-number v-model="bulkVelocity" :min="0" :max="12" :step="0.01" :precision="3" :controls="false" placeholder="统一流速 m/s" class="page__bulk-input" />
          <el-button @click="applyBulkVelocity">批量改写流速</el-button>
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴导入</el-button>
        </div>
      </el-card>

      <EmptyPanel
        v-if="points.length === 0"
        title="该垂线还没有流速测点"
        description="新增测点或使用批量粘贴导入；也可以在上一页把测点数改为 2 / 3 / 5 点法自动生成测点行。"
        action-text="新增测点"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <div v-else class="page__grid">
        <el-table :data="points" border stripe class="gb-table-compact" :row-class-name="rowClassName">
          <el-table-column label="相对水深" width="100" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.relativeDepth.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="转数" width="90" align="right">
            <template #default="{ row }">
              <span v-if="row.revolutions !== null" class="gb-mono">{{ row.revolutions }}</span>
              <span v-else class="gb-mono page__muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="测点流速 (m/s)" width="130" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.velocityMs.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="计算权重" width="100" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.weight.toFixed(4) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测速历时 (s)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.durationS }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag
                v-if="row.status === 'suspended'"
                :type="POINT_STATUS_META.suspended.type"
                size="small"
                effect="light"
              >
                挂起
              </el-tag>
              <el-tag v-else :type="POINT_STATUS_META.active.type" size="small" effect="plain">正常</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="加权贡献" align="right" min-width="110">
            <template #default="{ row }">
              <span class="gb-mono">{{ (row.velocityMs * row.weight).toFixed(4) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" type="danger" plain :icon="Delete" @click="removePoint(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-card shadow="never" class="page__chart-card">
          <div class="gb-panel-title">
            <h3>垂线流速分布</h3>
            <span class="gb-hint">纵轴相对水深、横轴流速</span>
          </div>
          <svg viewBox="0 0 340 220" class="page__chart">
            <line x1="40" y1="20" x2="40" y2="180" stroke="#b9cfdd" stroke-width="1" />
            <line x1="40" y1="180" x2="320" y2="180" stroke="#b9cfdd" stroke-width="1" />
            <text x="6" y="24" class="gb-chart-axis">0.0</text>
            <text x="6" y="184" class="gb-chart-axis">1.0</text>
            <text x="270" y="198" class="gb-chart-axis">v (m/s)</text>
            <polyline
              :points="chartPoints.map((point) => `${point.cx},${point.cy}`).join(' ')"
              fill="none"
              stroke="#0f4c75"
              stroke-width="2"
            />
            <circle
              v-for="point in chartPoints"
              :key="point.id"
              :cx="point.cx"
              :cy="point.cy"
              r="4"
              fill="#7fd1e8"
              stroke="#0f4c75"
            />
          </svg>
        </el-card>
      </div>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑流速测点' : '新增流速测点'" width="520px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="相对水深" required>
          <el-slider v-model="form.relativeDepth" :min="0" :max="1" :step="0.05" show-input />
          <span class="page__unit">0 水面 · 1 河底</span>
        </el-form-item>
        <el-form-item v-if="isMeterMethod" label="转数" required>
          <el-input-number v-model="form.revolutions" :min="0" :step="1" :precision="0" controls-position="right" placeholder="测速历时内转数" />
          <span class="page__unit">转</span>
        </el-form-item>
        <el-form-item label="测点流速" required>
          <el-input-number
            v-model="form.velocityMs"
            :min="0"
            :max="12"
            :step="0.01"
            :precision="3"
            controls-position="right"
            :readonly="isMeterMethod && !!effectiveLine"
          />
          <span class="page__unit">m/s</span>
          <span v-if="isMeterMethod && effectiveLine" class="page__convert">
            按 {{ effectiveLine.certNo }} 换算：
            <span class="gb-mono">{{ convertedVelocity !== null ? convertedVelocity.toFixed(3) : '—' }}</span> m/s
          </span>
        </el-form-item>
        <el-form-item label="计算权重" required>
          <el-input-number v-model="form.weight" :min="0" :max="1" :step="0.01" :precision="4" controls-position="right" />
        </el-form-item>
        <el-form-item label="测速历时" required>
          <el-input-number v-model="form.durationS" :min="1" :max="3600" controls-position="right" />
          <span class="page__unit">s</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增测点' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入测点" width="620px">
      <p class="gb-hint">
        每行一条，格式「相对水深,流速[,历时]」，逗号 / 空格 / 制表符均可。示例：<br />
        <span class="gb-mono">0.2,1.42,100</span><br />
        <span class="gb-mono">0.6 1.18 100</span><br />
        <span class="gb-mono">0.8,0.96</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="0.2,1.42,100" />
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">覆盖导入</el-button>
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

.page__bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.page__bulk-input {
  width: 180px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(420px, 1.4fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 220px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__line-bar {
  margin: 0;
}

.page__muted {
  color: #b0bec5;
}

.page__convert {
  margin-left: 12px;
  font-size: 12px;
  color: #0f4c75;
}

:deep(.gb-row-suspended) {
  background: #fdf6ec !important;
  color: #b88230;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
}

@media (max-width: 1080px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
