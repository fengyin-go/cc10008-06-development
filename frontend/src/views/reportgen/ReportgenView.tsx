import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  allTemplateRows,
  applySnapshotAction,
  availableSnapshotActions,
  availableTemplateActions,
  compressAttachment,
  downloadSnapshotExport,
  generateSnapshot,
  listSnapshots,
  loadSnapshotView,
  processPendingGeneration,
  pushRemainingChannels,
  pushSnapshotChannel,
  resetReportData,
  runReportTemplateAction,
  seedReportData,
  templateVersionHistory,
  updateTemplateContent,
} from '@/api/report-service'
import type { ReportSnapshot, SnapshotAction, SnapshotView } from '@/data/report-types'
import { moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('reportgen')
const templateFields = meta.fields

const periodPattern = /^\d{4}-\d{2}$/

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function ReportgenView() {
  const [templateRows, setTemplateRows] = useState<EntryRow[]>([])
  const [snapshots, setSnapshots] = useState<ReportSnapshot[]>([])
  const [pending, setPending] = useState<ReturnType<typeof listSnapshots>['pending']>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<SnapshotView | null>(null)
  const [operator, setOperator] = useState('值班管理员')
  const [generateTemplateId, setGenerateTemplateId] = useState(1)
  const [generatePeriod, setGeneratePeriod] = useState('')
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [editing, setEditing] = useState(false)
  const [editPatch, setEditPatch] = useState<Record<string, string>>({})

  const reload = useCallback(() => {
    const payload = listSnapshots()
    setSnapshots(payload.snapshots)
    setPending(payload.pending)
    setTemplateRows(allTemplateRows())
    setSelectedId((current) => current || payload.snapshots[payload.snapshots.length - 1]?.id || '')
  }, [])

  useEffect(() => {
    seedReportData()
    reload()
  }, [reload])

  useEffect(() => {
    setDetail(selectedId ? loadSnapshotView(selectedId) : null)
  }, [selectedId, snapshots])

  const stats = useMemo(() => {
    const active = snapshots.filter((snapshot) => snapshot.status === '已生效').length
    const blocked = snapshots.filter((snapshot) => snapshot.blockers.length > 0 && snapshot.status !== '已生效').length
    return [
      { label: '报告快照总数', value: snapshots.length },
      { label: '已生效报告', value: active },
      { label: '待处理任务', value: pending.filter((item) => item.status === '待处理').length },
      { label: '存在阻塞项', value: blocked },
    ]
  }, [snapshots, pending])

  function report(result: { ok: boolean; message: string }, onOk?: () => void) {
    if (result.ok) {
      setErrorMessage('')
      setMessage(result.message)
      onOk?.()
    } else {
      setMessage('')
      setErrorMessage(result.message)
    }
  }

  function refreshAfterAction() {
    reload()
    if (selectedId) {
      setDetail(loadSnapshotView(selectedId))
    }
  }

  function handleGenerate() {
    const trimmed = generatePeriod.trim()
    if (trimmed && !periodPattern.test(trimmed)) {
      setMessage('')
      setErrorMessage('报告周期必须是 YYYY-MM 格式')
      return
    }
    const beforeIds = new Set(snapshots.map((snapshot) => snapshot.id))
    const outcome = generateSnapshot({
      templateId: Number(generateTemplateId),
      period: trimmed || undefined,
      operator,
    })
    report(outcome, () => {
      reload()
      if (outcome.snapshotId) {
        setSelectedId(outcome.snapshotId)
      } else {
        const created = listSnapshots().snapshots.find((snapshot) => !beforeIds.has(snapshot.id))
        if (created) {
          setSelectedId(created.id)
        }
      }
    })
    setGeneratePeriod('')
  }

  function handleSnapshotAction(action: SnapshotAction) {
    if (!selectedId) {
      return
    }
    report(applySnapshotAction(selectedId, action, operator), refreshAfterAction)
  }

  function handlePush(channel: string) {
    if (!selectedId) {
      return
    }
    report(pushSnapshotChannel(selectedId, channel, operator), refreshAfterAction)
  }

  function handlePushAll() {
    if (!selectedId) {
      return
    }
    report(pushRemainingChannels(selectedId, operator), refreshAfterAction)
  }

  function handleCompress() {
    if (!selectedId) {
      return
    }
    report(compressAttachment(selectedId, operator), refreshAfterAction)
  }

  function handleExport() {
    if (!selectedId) {
      return
    }
    report(downloadSnapshotExport(selectedId))
  }

  function handlePending(pendingId: string) {
    report(processPendingGeneration(pendingId, operator), () => {
      reload()
    })
  }

  function startEdit(row: EntryRow) {
    const patch: Record<string, string> = {}
    for (const field of templateFields) {
      patch[field] = String(row[field] ?? '')
    }
    setEditPatch(patch)
    setEditing(true)
  }

  function saveEdit(row: EntryRow) {
    report(
      updateTemplateContent(Number(row.id), editPatch, operator),
      () => {
        setEditing(false)
        reload()
      },
    )
  }

  function handleTemplateAction(row: EntryRow, action: string) {
    report(runReportTemplateAction(Number(row.id), action, operator), reload)
  }

  const selected = detail?.snapshot ?? null
  const editingRow = templateRows.find((row) => Number(row.id) === generateTemplateId)

  return (
    <section className="page" data-module="reportgen">
      <header className="page-head">
        <div>
          <h2>报告生成管理</h2>
          <p className="page-desc">
            模板只读、快照固化：报告周期、包含图表、导出格式与水印在生成时冻结，推送结果与附件状态分别记录在快照旁。
          </p>
        </div>
        <div className="page-actions">
          <label className="inline-field">
            <span>当前操作人</span>
            <select value={operator} onChange={(event) => setOperator(event.target.value)}>
              <option value="值班管理员">值班管理员</option>
              <option value="运营分析师">运营分析师</option>
              <option value="财务复核员">财务复核员</option>
            </select>
          </label>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              resetReportData()
              setEditing(false)
              setSelectedId('')
              reload()
              setMessage('已清空本机报告快照、推送批次与待处理队列')
              setErrorMessage('')
            }}
          >
            清空报告数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      {message && <p className="notice-text">{message}</p>}
      {errorMessage && <p className="error-text">{errorMessage}</p>}

      <section className="panel">
        <div className="panel-head">
          <h3>一、模板登记</h3>
          <span className="panel-hint">模板可修订，已生成的快照不会被替换；模板版本在状态切换与内容修订时递增。</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>模板编号</th>
              <th>模板名称</th>
              <th>包含图表</th>
              <th>报告周期</th>
              <th>导出格式</th>
              <th>推送渠道</th>
              <th>水印</th>
              <th>附件压缩</th>
              <th>当前状态</th>
              <th>模板版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {templateRows.map((row) => {
              const version = templateVersionHistory(Number(row.id))
              return (
                <tr key={String(row.id)}>
                  <td>{row['模板编号']}</td>
                  <td>{row['模板名称']}</td>
                  <td>{row['包含图表']}</td>
                  <td>{row['报告周期']}</td>
                  <td>{row['导出格式']}</td>
                  <td>{row['推送渠道']}</td>
                  <td>{row['水印开关']}</td>
                  <td>{row['附件压缩']}</td>
                  <td>{row.status}</td>
                  <td>v{version.revision}</td>
                  <td className="row-actions">
                    {availableTemplateActions(String(row.status)).map((action) => (
                      <button key={action} className="link" type="button" onClick={() => handleTemplateAction(row, action)}>
                        {action}
                      </button>
                    ))}
                    <button className="link" type="button" onClick={() => startEdit(row)}>修订模板</button>
                  </td>
                </tr>
              )
            })}
            {templateRows.length === 0 && (
              <tr><td className="empty-state" colSpan={11}>暂无报告模板</td></tr>
            )}
          </tbody>
        </table>

        {editing && editingRow && (
          <form
            className="edit-panel"
            onSubmit={(event) => {
              event.preventDefault()
              saveEdit(editingRow)
            }}
          >
            <div className="panel-head">
              <h4>修订模板 {String(editingRow['模板编号'])}</h4>
              <span className="panel-hint">保存后模板版本 +1，已经生成的报告快照保持原内容。</span>
            </div>
            <div className="edit-grid">
              {templateFields.map((field) => (
                <label key={field} className="filter-item">
                  <span>{field}</span>
                  <input
                    value={editPatch[field] ?? ''}
                    onChange={(event) => setEditPatch((prev) => ({ ...prev, [field]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="panel-actions">
              <button className="btn primary" type="submit">保存修订</button>
              <button className="btn ghost" type="button" onClick={() => setEditing(false)}>取消</button>
            </div>
          </form>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>二、生成报告快照</h3>
          <span className="panel-hint">同一模板 + 同一报告周期只保留一份完整版本；第二次请求进入待处理，不拼接两份内容。</span>
        </div>
        <div className="filter-bar">
          <label className="filter-item">
            <span>选择模板</span>
            <select
              value={generateTemplateId}
              onChange={(event) => setGenerateTemplateId(Number(event.target.value))}
            >
              {templateRows.map((row) => (
                <option key={String(row.id)} value={Number(row.id)}>
                  {String(row['模板编号'])} · {String(row['模板名称'])}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-item">
            <span>报告周期（留空取模板值）</span>
            <input
              value={generatePeriod}
              placeholder={editingRow ? String(editingRow['报告周期'] ?? '') : 'YYYY-MM'}
              onChange={(event) => setGeneratePeriod(event.target.value)}
            />
          </label>
          <button className="btn primary" type="button" onClick={handleGenerate}>生成快照</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>三、报告快照</h3>
          <span className="panel-hint">快照列表按生成时间保留全部版本，撤回的版本仍可恢复。</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>快照编号</th>
              <th>模板</th>
              <th>报告周期</th>
              <th>内容版本</th>
              <th>生命周期版本</th>
              <th>状态</th>
              <th>图表 / 不可用</th>
              <th>生成时间</th>
              <th>附件</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((snapshot) => (
              <tr key={snapshot.id} className={snapshot.id === selectedId ? 'row-selected' : ''}>
                <td>{snapshot.id}</td>
                <td>{snapshot.templateCode} · {snapshot.templateName}</td>
                <td>{snapshot.period}</td>
                <td>v{snapshot.version}</td>
                <td>v{snapshot.revision}</td>
                <td>{snapshot.status}</td>
                <td>{snapshot.charts.length} / {snapshot.unavailableItems.length}</td>
                <td>{formatTime(snapshot.generatedAt)}</td>
                <td>{snapshot.attachment.enabled ? snapshot.attachment.status : '未启用'}</td>
                <td>
                  <button className="link" type="button" onClick={() => setSelectedId(snapshot.id)}>查看详情</button>
                </td>
              </tr>
            ))}
            {snapshots.length === 0 && (
              <tr><td className="empty-state" colSpan={10}>还没有报告快照，可先按模板生成一份</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>四、待处理队列</h3>
          <span className="panel-hint">同一模板同周期的重复请求在这里排队；只有原完整版本撤回后才能单独生成。</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>任务编号</th>
              <th>模板</th>
              <th>报告周期</th>
              <th>请求人</th>
              <th>请求时间</th>
              <th>被哪份完整版本阻塞</th>
              <th>状态</th>
              <th>处理结果</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.templateCode} · {item.templateName}</td>
                <td>{item.period}</td>
                <td>{item.requestedBy}</td>
                <td>{formatTime(item.requestedAt)}</td>
                <td>{item.blockedBySnapshotId}</td>
                <td>{item.status}</td>
                <td>{item.processedSnapshotId || item.note}</td>
                <td>
                  <button
                    className="link"
                    type="button"
                    disabled={item.status !== '待处理'}
                    onClick={() => handlePending(item.id)}
                  >
                    处理
                  </button>
                </td>
              </tr>
            ))}
            {pending.length === 0 && (
              <tr><td className="empty-state" colSpan={9}>没有待处理任务</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {selected && detail && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h3>五、快照详情 · {selected.id}</h3>
              <div className="panel-actions">
                <button className="btn" type="button" onClick={handleExport}>
                  导出快照（{selected.exportFormat}）
                </button>
              </div>
            </div>

            {detail.templateDrift.changedFields.length > 0 && (
              <p className="warn-text">
                模板 {selected.templateCode} 已从 v{selected.templateRevision} 修订到 v{detail.templateDrift.currentRevision}（当前状态 {detail.templateDrift.currentStatus}）。
                本快照仍显示生成时的内容，不受后改模板影响：
                {detail.templateDrift.changedFields.map((change) => ` ${change.field}「${change.from}」→「${change.to}」`).join('；')}
              </p>
            )}

            <div className="meta-grid">
              <div><span>报告周期</span><strong>{selected.period}</strong></div>
              <div><span>导出格式</span><strong>{selected.exportFormat}</strong></div>
              <div><span>水印</span><strong>{selected.watermarkEnabled ? '开启' : '关闭'}</strong></div>
              <div><span>生成时间（固化）</span><strong>{formatTime(selected.generatedAt)}</strong></div>
              <div><span>生成人</span><strong>{selected.operator}</strong></div>
              <div><span>当前状态</span><strong>{selected.status} · 生命周期 v{selected.revision}</strong></div>
            </div>
            {selected.watermarkEnabled && <p className="watermark-text">水印：{selected.watermarkText}</p>}

            {selected.blockers.length > 0 && (
              <div className="blocker-box">
                <strong>发布前阻止项</strong>
                <ul>
                  {selected.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                </ul>
                <span>残缺版本不会被发布；请先处理不可用图表或补齐推送渠道后重新生成。</span>
              </div>
            )}

            <div className="panel-actions">
              {availableSnapshotActions(selected.status).map((action) => (
                <button key={action} className="btn" type="button" onClick={() => handleSnapshotAction(action)}>
                  {action}
                </button>
              ))}
            </div>
            <p className="panel-hint">生命周期按「草稿 → 待审核 → 已生效」顺序流转，撤回后可恢复；每次切换都推进生命周期版本。</p>

            <h4>固化图表（顺序与取值不可变）</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>顺序</th>
                  <th>图表编号</th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>快照时状态</th>
                  <th>当前状态</th>
                  <th>可用性</th>
                  <th>固化取值</th>
                </tr>
              </thead>
              <tbody>
                {detail.charts.map((chart) => (
                  <tr key={`${chart.order}-${chart.chartCode}`} className={chart.available ? '' : 'row-warn'}>
                    <td>{chart.order}</td>
                    <td>{chart.chartCode}</td>
                    <td>{chart.name}</td>
                    <td>{chart.chartType}</td>
                    <td>{chart.statusAtSnapshot}</td>
                    <td>
                      {chart.currentStatus}
                      {chart.changedSinceSnapshot && <span className="tag-changed">已变化</span>}
                    </td>
                    <td>{chart.available ? '可用' : `不可用：${chart.unavailableReason}`}</td>
                    <td>{chart.series.length > 0 ? chart.series.map((point) => `${point.label}=${point.value}`).join('，') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4>不可用项目</h4>
            {selected.unavailableItems.length === 0 ? (
              <p className="panel-hint">无，全部图表在快照生成时可用。</p>
            ) : (
              <ul className="plain-list">
                {selected.unavailableItems.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>六、推送批次与接收结果</h3>
              <div className="panel-actions">
                <button className="btn" type="button" onClick={handlePushAll}>继续未完成渠道</button>
              </div>
            </div>
            <p className="panel-hint">
              快照记录“推什么”，推送批次记录“发给谁”；部分成功的渠道可以继续重试，重试只追加批次，不改写图表顺序和取值。
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>渠道</th>
                  <th>接收范围</th>
                  <th>已送达</th>
                  <th>失败</th>
                  <th>未推送</th>
                  <th>推送次数</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.channelSummaries.map((summary) => (
                  <tr key={summary.channel}>
                    <td>{summary.channel}</td>
                    <td>{summary.recipients.join('、') || '—'}</td>
                    <td>{summary.delivered.join('、') || '—'}</td>
                    <td>{summary.failed.join('、') || '—'}</td>
                    <td>{summary.pending.join('、') || '—'}</td>
                    <td>{summary.attempts}</td>
                    <td>{summary.status}</td>
                    <td>
                      <button
                        className="link"
                        type="button"
                        onClick={() => handlePush(summary.channel)}
                        disabled={summary.status === '成功' || selected.status !== '已生效'}
                      >
                        {summary.attempts === 0 ? '推送' : '重试'}
                      </button>
                    </td>
                  </tr>
                ))}
                {detail.channelSummaries.length === 0 && (
                  <tr><td className="empty-state" colSpan={8}>该快照没有固化推送渠道</td></tr>
                )}
              </tbody>
            </table>

            <h4>批次明细</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>批次编号</th>
                  <th>渠道</th>
                  <th>第几次</th>
                  <th>结果</th>
                  <th>送达 / 失败</th>
                  <th>接收人结果</th>
                  <th>开始时间</th>
                </tr>
              </thead>
              <tbody>
                {detail.pushBatches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.id}</td>
                    <td>{batch.channel}</td>
                    <td>{batch.attempt}</td>
                    <td>{batch.status}</td>
                    <td>{batch.deliveredCount} / {batch.failedCount}</td>
                    <td>{batch.recipients.map((result) => `${result.recipient}（${result.status}）`).join('、')}</td>
                    <td>{formatTime(batch.startedAt)}</td>
                  </tr>
                ))}
                {detail.pushBatches.length === 0 && (
                  <tr><td className="empty-state" colSpan={7}>尚未推送</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>七、附件与生命周期</h3>
              <div className="panel-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={handleCompress}
                  disabled={!selected.attachment.enabled || selected.attachment.status === '已完成'}
                >
                  {selected.attachment.attempts === 0 ? '压缩附件' : '重试附件压缩'}
                </button>
              </div>
            </div>
            <div className="meta-grid">
              <div><span>附件状态</span><strong>{selected.attachment.status}</strong></div>
              <div><span>文件名</span><strong>{selected.attachment.filename || '未启用'}</strong></div>
              <div><span>体积</span><strong>{selected.attachment.sizeKb} KB</strong></div>
              <div><span>压缩次数</span><strong>{selected.attachment.attempts}</strong></div>
            </div>
            {selected.attachment.lastError && <p className="warn-text">{selected.attachment.lastError}。正文快照仍可继续发布与导出。</p>}

            <h4>状态版本记录</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>版本</th>
                  <th>动作</th>
                  <th>状态变化</th>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {selected.history.map((entry) => (
                  <tr key={`${entry.seq}-${entry.revision}`}>
                    <td>{entry.seq}</td>
                    <td>v{entry.revision}</td>
                    <td>{entry.action}</td>
                    <td>{entry.fromStatus ? `${entry.fromStatus} → ${entry.toStatus}` : entry.toStatus}</td>
                    <td>{formatTime(entry.at)}</td>
                    <td>{entry.by}</td>
                    <td>{entry.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <footer className="page-foot">
        <span>共 {templateRows.length} 个模板、{snapshots.length} 份报告快照</span>
        <span>报告数据保存在浏览器 localStorage，刷新与重开仍在</span>
      </footer>
    </section>
  )
}
