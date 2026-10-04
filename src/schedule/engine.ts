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

// ---------- 时间工具（分钟 ↔ HH:mm） ----------

export function toMin(text: string): number {
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}

export function fmtTime(min: number): string {
  const wrapped = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function fmtRange(start: number, end: number): string {
  return `${fmtTime(start)}–${fmtTime(end)}（${end - start} 分钟）`;
}

// ---------- 时段 / 占位几何 ----------

/** 半开区间重叠：[aStart,aEnd) ∩ [bStart,bEnd) */
export function timeOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

export function overlapWindow(a: TimeWindow, b: TimeWindow): TimeWindow | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

/** 方位角是否落在扇区内（支持跨 0°，from > to 表示绕 0 跨越） */
export function angleInSector(angle: number, sector: Sector): boolean {
  const a = ((angle % 360) + 360) % 360;
  const from = ((sector.from % 360) + 360) % 360;
  const to = ((sector.to % 360) + 360) % 360;
  if (from === to) return true; // 整圆
  if (from < to) return a >= from && a <= to;
  return a >= from || a <= to;
}

/** 两扇环是否相交：圆相交 + 对向方位角落在彼此扇区内 */
export function sectorsOverlap(craneA: Crane, sa: Sector, craneB: Crane, sb: Sector): boolean {
  const dx = craneB.x - craneA.x;
  const dy = craneB.y - craneA.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= sa.radius + sb.radius) return false; // 作业半径圆不相交
  // 吊车重合时只看半径
  if (dist < 1e-6) return true;
  const bearingAToB = (Math.atan2(dy, dx) * 180) / Math.PI;
  const bearingBToA = bearingAToB + 180;
  return angleInSector(bearingAToB, sa) && angleInSector(bearingBToA, sb);
}

// ---------- 占用构建 ----------

let reservationSeq = 0;
export function resetReservationSeq(seed = 0) {
  reservationSeq = seed;
}

export function reservationForStep(step: ScheduleStep, craneId: string): Reservation {
  return {
    id: `R-${++reservationSeq}`,
    stepId: step.id,
    craneId,
    start: step.start,
    end: step.end,
    sector: step.sectors[craneId],
    retained: step.state === 'completed',
    kind: 'step'
  };
}

export function buildReservations(steps: ScheduleStep[]): Reservation[] {
  return steps.flatMap((step) => step.craneIds.map((craneId) => reservationForStep(step, craneId)));
}

// ---------- 冲突检测 ----------

type ConflictContext = {
  cranes: Crane[];
};

function craneById(cranes: Crane[], id: string): Crane {
  return cranes.find((c) => c.id === id) ?? cranes[0];
}

/**
 * 占用账两两核对：
 * - equipment：同一台吊车在重叠时段被两条占用预占；
 * - sweep：两台不同吊车的时段重叠，且回转占位扇环相交（占位相撞）。
 */
export function findConflicts(reservations: Reservation[], ctx: ConflictContext): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  const sorted = [...reservations].sort((a, b) => a.start - b.start);

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.start >= a.end) break;
      const win = overlapWindow(a, b);
      if (!win) continue;
      if (a.stepId === b.stepId) continue; // 同一步骤多机协同不算冲突

      if (a.craneId === b.craneId) {
        conflicts.push({
          id: `CF-${conflicts.length + 1}`,
          type: 'equipment',
          aReservationId: a.id,
          bReservationId: b.id,
          stepAId: a.stepId,
          stepBId: b.stepId,
          craneAId: a.craneId,
          craneBId: b.craneId,
          start: win.start,
          end: win.end,
          message: `吊车 ${a.craneId} 在 ${fmtTime(win.start)}–${fmtTime(win.end)} 被 ${a.stepId} 与 ${b.stepId} 同时预占`
        });
        continue;
      }

      const craneA = craneById(ctx.cranes, a.craneId);
      const craneB = craneById(ctx.cranes, b.craneId);
      if (sectorsOverlap(craneA, a.sector, craneB, b.sector)) {
        conflicts.push({
          id: `CF-${conflicts.length + 1}`,
          type: 'sweep',
          aReservationId: a.id,
          bReservationId: b.id,
          stepAId: a.stepId,
          stepBId: b.stepId,
          craneAId: a.craneId,
          craneBId: b.craneId,
          start: win.start,
          end: win.end,
          message: `${a.stepId}（${a.craneId}）与 ${b.stepId}（${b.craneId}）在 ${fmtTime(win.start)}–${fmtTime(win.end)} 回转占位相交`
        });
      }
    }
  }
  return conflicts;
}

// ---------- 不可用窗口（吊车故障 / 风停） ----------

export type Outage = { start: number; end: number; reason: string };

export type OutageMap = Record<string, Outage[]>;

/** 风停对所有吊车同时生效 */
export function applyWindStop(outages: OutageMap, cranes: Crane[], wind: Outage): OutageMap {
  const next: OutageMap = {};
  for (const crane of cranes) {
    next[crane.id] = [...(outages[crane.id] ?? []), wind];
  }
  return next;
}

export function craneOutages(cranes: Crane[]): OutageMap {
  const map: OutageMap = {};
  for (const crane of cranes) {
    map[crane.id] = crane.failedAt !== null && crane.resumeAt !== null
      ? [{ start: crane.failedAt, end: crane.resumeAt, reason: crane.faultReason || '吊车故障' }]
      : [];
  }
  return map;
}

export function firstBlockingOutage(window: TimeWindow, list: Outage[]): Outage | null {
  return list.find((o) => timeOverlap(window, o)) ?? null;
}

// ---------- 旧步骤补迁 ----------

/** 旧步骤缺结束时间时，按原时长（duration，缺省给 35 分钟）补迁 */
export function migrateLegacy(legacy: LegacyStep, fallbackDuration = 35): ScheduleStep {
  const duration = legacy.duration ?? (legacy.end != null ? legacy.end - legacy.start : fallbackDuration);
  return {
    id: legacy.id,
    title: legacy.title,
    shift: legacy.shift ?? 'A',
    craneIds: legacy.craneIds,
    start: legacy.start,
    end: legacy.end ?? legacy.start + duration,
    sectors: legacy.sectors,
    windLimit: legacy.windLimit,
    state: 'planned',
    source: legacy.end == null ? 'migrated' : 'native'
  };
}

// ---------- 可行性 / 恢复重试 ----------

export type FeasibleOptions = {
  cranes: Crane[];
  reservations: Reservation[];
  outages: OutageMap;
  /** 同一作业班内步骤顺序的最早允许开始时间（时间轴不回退到前序步骤之前） */
  notBefore?: number;
};

/** 检查一组候选占用在账上是否可行：无设备/占位冲突、不撞故障/风停窗口 */
export function checkFeasible(candidates: Reservation[], options: FeasibleOptions): { ok: boolean; reason?: string } {
  for (const candidate of candidates) {
    const outage = firstBlockingOutage(candidate, options.outages[candidate.craneId] ?? []);
    if (outage) {
      return { ok: false, reason: `${outage.reason}（${fmtTime(outage.start)}–${fmtTime(outage.end)}），吊车 ${candidate.craneId} 不可用` };
    }
  }
  for (const candidate of candidates) {
    for (const held of options.reservations) {
      if (held.stepId === candidate.stepId) continue;
      const win = overlapWindow(candidate, held);
      if (!win) continue;
      if (candidate.craneId === held.craneId) {
        return { ok: false, reason: `吊车 ${candidate.craneId} 已被 ${held.stepId} 预占至 ${fmtTime(held.end)}` };
      }
      const a = craneById(options.cranes, candidate.craneId);
      const b = craneById(options.cranes, held.craneId);
      if (sectorsOverlap(a, candidate.sector, b, held.sector)) {
        return { ok: false, reason: `与 ${held.stepId}（吊车 ${held.craneId}）回转占位相交` };
      }
    }
  }
  return { ok: true };
}

/**
 * 为一步寻找最早可行时段（保持原时长，按 5 分钟步进），
 * 已完成占用（retained）与其他既成占用均参与拦截。
 */
export function earliestSlot(
  step: ScheduleStep,
  options: FeasibleOptions & { horizon?: number }
): TimeWindow {
  const duration = step.end - step.start;
  const horizon = options.horizon ?? step.start + 600;
  const floor = Math.max(step.start, options.notBefore ?? 0);
  for (let t = floor; t + duration <= horizon; t += 5) {
    const candidates = step.craneIds.map((craneId) => ({
      id: `try-${step.id}-${craneId}`,
      stepId: step.id,
      craneId,
      start: t,
      end: t + duration,
      sector: step.sectors[craneId],
      retained: false,
      kind: 'step' as const
    }));
    if (checkFeasible(candidates, options).ok) return { start: t, end: t + duration };
  }
  return { start: horizon, end: horizon + duration };
}

/**
 * 从失败步骤恢复重试：
 * - completed 步骤及其 retained 占用原样保留；
 * - failed / planned 步骤从失败点开始按原顺序重排，每步取最早可行时段；
 * - 返回新步骤时间、保留占用、新增占用与失败信息。
 */
export function recoverSchedule(
  steps: ScheduleStep[],
  failedStepId: string,
  baseReservations: Reservation[],
  options: { cranes: Crane[]; outages: OutageMap }
): { steps: ScheduleStep[]; reservations: Reservation[]; failedStepId: string; recovered: boolean; reason: string } {
  const order = [...steps].sort((a, b) => a.start - b.start);
  const failedIndex = order.findIndex((s) => s.id === failedStepId);
  // 待重排步骤：失败点及之后、且未完成的步骤；其余占用（已完成、前序步骤、已占时窗）全部保留
  const reorderIds = new Set(
    order.slice(failedIndex).filter((s) => s.state !== 'completed').map((s) => s.id)
  );
  const live: Reservation[] = baseReservations.filter((r) => !reorderIds.has(r.stepId));

  const nextSteps = order.map((step) => ({ ...step }));
  let cursor = -1;
  let reason = '';
  for (let i = 0; i < nextSteps.length; i += 1) {
    const step = nextSteps[i];
    if (i < failedIndex || step.state === 'completed') {
      cursor = Math.max(cursor, step.end);
      continue;
    }

    const slot = earliestSlot(step, {
      cranes: options.cranes,
      reservations: live,
      outages: options.outages,
      notBefore: cursor >= 0 ? cursor : step.start
    });

    const candidates = step.craneIds.map((craneId) => ({
      id: `try-${step.id}-${craneId}`,
      stepId: step.id,
      craneId,
      start: slot.start,
      end: slot.end,
      sector: step.sectors[craneId],
      retained: false,
      kind: 'step' as const
    }));
    const verdict = checkFeasible(candidates, { cranes: options.cranes, reservations: live, outages: options.outages });
    if (!verdict.ok) {
      step.state = 'failed';
      step.failureReason = verdict.reason;
      reason = verdict.reason ?? '排程仍不可行';
      return { steps: nextSteps, reservations: live, failedStepId: step.id, recovered: false, reason };
    }

    step.start = slot.start;
    step.end = slot.end;
    step.state = 'planned';
    step.failureReason = undefined;
    live.push(...step.craneIds.map((craneId) => reservationForStep(step, craneId)));
    cursor = slot.end;
  }

  return { steps: nextSteps, reservations: live, failedStepId, recovered: true, reason: '已从失败步骤恢复，后续步骤顺延重排' };
}

// ---------- 调度员时窗申请（先到先得） ----------

export type ClaimResult = {
  request: WindowRequest;
  conflicts: ScheduleConflict[];
};

/**
 * 提交时窗申请：按 seq 判定先后。
 * 先到者 held 直接入账；后到者 queued，并算出同长度备选时窗。
 */
export function submitWindowRequest(
  request: Omit<WindowRequest, 'seq' | 'state' | 'alternatives'>,
  heldRequests: WindowRequest[],
  reservations: Reservation[],
  ctx: ConflictContext
): ClaimResult {
  const seq = heldRequests.length ? Math.max(...heldRequests.map((r) => r.seq)) + 1 : 1;
  const candidates: Reservation[] = request.craneIds.map((craneId) => ({
    id: `claim-${request.id}-${craneId}`,
    stepId: `CLAIM-${request.id}`,
    craneId,
    start: request.start,
    end: request.end,
    sector: request.sectors[craneId],
    retained: false,
    kind: 'claim'
  }));
  const conflicts = findConflicts([...reservations, ...candidates], ctx).filter(
    (c) => c.stepAId === `CLAIM-${request.id}` || c.stepBId === `CLAIM-${request.id}`
  );

  const full: WindowRequest = {
    ...request,
    seq,
    state: conflicts.length === 0 ? 'held' : 'queued',
    reason: conflicts.length ? conflicts[0].message : undefined,
    alternatives: conflicts.length === 0 ? [] : suggestAlternatives(candidates, reservations, ctx)
  };
  return { request: full, conflicts };
}

/** 备选时窗：先找冲突时段之后最近的空档，再找当天开始到申请之间的空档，最多 3 个 */
export function suggestAlternatives(
  candidates: Reservation[],
  reservations: Reservation[],
  ctx: ConflictContext,
  limit = 3
): TimeWindow[] {
  const duration = candidates[0].end - candidates[0].start;
  const result: TimeWindow[] = [];
  const pushIfFree = (start: number, end: number) => {
    if (result.length >= limit || end - start < duration) return false;
    const trial = candidates.map((c) => ({ ...c, start, end: start + duration }));
    const blockers = findConflicts([...reservations, ...trial], ctx).filter(
      (cf) => cf.stepAId === trial[0].stepId || cf.stepBId === trial[0].stepId
    );
    if (blockers.length === 0) {
      result.push({ start, end: start + duration });
      return true;
    }
    return false;
  };

  // 向后扫描：以每个相关占用的结束点为候选起点
  const ends = reservations
    .filter((r) => candidates.some((c) => c.craneId === r.craneId))
    .map((r) => r.end)
    .sort((a, b) => a - b);
  for (const end of ends) {
    if (end >= candidates[0].start) pushIfFree(end, end + duration);
    if (result.length >= limit) break;
  }
  // 向前扫描
  const starts = reservations
    .filter((r) => candidates.some((c) => c.craneId === r.craneId))
    .map((r) => r.start)
    .sort((a, b) => b - a);
  for (const start of starts) {
    if (start - duration < candidates[0].start) pushIfFree(start - duration, start);
    if (result.length >= limit) break;
  }
  if (result.length === 0) pushIfFree(candidates[0].end, candidates[0].end + duration);
  return result;
}

/** queued 调度员确认采用某个备选时窗：转 held 并生成占用 */
export function acceptAlternative(
  request: WindowRequest,
  window: TimeWindow
): { request: WindowRequest; reservations: Reservation[] } {
  const reservations: Reservation[] = request.craneIds.map((craneId) => ({
    id: `R-claim-${request.id}-${craneId}`,
    stepId: `CLAIM-${request.id}`,
    craneId,
    start: window.start,
    end: window.end,
    sector: request.sectors[craneId],
    retained: false,
    kind: 'claim'
  }));
  return {
    request: { ...request, state: 'held', start: window.start, end: window.end, reason: undefined, reservationId: reservations[0].id, alternatives: [] },
    reservations
  };
}
