/**
 * 排程账引擎
 *
 * 把吊车（主吊 / 辅吊，两班共用）、吊装步骤、回转占位接成一本排程账：
 *  - 每个步骤按时段 + 回转占位范围预占设备，重叠即列冲突；
 *  - 风停（风速超限停工）或吊车故障导致排程在某一步失败后，从失败步骤恢复重试，已完成占用保留；
 *  - 旧步骤没有结束时间时，按原时长补迁；
 *  - 两名调度员同时提交同一时窗时，先到者占用，后到者留备选时窗。
 */

export type CraneId = 'main' | 'aux';
export type ShiftId = 'day' | 'night';
export type CraneStatus = 'ok' | 'fault';

export type Crane = { id: CraneId; name: string; status: CraneStatus };
export type Shift = { id: ShiftId; name: string };

/** 回转占位范围（水平回转角度，度），角度区间按顺时针扫掠，支持跨 0°。 */
export type SlewRange = { from: number; to: number };

export type OccupancyStatus = 'reserved' | 'completed' | 'failed' | 'held';

/** 排程账条目：一条设备预占。 */
export type Occupancy = {
  id: string;
  stepId: string;
  stepTitle: string;
  craneId: CraneId;
  shift: ShiftId;
  start: string; // HH:MM
  end: string;   // HH:MM
  slewFrom: number;
  slewTo: number;
  radius: number;
  durationMin: number;
  status: OccupancyStatus;
  dispatcher: string;
  version: number;
};

export type StepStatus = 'pending' | 'completed' | 'failed' | 'blocked';

export type ScheduleStep = {
  id: string;
  title: string;
  craneId: CraneId;
  shift: ShiftId;
  start: string;
  end: string; // 旧步骤可能为空，补迁时按 durationMin 补
  durationMin: number; // 原时长（分钟）
  slewFrom: number;
  slewTo: number;
  radius: number;
  windLimit: number; // 作业风速限制 m/s
  windNow: number;   // 当前风速 m/s
  status: StepStatus;
  dispatcher: string;
};

/* ---------------- 时间工具 ---------------- */

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function toHHMM(min: number): string {
  const n = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function addMinutes(hhmm: string, mins: number): string {
  return toHHMM(toMinutes(hhmm) + mins);
}

export function durationOf(start: string, end: string, fallback: number): number {
  if (!end) return fallback;
  const d = toMinutes(end) - toMinutes(start);
  return d > 0 ? d : fallback;
}

/* ---------------- 回转占位 / 时段重叠 ---------------- */

/** 把回转角度区间拆成 [0,360) 上的若干线性区间。 */
function slewIntervals(r: SlewRange): Array<[number, number]> {
  if (r.from === r.to) return [];
  if (r.from < r.to) return [[r.from, r.to]];
  return [[r.from, 360], [0, r.to]];
}

function linearOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const [s1, e1] of a) {
    for (const [s2, e2] of b) {
      if (s1 < e2 && s2 < e1) return true; // 端点相接不算重叠
    }
  }
  return false;
}

/** 两个回转占位范围是否相撞（含跨 0° 情况）。 */
export function slewOverlap(a: SlewRange, b: SlewRange): boolean {
  return linearOverlap(slewIntervals(a), slewIntervals(b));
}

/** 两个时段是否重叠（端点相接不重叠）。 */
export function timeOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

/* ---------------- 冲突检测 ---------------- */

export type Conflict = {
  id: string;
  craneId: CraneId;
  stepA: string;
  stepB: string;
  slewCollision: boolean;
  message: string;
};

const ACTIVE: OccupancyStatus[] = ['reserved', 'completed'];

/**
 * 排程账冲突：同一台吊车 + 时段重叠 即列冲突；
 * 若回转占位范围也重叠，则为回转相撞（高severity）。
 */
export function detectConflicts(ledger: Occupancy[]): Conflict[] {
  const active = ledger.filter((o) => ACTIVE.includes(o.status));
  const conflicts: Conflict[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (a.craneId !== b.craneId) continue;
      if (!timeOverlap({ start: a.start, end: a.end }, { start: b.start, end: b.end })) continue;
      const slewHit = slewOverlap({ from: a.slewFrom, to: a.slewTo }, { from: b.slewFrom, to: b.slewTo });
      conflicts.push({
        id: `${a.id}×${b.id}`,
        craneId: a.craneId,
        stepA: a.stepId,
        stepB: b.stepId,
        slewCollision: slewHit,
        message: slewHit
          ? `同一台吊车回转占位相撞：${a.stepId}(${a.start}–${a.end} ${a.slewFrom}°→${a.slewTo}°) 与 ${b.stepId}(${b.start}–${b.end} ${b.slewFrom}°→${b.slewTo}°)`
          : `同一台吊车时窗重复占用：${a.stepId}(${a.start}–${a.end}) 与 ${b.stepId}(${b.start}–${b.end})`
      });
    }
  }
  return conflicts;
}

/* ---------------- 旧步骤补迁 ---------------- */

export function needsMigration(step: ScheduleStep): boolean {
  return !step.end || step.end.trim() === '';
}

/** 旧步骤没有结束时间时，按原时长补迁结束时间。 */
export function migrateStep(step: ScheduleStep): ScheduleStep {
  if (!needsMigration(step)) return step;
  return { ...step, end: addMinutes(step.start, step.durationMin) };
}

export function migrateAll(steps: ScheduleStep[]): ScheduleStep[] {
  return steps.map(migrateStep);
}

/* ---------------- 排程 / 故障恢复 ---------------- */

export type RunOutcome = {
  ledger: Occupancy[];
  completed: string[];
  failedStep: string | null;
  reason: string | null;
};

function checkStep(step: ScheduleStep, cranes: Crane[]): string | null {
  if (step.windNow > step.windLimit) {
    return `风速 ${step.windNow}m/s 超过作业限制 ${step.windLimit}m/s，风停停工`;
  }
  const crane = cranes.find((c) => c.id === step.craneId);
  if (crane && crane.status === 'fault') return `${crane.name}故障，无法作业`;
  return null;
}

function toOccupancy(step: ScheduleStep, dispatcher: string, version: number, status: OccupancyStatus): Occupancy {
  return {
    id: `O-${step.id}-${version}`,
    stepId: step.id,
    stepTitle: step.title,
    craneId: step.craneId,
    shift: step.shift,
    start: step.start,
    end: step.end,
    slewFrom: step.slewFrom,
    slewTo: step.slewTo,
    radius: step.radius,
    durationMin: step.durationMin,
    status,
    dispatcher,
    version
  };
}

/** 全量排程：按步骤顺序预占，遇风停/吊车故障即停。 */
export function runSchedule(steps: ScheduleStep[], cranes: Crane[], dispatcher: string, startVersion = 1): RunOutcome {
  const ledger: Occupancy[] = [];
  const completed: string[] = [];
  let failedStep: string | null = null;
  let reason: string | null = null;
  let version = startVersion;
  for (const step of steps) {
    const err = checkStep(step, cranes);
    if (err) {
      failedStep = step.id;
      reason = err;
      break;
    }
    ledger.push(toOccupancy(step, dispatcher, version, 'completed'));
    completed.push(step.id);
    version += 1;
  }
  return { ledger, completed, failedStep, reason };
}

/** 从失败步骤恢复重试：已完成的占用原样保留，从第一个未完成步骤继续。 */
export function retrySchedule(
  steps: ScheduleStep[],
  cranes: Crane[],
  existing: Occupancy[],
  dispatcher: string
): RunOutcome {
  const done = new Set(existing.filter((o) => o.status === 'completed').map((o) => o.stepId));
  const ledger: Occupancy[] = existing.map((o) => ({ ...o })); // 已完成占用保留
  const completed = [...done];
  let failedStep: string | null = null;
  let reason: string | null = null;
  let version = existing.reduce((m, o) => Math.max(m, o.version), 0) + 1;
  for (const step of steps) {
    if (done.has(step.id)) continue;
    const err = checkStep(step, cranes);
    if (err) {
      failedStep = step.id;
      reason = err;
      break;
    }
    ledger.push(toOccupancy(step, dispatcher, version, 'completed'));
    completed.push(step.id);
    done.add(step.id);
    version += 1;
  }
  return { ledger, completed, failedStep, reason };
}

/* ---------------- 并发提交：先到者占用，后到者备选 ---------------- */

export type SubmitRequest = {
  craneId: CraneId;
  shift: ShiftId;
  start: string;
  end: string;
  slewFrom: number;
  slewTo: number;
  radius: number;
  durationMin: number;
  dispatcher: string;
  stepTitle: string;
};

export type SubmitOutcome =
  | { kind: 'occupied'; entry: Occupancy }
  | { kind: 'taken'; by: Occupancy; alternatives: TimeWindow[] };

export type TimeWindow = { start: string; end: string };

function findAlternatives(req: SubmitRequest, ledger: Occupancy[]): TimeWindow[] {
  const duration = toMinutes(req.end) - toMinutes(req.start) || req.durationMin;
  const dayStart = 6 * 60;
  const dayEnd = 18 * 60;
  const wanted = toMinutes(req.start);
  const free: Array<{ win: TimeWindow; dist: number }> = [];
  for (let s = dayStart; s + duration <= dayEnd; s += 15) {
    const cand: TimeWindow = { start: toHHMM(s), end: toHHMM(s + duration) };
    const blocked = ledger.some(
      (o) =>
        o.craneId === req.craneId &&
        o.status !== 'held' &&
        timeOverlap(cand, { start: o.start, end: o.end }) &&
        slewOverlap({ from: o.slewFrom, to: o.slewTo }, { from: req.slewFrom, to: req.slewTo })
    );
    if (!blocked) free.push({ win: cand, dist: Math.abs(s - wanted) });
  }
  // 取距离请求时窗最近的 3 个备选
  free.sort((a, b) => a.dist - b.dist);
  return free.slice(0, 3).map((f) => f.win);
}

/**
 * 两名调度员同时提交同一时窗：
 *  - 时窗空闲 → 先到者占用（occupied）；
 *  - 已被占用 → 后到者不抢占，返回先占者与备选时窗（taken + alternatives）。
 */
export function submitWindow(req: SubmitRequest, ledger: Occupancy[], version: number): SubmitOutcome {
  const mine: TimeWindow = { start: req.start, end: req.end };
  const blocker = ledger.find(
    (o) =>
      o.craneId === req.craneId &&
      o.status !== 'held' &&
      timeOverlap(mine, { start: o.start, end: o.end }) &&
      slewOverlap({ from: o.slewFrom, to: o.slewTo }, { from: req.slewFrom, to: req.slewTo })
  );
  if (!blocker) {
    const entry: Occupancy = {
      id: `O-WALK-${version}`,
      stepId: 'WALK-IN',
      stepTitle: req.stepTitle,
      craneId: req.craneId,
      shift: req.shift,
      start: req.start,
      end: req.end,
      slewFrom: req.slewFrom,
      slewTo: req.slewTo,
      radius: req.radius,
      durationMin: req.durationMin,
      status: 'reserved',
      dispatcher: req.dispatcher,
      version
    };
    return { kind: 'occupied', entry };
  }
  return { kind: 'taken', by: blocker, alternatives: findAlternatives(req, ledger) };
}
