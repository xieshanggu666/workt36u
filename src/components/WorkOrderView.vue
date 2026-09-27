<template>
  <div class="wo">
    <div class="wtoolbar">
      <button v-if="canOps" class="add" @click="showForm=!showForm">＋ 拆分工单</button>
      <span class="hint">🔗 从危机拆分跨角色任务：指派即通知 · 超时自动升级管理员 · 办结结果回写危机时间线并可联动解除预警</span>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>

    <!-- 拆分工单（值班员以上） -->
    <form v-if="showForm && canOps" class="wo-form" @submit.prevent="create">
      <div class="row">
        <select v-model="form.crisis_id" required>
          <option :value="null" disabled>选择危机事件（未结案）</option>
          <option v-for="c in openCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}（{{ c.status==='disposal'?'处置中':'监测中' }}）</option>
        </select>
        <select v-model="form.priority">
          <option value="high">优先级 高</option><option value="mid">优先级 中</option><option value="low">优先级 低</option>
        </select>
      </div>
      <input v-model="form.title" placeholder="工单标题（如 发布官方回应声明）" required maxlength="60" />
      <textarea v-model="form.detail" placeholder="任务说明：处置要求、验收标准…"></textarea>
      <div class="row">
        <select v-model="form.assignee">
          <option value="">暂不指派（待指派池）</option>
          <option v-for="u in directory" :key="u.name" :value="u.name">{{ u.name }} · {{ roleText(u.role) }}</option>
        </select>
        <input v-model.number="form.due_minutes" type="number" min="0.1" step="0.5" placeholder="限期(分钟)" title="超时未办结将自动升级至管理员" />
        <button class="save" type="submit">拆分并指派</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
      <p class="f-hint">💡 指派即生成通知任务（通知中心统一调度发送）；限期最小 0.1 分钟，便于演示超时自动升级。</p>
    </form>

    <!-- 状态过滤 -->
    <div class="counts">
      <button class="chip" :class="{on:!filter}" @click="setFilter('')">全部 {{ totalCount }}</button>
      <button v-for="(txt,k) in statusText" :key="k" class="chip" :class="[k,{on:filter===k}]" @click="setFilter(k)">
        {{ txt }} {{ counts[k]||0 }}
      </button>
    </div>

    <div v-if="!orders.length" class="none">暂无协同工单（在危机处置页或此处从危机拆分）</div>
    <div class="orders">
      <div v-for="w in orders" :key="w.id" class="order" :class="[w.status, {overdue: isOverdue(w)}]">
        <div class="o-head">
          <span class="st" :class="w.status">{{ w.statusText }}</span>
          <span class="pr" :class="w.priority">{{ priorityText[w.priority] || w.priority }}</span>
          <b class="o-title">{{ w.title }}</b>
          <span v-if="w.escalated_from" class="esc-tag">⬆ 升级自 #{{ w.escalated_from }}</span>
          <span v-if="w.return_count" class="ret-tag">↩ 回退 ×{{ w.return_count }}</span>
          <button class="logbtn" @click="toggleLogs(w)">{{ logId===w.id ? '收起留痕' : '📜 留痕' }}</button>
        </div>
        <div v-if="w.detail" class="o-detail">{{ w.detail }}</div>
        <div class="o-meta">
          <span>危机 <i>#{{ w.crisis_id }} {{ w.crisis_title || '' }}</i></span>
          <span>处理人 <i :class="{none:!w.assignee}">{{ w.assignee || '待指派' }}</i></span>
          <span>创建 <i>{{ w.created_by }}</i></span>
          <span>截止 <i :class="{over: isOverdue(w)}">{{ dueText(w) }}</i></span>
          <span>更新 <i>{{ w.updated }}</i></span>
        </div>
        <div v-if="w.status==='done' && w.result" class="o-result">✅ 处理结果：{{ w.result }}<em v-if="w.result_at"> · {{ w.result_at }}</em></div>
        <div v-if="w.status==='done' && !w.result && w.result_at" class="o-result dim">（验收回退后重新办结将覆盖上次结果）</div>

        <div class="o-actions">
          <button v-if="w.status==='pending' && canStart(w)" class="op go" @click="op(w,'start')">▶ 接单</button>
          <button v-if="w.status==='doing' && canTouch(w)" class="op done" @click="complete(w)">✔ 办结</button>
          <button v-if="w.status==='doing' && canTouch(w)" class="op back" @click="returnBack(w)">↩ 退回</button>
          <button v-if="w.status==='done' && canOps" class="op back" @click="reviewBack(w)">↩ 验收回退</button>
          <button v-if="['pending','doing'].includes(w.status) && canOps" class="op" @click="reassign(w)">⇄ 改派</button>
          <button v-if="['pending','doing'].includes(w.status) && canOps" class="op cancel" @click="cancel(w)">✕ 取消</button>
        </div>

        <div v-if="logId===w.id" class="o-logs">
          <div v-for="l in logs" :key="l.id" class="olog">
            <span class="lg-act" :class="l.action">{{ logText(l.action) }}</span>
            <span class="lg-detail">{{ l.detail }}</span>
            <em>{{ l.operator }} · {{ l.time }}</em>
          </div>
          <div v-if="!logs.length" class="none">暂无留痕</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const orders = ref([])
const counts = ref({})
const directory = ref([])
const statusText = ref({})
const priorityText = ref({})
const filter = ref('')
const showForm = ref(false)
const form = ref({ crisis_id: null, title: '', detail: '', assignee: '', priority: 'mid', due_minutes: 30 })
const logId = ref(null)
const logs = ref([])
const nowMs = ref(Date.now())

const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const openCrises = computed(() => store.crises.filter((c) => c.status !== 'closed'))
const totalCount = computed(() => Object.values(counts.value).reduce((a, b) => a + b, 0))

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function logText(a) {
  return { created: '创建', assigned: '改派', started: '接单', completed: '办结', returned: '回退', cancelled: '取消', escalated: '升级' }[a] || a
}
// 跨角色：处理人本人可操作自己的工单（观察员被指派后同样可接单/办结/退回）
function canTouch(w) { return canOps.value || (!!w.assignee && store.user.name === w.assignee) }
function canStart(w) { return !!w.assignee && canTouch(w) }
function isOverdue(w) { return ['pending', 'doing'].includes(w.status) && w.due_at && w.due_at <= nowMs.value }
function dueText(w) {
  if (!w.due_at) return '—'
  const t = new Date(w.due_at).toLocaleString('zh-CN')
  if (!['pending', 'doing'].includes(w.status)) return t
  const diff = w.due_at - nowMs.value
  const m = Math.max(1, Math.round(Math.abs(diff) / 60000))
  return diff >= 0 ? `${t}（剩余 ${m} 分）` : `${t}（已超时 ${m} 分）`
}

async function load() {
  const d = await store.fetchWOOverview(filter.value ? { status: filter.value } : null)
  orders.value = d.orders
  counts.value = d.counts
  directory.value = d.directory
  statusText.value = d.statusText
  priorityText.value = d.priorityText
}
function setFilter(k) { filter.value = k; load() }

async function run(fn) {
  try { await fn(); await load() }
  catch (e) { store.msg(e.message, 'warn') }
}
async function create() {
  const f = form.value
  if (!f.crisis_id) { store.msg('请选择危机事件', 'warn'); return }
  await run(async () => {
    await store.createWO({
      crisis_id: f.crisis_id, title: f.title, detail: f.detail,
      assignee: f.assignee, priority: f.priority, due_minutes: f.due_minutes
    })
  })
  form.value = { crisis_id: null, title: '', detail: '', assignee: '', priority: 'mid', due_minutes: 30 }
  showForm.value = false
}
async function op(w, action) { await run(() => store.woOp(w.id, action)) }
async function complete(w) {
  const result = prompt(`办结工单「${w.title}」：\n处理结果（将回写危机 #${w.crisis_id} 时间线）：`)
  if (result == null) return
  if (!result.trim()) { store.msg('请填写处理结果', 'warn'); return }
  const resolve = confirm('是否同步解除该危机的全部未解除预警？（解除途径标记为「工单联动」）')
  await run(async () => {
    const r = await store.woOp(w.id, 'complete', { result: result.trim(), resolve_alerts: resolve })
    if (r.resolved) store.msg(`工单已办结，联动解除 ${r.resolved} 条未解除预警`, 'success')
    else store.msg('工单已办结，结果已回写危机时间线', 'success')
  })
}
async function returnBack(w) {
  const note = prompt(`退回工单「${w.title}」至待处理池（清空处理人，需重新指派）：\n退回原因：`)
  if (note == null) return
  if (!note.trim()) { store.msg('请填写退回原因', 'warn'); return }
  await run(() => store.woOp(w.id, 'return', { note: note.trim() }))
}
async function reviewBack(w) {
  const note = prompt(`验收回退工单「${w.title}」（已完成 → 处理中返工，保留处理人）：\n回退原因：`)
  if (note == null) return
  if (!note.trim()) { store.msg('请填写回退原因', 'warn'); return }
  await run(() => store.woOp(w.id, 'return', { note: note.trim() }))
}
async function reassign(w) {
  const names = directory.value.map((u) => `${u.name}（${roleText(u.role)}）`).join(' / ')
  const name = prompt(`改派工单「${w.title}」，当前处理人：${w.assignee || '（未指派）'}\n可选处理人：${names}\n请输入新处理人姓名：`, w.assignee || '')
  if (name == null || !name.trim()) return
  await run(() => store.woOp(w.id, 'assign', { assignee: name.trim() }))
}
async function cancel(w) {
  const note = prompt(`取消工单「${w.title}」？\n取消说明（可留空）：`)
  if (note == null) return
  await run(() => store.woOp(w.id, 'cancel', { note: note.trim() }))
}
async function toggleLogs(w) {
  if (logId.value === w.id) { logId.value = null; logs.value = []; return }
  const d = await store.fetchWO(w.id)
  logs.value = d.logs
  logId.value = w.id
}

let timer = null
onMounted(async () => {
  await load()
  timer = setInterval(() => {
    nowMs.value = Date.now()
    load() // 轮询：超时升级由调度器驱动，状态变化自动刷新
    if (logId.value) {
      const id = logId.value
      store.fetchWO(id).then((d) => { if (logId.value === id) logs.value = d.logs }).catch(() => {})
    }
  }, 4000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.wo{display:flex;flex-direction:column;gap:12px;}
.wtoolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.add{font-family:inherit;background:linear-gradient(135deg,#00897b,#2962ff);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;}
.hint{font-size:11px;color:#5b6f94;flex:1;min-width:200px;}
.me{font-size:11px;color:#8ba2c8;background:#13233f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 12px;}
.wo-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.row select,.row input{flex:1;min-width:120px;}
input,select,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:48px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.f-hint{margin:0;font-size:10px;color:#5b6f94;}
.counts{display:flex;gap:6px;flex-wrap:wrap;}
.chip{background:#0f1b38;border:1px solid rgba(120,160,220,0.18);color:#8ba2c8;border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;font-family:inherit;}
.chip.on{border-color:#2962ff;color:#fff;background:#132a52;}
.chip.escalated.on{border-color:#ff9800;background:#33230e;}
.orders{display:flex;flex-direction:column;gap:10px;}
.order{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-left:4px solid #546e7a;border-radius:10px;padding:12px 14px;}
.order.pending{border-left-color:#42a5f5;}
.order.doing{border-left-color:#ffb300;}
.order.done{border-left-color:#66bb6a;}
.order.escalated{border-left-color:#ff9800;}
.order.cancelled{opacity:.55;}
.order.overdue{box-shadow:inset 0 0 0 1px rgba(239,83,80,.35);}
.o-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:relative;}
.st{font-size:10px;padding:2px 9px;border-radius:6px;flex:none;}
.st.pending{background:#0d2137;color:#90caf9;}
.st.doing{background:#33260a;color:#ffd54f;}
.st.done{background:#1b5e20;color:#a5d6a7;}
.st.escalated{background:#3e2723;color:#ffcc80;}
.st.cancelled{background:#21262c;color:#78909c;}
.pr{font-size:10px;padding:2px 8px;border-radius:6px;flex:none;background:#16263f;color:#8ba2c8;}
.pr.high{background:#4a1518;color:#ef9a9a;}
.pr.mid{background:#33260a;color:#ffd54f;}
.pr.low{background:#16263f;color:#90a4ae;}
.o-title{color:#fff;font-size:13px;flex:1;min-width:160px;}
.esc-tag{font-size:10px;color:#ffcc80;background:#3e2723;border-radius:5px;padding:1px 6px;}
.ret-tag{font-size:10px;color:#ce93d8;background:#2a1530;border-radius:5px;padding:1px 6px;}
.logbtn{background:none;border:1px solid rgba(120,160,220,0.25);color:#8ba2c8;border-radius:7px;padding:3px 9px;font-size:10px;cursor:pointer;font-family:inherit;}
.o-detail{color:#8ba2c8;font-size:11px;margin:6px 0;}
.o-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#5b6f94;}
.o-meta i{color:#90caf9;font-style:normal;}
.o-meta i.none{color:#ffab91;}
.o-meta i.over{color:#ef9a9a;}
.o-result{margin-top:6px;font-size:11px;color:#a5d6a7;background:#10241a;border-radius:6px;padding:5px 9px;}
.o-result em{color:#5b6f94;font-style:normal;font-size:10px;}
.o-result.dim{color:#8ba2c8;background:#13233f;}
.o-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}
.op{background:none;border:1px solid rgba(144,202,249,.4);color:#90caf9;cursor:pointer;border-radius:7px;padding:4px 10px;font-size:11px;font-family:inherit;}
.op.go{border-color:rgba(255,213,79,.45);color:#ffe082;}
.op.done{border-color:rgba(102,187,106,.5);color:#81c784;}
.op.back{border-color:rgba(206,147,216,.45);color:#ce93d8;}
.op.cancel{border-color:rgba(239,83,80,.4);color:#ef5350;}
.o-logs{margin-top:10px;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:180px;overflow-y:auto;}
.olog{display:flex;align-items:baseline;gap:8px;font-size:10px;color:#8ba2c8;}
.olog em{margin-left:auto;color:#5b6f94;font-style:normal;white-space:nowrap;}
.lg-act{flex:none;font-size:9px;padding:1px 7px;border-radius:5px;background:#16263f;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.lg-act.escalated,.lg-act.returned{color:#ffab91;border-color:rgba(255,138,101,.35);}
.lg-act.completed{color:#81c784;border-color:rgba(102,187,106,.35);}
.lg-act.cancelled{color:#b0bec5;border-color:rgba(176,190,197,.3);}
.none{color:#5b6f94;text-align:center;padding:24px;}
</style>
