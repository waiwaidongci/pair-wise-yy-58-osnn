<script setup lang="ts">
import { computed, ref } from 'vue';
import { useScheduleStore } from './scheduleStore';
import { toMinutes, toHHMM, addMinutes } from './schedule';
import type { CraneId, ShiftId, ScheduleStep } from './schedule';

const store = useScheduleStore();

const DAY_START = 7 * 60; // 07:00
const DAY_END = 14 * 60;  // 14:00
const span = DAY_END - DAY_START;

function pct(hhmm: string): number {
  return ((toMinutes(hhmm) - DAY_START) / span) * 100;
}
function blockWidth(start: string, end: string): number {
  return ((toMinutes(end) - toMinutes(start)) / span) * 100;
}
function displayEnd(s: ScheduleStep): string {
  return s.end || addMinutes(s.start, s.durationMin);
}

const hours = Array.from({ length: 8 }, (_, i) => toHHMM(DAY_START + i * 60));

const craneRows = computed(() =>
  store.cranes.map((crane) => {
    const entries = store.ledger.filter((o) => o.craneId === crane.id && o.status !== 'held');
    const pending = store.steps.filter(
      (s) => s.craneId === crane.id && !store.ledger.some((o) => o.stepId === s.id && o.status !== 'held')
    );
    return { crane, entries, pending };
  })
);

const shiftName = (id: ShiftId) => store.shifts.find((s) => s.id === id)?.name ?? id;

const statusColor: Record<string, string> = {
  completed: '#2b8a69',
  reserved: '#3a6ea5',
  failed: '#c43b37',
  held: '#9c8a3a'
};

function toggleWind(stepId: string, current: number, limit: number) {
  store.setWind(stepId, current > limit ? limit - 1 : 12);
}

/* 并发提交演示 */
const walk = ref({
  craneId: 'main' as CraneId,
  start: '13:00',
  end: '13:40',
  slewFrom: 90,
  slewTo: 120,
  radius: 20,
  durationMin: 40,
  stepTitle: '临时加吊'
});

function submit() {
  store.submitWindow({
    craneId: walk.value.craneId,
    shift: 'day',
    start: walk.value.start,
    end: walk.value.end,
    slewFrom: walk.value.slewFrom,
    slewTo: walk.value.slewTo,
    radius: walk.value.radius,
    durationMin: walk.value.durationMin,
    stepTitle: walk.value.stepTitle
  });
  // 提交后切换为另一名调度员，演示“同时提交同一时窗”
  store.submitter = store.submitter === '王工' ? '李工' : '王工';
}

function pickAlternative(win: { start: string; end: string }) {
  walk.value.start = win.start;
  walk.value.end = win.end;
  store.clearSubmitResult();
}
</script>

<template>
  <div class="ledger">
    <!-- 设备与班次 -->
    <div class="res-row">
      <article v-for="crane in store.cranes" :key="crane.id" class="res-card">
        <div class="res-head">
          <strong>{{ crane.name }}</strong>
          <q-badge :color="crane.status === 'ok' ? 'positive' : 'negative'">
            {{ crane.status === 'ok' ? '完好' : '故障' }}
          </q-badge>
        </div>
        <span>两班共用 · {{ crane.id === 'main' ? '主吊 1200t' : '辅吊 400t' }}</span>
        <div class="res-actions">
          <q-btn
            v-if="crane.status === 'ok'"
            size="sm"
            outline
            color="negative"
            label="模拟故障"
            @click="store.setCraneStatus(crane.id, 'fault')"
          />
          <q-btn v-else size="sm" color="positive" label="修复" @click="store.setCraneStatus(crane.id, 'ok')" />
        </div>
      </article>
      <article class="res-card shifts-card">
        <div class="res-head"><strong>班次</strong></div>
        <div class="shift-chips">
          <span v-for="s in store.shifts" :key="s.id" class="shift-chip">{{ s.name }}</span>
        </div>
        <span class="muted">白班 / 夜班共用主吊、辅吊，预占时窗按吊车分别记账。</span>
      </article>
    </div>

    <!-- 补迁提示 -->
    <div v-if="store.migrationCount > 0" class="banner migrate">
      <q-icon name="history" />
      <span>检测到 <b>{{ store.migrationCount }}</b> 条旧步骤缺少结束时间，已按原时长补迁结束时间。</span>
      <q-btn size="sm" color="primary" label="一键补迁" @click="store.migrateAll" />
    </div>

    <!-- 排程操作 -->
    <div class="action-bar">
      <q-btn color="primary" no-caps icon="playlist_add_check" label="生成排程账" @click="store.runSchedule" />
      <q-btn
        color="secondary"
        no-caps
        icon="restart_alt"
        label="从失败步骤恢复重试"
        :disable="!store.lastRun?.failedStep"
        @click="store.retry"
      />
      <q-btn flat no-caps label="重置" @click="store.reset" />
      <span class="version-tag">账本版本 v{{ store.version }}</span>
      <span class="muted">已完成占用 {{ store.completedCount }} 项 · 冲突 {{ store.conflicts.length }} 项</span>
    </div>

    <div v-if="store.lastRun?.failedStep" class="banner fail">
      <q-icon name="error" />
      <span>
        排程在 <b>{{ store.lastRun.failedStep }}</b> 失败：{{ store.lastRun.reason }}。
        已完成的 {{ store.completedCount }} 项占用保留，风停恢复或吊车修复后可从失败步骤重试。
      </span>
    </div>
    <div v-else-if="store.lastRun" class="banner ok">
      <q-icon name="check_circle" />
      <span>排程完成，{{ store.completedCount }} 项占用已记入排程账。</span>
    </div>

    <!-- 甘特时间轴 -->
    <article class="content-panel gantt-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">SCHEDULE LEDGER</span>
          <h2>吊车预占时间轴（回转占位）</h2>
        </div>
      </div>
      <div class="gantt">
        <div class="gantt-hours">
          <span v-for="h in hours" :key="h" :style="{ left: pct(h) + '%' }">{{ h }}</span>
        </div>
        <div v-for="row in craneRows" :key="row.crane.id" class="gantt-row">
          <div class="gantt-label">{{ row.crane.name }}</div>
          <div class="gantt-track">
            <div v-for="h in hours" :key="h" class="gantt-grid" :style="{ left: pct(h) + '%' }" />
            <!-- 已预占 -->
            <div
              v-for="o in row.entries"
              :key="o.id"
              class="gantt-block"
              :class="o.status"
              :style="{
                left: pct(o.start) + '%',
                width: blockWidth(o.start, o.end) + '%',
                background: statusColor[o.status]
              }"
              :title="`${o.stepId} ${o.start}–${o.end} 回转 ${o.slewFrom}°→${o.slewTo}°`"
            >
              <span class="block-id">{{ o.stepId }}</span>
              <span class="block-slew">{{ o.slewFrom }}°→{{ o.slewTo }}°</span>
            </div>
            <!-- 未预占（计划中） -->
            <div
              v-for="s in row.pending"
              :key="s.id"
              class="gantt-block pending"
              :style="{ left: pct(s.start) + '%', width: blockWidth(s.start, displayEnd(s)) + '%' }"
            >
              <span class="block-id">{{ s.id }}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="gantt-legend">
        <span><i style="background:#2b8a69" />已完成占用</span>
        <span><i style="background:#3a6ea5" />已预占</span>
        <span><i style="background:#c43b37" />失败</span>
        <span><i class="hollow" />计划中（未预占）</span>
      </div>
    </article>

    <!-- 步骤表 -->
    <article class="content-panel steps-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">LIFT STEPS</span>
          <h2>吊装步骤与回转占位</h2>
        </div>
        <span class="muted">改时间或回转角后重新排程，重叠即列冲突</span>
      </div>
      <div class="table-wrap">
        <table class="steps-table">
          <thead>
            <tr>
              <th>步骤</th>
              <th>吊车</th>
              <th>班次</th>
              <th>开始</th>
              <th>结束</th>
              <th>时长</th>
              <th>回转占位</th>
              <th>半径</th>
              <th>风速</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in store.steps" :key="s.id" :class="['row', s.status]">
              <td class="step-name"><b>{{ s.id }}</b>{{ s.title }}</td>
              <td>{{ s.craneId === 'main' ? '主吊' : '辅吊' }}</td>
              <td>{{ shiftName(s.shift) }}</td>
              <td>
                <input
                  class="time-input"
                  type="time"
                  :value="s.start"
                  @change="store.updateStep(s.id, { start: ($event.target as HTMLInputElement).value })"
                />
              </td>
              <td>
                <input
                  v-if="!s.end"
                  class="time-input migrated"
                  type="time"
                  :value="s.end"
                  disabled
                  placeholder="补迁"
                />
                <input
                  v-else
                  class="time-input"
                  type="time"
                  :value="s.end"
                  @change="store.updateStep(s.id, { end: ($event.target as HTMLInputElement).value })"
                />
              </td>
              <td>{{ s.durationMin }}′</td>
              <td class="slew-cell">
                <input
                  class="angle-input"
                  type="number"
                  :value="s.slewFrom"
                  @change="store.updateStep(s.id, { slewFrom: Number(($event.target as HTMLInputElement).value) })"
                />°→
                <input
                  class="angle-input"
                  type="number"
                  :value="s.slewTo"
                  @change="store.updateStep(s.id, { slewTo: Number(($event.target as HTMLInputElement).value) })"
                />°
              </td>
              <td>{{ s.radius }}m</td>
              <td>
                <div class="wind-cell">
                  <input
                    class="wind-input"
                    type="number"
                    step="0.1"
                    :value="s.windNow"
                    @change="store.setWind(s.id, Number(($event.target as HTMLInputElement).value))"
                  />
                  <q-btn size="xs" :color="s.windNow > s.windLimit ? 'negative' : 'grey'" :label="s.windNow > s.windLimit ? '风停' : '防风'" @click="toggleWind(s.id, s.windNow, s.windLimit)" />
                </div>
              </td>
              <td>
                <q-badge :color="s.status === 'completed' ? 'positive' : s.status === 'failed' ? 'negative' : 'grey'">
                  {{ s.status === 'completed' ? '已完成' : s.status === 'failed' ? '失败' : '待排程' }}
                </q-badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

    <!-- 冲突清单 -->
    <article class="content-panel conflict-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">CONFLICTS</span>
          <h2>占位冲突</h2>
        </div>
        <q-badge :color="store.conflicts.length > 0 ? 'negative' : 'positive'">{{ store.conflicts.length }} 项</q-badge>
      </div>
      <div class="conflict-list">
        <div v-for="c in store.conflicts" :key="c.id" class="conflict-item" :class="{ slew: c.slewCollision }">
          <span class="sev" :class="{ high: c.slewCollision }">{{ c.slewCollision ? '回转相撞' : '时窗重复' }}</span>
          <div>
            <strong>{{ c.stepA }} ↔ {{ c.stepB }}（{{ c.craneId === 'main' ? '主吊' : '辅吊' }}）</strong>
            <small>{{ c.message }}</small>
          </div>
        </div>
        <div v-if="store.conflicts.length === 0" class="empty-state">当前排程账未发现占位冲突。</div>
      </div>
    </article>

    <!-- 并发提交 -->
    <article class="content-panel submit-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">FIRST-COME FIRST-SERVED</span>
          <h2>调度员同时提交同一时窗</h2>
        </div>
        <span class="muted">先到者占用，后到者留备选时窗</span>
      </div>
      <div class="submit-grid">
        <div class="submit-form">
          <div class="submitter-tag">当前调度员：<b>{{ store.submitter }}</b>（点击提交后切换为另一名调度员）</div>
          <div class="form-row">
            <label>吊车
              <select v-model="walk.craneId">
                <option value="main">主吊</option>
                <option value="aux">辅吊</option>
              </select>
            </label>
            <label>事项
              <input v-model="walk.stepTitle" type="text" />
            </label>
          </div>
          <div class="form-row">
            <label>开始
              <input v-model="walk.start" type="time" />
            </label>
            <label>结束
              <input v-model="walk.end" type="time" />
            </label>
          </div>
          <div class="form-row">
            <label>回转起
              <input v-model.number="walk.slewFrom" type="number" />
            </label>
            <label>回转止
              <input v-model.number="walk.slewTo" type="number" />
            </label>
          </div>
          <q-btn color="primary" no-caps icon="send" label="提交时窗预占" @click="submit" />
        </div>
        <div class="submit-result">
          <div v-if="!store.submitResult" class="empty-state">尚未提交。两名调度员先后提交同一时窗时，先到者占用，后到者将看到备选时窗。</div>
          <div v-else-if="store.submitResult.kind === 'occupied'" class="result-ok">
            <q-icon name="check_circle" color="positive" size="28px" />
            <div>
              <strong>{{ store.submitResult.entry.dispatcher }} 已占用该时窗</strong>
              <span>{{ store.submitResult.entry.start }}–{{ store.submitResult.entry.end }} · {{ store.submitResult.entry.craneId === 'main' ? '主吊' : '辅吊' }} · 回转 {{ store.submitResult.entry.slewFrom }}°→{{ store.submitResult.entry.slewTo }}°</span>
            </div>
          </div>
          <div v-else class="result-taken">
            <q-icon name="lock" color="negative" size="28px" />
            <div>
              <strong>该时窗已被 {{ store.submitResult.by.dispatcher }} 先占</strong>
              <span>{{ store.submitResult.by.start }}–{{ store.submitResult.by.end }} · 回转 {{ store.submitResult.by.slewFrom }}°→{{ store.submitResult.by.slewTo }}°</span>
              <div class="alts">
                <span class="alts-label">为后到者保留的备选时窗：</span>
                <button
                  v-for="(w, i) in store.submitResult.alternatives"
                  :key="i"
                  class="alt-chip"
                  @click="pickAlternative(w)"
                >
                  {{ w.start }}–{{ w.end }}
                </button>
                <span v-if="store.submitResult.alternatives.length === 0" class="muted">当日无备选时窗。</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.ledger { display: flex; flex-direction: column; gap: 16px; }
.res-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.res-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
.res-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.res-card > span { color: #6d8079; font-size: 12px; }
.res-actions { margin-top: 10px; display: flex; gap: 6px; }
.shift-chips { display: flex; gap: 6px; margin: 6px 0; }
.shift-chip { background: #d9ebe5; color: #125e4e; border-radius: 4px; padding: 3px 10px; font-size: 12px; }
.muted { color: #75867f; font-size: 12px; }

.banner { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 6px; font-size: 13px; }
.banner.migrate { background: #fff7e8; border: 1px solid #ecd9b0; color: #8a6420; }
.banner.fail { background: #fde9e7; border: 1px solid #f0c4c1; color: #a7312b; }
.banner.ok { background: #e7f4ee; border: 1px solid #bfe2d4; color: #1f6b52; }
.banner .q-btn { margin-left: auto; }

.action-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.version-tag { font-size: 12px; color: #6d8079; background: #eef2f0; border-radius: 4px; padding: 3px 8px; }

.gantt-panel { padding: 0; overflow: hidden; }
.gantt { padding: 12px; }
.gantt-hours { position: relative; height: 18px; margin-left: 56px; font-size: 10px; color: #8aa098; }
.gantt-hours span { position: absolute; transform: translateX(-50%); }
.gantt-row { display: flex; align-items: stretch; margin-bottom: 6px; }
.gantt-label { width: 56px; flex: 0 0 56px; font-size: 12px; color: #52675f; display: flex; align-items: center; }
.gantt-track { position: relative; flex: 1; height: 34px; background: #f4f7f6; border-radius: 4px; overflow: hidden; }
.gantt-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: #e2e9e6; }
.gantt-block { position: absolute; top: 5px; bottom: 5px; border-radius: 4px; color: #fff; font-size: 10px; display: flex; flex-direction: column; justify-content: center; padding: 0 6px; overflow: hidden; cursor: default; }
.gantt-block.pending { background: transparent; border: 1px dashed #9cafaa; color: #75867f; }
.block-id { font-weight: 700; }
.block-slew { opacity: .85; }
.gantt-legend { display: flex; gap: 16px; padding: 0 12px 12px 68px; font-size: 11px; color: #6d8079; }
.gantt-legend span { display: flex; align-items: center; gap: 5px; }
.gantt-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.gantt-legend i.hollow { background: transparent; border: 1px dashed #9cafaa; }

.steps-panel { padding: 0; overflow: hidden; }
.table-wrap { overflow-x: auto; }
.steps-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 900px; }
.steps-table th { text-align: left; padding: 10px 12px; color: #70857d; font-weight: 700; font-size: 11px; letter-spacing: .04em; border-bottom: 1px solid var(--line); background: #fafcfb; }
.steps-table td { padding: 8px 12px; border-bottom: 1px solid #edf2f0; vertical-align: middle; }
.steps-table tr.row.failed { background: #fdf3f2; }
.steps-table tr.row.completed { background: #f3f9f6; }
.step-name { display: flex; flex-direction: column; gap: 2px; }
.step-name b { color: #183129; }
.time-input { width: 86px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; }
.time-input.migrated { background: #fff7e8; border-color: #ecd9b0; color: #8a6420; }
.angle-input { width: 52px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; }
.slew-cell { white-space: nowrap; }
.wind-cell { display: flex; align-items: center; gap: 4px; }
.wind-input { width: 56px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; }

.conflict-panel { padding: 0; overflow: hidden; }
.conflict-list { padding: 12px; }
.conflict-item { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line); border-radius: 5px; padding: 10px 12px; margin-bottom: 8px; }
.conflict-item.slew { background: #fdf3f2; border-color: #f0c4c1; }
.conflict-item strong, .conflict-item small { display: block; }
.conflict-item small { color: #6d7e78; margin-top: 3px; }
.sev { padding: 3px 8px; border-radius: 3px; font-size: 11px; background: #fff0db; color: #995b14; white-space: nowrap; }
.sev.high { background: #fde9e7; color: #a7312b; }

.submit-panel { padding: 0; overflow: hidden; }
.submit-grid { display: grid; grid-template-columns: minmax(280px, .8fr) minmax(320px, 1.2fr); gap: 0; }
.submit-form { padding: 16px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 12px; }
.submitter-tag { font-size: 12px; color: #125e4e; background: #d9ebe5; border-radius: 4px; padding: 6px 10px; }
.submit-form label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: #70857d; }
.submit-form select, .submit-form input { padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px; font-size: 13px; }
.submit-result { padding: 16px; }
.result-ok, .result-taken { display: flex; gap: 12px; align-items: flex-start; }
.result-ok strong, .result-taken strong { display: block; font-size: 14px; }
.result-ok span, .result-taken span { color: #6d7e78; font-size: 12px; }
.alts { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.alts-label { font-size: 11px; color: #70857d; }
.alt-chip { border: 1px solid #2b8a69; background: #e7f4ee; color: #1f6b52; border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer; }

@media (max-width: 980px) {
  .res-row { grid-template-columns: 1fr; }
  .submit-grid { grid-template-columns: 1fr; }
  .submit-form { border-right: 0; border-bottom: 1px solid var(--line); }
}
</style>
