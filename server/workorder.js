import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 协同工单：从危机拆分跨角色任务，状态机驱动流转，超时自动升级，结果回写危机 =====
export const WO_STATUS = {
  pending: '待处理', doing: '处理中', done: '已完成', escalated: '已升级', cancelled: '已取消'
}
export const WO_PRIORITY = { high: '高', mid: '中', low: '低' }
const PRIORITY_UP = { low: 'mid', mid: 'high', high: 'high' } // 升级时优先级上调一档
// 处理人名录（演示权限模型同源：admin 管理员 / ops 值班员 / viewer 观察员）
export const DIRECTORY = [
  { name: '张岚', role: 'admin' },
  { name: '李澈', role: 'ops' },
  { name: '王观', role: 'viewer' }
]
const ESCALATE_TO = (DIRECTORY.find((u) => u.role === 'admin') || DIRECTORY[0]).name // 超时升级目标：管理员
const DEFAULT_DUE_MIN = 30
const MIN_DUE_MIN = 0.1 // 演示用小时间窗，便于观察超时自动升级

export const TICK_MS = 3000 // 超时扫描间隔（与通知/采集调度器一致）
const DUE_BATCH = 20

// 工单留痕：创建/指派/接单/办结/回退/取消/升级全程记录（含操作人）
function addLog(woId, action, detail, operator = '系统') {
  run('INSERT INTO work_order_logs (wo_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
    woId, action, detail || '', operator, now())
}

const crisisOpen = (crisisId) => {
  const c = q1('SELECT status FROM crisis WHERE id=?', crisisId)
  return c && c.status !== 'closed'
}

// ===== 联动通知调度：工单事件直接生成通知任务（kind=workorder），由通知调度器统一发送/重试 =====
function woNotifyChannel() {
  // 优先站内信渠道（工单种子预置「工单站内信」）；缺失/停用时退避到任一启用渠道，都没有则静默跳过
  return q1("SELECT * FROM notify_channels WHERE type='inapp' AND enabled=1 ORDER BY id LIMIT 1")
    || q1('SELECT * FROM notify_channels WHERE enabled=1 ORDER BY id LIMIT 1')
}
function generateWONotify(wo, action, toUser) {
  const ch = woNotifyChannel()
  if (!ch) return
  const ts = now()
  const title = action === 'escalate' ? `【工单升级】${wo.title}` : `【协同工单】${wo.title}`
  const content = action === 'escalate'
    ? `工单 #${wo.escalated_from || wo.id} 超时未办结，已升级至 ${toUser} 处理 · 危机 #${wo.crisis_id}`
    : `新工单指派给 ${toUser}：${wo.detail || wo.title} · 危机 #${wo.crisis_id}`
  // 幂等键：同一工单同一动作同一对象只生成一次（改派不同对象各自生成）
  const r = run(`INSERT OR IGNORE INTO notify_tasks
    (idem_key,sub_id,channel_id,alert_event_id,crisis_id,kind,title,content,status,attempts,max_attempts,next_retry_at,require_ack,created,updated)
    VALUES (?,NULL,?,NULL,?,?,?,?,'pending',0,3,NULL,0,?,?)`,
    `wo:${wo.id}:${action}:${toUser}:ch${ch.id}`, ch.id, wo.crisis_id, 'workorder', title, content, ts, ts)
  if (Number(r.changes)) {
    run('INSERT INTO notify_logs (task_id,action,detail,operator,time) VALUES (?,?,?,?,?)',
      Number(r.lastInsertRowid), 'created',
      `协同工单${action === 'escalate' ? '升级' : '指派'}生成通知任务（渠道：${ch.name}）`, '系统', ts)
  }
}

// ===== 查询 =====
export function getWO(id) {
  const wo = q1(`SELECT w.*, c.title crisis_title, c.status crisis_status, c.level crisis_level
    FROM work_orders w LEFT JOIN crisis c ON c.id=w.crisis_id WHERE w.id=?`, id)
  return wo ? { ...wo, statusText: WO_STATUS[wo.status] || wo.status } : null
}
export function listWOs({ status = '', crisisId = null, limit = 100 } = {}) {
  let sql = `SELECT w.*, c.title crisis_title, c.status crisis_status, c.level crisis_level
    FROM work_orders w LEFT JOIN crisis c ON c.id=w.crisis_id`
  const args = []
  const conds = []
  if (status) { conds.push('w.status=?'); args.push(status) }
  if (crisisId) { conds.push('w.crisis_id=?'); args.push(crisisId) }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ')
  sql += ' ORDER BY w.id DESC LIMIT ?'
  args.push(limit)
  const orders = q(sql, ...args).map((w) => ({ ...w, statusText: WO_STATUS[w.status] || w.status }))
  const counts = {}
  for (const r of q('SELECT status, COUNT(*) c FROM work_orders GROUP BY status')) counts[r.status] = r.c
  return { orders, counts }
}
export function listWOLogs(woId, limit = 50) {
  return q('SELECT * FROM work_order_logs WHERE wo_id=? ORDER BY id DESC LIMIT ?', woId, limit)
}

// ===== 校验 =====
export function validateWO(b) {
  if (!b || typeof b.title !== 'string' || !b.title.trim()) return '工单标题必填'
  if (b.title.trim().length > 60) return '工单标题最长 60 字'
  if (b.assignee !== undefined && b.assignee !== '' && !DIRECTORY.some((u) => u.name === b.assignee)) {
    return `处理人必须是名录成员：${DIRECTORY.map((u) => u.name).join(' / ')}`
  }
  if (b.priority !== undefined && b.priority !== '' && !WO_PRIORITY[b.priority]) return '优先级无效'
  if (b.due_minutes !== undefined && b.due_minutes !== null && b.due_minutes !== '') {
    const m = +b.due_minutes
    if (!(m >= MIN_DUE_MIN)) return `限期至少 ${MIN_DUE_MIN} 分钟`
  }
  return null
}

// ===== 拆分工单（从危机创建并指派；结果写入危机时间线 + 联动通知处理人） =====
export function createWO(actor, b) {
  const crisis = q1('SELECT * FROM crisis WHERE id=?', +b.crisis_id)
  if (!crisis) return { error: '危机事件不存在' }
  if (crisis.status === 'closed') return { error: '已结案事件不可拆分工单（如需处置请先回滚结案）' }
  const err = validateWO(b)
  if (err) return { error: err }
  const ts = now()
  const assignee = (b.assignee || '').trim()
  const priority = WO_PRIORITY[b.priority] ? b.priority : (crisis.level === 'red' ? 'high' : 'mid')
  const dueMin = +b.due_minutes >= MIN_DUE_MIN ? +b.due_minutes : DEFAULT_DUE_MIN
  const dueAt = Date.now() + Math.round(dueMin * 60000)
  const r = run(`INSERT INTO work_orders (crisis_id,title,detail,assignee,priority,status,due_at,created_by,created,updated)
    VALUES (?,?,?,?,?,'pending',?,?,?,?)`,
    crisis.id, b.title.trim(), (b.detail || '').trim(), assignee, priority, dueAt, actor.user, ts, ts)
  const id = Number(r.lastInsertRowid)
  addLog(id, 'created',
    `从危机 #${crisis.id} 拆分工单${assignee ? `并指派给 ${assignee}` : '（待指派）'}（限期 ${dueMin} 分钟，优先级 ${WO_PRIORITY[priority]}）`, actor.user)
  addTimeline(crisis.id, '工单拆分',
    `拆分工单「${b.title.trim()}」${assignee ? `→ 处理人 ${assignee}` : '（待指派）'}（优先级 ${WO_PRIORITY[priority]}）`, ts)
  const wo = getWO(id)
  if (assignee) generateWONotify(wo, 'assign', assignee) // 联动通知调度：指派即通知
  return { ok: true, order: wo }
}

// ===== 改派（待处理/处理中可改派；通知新处理人） =====
export function assignWO(id, actor, assignee) {
  const wo = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!wo) return null
  if (!['pending', 'doing'].includes(wo.status)) return { error: `当前状态（${WO_STATUS[wo.status]}）不可改派`, order: getWO(id) }
  if (!DIRECTORY.some((u) => u.name === assignee)) return { error: `处理人必须是名录成员：${DIRECTORY.map((u) => u.name).join(' / ')}`, order: getWO(id) }
  if (assignee === wo.assignee) return { already: true, order: getWO(id) }
  const ts = now()
  const r = run(`UPDATE work_orders SET assignee=?, updated=? WHERE id=? AND status IN ('pending','doing')`, assignee, ts, id)
  if (!Number(r.changes)) return { already: true, order: getWO(id) }
  addLog(id, 'assigned', `改派：${wo.assignee || '（未指派）'} → ${assignee}`, actor.user)
  generateWONotify(getWO(id), 'assign', assignee)
  return { ok: true, order: getWO(id) }
}

// ===== 接单（待处理 → 处理中；处理人本人或值班员以上） =====
export function startWO(id, actor) {
  const wo = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!wo) return null
  if (wo.status !== 'pending') return { error: `当前状态（${WO_STATUS[wo.status]}）不可接单`, order: getWO(id) }
  if (!wo.assignee) return { error: '工单尚未指派处理人，请先指派', order: getWO(id) }
  const r = run(`UPDATE work_orders SET status='doing', updated=? WHERE id=? AND status='pending'`, now(), id)
  if (!Number(r.changes)) return { already: true, order: getWO(id) }
  addLog(id, 'started', `处理人接单，开始处理（处理人：${wo.assignee}）`, actor.user)
  return { ok: true, order: getWO(id) }
}

// ===== 办结（处理中 → 已完成）：结果回写危机时间线，可选联动解除该危机全部未解除预警 =====
export function completeWO(id, actor, { result = '', resolveAlerts = false } = {}) {
  const wo = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!wo) return null
  if (wo.status !== 'doing') return { error: `当前状态（${WO_STATUS[wo.status]}）不可办结`, order: getWO(id) }
  const text = String(result || '').trim()
  if (!text) return { error: '请填写处理结果（将回写危机时间线）', order: getWO(id) }
  const ts = now()
  let resolved = 0
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE work_orders SET status='done', result=?, result_at=?, updated=? WHERE id=? AND status='doing'`,
      text, ts, ts, id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { already: true, order: getWO(id) } }
    addLog(id, 'completed', `办结：${text}`, actor.user)
    if (crisisOpen(wo.crisis_id)) {
      // 结果回写①：危机统一时间线
      addTimeline(wo.crisis_id, '工单完成', `工单「${wo.title}」由 ${actor.user} 办结：${text}`, ts)
      // 结果回写②：联动解除该危机全部未解除预警（resolve_kind=workorder，状态守卫幂等）
      if (resolveAlerts) {
        const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", wo.crisis_id)
        for (const ev of opens) {
          run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='workorder' WHERE id=? AND status='open'", ts, ev.id)
        }
        resolved = opens.length
        if (resolved) {
          const rules = [...new Set(opens.map((e) => e.alert_id))].map((rid) => {
            const al = q1('SELECT title FROM alerts WHERE id=?', rid)
            return al ? `「${al.title}」` : '已删除规则'
          }).join('、')
          addTimeline(wo.crisis_id, '预警解除', `工单「${wo.title}」办结联动：解除 ${resolved} 条未解除预警（${rules}）`, ts)
          addLog(id, 'completed', `联动解除危机 #${wo.crisis_id} 未解除预警 ${resolved} 条`, actor.user)
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  return { ok: true, resolved, crisisId: wo.crisis_id, order: getWO(id) }
}

// ===== 回退（双向）：
// 处理中 → 待处理（处理人退回：无法处理退回待指派池，清空处理人，需重新指派）
// 已完成 → 处理中（验收回退：结果不达标退回返工，保留处理人与上次结果） =====
export function returnWO(id, actor, note = '', { review = false } = {}) {
  const wo = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!wo) return null
  const text = String(note || '').trim()
  if (!text) return { error: '请填写回退原因', order: getWO(id) }
  const ts = now()
  if (wo.status === 'doing') {
    const r = run(`UPDATE work_orders SET status='pending', assignee='', return_count=return_count+1, updated=?
      WHERE id=? AND status='doing'`, ts, id)
    if (!Number(r.changes)) return { already: true, order: getWO(id) }
    addLog(id, 'returned', `退回待处理（原处理人 ${wo.assignee || '—'}）：${text}`, actor.user)
    if (crisisOpen(wo.crisis_id)) addTimeline(wo.crisis_id, '工单回退', `工单「${wo.title}」由 ${actor.user} 退回待处理：${text}`, ts)
    return { ok: true, kind: 'return', order: getWO(id) }
  }
  if (wo.status === 'done' && review) {
    const r = run(`UPDATE work_orders SET status='doing', return_count=return_count+1, updated=?
      WHERE id=? AND status='done'`, ts, id)
    if (!Number(r.changes)) return { already: true, order: getWO(id) }
    addLog(id, 'returned', `验收回退（返工，处理人 ${wo.assignee || '—'}）：${text}`, actor.user)
    if (crisisOpen(wo.crisis_id)) addTimeline(wo.crisis_id, '工单回退', `工单「${wo.title}」验收不通过，由 ${actor.user} 退回返工：${text}`, ts)
    return { ok: true, kind: 'review', order: getWO(id) }
  }
  return { error: `当前状态（${WO_STATUS[wo.status]}）不可回退`, order: getWO(id) }
}

// ===== 取消（待处理/处理中 → 已取消） =====
export function cancelWO(id, actor, note = '') {
  const wo = q1('SELECT * FROM work_orders WHERE id=?', id)
  if (!wo) return null
  if (!['pending', 'doing'].includes(wo.status)) return { error: `当前状态（${WO_STATUS[wo.status]}）不可取消`, order: getWO(id) }
  const ts = now()
  const r = run(`UPDATE work_orders SET status='cancelled', updated=? WHERE id=? AND status IN ('pending','doing')`, ts, id)
  if (!Number(r.changes)) return { already: true, order: getWO(id) }
  addLog(id, 'cancelled', note ? `工单取消：${note}` : '工单取消', actor.user)
  if (crisisOpen(wo.crisis_id)) addTimeline(wo.crisis_id, '工单取消', `工单「${wo.title}」由 ${actor.user} 取消${note ? `：${note}` : ''}`, ts)
  return { ok: true, order: getWO(id) }
}

// ===== 超时升级：原单关闭（已升级），生成升级单指派管理员（优先级上调一档；升级链不二次升级） =====
function escalateWO(wo) {
  const ts = now()
  let newId = null
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE work_orders SET status='escalated', updated=? WHERE id=? AND status IN ('pending','doing')`, ts, wo.id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return }
    addLog(wo.id, 'escalated', `超时未办结（截止 ${new Date(wo.due_at).toLocaleString('zh-CN')}），自动升级至 ${ESCALATE_TO}`)
    const priority = PRIORITY_UP[wo.priority] || 'high'
    const dueAt = Date.now() + DEFAULT_DUE_MIN * 60000
    const cr = run(`INSERT INTO work_orders (crisis_id,title,detail,assignee,priority,status,due_at,escalated_from,created_by,created,updated)
      VALUES (?,?,?,?,?,'pending',?,?,?,?,?)`,
      wo.crisis_id, `【升级】${wo.title}`, wo.detail, ESCALATE_TO, priority, dueAt, wo.id, '系统（超时升级）', ts, ts)
    newId = Number(cr.lastInsertRowid)
    addLog(newId, 'created',
      `工单 #${wo.id} 超时升级生成（优先级上调：${WO_PRIORITY[wo.priority]}→${WO_PRIORITY[priority]}，限期 ${DEFAULT_DUE_MIN} 分钟）`)
    if (crisisOpen(wo.crisis_id)) {
      addTimeline(wo.crisis_id, '工单升级',
        `工单「${wo.title}」超时未办结，已升级至 ${ESCALATE_TO}（新工单 #${newId}，优先级 ${WO_PRIORITY[priority]}）`, ts)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  generateWONotify(getWO(newId), 'escalate', ESCALATE_TO) // 联动通知调度：升级通知
}

// 调度一轮：扫描超时未办结工单（升级链生成的工单不再二次升级，保持超时可见）
export function runWorkTick() {
  const due = q(`SELECT * FROM work_orders WHERE status IN ('pending','doing') AND escalated_from IS NULL
    AND due_at IS NOT NULL AND due_at<=? ORDER BY id LIMIT ?`, Date.now(), DUE_BATCH)
  for (const wo of due) escalateWO(wo)
}

let timer = null
export function startWorkScheduler() {
  if (timer) return
  timer = setInterval(() => {
    try { runWorkTick() } catch (e) { console.error('[WORK] 调度异常：', e.message) }
  }, TICK_MS)
  if (timer.unref) timer.unref()
  console.log(`[WORK] 工单调度器已启动（每 ${TICK_MS / 1000} 秒扫描：超时未办结自动升级至 ${ESCALATE_TO}）`)
}
export function stopWorkScheduler() { if (timer) clearInterval(timer); timer = null }
