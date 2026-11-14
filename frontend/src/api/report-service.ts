import { listRows, reloadRows, saveRows } from '@/data/local-store'
import { moduleMeta } from '@/api/local-service'
import {
  allPendingGenerations,
  allPushBatches,
  allSnapshots,
  emptyAttachment,
  freezeChart,
  getTemplateState,
  hasSeededReports,
  initialHistory,
  markReportsSeeded,
  normalizeSnapshot,
  publishedChartRows,
  reloadReportStore,
  savePendingGenerations,
  savePushBatches,
  saveSnapshots,
  setTemplateState,
  templateContentOf,
} from '@/data/report-store'
import type {
  AttachmentState,
  ChannelDeliverySummary,
  FrozenChart,
  FrozenChannel,
  FrozenChartView,
  PendingGeneration,
  PushBatch,
  RecipientResult,
  ReportExportFile,
  ReportSnapshot,
  SnapshotAction,
  SnapshotStatus,
  SnapshotView,
  TemplateHistoryEntry,
  TemplateState,
} from '@/data/report-types'
import type { ActionResult, EntryRow } from '@/data/types'

// 报告生成服务：模板只读、快照固化、推送批次旁路记录，三类记录各自持久化。

const TEMPLATE_KEY = 'reportgen'
const CHART_KEY = 'chart'

const TEMPLATE_FIELDS = moduleMeta(TEMPLATE_KEY).fields

/** 快照生命周期：只能按顺序前进，撤回后可以恢复，任何切换都会写入版本。 */
const SNAPSHOT_TRANSITIONS: Record<
  SnapshotAction,
  { from: SnapshotStatus; to: SnapshotStatus; label: string }
> = {
  提交审核: { from: '草稿', to: '待审核', label: '提交审核' },
  撤回审核: { from: '待审核', to: '草稿', label: '撤回审核' },
  生效发布: { from: '待审核', to: '已生效', label: '生效发布' },
  撤回发布: { from: '已生效', to: '已撤回', label: '撤回发布' },
  恢复发布: { from: '已撤回', to: '已生效', label: '恢复发布' },
}

const PERMANENT_BOUNCE = ['bounce', '退信', '失效']

/** 模板生命周期：草稿 → 待审核 → 已生效 → 已停用，撤回可回退，任何切换都推进模板版本。 */
const TEMPLATE_TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  提交审核: { from: ['草稿'], to: '待审核' },
  撤回审核: { from: ['待审核'], to: '草稿' },
  生效发布: { from: ['待审核'], to: '已生效' },
  停用模板: { from: ['已生效'], to: '已停用' },
  恢复启用: { from: ['已停用'], to: '已生效' },
}

export const TEMPLATE_ACTIONS = Object.keys(TEMPLATE_TRANSITIONS)

/** 每个渠道的接收范围固定在快照里；推送结果只写批次，不动快照。 */
const CHANNEL_ADDRESS_BOOK: Record<string, string[]> = {
  企业微信: ['张伟@corp', '李娜@corp', '王强@corp', 'ops-bounce@corp'],
  邮件: ['finance@example.com', 'ceo-office@example.com', 'data-team@example.com', 'ops-bounce@example.com'],
  钉钉: ['增长运营组', '财务分析组', '运维值班组'],
  飞书: ['经营分析组', '数据平台组'],
  短信: ['13800000001', '13800000002', '13800000003', '13800000004'],
}

export type GenerateInput = {
  templateId: number
  period?: string
  operator: string
}

export type GenerateOutcome = {
  ok: boolean
  queued: boolean
  message: string
  snapshotId: string
  pendingId: string
}

export type ListSnapshotResult = {
  snapshots: ReportSnapshot[]
  pending: PendingGeneration[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function stableHash(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000003
  }
  return hash
}

function splitList(value: string): string[] {
  return value
    .split(/[,，、;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
}

function enabled(value: string): boolean {
  return ['开启', '开', '是', '启用', 'true', '1'].includes(value.trim().toLowerCase())
}

function validPeriod(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})$/.exec(value.trim())
  if (!matched) {
    return false
  }
  const month = Number(matched[2])
  return month >= 1 && month <= 12
}

function templateRow(templateId: number): EntryRow | undefined {
  return listRows(TEMPLATE_KEY).find((row) => Number(row.id) === templateId)
}

function chartRowByCode(code: string): EntryRow | undefined {
  return listRows(CHART_KEY).find((row) => String(row['图表编号']) === code)
}

function templateVersion(templateId: number): number {
  return getTemplateState(templateId)?.revision ?? 1
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
}

/** 生成前的冲突检查：同模板 + 同周期只要还有未撤回的版本，就只保留那完整的一份。 */
function activeSnapshotFor(templateId: number, period: string): ReportSnapshot | undefined {
  return allSnapshots().find(
    (snapshot) =>
      snapshot.templateId === templateId && snapshot.period === period && snapshot.status !== '已撤回',
  )
}

function nextVersion(templateId: number, period: string): number {
  const versions = allSnapshots()
    .filter((snapshot) => snapshot.templateId === templateId && snapshot.period === period)
    .map((snapshot) => snapshot.version)
  return (versions.length === 0 ? 0 : Math.max(...versions)) + 1
}

export function listSnapshots(): ListSnapshotResult {
  return { snapshots: allSnapshots(), pending: allPendingGenerations() }
}

export function findSnapshot(snapshotId: string): ReportSnapshot | undefined {
  return allSnapshots().find((snapshot) => snapshot.id === snapshotId)
}

export function generateSnapshot(input: GenerateInput): GenerateOutcome {
  // 先丢弃内存缓存，按 localStorage 最新内容判断冲突，模拟两个用户同时操作同一模板。
  reloadRows()
  reloadReportStore()

  const row = templateRow(input.templateId)
  if (!row) {
    return { ok: false, queued: false, message: `没有找到编号为 ${input.templateId} 的报告模板`, snapshotId: '', pendingId: '' }
  }
  const templateCode = String(row['模板编号'] ?? '')
  const templateName = String(row['模板名称'] ?? '')
  const period = (input.period ?? String(row['报告周期'] ?? '')).trim()
  if (!validPeriod(period)) {
    return { ok: false, queued: false, message: '报告周期必须是 YYYY-MM 格式', snapshotId: '', pendingId: '' }
  }

  const existing = activeSnapshotFor(input.templateId, period)
  if (existing) {
    const duplicate = allPendingGenerations().find(
      (item) =>
        item.templateId === input.templateId && item.period === period && item.status === '待处理',
    )
    if (duplicate) {
      return {
        ok: true,
        queued: true,
        message: `模板 ${templateCode} 的 ${period} 报告已有待处理任务 ${duplicate.id}，继续保留一份完整版本 ${existing.id}`,
        snapshotId: '',
        pendingId: duplicate.id,
      }
    }
    const pending: PendingGeneration = {
      id: `PEND-${templateCode}-${period}-${nowIso().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
      templateId: input.templateId,
      templateCode,
      templateName,
      period,
      requestedAt: nowIso(),
      requestedBy: input.operator,
      blockedBySnapshotId: existing.id,
      status: '待处理',
      processedSnapshotId: '',
      processedAt: '',
      note: `与 ${existing.id} 属于同模板同周期，保留一份完整版本；另一份进入待处理，不拼接内容`,
    }
    savePendingGenerations([...allPendingGenerations(), pending])
    return {
      ok: true,
      queued: true,
      message: `模板 ${templateCode} 的 ${period} 报告已有完整版本 ${existing.id}，本次请求进入待处理（${pending.id}），不会覆盖或拼接`,
      snapshotId: '',
      pendingId: pending.id,
    }
  }

  const snapshot = buildSnapshot(row, period, input.operator)
  if (!snapshot.ok) {
    return { ok: false, queued: false, message: snapshot.message, snapshotId: '', pendingId: '' }
  }
  saveSnapshots([...allSnapshots(), snapshot.snapshot])
  return {
    ok: true,
    queued: false,
    message: `已固化报告快照 ${snapshot.snapshot.id}（${period}，v${snapshot.snapshot.version}）`,
    snapshotId: snapshot.snapshot.id,
    pendingId: '',
  }
}

function buildSnapshot(
  row: EntryRow,
  period: string,
  operator: string,
): { ok: true; snapshot: ReportSnapshot } | { ok: false; message: string } {
  const templateId = Number(row.id)
  const templateCode = String(row['模板编号'] ?? '')
  const templateName = String(row['模板名称'] ?? '')
  const exported = String(row['导出格式'] ?? '').trim() || 'PDF'
  const content = templateContentOf(row, TEMPLATE_FIELDS)
  const version = nextVersion(templateId, period)
  const createdAt = nowIso()
  const snapshotId = `SNAP-${templateCode}-${period}-v${version}`

  const chartCodes = splitList(String(row['包含图表'] ?? ''))
  if (chartCodes.length === 0) {
    return { ok: false, message: '模板未配置包含图表，无法生成报告快照' }
  }

  const charts: FrozenChart[] = chartCodes.map((code, index) => freezeChart(chartRowByCode(code) ?? null, code, index + 1, createdAt))
  const unavailableItems = charts
    .filter((chart) => !chart.available)
    .map((chart) => `#${chart.order} ${chart.chartCode} ${chart.name}：${chart.unavailableReason}`)

  const channelNames = splitList(String(row['推送渠道'] ?? ''))
  const channels: FrozenChannel[] = channelNames.map((name) => ({
    name,
    recipients: CHANNEL_ADDRESS_BOOK[name] ?? [`${name}-值班组`, `${name}-运营组`],
  }))

  const blockers: string[] = []
  if (unavailableItems.length > 0) {
    blockers.push(`包含 ${unavailableItems.length} 个不可用图表，需先处理才能发布：${unavailableItems.join('；')}`)
  }
  if (channels.length === 0) {
    blockers.push('模板未配置推送渠道，无法完成发布后的分发')
  }

  const watermarkEnabled = enabled(String(row['水印开关'] ?? ''))
  const watermarkText = watermarkEnabled
    ? `内部资料 · ${operator} · ${period} · ${snapshotId} · ${createdAt}`
    : ''

  const attachmentEnabled = enabled(String(row['附件压缩'] ?? ''))
  const attachment = emptyAttachment(
    attachmentEnabled,
    attachmentEnabled ? `${safeName(templateName)}-${period}-附件.zip` : '',
  )
  attachment.sizeKb = attachmentEnabled ? charts.length * 4200 + 1200 : 0

  return {
    ok: true,
    snapshot: {
      id: snapshotId,
      templateId,
      templateCode,
      templateName,
      templateRevision: templateVersion(templateId),
      templateStatusAtSnapshot: String(row.status),
      templateSnapshot: content,
      period,
      version,
      revision: 1,
      status: '草稿',
      createdAt,
      generatedAt: createdAt,
      updatedAt: createdAt,
      operator,
      exportFormat: exported,
      watermarkEnabled,
      watermarkText,
      charts,
      channels,
      unavailableItems,
      attachment,
      history: initialHistory('草稿', 1, createdAt, operator, `从模板 ${templateCode}（v${templateVersion(templateId)}）固化报告内容`),
      blockers,
    },
  }
}

export function processPendingGeneration(pendingId: string, operator: string): GenerateOutcome {
  reloadRows()
  reloadReportStore()
  const pending = allPendingGenerations().find((item) => item.id === pendingId)
  if (!pending) {
    return { ok: false, queued: false, message: `没有找到待处理任务 ${pendingId}`, snapshotId: '', pendingId: '' }
  }
  if (pending.status !== '待处理') {
    return { ok: false, queued: false, message: `待处理任务 ${pendingId} 已经处理完成`, snapshotId: pending.processedSnapshotId, pendingId }
  }
  const existing = activeSnapshotFor(pending.templateId, pending.period)
  if (existing) {
    return {
      ok: false,
      queued: true,
      message: `完整版本 ${existing.id} 仍处于「${existing.status}」，优先保留这份版本；撤回它之后才能处理待处理任务 ${pendingId}`,
      snapshotId: '',
      pendingId,
    }
  }
  const row = templateRow(pending.templateId)
  if (!row) {
    return { ok: false, queued: false, message: `待处理任务的模板 ${pending.templateCode} 已不存在`, snapshotId: '', pendingId }
  }
  const built = buildSnapshot(row, pending.period, operator)
  if (!built.ok) {
    return { ok: false, queued: false, message: built.message, snapshotId: '', pendingId }
  }
  const nextPending = allPendingGenerations().map((item) =>
    item.id === pendingId
      ? { ...item, status: '已处理' as const, processedSnapshotId: built.snapshot.id, processedAt: nowIso() }
      : item,
  )
  savePendingGenerations(nextPending)
  saveSnapshots([...allSnapshots(), built.snapshot])
  return {
    ok: true,
    queued: false,
    message: `待处理任务 ${pendingId} 已生成独立完整版本 ${built.snapshot.id}（v${built.snapshot.version}）`,
    snapshotId: built.snapshot.id,
    pendingId,
  }
}

export function applySnapshotAction(
  snapshotId: string,
  action: SnapshotAction,
  operator: string,
): ActionResult {
  reloadRows()
  reloadReportStore()
  const snapshot = findSnapshot(snapshotId)
  if (!snapshot) {
    return { ok: false, message: `没有找到报告快照 ${snapshotId}` }
  }
  const transition = SNAPSHOT_TRANSITIONS[action]
  if (!transition) {
    return { ok: false, message: `报告快照没有登记「${action}」这个动作` }
  }
  if (snapshot.status !== transition.from) {
    return { ok: false, message: `报告快照当前「${snapshot.status}」，按顺序只能从「${transition.from}」执行「${action}」` }
  }
  if ((action === '生效发布' || action === '恢复发布') && snapshot.blockers.length > 0) {
    return { ok: false, message: `发布被阻止：${snapshot.blockers.join('；')}` }
  }
  if (action === '恢复发布') {
    // 撤回期间别人可能已为同模板同周期生成了另一份完整版本，恢复必须先让路，避免两份并存。
    const conflicting = allSnapshots().find(
      (item) =>
        item.id !== snapshot.id &&
        item.templateId === snapshot.templateId &&
        item.period === snapshot.period &&
        item.status !== '已撤回',
    )
    if (conflicting) {
      return {
        ok: false,
        message: `模板 ${snapshot.templateCode} 的 ${snapshot.period} 已有完整版本 ${conflicting.id}（${conflicting.status}），不能再恢复 ${snapshot.id}`,
      }
    }
  }
  const at = nowIso()
  const revision = snapshot.revision + 1
  const updated: ReportSnapshot = normalizeSnapshot({
    ...snapshot,
    status: transition.to,
    revision,
    updatedAt: at,
    history: [
      ...snapshot.history,
      {
        seq: snapshot.history.length + 1,
        revision,
        action,
        fromStatus: snapshot.status,
        toStatus: transition.to,
        at,
        by: operator,
        note: action === '撤回发布' ? '撤回后保留固化内容与历史推送批次，可恢复' : `状态版本推进到 v${revision}`,
      },
    ],
  })
  saveSnapshots(allSnapshots().map((item) => (item.id === snapshotId ? updated : item)))
  return { ok: true, message: `报告快照 ${snapshotId} 已${action}，状态「${transition.to}」，生命周期版本 v${revision}` }
}

export function riskyChartsOf(snapshot: ReportSnapshot): FrozenChartView[] {
  return snapshot.charts.map((chart) => {
    const current = chart.chartId === null ? undefined : listRows(CHART_KEY).find((row) => Number(row.id) === chart.chartId)
    const currentStatus = current ? String(current.status) : '已不存在'
    return {
      ...chart,
      currentStatus,
      changedSinceSnapshot: currentStatus !== chart.statusAtSnapshot,
    }
  })
}

export function deliverySummaryOf(snapshot: ReportSnapshot): ChannelDeliverySummary[] {
  return snapshot.channels.map((channel) => {
    const batches = allPushBatches().filter(
      (batch) => batch.snapshotId === snapshot.id && batch.channel === channel.name,
    )
    const attemptSet = batches.map((batch) => batch.attempt)
    const delivered = new Set<string>()
    for (const batch of batches) {
      for (const result of batch.recipients) {
        if (result.status === '已送达') {
          delivered.add(result.recipient)
        }
      }
    }
    const deliveredList = channel.recipients.filter((recipient) => delivered.has(recipient))
    const failedList = channel.recipients.filter((recipient) => !delivered.has(recipient) && attemptSet.length > 0)
    const pendingList = channel.recipients.filter((recipient) => !delivered.has(recipient) && attemptSet.length === 0)
    let status: ChannelDeliverySummary['status'] = '未推送'
    if (attemptSet.length > 0) {
      if (deliveredList.length === channel.recipients.length) {
        status = '成功'
      } else if (deliveredList.length === 0) {
        status = '失败'
      } else {
        status = '部分成功'
      }
    }
    const latest = batches.length > 0 ? batches[batches.length - 1] : undefined
    return {
      channel: channel.name,
      recipients: channel.recipients,
      delivered: deliveredList,
      failed: failedList,
      pending: pendingList,
      attempts: attemptSet.length,
      lastBatchId: latest?.id ?? '',
      status,
    }
  })
}

export function pushSnapshotChannel(snapshotId: string, channelName: string, operator: string): ActionResult {
  reloadReportStore()
  const snapshot = findSnapshot(snapshotId)
  if (!snapshot) {
    return { ok: false, message: `没有找到报告快照 ${snapshotId}` }
  }
  if (snapshot.status !== '已生效') {
    return { ok: false, message: `报告快照当前「${snapshot.status}」，只有已生效的报告可以推送` }
  }
  const channel = snapshot.channels.find((item) => item.name === channelName)
  if (!channel) {
    return { ok: false, message: `快照 ${snapshotId} 没有固化推送渠道「${channelName}」` }
  }
  const previous = allPushBatches().filter(
    (batch) => batch.snapshotId === snapshotId && batch.channel === channelName,
  )
  const attempt = previous.length + 1
  const deliveredBefore = new Set<string>()
  for (const batch of previous) {
    for (const result of batch.recipients) {
      if (result.status === '已送达') {
        deliveredBefore.add(result.recipient)
      }
    }
  }
  const remaining = channel.recipients.filter((recipient) => !deliveredBefore.has(recipient))
  if (remaining.length === 0) {
    return { ok: true, message: `渠道「${channelName}」的接收人已全部送达，无需重试` }
  }
  const results: RecipientResult[] = remaining.map((recipient) => {
    const bounced = PERMANENT_BOUNCE.some((marker) => recipient.includes(marker))
    const transient = attempt === 1 && stableHash(recipient) % 3 === 0
    if (bounced) {
      return { recipient, status: '失败', detail: '地址退信，重试无法送达' }
    }
    if (transient) {
      return { recipient, status: '失败', detail: '网关超时，可重试' }
    }
    return { recipient, status: '已送达', detail: `第 ${attempt} 次推送送达` }
  })
  const delivered = results.filter((result) => result.status === '已送达').length
  const failed = results.length - delivered
  const status: PushBatch['status'] = delivered === 0 ? '失败' : failed === 0 ? '成功' : '部分成功'
  const startedAt = nowIso()
  const batch: PushBatch = {
    id: `PUSH-${snapshotId}-${safeName(channelName)}-${attempt}`,
    snapshotId,
    channel: channelName,
    attempt,
    status,
    recipients: results,
    deliveredCount: delivered,
    failedCount: failed,
    startedAt,
    finishedAt: nowIso(),
    message: `第 ${attempt} 次推送：${delivered} 人送达，${failed} 人失败`,
  }
  savePushBatches([...allPushBatches(), batch])
  return {
    ok: true,
    message: `渠道「${channelName}」第 ${attempt} 次推送完成：${batch.message}；快照 ${snapshotId} 的图表顺序与取值未改变`,
  }
}

export function pushRemainingChannels(snapshotId: string, operator: string): ActionResult {
  const snapshot = findSnapshot(snapshotId)
  if (!snapshot) {
    return { ok: false, message: `没有找到报告快照 ${snapshotId}` }
  }
  const summaries = deliverySummaryOf(snapshot)
  const targets = summaries.filter((summary) => summary.status !== '成功').map((summary) => summary.channel)
  if (targets.length === 0) {
    return { ok: true, message: '所有渠道都已送达，没有需要继续的渠道' }
  }
  const messages: string[] = []
  for (const channel of targets) {
    const result = pushSnapshotChannel(snapshotId, channel, operator)
    messages.push(result.message)
    if (!result.ok) {
      break
    }
  }
  return { ok: true, message: messages.join('；') }
}

export function compressAttachment(snapshotId: string, operator: string): ActionResult {
  reloadReportStore()
  const snapshot = findSnapshot(snapshotId)
  if (!snapshot) {
    return { ok: false, message: `没有找到报告快照 ${snapshotId}` }
  }
  if (!snapshot.attachment.enabled) {
    return { ok: false, message: '该快照未开启附件压缩' }
  }
  if (snapshot.attachment.status === '已完成') {
    return { ok: true, message: `附件 ${snapshot.attachment.filename} 已压缩完成，无需重试` }
  }
  const attempts = snapshot.attachment.attempts + 1
  const at = nowIso()
  let attachment: AttachmentState
  if (attempts === 1 && snapshot.attachment.sizeKb > 8192) {
    attachment = {
      ...snapshot.attachment,
      status: '压缩失败',
      attempts,
      lastError: `附件原始体积 ${snapshot.attachment.sizeKb} KB 超过单文件上限 8 MB，正文快照不受影响，可重试分卷压缩`,
      updatedAt: at,
    }
  } else {
    attachment = {
      ...snapshot.attachment,
      status: '已完成',
      attempts,
      sizeKb: Math.round(snapshot.attachment.sizeKb * 0.55),
      lastError: '',
      updatedAt: at,
    }
  }
  // 只写附件的压缩状态，图表、正文、生命周期版本都保持不变。
  saveSnapshots(
    allSnapshots().map((item) => (item.id === snapshotId ? { ...item, attachment } : item)),
  )
  return {
    ok: true,
    message:
      attachment.status === '已完成'
        ? `附件压缩完成（${attachment.sizeKb} KB，第 ${attempts} 次）`
        : `附件压缩失败：${attachment.lastError}；正文快照 ${snapshotId} 仍可发布与导出`,
  }
}

export function loadSnapshotView(snapshotId: string): SnapshotView | null {
  const raw = findSnapshot(snapshotId)
  if (!raw) {
    return null
  }
  const snapshot = normalizeSnapshot(raw)
  const currentTemplate = templateRow(snapshot.templateId)
  const changedFields = Object.entries(snapshot.templateSnapshot)
    .filter(([field, value]) => currentTemplate && String(currentTemplate[field] ?? '') !== value)
    .map(([field, value]) => ({ field, from: value, to: currentTemplate ? String(currentTemplate[field] ?? '') : '（模板已不存在）' }))
  return {
    snapshot,
    charts: riskyChartsOf(snapshot),
    pushBatches: allPushBatches().filter((batch) => batch.snapshotId === snapshotId),
    channelSummaries: deliverySummaryOf(snapshot),
    templateDrift: {
      currentRevision: currentTemplate ? templateVersion(snapshot.templateId) : snapshot.templateRevision,
      currentStatus: currentTemplate ? String(currentTemplate.status) : '已不存在',
      changedFields,
    },
  }
}

function csvCell(value: string | number | boolean): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出只读取快照里的固化字段，所以同一快照反复导出得到同样的内容，只与生成时间有关。 */
export function buildSnapshotExport(snapshotId: string): ReportExportFile | null {
  const raw = findSnapshot(snapshotId)
  if (!raw) {
    return null
  }
  const snapshot = normalizeSnapshot(raw)
  const meta: [string, string][] = [
    ['快照编号', snapshot.id],
    ['模板编号', snapshot.templateCode],
    ['模板名称', snapshot.templateName],
    ['模板版本', `v${snapshot.templateRevision}`],
    ['报告周期', snapshot.period],
    ['内容版本', `v${snapshot.version}`],
    ['生命周期版本', `v${snapshot.revision}`],
    ['模板状态（快照时）', snapshot.templateStatusAtSnapshot],
    ['导出格式（固化）', snapshot.exportFormat],
    ['快照状态', snapshot.status],
    ['生成时间', snapshot.generatedAt],
    ['生成人', snapshot.operator],
    ['水印', snapshot.watermarkEnabled ? snapshot.watermarkText : '未开启'],
    ['附件', snapshot.attachment.enabled ? `${snapshot.attachment.filename}（压缩由附件任务独立处理）` : '未启用'],
  ]
  const filenameBase = `${safeName(snapshot.templateName)}-${snapshot.period}-v${snapshot.version}-${safeName(snapshot.exportFormat)}`

  if (snapshot.exportFormat === 'Excel') {
    const lines: string[] = []
    for (const [label, value] of meta) {
      lines.push([label, value].map(csvCell).join(','))
    }
    lines.push('')
    lines.push(['图表顺序', '图表编号', '图表名称', '图表类型', '快照时状态', '是否可用', '不可用原因', '数据点'].map(csvCell).join(','))
    for (const chart of snapshot.charts) {
      lines.push(
        [
          chart.order,
          chart.chartCode,
          chart.name,
          chart.chartType,
          chart.statusAtSnapshot,
          chart.available ? '可用' : '不可用',
          chart.unavailableReason,
          chart.series.map((point) => `${point.label}=${point.value}`).join(' | '),
        ]
          .map(csvCell)
          .join(','),
      )
    }
    lines.push('')
    lines.push(['渠道', '接收范围'].map(csvCell).join(','))
    for (const channel of snapshot.channels) {
      lines.push([channel.name, channel.recipients.join(' / ')].map(csvCell).join(','))
    }
    lines.push('')
    lines.push(['不可用项目', snapshot.unavailableItems.length === 0 ? '无' : snapshot.unavailableItems.join('；')].map(csvCell).join(','))
    return {
      filename: `${filenameBase}.csv`,
      mime: 'text/csv;charset=utf-8',
      content: `﻿${lines.join('\n')}`,
    }
  }

  const escapeHtml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const watermark = snapshot.watermarkEnabled ? escapeHtml(snapshot.watermarkText) : ''
  const chartRows = snapshot.charts
    .map(
      (chart) => `
      <tr class="${chart.available ? '' : 'unavailable'}">
        <td>${chart.order}</td>
        <td>${escapeHtml(chart.chartCode)}</td>
        <td>${escapeHtml(chart.name)}</td>
        <td>${escapeHtml(chart.chartType)}</td>
        <td>${escapeHtml(chart.statusAtSnapshot)}</td>
        <td>${chart.available ? '可用' : `不可用：${escapeHtml(chart.unavailableReason)}`}</td>
        <td>${chart.available ? chart.series.map((point) => `${escapeHtml(point.label)}：${point.value}`).join('，') : '—'}</td>
      </tr>`,
    )
    .join('')
  const channelRows = snapshot.channels
    .map(
      (channel) =>
        `<tr><td>${escapeHtml(channel.name)}</td><td>${escapeHtml(channel.recipients.join(' / '))}</td></tr>`,
    )
    .join('')
  const unavailable = snapshot.unavailableItems.length === 0
    ? '<p>无</p>'
    : `<ul>${snapshot.unavailableItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
  const watermarkLayer = watermark
    ? `<div class="watermark">${Array.from({ length: 6 }).map(() => `<span>${watermark}</span>`).join('')}</div>`
    : ''
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(snapshot.templateName)} ${escapeHtml(snapshot.period)} 报告快照</title>
<style>
  body { font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1f2937; margin: 32px; }
  h1 { font-size: 20px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
  th, td { border: 1px solid #d8dee6; padding: 6px 8px; font-size: 12px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  tr.unavailable td { background: #fff1f0; color: #b42318; }
  .meta td:first-child { width: 160px; color: #64748b; }
  .foot { margin-top: 24px; color: #64748b; font-size: 11px; }
  .watermark { position: fixed; inset: 0; pointer-events: none; display: flex; flex-wrap: wrap; align-content: space-between; opacity: .08; font-size: 28px; transform: rotate(-24deg); }
  .watermark span { width: 50%; padding: 40px; }
</style>
</head>
<body>
${watermarkLayer}
<h1>${escapeHtml(snapshot.templateName)} · ${escapeHtml(snapshot.period)}</h1>
<table class="meta">
${meta.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}
</table>
<h2>包含图表（固化顺序与取值）</h2>
<table><thead><tr><th>顺序</th><th>图表编号</th><th>图表名称</th><th>类型</th><th>快照时状态</th><th>可用性</th><th>数据点</th></tr></thead>
<tbody>${chartRows}</tbody></table>
<h2>不可用项目</h2>
${unavailable}
<h2>推送渠道与接收范围</h2>
<table><thead><tr><th>渠道</th><th>接收人</th></tr></thead><tbody>${channelRows}</tbody></table>
<p class="foot">本文件由报告快照 ${escapeHtml(snapshot.id)} 导出，数据固化于 ${escapeHtml(snapshot.generatedAt)}；推送结果与附件状态单独记录，不改变本文件内容。</p>
</body>
</html>`
  return {
    filename: `${filenameBase}.html`,
    mime: 'text/html;charset=utf-8',
    content: html,
  }
}

export function downloadSnapshotExport(snapshotId: string): ActionResult {
  const file = buildSnapshotExport(snapshotId)
  if (!file) {
    return { ok: false, message: `没有找到报告快照 ${snapshotId}` }
  }
  const blob = new Blob([file.content], { type: file.mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return {
    ok: true,
    message:
      file.filename.endsWith('.html') && findSnapshot(snapshotId)?.exportFormat === 'PDF'
        ? `已导出 ${file.filename}（离线版用可打印 HTML 呈现 PDF 版式，文件内保留快照编号与生成时间）`
        : `已导出 ${file.filename}`,
  }
}

export type TemplatePatch = Record<string, string>

/** 修改模板只推进模板版本，不改写任何已经生成的快照。 */
export function updateTemplateContent(
  templateId: number,
  patch: TemplatePatch,
  operator: string,
): ActionResult {
  reloadRows()
  reloadReportStore()
  const rows = listRows(TEMPLATE_KEY)
  const row = rows.find((item) => Number(item.id) === templateId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${templateId} 的报告模板` }
  }
  const allowed = new Set(TEMPLATE_FIELDS)
  const changes = Object.entries(patch).filter(
    ([field, value]) => allowed.has(field) && String(row[field] ?? '') !== String(value),
  )
  if (changes.length === 0) {
    return { ok: false, message: '模板内容没有变化' }
  }
  const at = nowIso()
  const state = getTemplateState(templateId)
  const revision = (state?.revision ?? 1) + 1
  const history: TemplateHistoryEntry[] = [...(state?.history ?? [])]
  for (const [field, value] of changes) {
    history.push({
      seq: history.length + 1,
      revision,
      kind: '内容',
      field,
      from: String(row[field] ?? ''),
      to: String(value),
      at,
      by: operator,
      note: '模板内容修订，已生成快照保持原版本',
    })
  }
  const nextRow: EntryRow = { ...row }
  for (const [field, value] of changes) {
    nextRow[field] = value
  }
  saveRows(TEMPLATE_KEY, rows.map((item) => (Number(item.id) === templateId ? nextRow : item)))
  setTemplateState(templateId, { revision, history })
  return {
    ok: true,
    message: `模板 ${String(row['模板编号'] ?? '')} 已更新 ${changes.map(([field]) => field).join('、')}，模板版本 v${revision}；已生成快照不会被替换`,
  }
}

/** 模板状态流转同样写入模板版本，和启动快照生成时的版本号对得上。 */
export function runReportTemplateAction(templateId: number, action: string, operator: string): ActionResult {
  reloadRows()
  reloadReportStore()
  const rowsBefore = listRows(TEMPLATE_KEY)
  const before = rowsBefore.find((item) => Number(item.id) === templateId)
  if (!before) {
    return { ok: false, message: `没有找到编号为 ${templateId} 的报告模板` }
  }
  const transition = TEMPLATE_TRANSITIONS[action]
  if (!transition) {
    return { ok: false, message: `报告模板没有登记「${action}」这个动作` }
  }
  if (!transition.from.includes(String(before.status))) {
    return { ok: false, message: `报告模板当前「${before.status}」，按顺序只能从「${transition.from.join(' / ')}」执行「${action}」` }
  }
  const at = nowIso()
  const state = getTemplateState(templateId)
  const revision = (state?.revision ?? 1) + 1
  const history: TemplateHistoryEntry[] = [
    ...(state?.history ?? []),
    {
      seq: (state?.history.length ?? 0) + 1,
      revision,
      kind: '状态',
      field: '当前状态',
      from: String(before.status),
      to: transition.to,
      at,
      by: operator,
      note: `模板状态切换，版本推进到 v${revision}`,
    },
  ]
  saveRows(
    TEMPLATE_KEY,
    rowsBefore.map((item) =>
      Number(item.id) === templateId
        ? { ...item, status: transition.to, pending: transition.to !== '已生效', abnormal: transition.to === '已停用' }
        : item,
    ),
  )
  setTemplateState(templateId, { revision, history })
  return {
    ok: true,
    message: `报告模板已${action}，当前状态「${transition.to}」；模板版本 v${revision}`,
  }
}

/** 报告快照固定的生命周期顺序：从草稿到生效，撤回可恢复。 */
export function availableSnapshotActions(status: string): SnapshotAction[] {
  return (Object.keys(SNAPSHOT_TRANSITIONS) as SnapshotAction[]).filter(
    (action) => SNAPSHOT_TRANSITIONS[action].from === status,
  )
}

/** 页面用：只返回当前状态允许执行的模板动作。 */
export function availableTemplateActions(status: string): string[] {
  return TEMPLATE_ACTIONS.filter((action) => TEMPLATE_TRANSITIONS[action].from.includes(status))
}

export function resetReportData(): void {
  saveSnapshots([])
  savePushBatches([])
  savePendingGenerations([])
}

export function seedReportData(): void {
  // 首次访问时预置一份历史已生效快照；清空后不会再播种，避免把用户删除的数据「复活」。
  if (hasSeededReports()) {
    return
  }
  markReportsSeeded()
  if (allSnapshots().length > 0) {
    return
  }
  const template3 = templateRow(3)
  if (!template3) {
    return
  }
  // 这份快照生成于图表 CHAR-0003 下线之前，需要保留当时图形；先把已下线的图表临时按当时状态冻结。
  const chartRows = listRows(CHART_KEY)
  const generatedAt = '2026-10-01T09:00:00.000Z'
  const charts = splitList(String(template3['包含图表'] ?? '')).map((code, index) => {
    const row = chartRows.find((item) => String(item['图表编号']) === code)
    const historical = row ? { ...row, status: row.status === '已下线' ? '已发布' : row.status } : null
    return freezeChart(historical, code, index + 1, generatedAt)
  })
  const pinned = templateContentOf(template3, TEMPLATE_FIELDS)
  const channels: FrozenChannel[] = splitList(String(template3['推送渠道'] ?? '')).map((name) => ({
    name,
    recipients: CHANNEL_ADDRESS_BOOK[name] ?? [`${name}-值班组`],
  }))
  const archived: ReportSnapshot = {
    id: `SNAP-${template3['模板编号']}-${template3['报告周期']}-v1`,
    templateId: Number(template3.id),
    templateCode: String(template3['模板编号']),
    templateName: String(template3['模板名称']),
    templateRevision: 1,
    templateStatusAtSnapshot: String(template3.status),
    templateSnapshot: pinned,
    period: String(template3['报告周期']),
    version: 1,
    revision: 2,
    status: '已生效',
    createdAt: generatedAt,
    generatedAt,
    updatedAt: '2026-10-01T09:05:00.000Z',
    operator: '值班管理员',
    exportFormat: String(template3['导出格式']),
    watermarkEnabled: enabled(String(template3['水印开关'])),
    watermarkText: `内部资料 · 值班管理员 · ${template3['报告周期']} · SNAP-${template3['模板编号']}-${template3['报告周期']}-v1 · ${generatedAt}`,
    charts,
    channels,
    unavailableItems: charts.filter((chart) => !chart.available).map((chart) => `#${chart.order} ${chart.chartCode}：${chart.unavailableReason}`),
    attachment: {
      enabled: true,
      status: '已完成',
      filename: `${safeName(String(template3['模板名称']))}-${template3['报告周期']}-附件.zip`,
      sizeKb: 2340,
      attempts: 2,
      lastError: '',
      updatedAt: '2026-10-01T09:06:00.000Z',
    },
    history: [
      { seq: 1, revision: 1, action: '生成快照', fromStatus: '', toStatus: '草稿', at: generatedAt, by: '值班管理员', note: '从模板固化报告内容' },
      { seq: 2, revision: 2, action: '生效发布', fromStatus: '草稿', toStatus: '已生效', at: '2026-10-01T09:05:00.000Z', by: '值班管理员', note: '状态版本推进到 v2' },
    ],
    blockers: [],
  }
  const batch1: PushBatch = {
    id: `PUSH-${archived.id}-邮件-1`,
    snapshotId: archived.id,
    channel: '邮件',
    attempt: 1,
    status: '部分成功',
    recipients: [
      { recipient: 'finance@example.com', status: '已送达', detail: '第 1 次推送送达' },
      { recipient: 'ceo-office@example.com', status: '已送达', detail: '第 1 次推送送达' },
      { recipient: 'data-team@example.com', status: '已送达', detail: '第 1 次推送送达' },
      { recipient: 'ops-bounce@example.com', status: '失败', detail: '地址退信，重试无法送达' },
    ],
    deliveredCount: 3,
    failedCount: 1,
    startedAt: '2026-10-01T09:10:00.000Z',
    finishedAt: '2026-10-01T09:10:30.000Z',
    message: '第 1 次推送：3 人送达，1 人失败',
  }
  const batch2: PushBatch = {
    id: `PUSH-${archived.id}-钉钉-1`,
    snapshotId: archived.id,
    channel: '钉钉',
    attempt: 1,
    status: '成功',
    recipients: [
      { recipient: '增长运营组', status: '已送达', detail: '第 1 次推送送达' },
      { recipient: '财务分析组', status: '已送达', detail: '第 1 次推送送达' },
      { recipient: '运维值班组', status: '已送达', detail: '第 1 次推送送达' },
    ],
    deliveredCount: 3,
    failedCount: 0,
    startedAt: '2026-10-01T09:11:00.000Z',
    finishedAt: '2026-10-01T09:11:10.000Z',
    message: '第 1 次推送：3 人送达，0 人失败',
  }
  saveSnapshots([archived])
  savePushBatches([batch1, batch2])
  setTemplateState(Number(template3.id), {
    revision: 1,
    history: [
      { seq: 1, revision: 1, kind: '状态', field: '当前状态', from: '待审核', to: '已生效', at: generatedAt, by: '值班管理员', note: '模板初始版本' },
    ],
  })
}

export function templateVersionHistory(templateId: number): TemplateState {
  return getTemplateState(templateId) ?? { revision: 1, history: [] }
}

export function allTemplateRows(): EntryRow[] {
  return listRows(TEMPLATE_KEY)
}

export function allCharts(): EntryRow[] {
  return publishedChartRows()
}
