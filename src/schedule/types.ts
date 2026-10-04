// 排程账核心类型：吊车、吊装步骤、回转占位、占用、冲突、时窗申请

export type ShiftId = 'A' | 'B';
export type StepState = 'planned' | 'completed' | 'failed';
export type RequestState = 'held' | 'queued';

/** 极坐标回转占位扇环：以吊车为圆心，[from,to] 为方位角（度，0=东，逆时针），半径单位 m */
export type Sector = {
  from: number;
  to: number;
  radius: number;
};

/** 吊车台账：两班共用，含当前站位与故障状态 */
export type Crane = {
  id: string;
  name: string;
  model: string;
  /** 站位平面坐标（米，场地坐标） */
  x: number;
  y: number;
  maxRadius: number;
  /** 故障开始时间（分钟），故障恢复后由排程器重试失败步骤 */
  failedAt: number | null;
  /** 故障结束时间（分钟），在此之前该吊车不可用 */
  resumeAt: number | null;
  /** 故障期间影响的步骤说明 */
  faultReason: string;
};

/** 吊装步骤：按时段预占设备 + 回转占位 */
export type ScheduleStep = {
  id: string;
  title: string;
  shift: ShiftId;
  craneIds: string[];
  /** 开始时间（分钟，如 7:30 = 450） */
  start: number;
  /** 结束时间（分钟）；旧步骤补迁时按原时长写入 */
  end: number;
  /** 每台吊车的回转占位，键为吊车 id */
  sectors: Record<string, Sector>;
  windLimit: number;
  state: StepState;
  /** 失败原因（风停 / 吊车故障 / 冲突），成功后清空 */
  failureReason?: string;
  source?: 'native' | 'migrated';
};

/**
 * 设备/占位占用记录。一条步骤为它用到的每台吊车生成一条占用；
 * 已完成步骤的占用在排程失败后仍然保留（retain）。
 */
export type Reservation = {
  id: string;
  stepId: string;
  craneId: string;
  start: number;
  end: number;
  sector: Sector;
  /** completed 的占用是保留占用，重试时不能被覆盖 */
  retained: boolean;
  kind: 'step' | 'claim';
};

export type ConflictType = 'equipment' | 'sweep';

export type ScheduleConflict = {
  id: string;
  type: ConflictType;
  aReservationId: string;
  bReservationId: string;
  stepAId: string;
  stepBId: string;
  craneAId: string;
  craneBId: string;
  start: number;
  end: number;
  message: string;
};

/** 调度员时窗申请：先到者 held 占用，后到者 queued 并保留备选时窗 */
export type WindowRequest = {
  id: string;
  dispatcher: string;
  craneIds: string[];
  sectors: Record<string, Sector>;
  start: number;
  end: number;
  seq: number;
  state: RequestState;
  reason?: string;
  alternatives: TimeWindow[];
  /** queued 申请被确认采用某个备选时窗后，转成占用的 reservationId */
  reservationId?: string;
};

export type TimeWindow = {
  start: number;
  end: number;
};

export type FailureResult = {
  failedStepId: string;
  reason: string;
  completedStepIds: string[];
  blockedStepIds: string[];
  /** 恢复重试后仍排不开时给出的候选时段 */
  suggestion?: TimeWindow;
};

export type LedgerInput = {
  cranes: Crane[];
  steps: ScheduleStep[];
  extraReservations: Reservation[];
};

/** 旧系统步骤：可能缺结束时间（end 为空时按原时长补迁） */
export type LegacyStep = {
  id: string;
  title: string;
  craneIds: string[];
  start: number;
  end?: number | null;
  /** 原时长（分钟），来自旧台账 */
  duration?: number;
  shift?: ShiftId;
  sectors: Record<string, Sector>;
  windLimit: number;
};
