import { createRouter, createWebHashHistory } from 'vue-router';
import ScheduleView from './schedule/ScheduleView.vue';

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/models', component: { template: '<div />' } },
    { path: '/checks', component: { template: '<div />' } },
    { path: '/review', component: { template: '<div />' } },
    { path: '/schedule', component: ScheduleView }
  ]
});
