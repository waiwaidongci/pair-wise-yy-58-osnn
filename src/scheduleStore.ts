import { defineStore } from 'pinia';
import {
  Crane,
  CraneId,
  CraneStatus,
  Shift,
  ScheduleStep,
  Occupancy,
  RunOutcome,
  SubmitRequest,
  SubmitOutcome,
  migrateAll,
  needsMigration,
  runSchedule,
  retrySchedule,
  submitWindow,
  detectConflicts,
  addMinutes
} from './schedule';

const cranes: Crane[] = [
  { id: 'main', name: '主吊', status: 'ok' },
  { id: 'aux', name: '辅吊', status: 'ok' }
];

const shifts: Shift[] = [
  { id: 'day', name: '白班' },
  { id: 'night', name: '夜班' }
];

const initialSteps: ScheduleStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', craneId: 'main', shift: 'day', start: '07:30', end: '08:10', durationMin: 40, slewFrom: 0, slewTo: 20, radius: 18, windLimit: 10, windNow: 3.4, status: 'pending', dispatcher: '王工' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', craneId: 'main', shift: 'day', start: '08:10', end: '08:50', durationMin: 40, slewFrom: 20, slewTo: 65, radius: 22, windLimit: 10, windNow: 4.1, status: 'pending', dispatcher: '王工' },
  { id: 'S-03', title: '桁架试吊离地 300mm', craneId: 'main', shift: 'day', start: '08:50', end: '', durationMin: 40, slewFrom: 65, slewTo: 75, radius: 20, windLimit: 10, windNow: 5.2, status: 'pending', dispatcher: '王工' },
  { id: 'S-04', title: '主吊回转至安装轴线', craneId: 'main', shift: 'day', start: '09:30', end: '10:10', durationMin: 40, slewFrom: 75, slewTo: 120, radius: 24, windLimit: 10, windNow: 6.8, status: 'pending', dispatcher: '王工' },
  { id: 'S-05', title: '双机抬吊·主吊受力', craneId: 'main', shift: 'day', start: '10:10', end: '11:00', durationMin: 50, slewFrom: 120, slewTo: 160, radius: 27, windLimit: 10, windNow: 7.2, status: 'pending', dispatcher: '王工' },
  { id: 'S-06', title: '双机抬吊·辅吊溜尾', craneId: 'aux', shift: 'day', start: '10:10', end: '11:00', durationMin: 50, slewFrom: 200, slewTo: 250, radius: 26, windLimit: 10, windNow: 7.2, status: 'pending', dispatcher: '王工' },
  { id: 'S-07', title: '就位、临时固定与摘钩', craneId: 'main', shift: 'day', start: '11:00', end: '11:40', durationMin: 40, slewFrom: 160, slewTo: 185, radius: 21, windLimit: 10, windNow: 5.6, status: 'pending', dispatcher: '王工' },
  { id: 'S-08', title: '夜班主吊回转复位', craneId: 'main', shift: 'night', start: '11:20', end: '12:00', durationMin: 40, slewFrom: 175, slewTo: 210, radius: 18, windLimit: 10, windNow: 4.0, status: 'pending', dispatcher: '李工' }
];

const cacheKey = 'yy58-schedule-ledger';

type PersistedState = {
  cranes: Crane[];
  steps: ScheduleStep[];
  ledger: Occupancy[];
  version: number;
  lastRun: RunOutcome | null;
};

function loadState(): PersistedState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey);
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

export const useScheduleStore = defineStore('schedule-ledger', {
  state: () => ({
    cranes: loadState()?.cranes ?? (cranes as Crane[]),
    shifts: shifts as Shift[],
    steps: loadState()?.steps ?? (initialSteps as ScheduleStep[]),
    ledger: (loadState()?.ledger ?? []) as Occupancy[],
    version: (loadState()?.version ?? 1) as number,
    lastRun: (loadState()?.lastRun ?? null) as RunOutcome | null,
    migrated: false,
    submitResult: null as SubmitOutcome | null,
    submitter: '王工'
  }),
  getters: {
    conflicts(state) {
      return detectConflicts(state.ledger);
    },
    migrationCount(state): number {
      return state.steps.filter((s) => needsMigration(s)).length;
    },
    completedCount(state): number {
      return state.ledger.filter((o) => o.status === 'completed').length;
    },
    failedStep(state): ScheduleStep | null {
      const id = state.lastRun?.failedStep;
      return id ? state.steps.find((s) => s.id === id) ?? null : null;
    }
  },
  actions: {
    persist() {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        cacheKey,
        JSON.stringify({
          cranes: this.cranes,
          steps: this.steps,
          ledger: this.ledger,
          version: this.version,
          lastRun: this.lastRun,
          draftSavedAt: new Date().toISOString()
        })
      );
    },
    /** 旧步骤没有结束时间时，按原时长补迁。 */
    migrateAll() {
      this.steps = migrateAll(this.steps);
      this.migrated = true;
      this.persist();
    },
    updateStep(id: string, patch: Partial<ScheduleStep>) {
      const idx = this.steps.findIndex((s) => s.id === id);
      if (idx >= 0) {
        this.steps[idx] = { ...this.steps[idx], ...patch };
        // 若改了开始时间且没有结束时间，按原时长联动补迁
        if (patch.start && !this.steps[idx].end) {
          this.steps[idx].end = addMinutes(this.steps[idx].start, this.steps[idx].durationMin);
        }
      }
      this.persist();
    },
    setCraneStatus(id: CraneId, status: CraneStatus) {
      const crane = this.cranes.find((c) => c.id === id);
      if (crane) crane.status = status;
      this.persist();
    },
    setWind(id: string, windNow: number) {
      const step = this.steps.find((s) => s.id === id);
      if (step) step.windNow = windNow;
      this.persist();
    },
    /** 全量排程预占。 */
    runSchedule() {
      const outcome = runSchedule(this.steps, this.cranes, this.submitter, this.version);
      this.applyOutcome(outcome);
    },
    /** 从失败步骤恢复重试，已完成占用保留。 */
    retry() {
      const outcome = retrySchedule(this.steps, this.cranes, this.ledger, this.submitter);
      this.applyOutcome(outcome);
    },
    applyOutcome(outcome: RunOutcome) {
      this.ledger = outcome.ledger;
      this.version += outcome.ledger.length;
      this.lastRun = outcome;
      // 同步步骤状态
      const done = new Set(outcome.completed);
      this.steps.forEach((s) => {
        if (done.has(s.id)) s.status = 'completed';
        else if (outcome.failedStep === s.id) s.status = 'failed';
        else s.status = 'pending';
      });
      this.persist();
    },
    /** 调度员提交时窗（并发：先到者占用，后到者备选）。 */
    submitWindow(req: Omit<SubmitRequest, 'dispatcher'>) {
      const full: SubmitRequest = { ...req, dispatcher: this.submitter };
      const outcome = submitWindow(full, this.ledger, this.version);
      if (outcome.kind === 'occupied') {
        this.ledger.push(outcome.entry);
        this.version += 1;
      }
      this.submitResult = outcome;
      this.persist();
    },
    clearSubmitResult() {
      this.submitResult = null;
    },
    reset() {
      this.ledger = [];
      this.version = 1;
      this.lastRun = null;
      this.submitResult = null;
      this.steps = initialSteps.map((s) => ({ ...s, status: 'pending' }));
      this.cranes = cranes.map((c) => ({ ...c, status: 'ok' }));
      this.persist();
    }
  }
});
