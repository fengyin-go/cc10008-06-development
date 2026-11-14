/** 报告快照的领域类型：快照内容一次生成后不可改写，状态、附件、推送批次各自独立记录。 */

export type SnapshotStatus = '草稿' | '待审核' | '已生效' | '已撤回'

export type SnapshotAction = '提交审核' | '撤回审核' | '生效发布' | '撤回发布' | '恢复发布'

export type AttachmentStatus = '未启用' | '待压缩' | '已完成' | '压缩失败'

export type FrozenChartSeriesPoint = {
  label: string
  value: number
}

export type FrozenChart = {
  /** 在报告中的固化顺序，从 1 开始，重试与重新导出都不会改变。 */
  order: number
  chartId: number | null
  chartCode: string
  name: string
  chartType: string
  dataSource: string
  xField: string
  yField: string
  colorScheme: string
  refreshSeconds: string
  /** 生成快照时图表所处的状态，之后图表下线不会回写这里。 */
  statusAtSnapshot: string
  available: boolean
  unavailableReason: string
  capturedAt: string
  series: FrozenChartSeriesPoint[]
}

export type FrozenChannel = {
  name: string
  recipients: string[]
}

export type SnapshotHistoryEntry = {
  seq: number
  /** 每次状态切换都会 +1，作为该快照的生命周期版本号。 */
  revision: number
  action: string
  fromStatus: string
  toStatus: string
  at: string
  by: string
  note: string
}

export type AttachmentState = {
  enabled: boolean
  status: AttachmentStatus
  filename: string
  sizeKb: number
  attempts: number
  lastError: string
  updatedAt: string
}

export type RecipientResult = {
  recipient: string
  status: '已送达' | '失败'
  detail: string
}

export type PushStatus = '待推送' | '成功' | '部分成功' | '失败'

export type PushBatch = {
  id: string
  snapshotId: string
  channel: string
  attempt: number
  status: PushStatus
  recipients: RecipientResult[]
  /** 已经收到报告的接收人，跨批次累计去重后展示。 */
  deliveredCount: number
  failedCount: number
  startedAt: string
  finishedAt: string
  message: string
}

export type TemplateHistoryEntry = {
  seq: number
  revision: number
  kind: '状态' | '内容'
  field: string
  from: string
  to: string
  at: string
  by: string
  note: string
}

export type TemplateState = {
  /** 模板内容与状态的统一版本号，每次状态切换或内容修订都会递增。 */
  revision: number
  history: TemplateHistoryEntry[]
}

export type PendingGeneration = {
  id: string
  templateId: number
  templateCode: string
  templateName: string
  period: string
  requestedAt: string
  requestedBy: string
  /** 造成排队的那份完整报告版本，待处理任务不会与它拼接内容。 */
  blockedBySnapshotId: string
  status: '待处理' | '已处理'
  processedSnapshotId: string
  processedAt: string
  note: string
}

export type ChannelDeliverySummary = {
  channel: string
  recipients: string[]
  delivered: string[]
  failed: string[]
  pending: string[]
  attempts: number
  lastBatchId: string
  status: '未推送' | '成功' | '部分成功' | '失败'
}

export type FrozenChartView = FrozenChart & {
  currentStatus: string
  /** 快照生成后图表状态发生变化时为 true，仅用于提示，不改写快照。 */
  changedSinceSnapshot: boolean
}

export type SnapshotView = {
  snapshot: ReportSnapshot
  charts: FrozenChartView[]
  pushBatches: PushBatch[]
  channelSummaries: ChannelDeliverySummary[]
  templateDrift: {
    currentRevision: number
    currentStatus: string
    changedFields: { field: string; from: string; to: string }[]
  }
}

export type ReportExportFile = {
  filename: string
  content: string
  mime: string
}

export type ReportSnapshot = {
  id: string
  templateId: number
  templateCode: string
  templateName: string
  templateRevision: number
  templateStatusAtSnapshot: string
  /** 模板字段的完整冻结副本，页面只读这一份，不再回查模板。 */
  templateSnapshot: Record<string, string>
  period: string
  /** 同一模板 + 同一报告周期的内容版本号。 */
  version: number
  /** 生命周期状态版本号，任何状态切换都会递增。 */
  revision: number
  status: SnapshotStatus
  createdAt: string
  /** 数据固化时间，重试推送、重试附件、导出都不会改写。 */
  generatedAt: string
  updatedAt: string
  operator: string
  exportFormat: string
  watermarkEnabled: boolean
  watermarkText: string
  charts: FrozenChart[]
  channels: FrozenChannel[]
  unavailableItems: string[]
  attachment: AttachmentState
  history: SnapshotHistoryEntry[]
  /** 生效前校验结果：有不可用图表或渠道为空时会阻止发布。 */
  blockers: string[]
}
