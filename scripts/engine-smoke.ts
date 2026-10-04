import assert from 'node:assert';
import {
  angleInSector,
  applyWindStop,
  buildReservations,
  craneOutages,
  earliestSlot,
  findConflicts,
  fmtTime,
  migrateLegacy,
  recoverSchedule,
  sectorsOverlap,
  submitWindowRequest,
  toMin
} from '../src/schedule/engine';
import { seedCranes, seedSteps } from '../src/schedule/seed';
import type { ScheduleStep } from './src/schedule/types';

let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 初始台账无冲突（同机时段不重叠，两机扇环不相交）
const cranes = seedCranes.map((c) => ({ ...c }));
const steps = seedSteps.map((s) => ({ ...s, sectors: { ...s.sectors } })) as ScheduleStep[];
ok('初始台账占用无冲突', findConflicts(buildReservations(steps), { cranes }).length === 0);

// 2. 现场改步骤时间后时间轴重排：S-02 提前到 07:40，与已完成 S-01 同机重叠 -> equipment 冲突
const s02 = steps.find((s) => s.id === 'S-02')!;
s02.start = toMin('07:40');
s02.end = toMin('08:20');
const conflictsAfterMove = findConflicts(buildReservations(steps), { cranes });
ok('改时间后列出设备冲突', conflictsAfterMove.some((c) => c.type === 'equipment' && c.stepAId === 'S-01'));

// 还原 S-02
s02.start = toMin('08:10');
s02.end = toMin('08:50');

// 3. 现场改步骤时间 + 辅吊移位：S-02 提前到 07:40 与已完成 S-01 时段重叠，
//    辅吊靠拢主吊后，S-02-辅吊与 S-01-主吊（不同步骤、不同吊车）回转占位相交 -> sweep
const moved = seedSteps.map((s) => ({ ...s, sectors: { ...s.sectors } })) as ScheduleStep[];
const movedS02 = moved.find((s) => s.id === 'S-02')!;
movedS02.start = toMin('07:40');
movedS02.end = toMin('08:20');
const movedCranes = seedCranes.map((c) => ({ ...c }));
movedCranes.find((c) => c.id === 'CR-AUX')!.x = -2;
movedCranes.find((c) => c.id === 'CR-AUX')!.y = -4;
const movedConflicts = findConflicts(buildReservations(moved), { cranes: movedCranes });
ok('改时间+移位后出现 sweep 占位相撞', movedConflicts.some((c) => c.type === 'sweep'));
ok('同机重叠同时报 equipment 冲突', movedConflicts.some((c) => c.type === 'equipment'));

// 4. 扇区几何：跨 0° 扇区
ok('跨0°扇区包含 350°', angleInSector(350, { from: 300, to: 70, radius: 10 }));
ok('跨0°扇区不包含 180°', !angleInSector(180, { from: 300, to: 70, radius: 10 }));
ok('近距离且相向扇区重叠', sectorsOverlap(cranes[0], { from: 350, to: 60, radius: 30 }, cranes[1], { from: 170, to: 210, radius: 22 }));

// 5. 旧步骤缺结束时间按原时长补迁
const migrated = migrateLegacy({
  id: 'OLD-1',
  title: '旧台账步骤',
  craneIds: ['CR-MAIN'],
  start: toMin('07:00'),
  duration: 45,
  sectors: { 'CR-MAIN': { from: 0, to: 90, radius: 20 } },
  windLimit: 8
});
ok('旧步骤按原时长 45 分钟补迁', migrated.end - migrated.start === 45 && migrated.source === 'migrated');

// 6. 风停导致 S-02 失败，恢复重试：S-01 已完成占用保留，S-02 顺延到风停后
const runSteps = seedSteps.map((s) => ({ ...s, sectors: { ...s.sectors } })) as ScheduleStep[];
let outages = craneOutages(cranes);
outages = applyWindStop(outages, cranes, { start: toMin('08:20'), end: toMin('09:10'), reason: '风停' });
const s2 = runSteps.find((s) => s.id === 'S-02')!;
s2.state = 'failed';
s2.failureReason = '风停';
const base = buildReservations(runSteps);
const windRecovery = recoverSchedule(runSteps, 'S-02', base, { cranes, outages });
ok('风停窗口内可恢复（恢复为 true）', windRecovery.recovered);
const recoveredS02 = windRecovery.steps.find((s) => s.id === 'S-02')!;
ok('S-02 顺延到 09:10 风停结束后', recoveredS02.start >= toMin('09:10'), );
const s01After = windRecovery.steps.find((s) => s.id === 'S-01')!;
ok('已完成 S-01 占用/时间保留不动', s01After.start === toMin('07:30') && s01After.end === toMin('08:05') && s01After.state === 'completed');
ok('恢复后无占用冲突', findConflicts(buildReservations(windRecovery.steps), { cranes }).length === 0);

// 7. 吊车故障窗口仍在 -> 恢复失败；排除后恢复成功
const run2 = seedSteps.map((s) => ({ ...s, sectors: { ...s.sectors } })) as ScheduleStep[];
const s04 = run2.find((s) => s.id === 'S-04')!;
s04.state = 'failed';
s04.failureReason = '辅吊故障';
const faultCranes = cranes.map((c) => ({ ...c }));
const faultAux = faultCranes.find((c) => c.id === 'CR-AUX')!;
faultAux.failedAt = toMin('13:00');
faultAux.resumeAt = toMin('23:30');
faultAux.faultReason = '辅吊故障';
const faultOutages = craneOutages(faultCranes);
const stillFailing = recoverSchedule(run2, 'S-04', buildReservations(run2), { cranes: faultCranes, outages: faultOutages });
ok('故障未排除时恢复失败并保留失败标记', !stillFailing.recovered && stillFailing.steps.find((s) => s.id === 'S-04')!.state === 'failed');
faultAux.failedAt = null;
faultAux.resumeAt = null;
const retry = recoverSchedule(stillFailing.steps.map((s) => ({ ...s })), 'S-04', buildReservations(stillFailing.steps), { cranes: faultCranes, outages: craneOutages(faultCranes) });
ok('故障排除后从 S-04 恢复成功', retry.recovered);

// 8. earliestSlot：被 08:10–08:50 的 S-02 占用时，08:00 开始 30 分钟的主吊步骤排在 08:50
const probe: ScheduleStep = {
  id: 'P1',
  title: '插入步骤',
  shift: 'A',
  craneIds: ['CR-MAIN'],
  start: toMin('08:00'),
  end: toMin('08:30'),
  sectors: { 'CR-MAIN': { from: 20, to: 120, radius: 24 } },
  windLimit: 8,
  state: 'planned'
};
const slot = earliestSlot(probe, { cranes, reservations: buildReservations(seedSteps as ScheduleStep[]), outages: craneOutages(cranes) });
ok('插入步骤避开 S-02、S-03 后顺延（09:35）', slot.start === toMin('09:35'));

// 9. 两名调度员同时提交同一时窗：先到 held，后到 queued 且有备选（选一段两台吊车都空闲的时窗）
let claims = [];
const makeClaimInput = (dispatcher: string, id: string) => ({
  id,
  dispatcher,
  craneIds: ['CR-MAIN', 'CR-AUX'],
  sectors: {
    'CR-MAIN': { from: 20, to: 120, radius: 24 },
    'CR-AUX': { from: 200, to: 300, radius: 18 }
  },
  start: toMin('10:30'),
  end: toMin('11:00')
});
const first = submitWindowRequest(makeClaimInput('周工', 'W1'), [], buildReservations(seedSteps as ScheduleStep[]), { cranes });
claims.push(first.request);
ok('先到者 held 占用', first.request.state === 'held');
const heldRes = buildReservations(seedSteps as ScheduleStep[]).concat(
  first.request.craneIds.map((id) => ({ id: `claim-${first.request.id}-${id}`, stepId: `CLAIM-${first.request.id}`, craneId: id, start: first.request.start, end: first.request.end, sector: first.request.sectors[id], retained: false, kind: 'claim' as const }))
);
const second = submitWindowRequest(makeClaimInput('吴工', 'W2'), claims, heldRes, { cranes });
claims.push(second.request);
ok('后到者 queued 排队', second.request.state === 'queued');
ok('后到者拿到备选时窗', second.request.alternatives.length > 0);
ok('备选时窗与申请同长（30 分钟）', second.request.alternatives.every((a) => a.end - a.start === 30));

console.log(`\n全部 ${passed} 项引擎冒烟断言通过。`);
