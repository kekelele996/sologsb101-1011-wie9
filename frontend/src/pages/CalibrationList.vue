<script setup lang="ts">
/**
 * 模块 7：/calibrations 流速仪检定线台账与测次对账
 * 检定室管线（检定号、生效起止、系数），巡测组按测次日期对账；
 * 换新 / 撤销后挂起的测点由巡测组重算恢复，检定室记录不动。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshLeft, RefreshRight, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useCalibrationStore } from '@/stores/calibrationStore'
import { useStationStore } from '@/stores/stationStore'
import {
  CALIBRATION_STATUS_META,
  POINT_STATUS_META,
  createEmptyCalibrationDraft,
  formatEffectiveRange,
  type CalibrationLine,
  type CalibrationDraft,
  type CalibrationStatus
} from '@/types/calibration'
import { initDatabase } from '@/utils/db'

const calibrationStore = useCalibrationStore()
const stationStore = useStationStore()

const activeTab = ref<'lines' | 'recon' | 'suspended'>('lines')
const filterMeter = ref<string>('')
const filterStatus = ref<CalibrationStatus | ''>('')

const filteredLines = computed<CalibrationLine[]>(() =>
  calibrationStore.lines
    .filter((line) => (filterMeter.value ? line.meterNo === filterMeter.value : true))
    .filter((line) => (filterStatus.value ? line.status === filterStatus.value : true))
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())
)

const statusCounts = computed(() => ({
  active: calibrationStore.lines.filter((line) => line.status === 'active').length,
  replaced: calibrationStore.lines.filter((line) => line.status === 'replaced').length,
  revoked: calibrationStore.lines.filter((line) => line.status === 'revoked').length
}))

/** 挂起测点的展示行：带上测次与垂线信息 */
const suspendedRows = computed(() =>
  calibrationStore.suspendedPoints.map((point) => {
    const vertical = calibrationStore.verticals.find((item) => item.id === point.verticalId) ?? null
    const section = vertical
      ? calibrationStore.sections.find((item) => item.id === vertical.sectionId) ?? null
      : null
    const station = section ? stationStore.stationById(section.stationId) : null
    return { point, vertical, section, stationName: station?.name ?? '—' }
  })
)

/* ------------------------------- 新增 / 编辑 ------------------------------- */

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive<CalibrationDraft>(createEmptyCalibrationDraft())

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyCalibrationDraft())
  dialogVisible.value = true
}

function openEdit(line: CalibrationLine): void {
  editingId.value = line.id
  form.certNo = line.certNo
  form.meterNo = line.meterNo
  form.effectiveFrom = line.effectiveFrom.slice(0, 10)
  form.effectiveTo = line.effectiveTo ? line.effectiveTo.slice(0, 10) : ''
  form.k = line.k
  form.c = line.c
  form.remark = line.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.certNo.trim()) {
    ElMessage.warning('请填写检定号')
    return
  }
  if (!form.meterNo.trim()) {
    ElMessage.warning('请填写流速仪编号')
    return
  }
  if (!form.effectiveFrom) {
    ElMessage.warning('请选择生效起始日期')
    return
  }
  if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) {
    ElMessage.warning('生效截止不能早于生效起始')
    return
  }
  if (!Number.isFinite(form.k) || form.k <= 0) {
    ElMessage.warning('系数 k 应为正数')
    return
  }
  submitting.value = true
  try {
    const payload = {
      certNo: form.certNo.trim(),
      meterNo: form.meterNo.trim(),
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.effectiveTo || null,
      k: form.k,
      c: form.c,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await calibrationStore.updateLine(editingId.value, payload)
      ElMessage.success('检定线已更新')
    } else {
      await calibrationStore.createLine(payload)
      ElMessage.success('检定线已新增')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

/* --------------------------------- 换新 --------------------------------- */

const replaceVisible = ref(false)
const replacing = ref<CalibrationLine | null>(null)
const replaceForm = reactive({ certNo: '', effectiveFrom: '', k: 0.25, c: 0.012, remark: '' })

function openReplace(line: CalibrationLine): void {
  replacing.value = line
  replaceForm.certNo = ''
  replaceForm.effectiveFrom = new Date().toISOString().slice(0, 10)
  replaceForm.k = line.k
  replaceForm.c = line.c
  replaceForm.remark = ''
  replaceVisible.value = true
}

async function submitReplace(): Promise<void> {
  if (!replacing.value) return
  if (!replaceForm.certNo.trim()) {
    ElMessage.warning('请填写新线检定号')
    return
  }
  if (!replaceForm.effectiveFrom) {
    ElMessage.warning('请选择新线生效起始日期')
    return
  }
  try {
    await ElMessageBox.confirm(
      `换新后旧线「${replacing.value.certNo}」置为已换新，用过它的测点将挂起待重算，确认继续？`,
      '换新确认',
      { type: 'warning', confirmButtonText: '换新', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await calibrationStore.replaceLine(replacing.value.id, {
    certNo: replaceForm.certNo.trim(),
    meterNo: replacing.value.meterNo,
    effectiveFrom: replaceForm.effectiveFrom,
    effectiveTo: null,
    k: replaceForm.k,
    c: replaceForm.c,
    remark: replaceForm.remark.trim() || `替代旧线 ${replacing.value.certNo}`
  })
  replaceVisible.value = false
  ElMessage.success(`已换新，${result.suspendedCount} 个测点挂起待重算`)
}

/* --------------------------------- 撤销 --------------------------------- */

async function revoke(line: CalibrationLine): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤销检定线「${line.certNo}」？撤销后用过它的测点挂起、不参与断面流量，需巡测组重算恢复。`,
      '撤销确认',
      { type: 'warning', confirmButtonText: '撤销', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await calibrationStore.revokeLine(line.id)
  ElMessage.success(`已撤销，${result.suspendedCount} 个测点挂起待重算`)
}

async function removeLine(line: CalibrationLine): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除检定线「${line.certNo}」？删除不可恢复。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await calibrationStore.removeLine(line.id)
  ElMessage.success('检定线已删除')
}

/* ------------------------------- 巡测组重算 ------------------------------- */

async function recalculateAll(): Promise<void> {
  const result = await calibrationStore.recalculateAll()
  if (result.reactivated === 0 && result.stillSuspended === 0) {
    ElMessage.info('没有需要重算的挂起测点')
    return
  }
  ElMessage.success(
    `重算完成：${result.reactivated} 个恢复正常（其中 ${result.recomputed} 个已按线系数换算流速），${result.stillSuspended} 个仍对不上、保持挂起`
  )
}

async function backfillAll(): Promise<void> {
  const result = await calibrationStore.backfillAll()
  ElMessage.success(`回填完成：${result.matched} 个测点归属检定线，${result.unmatched} 个对不上已挂起`)
}

function statusMeta(status: CalibrationStatus) {
  return CALIBRATION_STATUS_META[status]
}

function pointStatusMeta(status: 'active' | 'suspended') {
  return POINT_STATUS_META[status]
}

function stationNameOf(stationId: string): string {
  return stationStore.stationById(stationId)?.name ?? '—'
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!calibrationStore.ready" :rows="5" animated />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item>流速仪检定线</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            流速仪检定线
            <el-tag size="small" effect="plain">检定室管线 · 巡测组对账</el-tag>
          </h2>
          <p class="gb-hint">
            流速仪每检定一次换一组系数，检定室记检定号、生效起止与系数；测点流速按施测日生效的检定线换算，
            同一测次的测点在同一条线上。线换新或撤销后，用过它的测点先挂起、不参与断面流量，由巡测组本侧重算，检定室那份不动。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="RefreshLeft" @click="backfillAll">重新回填归属</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增检定线</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="检定线总数" :value="calibrationStore.lines.length" suffix="条" icon="Medal" />
        <StatBadge label="在用" :value="statusCounts.active" suffix="条" tone="success" icon="CircleCheck" />
        <StatBadge label="已换新" :value="statusCounts.replaced" suffix="条" tone="info" icon="RefreshRight" />
        <StatBadge
          label="挂起测点"
          :value="calibrationStore.suspendedCount"
          suffix="点"
          tone="warning"
          icon="Warning"
        />
      </div>

      <el-tabs v-model="activeTab" class="gb-panel">
        <el-tab-pane label="检定线台账" name="lines">
          <div class="page__filters">
            <el-select v-model="filterMeter" placeholder="流速仪编号" clearable size="default" class="page__filter">
              <el-option v-for="meter in calibrationStore.meters" :key="meter" :label="meter" :value="meter" />
            </el-select>
            <el-select
              v-model="filterStatus"
              placeholder="线状态"
              clearable
              size="default"
              class="page__filter"
            >
              <el-option label="在用" value="active" />
              <el-option label="已换新" value="replaced" />
              <el-option label="已撤销" value="revoked" />
            </el-select>
          </div>

          <EmptyPanel
            v-if="filteredLines.length === 0"
            title="还没有检定线"
            description="新增一条流速仪检定线，记录检定号、生效起止与系数；测点录入转数后将按施测日生效的线换算流速。"
            action-text="新增检定线"
            @action="openCreate"
          />

          <el-table v-else :data="filteredLines" border stripe class="gb-table-compact">
            <el-table-column label="检定号" prop="certNo" min-width="140" />
            <el-table-column label="流速仪编号" prop="meterNo" min-width="130">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.meterNo }}</span>
              </template>
            </el-table-column>
            <el-table-column label="生效区间" min-width="200">
              <template #default="{ row }">
                <span class="gb-mono">{{ formatEffectiveRange(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="系数 k" width="100" align="right">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.k }}</span>
              </template>
            </el-table-column>
            <el-table-column label="系数 c" width="100" align="right">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.c }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="statusMeta(row.status).type" size="small" effect="light">
                  {{ statusMeta(row.status).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="备注" prop="remark" min-width="160" show-overflow-tooltip />
            <el-table-column label="操作" width="230" fixed="right">
              <template #default="{ row }">
                <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
                <el-button
                  size="small"
                  type="success"
                  plain
                  :icon="RefreshRight"
                  :disabled="row.status !== 'active'"
                  @click="openReplace(row)"
                >
                  换新
                </el-button>
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :disabled="row.status === 'revoked'"
                  @click="revoke(row)"
                >
                  撤销
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="recon">
          <template #label>
            <span>测次对账</span>
            <el-badge
              v-if="calibrationStore.suspendedCount > 0"
              :value="calibrationStore.suspendedCount"
              class="page__tab-badge"
              type="warning"
            />
          </template>
          <p class="gb-hint">
            按测次日期对账：每个流速仪测次应在施测日生效的同一条检定线上；对不上或线已撤销的测次，其测点单列挂起。
          </p>
          <EmptyPanel
            v-if="calibrationStore.reconRows.length === 0"
            title="暂无流速仪测次"
            description="流速仪法测次录入后，这里会按施测日自动对账。"
          />
          <el-table v-else :data="calibrationStore.reconRows" border stripe class="gb-table-compact">
            <el-table-column label="测次号" prop="section.measureNo" min-width="130" />
            <el-table-column label="测站" min-width="120">
              <template #default="{ row }">{{ stationNameOf(row.section.stationId) }}</template>
            </el-table-column>
            <el-table-column label="流速仪编号" min-width="130">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.section.meterNo || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="施测日期" min-width="120">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.section.measuredAt.slice(0, 10) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="生效检定线" min-width="140">
              <template #default="{ row }">
                <span v-if="row.line" class="gb-mono">{{ row.line.certNo }}</span>
                <el-tag v-else type="warning" size="small" effect="light">对不上</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="测点一致性" width="110">
              <template #default="{ row }">
                <el-tag v-if="row.consistent" type="success" size="small" effect="plain">同一条线</el-tag>
                <el-tag v-else type="danger" size="small" effect="plain">不一致</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="正常 / 挂起" width="110">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.activeCount }} / {{ row.suspendedCount }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="suspended">
          <template #label>
            <span>挂起测点</span>
            <el-badge
              v-if="calibrationStore.suspendedCount > 0"
              :value="calibrationStore.suspendedCount"
              class="page__tab-badge"
              type="warning"
            />
          </template>
          <div class="page__recon-bar">
            <el-alert
              type="warning"
              :closable="false"
              show-icon
              title="挂起测点不参与垂线平均流速与断面流量。由巡测组按测次日期重新匹配检定线、换算流速后恢复；检定室的检定线记录不变。"
            />
            <el-button type="primary" :icon="RefreshLeft" @click="recalculateAll">巡测组重算全部挂起测点</el-button>
          </div>
          <EmptyPanel
            v-if="suspendedRows.length === 0"
            title="没有挂起测点"
            description="所有流速仪测点都已归属到施测日生效的检定线，正常参与断面流量。"
          />
          <el-table v-else :data="suspendedRows" border stripe class="gb-table-compact">
            <el-table-column label="测次号" min-width="130">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.section?.measureNo ?? '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="测站" min-width="120">
              <template #default="{ row }">{{ row.stationName }}</template>
            </el-table-column>
            <el-table-column label="垂线号" width="90">
              <template #default="{ row }">{{ row.vertical?.no ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="相对水深" width="100" align="right">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.point.relativeDepth.toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="现存流速 (m/s)" width="120" align="right">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.point.velocityMs.toFixed(3) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="pointStatusMeta(row.point.status).type" size="small" effect="light">
                  <el-icon><Warning /></el-icon>
                  {{ pointStatusMeta(row.point.status).label }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </template>

    <!-- 新增 / 编辑检定线 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑检定线' : '新增检定线'" width="520px" :close-on-click-modal="false">
      <el-form label-width="120px">
        <el-form-item label="检定号" required>
          <el-input v-model="form.certNo" placeholder="如 检字 2024-018" />
        </el-form-item>
        <el-form-item label="流速仪编号" required>
          <el-input v-model="form.meterNo" placeholder="如 LS25-1/08#" />
        </el-form-item>
        <el-form-item label="生效起始" required>
          <el-date-picker v-model="form.effectiveFrom" type="date" value-format="YYYY-MM-DD" class="page__date" />
        </el-form-item>
        <el-form-item label="生效截止">
          <el-date-picker
            v-model="form.effectiveTo"
            type="date"
            value-format="YYYY-MM-DD"
            class="page__date"
            placeholder="留空表示长期有效"
          />
        </el-form-item>
        <el-form-item label="系数 k" required>
          <el-input-number v-model="form.k" :min="0" :step="0.001" :precision="4" controls-position="right" />
          <span class="page__unit">v = k·转数/历时 + c</span>
        </el-form-item>
        <el-form-item label="系数 c" required>
          <el-input-number v-model="form.c" :step="0.001" :precision="4" controls-position="right" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="检定机构、有效期说明等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 换新 -->
    <el-dialog v-model="replaceVisible" title="检定线换新" width="520px" :close-on-click-modal="false">
      <p v-if="replacing" class="gb-hint">
        旧线 <span class="gb-mono">{{ replacing.certNo }}</span>（{{ replacing.meterNo }}）将置为已换新，
        生效截止落到新线生效前一日；用过旧线的测点挂起待重算。
      </p>
      <el-form label-width="120px">
        <el-form-item label="新检定号" required>
          <el-input v-model="replaceForm.certNo" placeholder="如 检字 2024-025" />
        </el-form-item>
        <el-form-item label="新生效起始" required>
          <el-date-picker v-model="replaceForm.effectiveFrom" type="date" value-format="YYYY-MM-DD" class="page__date" />
        </el-form-item>
        <el-form-item label="系数 k" required>
          <el-input-number v-model="replaceForm.k" :min="0" :step="0.001" :precision="4" controls-position="right" />
        </el-form-item>
        <el-form-item label="系数 c" required>
          <el-input-number v-model="replaceForm.c" :step="0.001" :precision="4" controls-position="right" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="replaceForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="replaceVisible = false">取消</el-button>
        <el-button type="primary" @click="submitReplace">确认换新</el-button>
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

.page__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.page__filter {
  width: 200px;
}

.page__date {
  width: 100%;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__tab-badge {
  margin-left: 6px;
}

.page__recon-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
</style>
