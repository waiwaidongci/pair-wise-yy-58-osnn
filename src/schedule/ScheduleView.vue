<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useScheduleStore } from './store';
import { fmtTime, toMin } from './engine';
import type { ScheduleStep, Sector, LegacyStep } from './types';

const store = useScheduleStore();

// 时间轴视窗 06:00–16:00
const AXIS_START = 6 * 60;
const AXIS_END = 16 * 60;
const AXIS_MINUTES = AXIS_END - AXIS_START;
const HOUR_WIDTH = 150;

function pct(min: number) {
  return ((min - AXIS_START) / AXIS_MINUTES) * 100;
}
function widthPct(start: number, end: number) {
  return Math.max(0, ((end - start) / AXIS_MINUTES) * 100);
}

const axisHours = Array.from({ length: 11 }, (_, i) => AXIS_START + i * 60);
const trackCount = computed(() => store.cranes.length + 1); // 吊车轨 + 时窗申请轨

// —— 步骤编辑 ——
const editingId = ref<string | null>(null);
const editor = reactive<{ start: string; end: string; sector: Sector; craneId: string }>({
  start: '',
  end: '',
  sector: { from: 0, to: 90, radius: 20 },
  craneId: 'CR-MAIN'
});

function startEdit(step: ScheduleStep) {
  editingId.value = step.id;
  const craneId = step.craneIds[0];
  editor.craneId = craneId;
  editor.start = fmtTime(step.start);
  editor.end = fmtTime(step.end);
  editor.sector = { ...step.sectors[craneId] };
}

function saveEdit() {
  if (!editingId.value) return;
  const [sh, sm] = editor.start.split(':').map(Number);
  const [eh, em] = editor.end.split(':').map(Number);
  store.moveStep(editingId.value, sh * 60 + sm, eh * 60 + em);
  store.updateSector(editingId.value, editor.craneId, editor.sector);
  editingId.value = null;
}

function shiftStep(step: ScheduleStep, delta: number) {
  store.moveStep(step.id, step.start + delta, step.end + delta);
}

// 补迁旧台账步骤：这条旧步骤没有结束时间，按原时长 50 分钟补齐
function importLegacyDemo() {
  const legacy: LegacyStep[] = [
    {
      id: 'OLD-9',
      title: '旧台账｜班前场地与路基地垄复核',
      craneIds: ['CR-AUX'],
      start: toMin('06:40'),
      duration: 50,
      sectors: { 'CR-AUX': { from: 250, to: 340, radius: 16 } },
      windLimit: 10
    }
  ];
  store.importLegacy(legacy);
}

// 一键还原事故场景：把 S-02 提前到 07:40，与已完成的 S-01 重叠相撞
function reproduceOverlap() {
  store.moveStep('S-02', 7 * 60 + 40, 8 * 60 + 20);
}

// —— 风停 / 故障 ——
const wind = reactive({ start: '08:20', end: '09:10' });
const fault = reactive({ craneId: 'CR-AUX', start: '13:20', end: '14:10', reason: '辅吊变幅机构报警停机' });

function addWind() {
  store.addWindStop(wind.start, wind.end);
}
function addFault() {
  store.reportCraneFault(fault.craneId, fault.start, fault.end, fault.reason);
}

// —— 吊车移位 ——
const cranePos = reactive<Record<string, { x: number; y: number }>>(
  Object.fromEntries(store.cranes.map((c) => [c.id, { x: c.x, y: c.y }]))
);
function saveCranePosition(craneId: string) {
  store.moveCrane(craneId, cranePos[craneId].x, cranePos[craneId].y);
}
function collideCranes() {
  // 演示：辅吊向主吊方向靠拢 + S-02 提前到 07:40 与已完成 S-01 时段重叠，
  // 时间轴虽按原顺序显示，但 S-02 辅吊回转占位会撞上 S-01 主吊占位
  cranePos['CR-AUX'].x = -2;
  cranePos['CR-AUX'].y = -4;
  store.moveCrane('CR-AUX', -2, -4);
  store.moveStep('S-02', 7 * 60 + 40, 8 * 60 + 20);
}

// —— 双调度员抢同一时窗 ——
const claimForm = reactive({
  dispatcher: '周工',
  craneIds: ['CR-MAIN'] as string[],
  start: '08:15',
  end: '08:45',
  from: 20,
  to: 120,
  radius: 24
});
let claimSeq = 1;

function buildClaimInput(dispatcher: string, tag: string) {
  const [sh, sm] = claimForm.start.split(':').map(Number);
  const [eh, em] = claimForm.end.split(':').map(Number);
  const sectors: Record<string, Sector> = {};
  for (const id of claimForm.craneIds) {
    sectors[id] = { from: claimForm.from, to: claimForm.to, radius: claimForm.radius };
  }
  return {
    id: `W${String(claimSeq++).padStart(2, '0')}-${tag}`,
    dispatcher,
    craneIds: [...claimForm.craneIds],
    sectors,
    start: sh * 60 + sm,
    end: eh * 60 + em
  };
}

function submitOne(tag: string) {
  store.submitClaim(buildClaimInput(claimForm.dispatcher, tag));
}

// 两名调度员同时提交同一时窗：同一事务内连交两单，按入账先后判定
function submitBoth() {
  store.submitClaim(buildClaimInput('周工（A班调度）', 'A'));
  store.submitClaim(buildClaimInput('吴工（B班调度）', 'B'));
}

function stateLabel(state: string) {
  return { completed: '已完成', planned: '待执行', failed: '失败' }[state] ?? state;
}
function stateClass(state: string) {
  return { completed: 'ok', planned: 'plan', failed: 'fail' }[state] ?? '';
}
</script>

<template>
  <section class="sched-page">
    <div class="sched-toolbar content-panel">
      <div class="summary">
        <div><strong>{{ store.steps.length }}</strong><span>吊装步骤</span></div>
        <div><strong class="ok-text">{{ store.completedSteps.length }}</strong><span>已完成/保留占用</span></div>
        <div><strong :class="{ 'danger-text': store.conflicts.length }">{{ store.conflicts.length }}</strong><span>占用冲突</span></div>
        <div><strong :class="{ 'warn-text': store.queuedClaims.length }">{{ store.heldClaims.length }}/{{ store.queuedClaims.length }}</strong><span>时窗 已占/备选</span></div>
      </div>
      <div class="toolbar-actions">
        <q-btn dense outline no-caps icon="restart_alt" label="还原改步骤相撞场景" @click="reproduceOverlap" />
        <q-btn v-if="store.failedSteps.length" dense color="negative" no-caps icon="schedule" label="从失败步骤恢复重试" @click="store.recover()" />
        <q-btn dense flat no-caps icon="delete_sweep" label="重置台账" @click="store.resetAll" />
      </div>
    </div>

    <!-- 时间轴占用账 -->
    <article class="content-panel chart-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">RESERVATION LEDGER</span>
          <h2>吊车 × 时段 × 回转占位 占用时间轴</h2>
        </div>
        <div class="legend">
          <span><i class="sw ok" />已完成(保留)</span>
          <span><i class="sw plan" />待执行</span>
          <span><i class="sw fail" />失败</span>
          <span><i class="sw claim" />调度时窗</span>
          <span><i class="sw outage" />风停/故障</span>
          <span><i class="sw conflict" />冲突重叠</span>
        </div>
      </div>

      <div class="gantt" :style="{ gridTemplateColumns: `96px repeat(${AXIS_MINUTES / 60}, ${HOUR_WIDTH}px)` }">
        <div class="corner">吊车 / 时窗</div>
        <div v-for="h in axisHours.slice(0, -1)" :key="h" class="hour-head">{{ fmtTime(h) }}</div>

        <template v-for="(crane, trackIndex) in store.cranes" :key="crane.id">
          <div class="track-label">
            <strong>{{ crane.name }}</strong>
            <small>{{ crane.id }}</small>
            <small v-if="crane.failedAt !== null" class="fault-tag">故障中</small>
          </div>
          <div class="track" :style="{ gridColumn: `2 / span ${AXIS_MINUTES / 60}` }">
            <div v-for="h in axisHours.slice(1, -1)" :key="h" class="gridline" :style="{ left: `${pct(h)}%` }" />
            <div
              v-for="o in store.outages[crane.id]"
              :key="`${crane.id}-${o.start}-${o.reason}`"
              class="bar outage"
              :style="{ left: `${pct(o.start)}%`, width: `${widthPct(o.start, o.end)}%` }"
              :title="o.reason"
            >
              {{ o.reason }}
            </div>
            <template v-for="r in store.reservations.filter(x => x.craneId === crane.id)" :key="r.id">
              <div
                class="bar"
                :class="[r.kind === 'claim' ? 'claim' : stateClass(store.steps.find(s => s.id === r.stepId)?.state ?? 'planned'), { retained: r.retained }]"
                :style="{ left: `${pct(r.start)}%`, width: `${widthPct(r.start, r.end)}%` }"
                @click="r.kind === 'step' && startEdit(store.steps.find(s => s.id === r.stepId)!)"
              >
                <strong>{{ r.stepId }}</strong>
                <small>{{ fmtTime(r.start) }}–{{ fmtTime(r.end) }} · {{ r.sector.from }}°→{{ r.sector.to }}° R{{ r.sector.radius }}</small>
              </div>
            </template>
          </div>
        </template>

        <div class="track-label"><strong>时窗申请</strong><small>两班调度员</small></div>
        <div class="track claim-track" :style="{ gridColumn: `2 / span ${AXIS_MINUTES / 60}` }">
          <div v-for="h in axisHours.slice(1, -1)" :key="h" class="gridline" :style="{ left: `${pct(h)}%` }" />
          <div
            v-for="claim in store.claims"
            :key="claim.id"
            class="bar claim"
            :class="{ queued: claim.state === 'queued' }"
            :style="{ left: `${pct(claim.start)}%`, width: `${widthPct(claim.start, claim.end)}%`, top: claim.seq % 2 ? '2px' : '26px' }"
          >
            <strong>{{ claim.dispatcher }} · {{ claim.state === 'held' ? '先到已占' : '后到备选' }}</strong>
          </div>
        </div>
      </div>

      <div v-if="store.conflicts.length" class="conflict-ribbon">
        <q-icon name="warning" />
        <span>检测到 {{ store.conflicts.length }} 处时段重叠占用，详见下方冲突账。</span>
      </div>
    </article>

    <div class="sched-grid">
      <!-- 冲突账 -->
      <article class="content-panel sub-panel">
        <div class="panel-heading compact"><h2>冲突账（时段 + 占位相交）</h2></div>
        <div class="ledger-list">
          <div v-for="cf in store.conflicts" :key="cf.id" class="ledger-row danger-row">
            <q-icon :name="cf.type === 'sweep' ? 'sync_problem' : 'precision_manufacturing'" />
            <div>
              <strong>{{ cf.type === 'sweep' ? '回转占位相撞' : '同机时段冲突' }} · {{ fmtTime(cf.start) }}–{{ fmtTime(cf.end) }}</strong>
              <p>{{ cf.message }}</p>
            </div>
          </div>
          <div v-if="!store.conflicts.length" class="empty-state">占用账两两核对通过：同机无重叠时段，两机回转扇环无相交。</div>
        </div>
      </article>

      <!-- 风停 / 故障 -->
      <article class="content-panel sub-panel">
        <div class="panel-heading compact"><h2>风停与吊车故障（失败恢复）</h2></div>
        <div class="control-body">
          <div class="inline-form">
            <q-input v-model="wind.start" dense outlined label="风停起" style="width: 92px" />
            <q-input v-model="wind.end" dense outlined label="风停止" style="width: 92px" />
            <q-btn dense no-caps color="deep-orange" icon="air" label="登记风停" @click="addWind" />
            <q-btn v-if="store.windStops.length" dense flat no-caps label="清除风停" @click="store.clearWindStops" />
          </div>
          <div class="inline-form">
            <q-select v-model="fault.craneId" dense outlined :options="store.cranes.map(c => ({ label: c.name, value: c.id }))" label="故障吊车" style="width: 120px" />
            <q-input v-model="fault.start" dense outlined label="故障起" style="width: 92px" />
            <q-input v-model="fault.end" dense outlined label="修复于" style="width: 92px" />
          </div>
          <div class="inline-form">
            <q-input v-model="fault.reason" dense outlined label="故障原因" style="flex: 1" />
            <q-btn dense no-caps color="negative" icon="build_circle" label="登记故障" @click="addFault" />
          </div>
          <div v-for="crane in store.cranes.filter(c => c.failedAt !== null)" :key="crane.id" class="fault-line">
            <span>{{ crane.name }}：{{ fmtTime(crane.failedAt!) }}–{{ fmtTime(crane.resumeAt!) }} {{ crane.faultReason }}</span>
            <q-btn dense flat no-caps size="sm" label="已修复，清除" @click="store.clearCraneFault(crane.id)" />
          </div>
          <div class="recover-hint">
            登记后受影响步骤标记 <b>失败</b>，已完成步骤的占用保留；清除风停/故障后点
            <q-btn dense no-caps color="primary" icon="play_arrow" label="从失败步骤恢复" @click="store.recover()" />
            ，排程器从最早失败步骤起重试并把后续步骤顺延。
          </div>
        </div>
      </article>
    </div>

    <div class="sched-grid wide">
      <!-- 步骤台账 -->
      <article class="content-panel sub-panel">
        <div class="panel-heading compact">
          <h2>吊装步骤台账（两班共用双机）</h2>
          <span class="hint">点时间轴色块或“改时段”调整现场时间；旧步骤缺结束时间时按原时长补迁
            <q-btn dense flat no-caps size="sm" icon="history" label="补迁一条无结束时间的旧步骤" @click="importLegacyDemo" />
          </span>
        </div>
        <table class="sched-table">
          <thead>
            <tr><th>班</th><th>步骤</th><th>吊车 / 占位</th><th>时段</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            <template v-for="step in [...store.steps].sort((a,b) => a.start - b.start)" :key="step.id">
              <tr :class="{ failed: step.state === 'failed', done: step.state === 'completed' }">
                <td><q-badge :color="step.shift === 'A' ? 'teal' : 'indigo'">{{ step.shift }}班</q-badge></td>
                <td><strong>{{ step.id }}</strong><br /><small>{{ step.title }}</small></td>
                <td>
                  <span v-for="id in step.craneIds" :key="id" class="crane-chip">
                    {{ store.craneName(id) }} {{ step.sectors[id].from }}°→{{ step.sectors[id].to }}°/R{{ step.sectors[id].radius }}
                  </span>
                </td>
                <td>{{ fmtTime(step.start) }}–{{ fmtTime(step.end) }}</td>
                <td><q-badge :color="step.state === 'completed' ? 'positive' : step.state === 'failed' ? 'negative' : 'grey'">{{ stateLabel(step.state) }}</q-badge>
                  <small v-if="step.failureReason" class="fail-reason">{{ step.failureReason }}</small></td>
                <td class="row-actions">
                  <q-btn dense flat round size="sm" icon="chevron_left" :disable="step.state === 'completed'" @click="shiftStep(step, -15)" />
                  <q-btn dense flat round size="sm" icon="chevron_right" :disable="step.state === 'completed'" @click="shiftStep(step, 15)" />
                  <q-btn dense flat no-caps size="sm" label="改时段/占位" @click="startEdit(step)" />
                  <q-btn v-if="step.state !== 'completed'" dense flat no-caps size="sm" color="positive" label="完成" @click="store.markComplete(step.id)" />
                </td>
              </tr>
              <tr v-if="editingId === step.id" class="edit-row">
                <td colspan="6">
                  <div class="inline-form">
                    <q-input v-model="editor.start" dense outlined label="开始 HH:mm" style="width: 110px" />
                    <q-input v-model="editor.end" dense outlined label="结束 HH:mm" style="width: 110px" />
                    <q-select v-model="editor.craneId" dense outlined :options="step.craneIds.map(id => ({ label: store.craneName(id), value: id }))" label="占位吊车" style="width: 120px" />
                    <q-input v-model.number="editor.sector.from" type="number" dense outlined label="起始角°" style="width: 96px" />
                    <q-input v-model.number="editor.sector.to" type="number" dense outlined label="终止角°" style="width: 96px" />
                    <q-input v-model.number="editor.sector.radius" type="number" dense outlined label="半径m" style="width: 96px" />
                    <q-btn dense no-caps color="primary" icon="save" label="保存并重排核账" @click="saveEdit" />
                    <q-btn dense flat no-caps label="取消" @click="editingId = null" />
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </article>
    </div>

    <div class="sched-grid">
      <!-- 吊车位置 -->
      <article class="content-panel sub-panel">
        <div class="panel-heading compact"><h2>吊车站位（移动后重新校核占位）</h2></div>
        <div v-for="crane in store.cranes" :key="crane.id" class="crane-pos-row">
          <strong>{{ crane.name }} · {{ crane.model }}</strong>
          <div class="inline-form">
            <q-input v-model.number="cranePos[crane.id].x" type="number" dense outlined label="x / m" style="width: 88px" />
            <q-input v-model.number="cranePos[crane.id].y" type="number" dense outlined label="y / m" style="width: 88px" />
            <q-btn dense no-caps icon="my_location" label="移位并核账" @click="saveCranePosition(crane.id)" />
          </div>
        </div>
        <q-btn dense outline no-caps icon="warning_amber" label="演示：移辅吊+提前S-02 致占位相撞" @click="collideCranes" />
      </article>

      <!-- 双调度员时窗 -->
      <article class="content-panel sub-panel">
        <div class="panel-heading compact"><h2>调度员时窗申请（先到先占）</h2></div>
        <div class="control-body">
          <div class="inline-form">
            <q-input v-model="claimForm.dispatcher" dense outlined label="调度员" style="width: 150px" />
            <q-input v-model="claimForm.start" dense outlined label="起" style="width: 88px" />
            <q-input v-model="claimForm.end" dense outlined label="止" style="width: 88px" />
            <q-select
              v-model="claimForm.craneIds"
              multiple
              dense
              outlined
              emit-value
              map-options
              :options="store.cranes.map(c => ({ label: c.name, value: c.id }))"
              label="占用吊车"
              style="min-width: 170px"
            />
          </div>
          <div class="inline-form">
            <q-input v-model.number="claimForm.from" type="number" dense outlined label="占位起角°" style="width: 100px" />
            <q-input v-model.number="claimForm.to" type="number" dense outlined label="占位止角°" style="width: 100px" />
            <q-input v-model.number="claimForm.radius" type="number" dense outlined label="半径m" style="width: 92px" />
            <q-btn dense no-caps color="primary" icon="send" label="提交一单" @click="submitOne('S')" />
            <q-btn dense no-caps color="secondary" icon="groups" label="两人同时提交同窗" @click="submitBoth" />
          </div>
          <div class="claims-list">
            <div v-for="claim in store.claims" :key="claim.id" class="claim-row" :class="claim.state">
              <div>
                <strong>#{{ claim.seq }} {{ claim.dispatcher }}</strong>
                <small>{{ fmtTime(claim.start) }}–{{ fmtTime(claim.end) }} · {{ claim.craneIds.map(id => store.craneName(id)).join('、') }}
                  <q-badge :color="claim.state === 'held' ? 'positive' : 'warning'" class="state-chip">{{ claim.state === 'held' ? '已占用' : '备选排队' }}</q-badge>
                </small>
                <small v-if="claim.reason" class="fail-reason">{{ claim.reason }}</small>
                <div v-if="claim.state === 'queued'" class="alts">
                  <span>备选时窗：</span>
                  <q-btn
                    v-for="(alt, i) in claim.alternatives"
                    :key="i"
                    dense
                    outline
                    no-caps
                    size="sm"
                    :label="`${fmtTime(alt.start)}–${fmtTime(alt.end)}`"
                    @click="store.acceptClaimAlternative(claim.id, alt)"
                  />
                </div>
              </div>
              <q-btn dense flat round icon="close" @click="store.releaseClaim(claim.id)" />
            </div>
            <div v-if="!store.claims.length" class="empty-state">尚无时窗申请。</div>
          </div>
        </div>
      </article>
    </div>

    <!-- 排程账流水 -->
    <article class="content-panel sub-panel">
      <div class="panel-heading compact"><h2>排程账流水</h2></div>
      <div class="journal">
        <div v-for="(entry, i) in store.log" :key="i" class="journal-row" :class="entry.tone">
          <time>{{ entry.at }}</time><span>{{ entry.text }}</span>
        </div>
      </div>
    </article>
  </section>
</template>
