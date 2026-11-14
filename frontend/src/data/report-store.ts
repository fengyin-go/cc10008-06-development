import { listRows } from './local-store'
import type {
  AttachmentState,
  FrozenChart,
  FrozenChartSeriesPoint,
  PushBatch,
  ReportSnapshot,
  SnapshotHistoryEntry,
  SnapshotStatus,
  TemplateState,
} from './report-types'
import type { EntryRow } from './types'

/** 报告快照的持久化层：快照内容与推送批次分开存放，互不覆盖。 */

const STORAGE_KEY = 'interactive-analytics-lab:report-snapshots'
const SEEDED_KEY = 'interactive-analytics-lab:report-seeded'

type ReportStore = {
  snapshots: ReportSnapshot[]
  pushBatches: PushBatch[]
  templateStates: Record<string, TemplateState>
  pending: import('./report-types').PendingGeneration[]
}

const EMPTY_STORE: ReportStore = {
  snapshots: [],
  pushBatches: [],
  templateStates: {},
  pending: [],
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStore(): ReportStore {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(EMPTY_STORE)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return clone(EMPTY_STORE)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReportStore>
    return {
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      pushBatches: Array.isArray(parsed.pushBatches) ? parsed.pushBatches : [],
      templateStates:
        parsed.templateStates && typeof parsed.templateStates === 'object' ? parsed.templateStates : {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    }
  } catch {
    return clone(EMPTY_STORE)
  }
}

let cache: ReportStore | null = null

function store(): ReportStore {
  if (cache === null) {
    cache = readStore()
  }
  return cache
}

function persist(next: ReportStore): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function reportStorageKey(): string {
  return STORAGE_KEY
}

export function hasSeededReports(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true
  }
  return window.localStorage.getItem(SEEDED_KEY) === '1'
}

export function markReportsSeeded(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SEEDED_KEY, '1')
  }
}

/** 丢弃内存缓存、重新读 localStorage：并发写入后先看到对方落盘的结果。 */
export function reloadReportStore(): void {
  cache = null
}

export function allSnapshots(): ReportSnapshot[] {
  return store().snapshots
}

export function saveSnapshots(snapshots: ReportSnapshot[]): void {
  persist({ ...store(), snapshots })
}

export function allPushBatches(): PushBatch[] {
  return store().pushBatches
}

export function savePushBatches(pushBatches: PushBatch[]): void {
  persist({ ...store(), pushBatches })
}

export function getTemplateState(templateId: number): TemplateState | undefined {
  return store().templateStates[String(templateId)]
}

export function setTemplateState(templateId: number, state: TemplateState): void {
  persist({ ...store(), templateStates: { ...store().templateStates, [String(templateId)]: state } })
}

export function allPendingGenerations(): import('./report-types').PendingGeneration[] {
  return store().pending
}

export function savePendingGenerations(pending: import('./report-types').PendingGeneration[]): void {
  persist({ ...store(), pending })
}

export function templateContentOf(row: EntryRow, fields: string[]): Record<string, string> {
  const content: Record<string, string> = {}
  for (const field of fields) {
    content[field] = String(row[field] ?? '')
  }
  return content
}

/** 只取已发布或已下线的图表，草稿图表不会进入报告候选列表。 */
export function publishedChartRows(): EntryRow[] {
  return listRows('chart').filter((row) => ['已发布', '已下线'].includes(String(row.status)))
}

export function isChartDown(row: EntryRow): boolean {
  return String(row.status) === '已下线'
}

export function emptyAttachment(enabled: boolean, filename: string): AttachmentState {
  return {
    enabled,
    status: enabled ? '待压缩' : '未启用',
    filename: enabled ? filename : '',
    sizeKb: 0,
    attempts: 0,
    lastError: '',
    updatedAt: '',
  }
}

export function initialHistory(
  status: SnapshotStatus,
  revision: number,
  at: string,
  by: string,
  note: string,
): SnapshotHistoryEntry[] {
  return [{ seq: 1, revision, action: '生成快照', fromStatus: '', toStatus: status, at, by, note }]
}

/** 根据图表行生成一条固化图表记录；序列值以快照生成为准，之后不再变化。 */
export function freezeChart(
  row: EntryRow | null,
  chartCode: string,
  order: number,
  at: string,
): FrozenChart {
  if (!row) {
    return {
      order,
      chartId: null,
      chartCode,
      name: chartCode,
      chartType: '',
      dataSource: '',
      xField: '',
      yField: '',
      colorScheme: '',
      refreshSeconds: '',
      statusAtSnapshot: '不存在',
      available: false,
      unavailableReason: '图表编号未登记或模板引用的图表不存在',
      capturedAt: at,
      series: [],
    }
  }
  const down = isChartDown(row)
  return {
    order,
    chartId: Number(row.id),
    chartCode,
    name: String(row['图表名称'] ?? ''),
    chartType: String(row['图表类型'] ?? ''),
    dataSource: String(row['数据来源'] ?? ''),
    xField: String(row['X轴字段'] ?? ''),
    yField: String(row['Y轴字段'] ?? ''),
    colorScheme: String(row['配色方案'] ?? ''),
    refreshSeconds: String(row['刷新间隔秒'] ?? ''),
    statusAtSnapshot: String(row.status),
    available: !down,
    unavailableReason: down ? '图表已在快照生成前下线' : '',
    capturedAt: at,
    series: down ? [] : buildSeries(row, chartCode),
  }
}

/** 演示用的确定性序列：同一图表编号与名称总是生成同一组点，便于验证重试不改变取值。 */
function buildSeries(row: EntryRow, chartCode: string): FrozenChartSeriesPoint[] {
  let seed = Number(row.id) * 7919 + chartCode.length * 131
  const points: FrozenChartSeriesPoint[] = []
  for (let index = 1; index <= 6; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483647
    const value = Math.round((seed / 2147483647) * 900 + 100)
    points.push({ label: `${index}月`, value })
  }
  return points
}

export function normalizeSnapshot(snapshot: ReportSnapshot): ReportSnapshot {
  return {
    ...snapshot,
    charts: snapshot.charts ?? [],
    channels: snapshot.channels ?? [],
    unavailableItems: snapshot.unavailableItems ?? [],
    history: snapshot.history ?? [],
    blockers: snapshot.blockers ?? [],
    attachment: snapshot.attachment ?? emptyAttachment(false, ''),
  }
}
