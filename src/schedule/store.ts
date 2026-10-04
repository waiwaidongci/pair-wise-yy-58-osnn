import { defineStore } from 'pinia';
import {
  acceptAlternative,
  applyWindStop,
  buildReservations,
  craneOutages,
  findConflicts,
  migrateLegacy,
  recoverSchedule,
  submitWindowRequest,
  toMin
} from './engine';
import { seedCranes, seedSteps } from './seed';
import type {
  Crane,
  LegacyStep,
  Reservation,
  ScheduleConflict,
  ScheduleStep,
  Sector,
  TimeWindow,
  WindowRequest
} from './types';
import type { OutageMap } from './engine';

export type LedgerEntry = {
  at: string;
  text: string;
  tone: 'ok' | 'warn' | 'danger' | 'info';
};

type LedgerState = {
  cranes: Crane[];
  steps: ScheduleStep[];
  claims: WindowRequest[];
  windStops: TimeWindow[];
  log: LedgerEntry[];
};

const cacheKey = 'yy58-schedule-ledger';

function load(): Partial<LedgerState> | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(cacheKey);
  return raw ? JSON.parse(raw) : null;
}

const saved = load();

function pushLog(log: LedgerEntry[], text: string, tone: LedgerEntry['tone']) {
  log.unshift({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text, tone });
  if (log.length > 60) log.pop();
}

export const useScheduleStore = defineStore('schedule-ledger', {
  state: (): LedgerState => ({
    cranes: (saved?.cranes as Crane[]) ?? seedCranes.map((c) => ({ ...c })),
    steps: (saved?.steps as ScheduleStep[]) ?? seedSteps.map((s) => ({ ...s, sectors: { ...s.sectors } })),
    claims: (saved?.claims as WindowRequest[]) ?? [],
    windStops: (saved?.windStops as TimeWindow[]) ?? [],
    log: (saved?.log as LedgerEntry[]) ?? [
      { at: '', text: '排程账初始化：A/B 两班共用主吊、辅吊，已按步骤时段与回转占位建账。', tone: 'info' }
    ]
  }),
  getters: {
    outages(state): OutageMap {
      let map = craneOutages(state.cranes);
      for (const wind of state.windStops) {
        map = applyWindStop(map, state.cranes, { ...wind, reason: '风停（风速超限暂停作业）' });
      }
      return map;
    },
    /** 已确认的时窗申请也作为占用入账 */
    claimReservations(state): Reservation[] {
      return state.claims
        .filter((claim) => claim.state === 'held')
        .flatMap((claim) =>
          claim.craneIds.map((craneId) => ({
            id: claim.reservationId ? `${claim.reservationId}-${craneId}` : `R-claim-${claim.id}-${craneId}`,
            stepId: `CLAIM-${claim.id}`,
            craneId,
            start: claim.start,
            end: claim.end,
            sector: claim.sectors[craneId],
            retained: false,
            kind: 'claim' as const
          }))
        );
    },
    reservations(): Reservation[] {
      return [...buildReservations(this.steps), ...this.claimReservations];
    },
    stepReservations(): Reservation[] {
      return buildReservations(this.steps);
    },
    conflicts(): ScheduleConflict[] {
      return findConflicts(this.reservations, { cranes: this.cranes });
    },
    stepConflicts(): ScheduleConflict[] {
      return findConflicts(this.stepReservations, { cranes: this.cranes });
    },
    completedSteps(state): ScheduleStep[] {
      return state.steps.filter((s) => s.state === 'completed');
    },
    failedSteps(): ScheduleStep[] {
      return this.steps.filter((s) => s.state === 'failed');
    },
    heldClaims(state): WindowRequest[] {
      return state.claims.filter((c) => c.state === 'held');
    },
    queuedClaims(state): WindowRequest[] {
      return state.claims.filter((c) => c.state === 'queued');
    },
    craneName(state) {
      return (id: string) => state.cranes.find((c) => c.id === id)?.name ?? id;
    },
    conflictsByStep(): Record<string, ScheduleConflict[]> {
      const map: Record<string, ScheduleConflict[]> = {};
      for (const cf of this.conflicts) {
        (map[cf.stepAId] ??= []).push(cf);
        (map[cf.stepBId] ??= []).push(cf);
      }
      return map;
    }
  },
  actions: {
    persist() {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(cacheKey, JSON.stringify(this.$state));
    },
    record(text: string, tone: LedgerEntry['tone'] = 'info') {
      pushLog(this.log, text, tone);
      this.persist();
    },

    // —— 现场改步骤时间 / 吊车位置：时间轴重排并重新核账 ——
    moveStep(id: string, start: number, end: number) {
      const step = this.steps.find((s) => s.id === id);
      if (!step || end <= start) return;
      step.start = start;
      step.end = end;
      const found = this.stepConflicts.find((c) => c.stepAId === id || c.stepBId === id);
      this.record(`现场调整 ${id} 时段为 ${start}–${end}：${found ? '出现重叠冲突，已列入冲突账' : '时间轴重算完成，无重叠'}`, found ? 'danger' : 'ok');
      this.persist();
    },
    updateSector(id: string, craneId: string, patch: Partial<Sector>) {
      const step = this.steps.find((s) => s.id === id);
      if (!step) return;
      step.sectors[craneId] = { ...step.sectors[craneId], ...patch };
      this.record(`${id} 的 ${this.craneName(craneId)} 回转占位改为 ${step.sectors[craneId].from}°→${step.sectors[craneId].to}° / R${step.sectors[craneId].radius}m，重新核账`, 'info');
      this.persist();
    },
    moveCrane(id: string, x: number, y: number) {
      const crane = this.cranes.find((c) => c.id === id);
      if (!crane) return;
      crane.x = x;
      crane.y = y;
      const found = this.stepConflicts.some((c) => c.type === 'sweep');
      this.record(`${crane.name} 站位移至 (${x}, ${y})，全部回转占位重新相交校核：${found ? '存在占位相撞' : '无相撞'}`, found ? 'danger' : 'ok');
      this.persist();
    },

    // —— 旧步骤补迁：缺结束时间按原时长补 ——
    importLegacy(legacy: LegacyStep[]) {
      const migrated = legacy.map((item) => migrateLegacy(item));
      this.steps.push(...migrated);
      this.record(`补迁 ${migrated.length} 条旧步骤：缺结束时间的按原时长补齐`, 'info');
      this.persist();
    },

    // —— 风停 / 故障：标记失败步骤，已完成占用保留 ——
    addWindStop(startText: string, endText: string) {
      const start = toMin(startText);
      const end = toMin(endText);
      if (end <= start) return;
      this.windStops.push({ start, end });
      this.markFailuresInWindow({ start, end }, '风停（风速超限暂停作业）', 'wind');
    },
    reportCraneFault(craneId: string, startText: string, endText: string, reason: string) {
      const crane = this.cranes.find((c) => c.id === craneId);
      if (!crane || toMin(endText) <= toMin(startText)) return;
      crane.failedAt = toMin(startText);
      crane.resumeAt = toMin(endText);
      crane.faultReason = reason || '吊车故障';
      this.markFailuresInWindow({ start: crane.failedAt, end: crane.resumeAt }, `${crane.name}故障：${crane.faultReason}`);
    },
    clearCraneFault(craneId: string) {
      const crane = this.cranes.find((c) => c.id === craneId);
      if (!crane) return;
      crane.failedAt = null;
      crane.resumeAt = null;
      crane.faultReason = '';
      this.record(`${crane.name}故障已排除，可以恢复排程`, 'ok');
      this.persist();
    },
    clearWindStops() {
      this.windStops = [];
      this.record('风停窗口已清除', 'ok');
      this.persist();
    },
    markFailuresInWindow(window: TimeWindow, reason: string, kind: 'wind' | 'fault' = 'fault') {
      const blocked: string[] = [];
      for (const step of this.steps) {
        if (step.state === 'completed') continue;
        const overlaps = step.start < window.end && window.start < step.end;
        if (!overlaps) continue;
        if (kind === 'wind' || step.craneIds.some((craneId) => (this.outages[craneId] ?? []).some((o: { start: number; end: number }) => o.start < window.end && window.start < o.end))) {
          step.state = 'failed';
          step.failureReason = reason;
          blocked.push(step.id);
        }
      }
      this.record(`${reason}；${blocked.length ? `失败步骤 ${blocked.join('、')}，已完成占用保留` : '时段内无待执行步骤'}`, blocked.length ? 'danger' : 'warn');
      this.persist();
    },

    // —— 从失败步骤恢复重试 ——
    recover(failedStepId?: string) {
      const target = failedStepId ?? this.steps.find((s) => s.state === 'failed')?.id;
      if (!target) {
        this.record('没有可恢复的失败步骤', 'warn');
        return;
      }
      const result = recoverSchedule(this.steps, target, this.reservations, { cranes: this.cranes, outages: this.outages });
      this.steps = result.steps;
      if (result.recovered) {
        this.record(`从 ${target} 恢复重试成功：已完成占用保留，后续步骤顺延重排`, 'ok');
      } else {
        this.record(`从 ${target} 恢复失败：${result.reason}，保留失败标记等待条件解除`, 'danger');
      }
      this.persist();
    },

    markComplete(id: string) {
      const step = this.steps.find((s) => s.id === id);
      if (!step) return;
      step.state = 'completed';
      step.failureReason = undefined;
      this.record(`${id} 已完成，占用转为保留占用（后续排程失败也不释放）`, 'ok');
      this.persist();
    },

    // —— 两名调度员同时提交：先到者占用，后到者备选时窗 ——
    submitClaim(input: { id: string; dispatcher: string; craneIds: string[]; sectors: Record<string, Sector>; start: number; end: number }) {
      const { request } = submitWindowRequest(input, this.claims, this.reservations, { cranes: this.cranes });
      this.claims.push(request);
      if (request.state === 'held') {
        this.record(`调度员 ${request.dispatcher}（#${request.seq}）申请 ${input.id} 时窗先到，已预占吊车`, 'ok');
      } else {
        this.record(`调度员 ${request.dispatcher}（#${request.seq}）时窗冲突，转入备选：${request.reason}`, 'warn');
      }
      this.persist();
      return request;
    },
    acceptClaimAlternative(claimId: string, window: TimeWindow) {
      const claim = this.claims.find((c) => c.id === claimId);
      if (!claim || claim.state !== 'queued') return;
      const { request } = acceptAlternative(claim, window);
      const index = this.claims.findIndex((c) => c.id === claimId);
      this.claims[index] = request;
      this.record(`调度员 ${request.dispatcher} 采用备选时窗并完成占用`, 'ok');
      this.persist();
    },
    releaseClaim(claimId: string) {
      const index = this.claims.findIndex((c) => c.id === claimId);
      if (index < 0) return;
      const [claim] = this.claims.splice(index, 1);
      this.record(`调度员 ${claim.dispatcher} 的时窗申请已撤销`, 'info');
      this.persist();
    },
    resetAll() {
      this.cranes = seedCranes.map((c) => ({ ...c }));
      this.steps = seedSteps.map((s) => ({ ...s, sectors: { ...s.sectors } }));
      this.claims = [];
      this.windStops = [];
      this.log = [{ at: '', text: '排程账已重置为初始台账。', tone: 'info' }];
      this.persist();
    }
  }
});
