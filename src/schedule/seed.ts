import type { Crane, ScheduleStep } from './types';
import { toMin } from './engine';

// 两班共用主吊、辅吊；站位以场地平面坐标（米）表示
export const seedCranes: Crane[] = [
  { id: 'CR-MAIN', name: '主吊', model: '500t 履带吊', x: -15, y: -12, maxRadius: 30, failedAt: null, resumeAt: null, faultReason: '' },
  { id: 'CR-AUX', name: '辅吊', model: '260t 汽车吊', x: 13, y: -10, maxRadius: 22, failedAt: null, resumeAt: null, faultReason: '' }
];

// 回转占位方位角：0=东，逆时针，单位度；可跨 0°
export const seedSteps: ScheduleStep[] = [
  {
    id: 'S-01',
    title: 'A班｜主吊支腿就位与空钩回转',
    shift: 'A',
    craneIds: ['CR-MAIN'],
    start: toMin('07:30'),
    end: toMin('08:05'),
    sectors: { 'CR-MAIN': { from: 300, to: 70, radius: 24 } },
    windLimit: 8,
    state: 'completed'
  },
  {
    id: 'S-02',
    title: 'A班｜桁架试吊离地 300mm',
    shift: 'A',
    craneIds: ['CR-MAIN', 'CR-AUX'],
    start: toMin('08:10'),
    end: toMin('08:50'),
    sectors: {
      'CR-MAIN': { from: 20, to: 120, radius: 24 },
      'CR-AUX': { from: 200, to: 300, radius: 18 }
    },
    windLimit: 8,
    state: 'planned'
  },
  {
    id: 'S-03',
    title: 'A班｜主吊回转至安装轴线',
    shift: 'A',
    craneIds: ['CR-MAIN', 'CR-AUX'],
    start: toMin('08:55'),
    end: toMin('09:35'),
    sectors: {
      'CR-MAIN': { from: 110, to: 200, radius: 26 },
      'CR-AUX': { from: 300, to: 40, radius: 18 }
    },
    windLimit: 8,
    state: 'planned'
  },
  {
    id: 'S-04',
    title: 'B班｜双机抬吊姿态调整',
    shift: 'B',
    craneIds: ['CR-MAIN', 'CR-AUX'],
    start: toMin('13:00'),
    end: toMin('13:40'),
    sectors: {
      'CR-MAIN': { from: 210, to: 300, radius: 27 },
      'CR-AUX': { from: 40, to: 130, radius: 19 }
    },
    windLimit: 8,
    state: 'planned'
  },
  {
    id: 'S-05',
    title: 'B班｜回转跨越安装轴线就位',
    shift: 'B',
    craneIds: ['CR-MAIN', 'CR-AUX'],
    start: toMin('13:45'),
    end: toMin('14:25'),
    sectors: {
      'CR-MAIN': { from: 120, to: 210, radius: 25 },
      'CR-AUX': { from: 320, to: 60, radius: 18 }
    },
    windLimit: 8,
    state: 'planned'
  },
  {
    id: 'S-06',
    title: 'B班｜临时固定与摘钩',
    shift: 'B',
    craneIds: ['CR-MAIN'],
    start: toMin('14:30'),
    end: toMin('15:05'),
    sectors: { 'CR-MAIN': { from: 60, to: 150, radius: 20 } },
    windLimit: 8,
    state: 'planned'
  }
];
