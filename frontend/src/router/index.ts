import { createRouter, createWebHistory } from 'vue-router'
import type { ComponentPublicInstance } from 'vue'
import HomeView from '../views/HomeView.vue'

interface ReloadableComponent extends ComponentPublicInstance {
  reload?: () => void
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
      meta: {
        title: 'Home',
        keepAlive: true
      }
    },
    {
      path: '/users',
      name: 'Users',
      component: () => import('@/views/UserView.vue'),
      meta: {
        title: 'User Management',
        keepAlive: true
      }
    },
    {
      path: '/search-tasks',
      name: 'searchTasks',
      component: () => import('@/views/SearchTaskView.vue'),
      meta: {
        title: 'Search Tasks',
        keepAlive: true
      }
    },
    {
      path: '/search-tasks/:taskId/results',
      name: 'search-results',
      component: () => import('@/views/SearchResultView.vue'),
      meta: {
        title: 'Search Results',
        keepAlive: false
      }
    },
    {
      path: '/message-tasks',
      name: 'messageTasks',
      component: () => import('@/views/MessageTaskView.vue'),
      meta: {
        title: 'Message Tasks',
        keepAlive: true
      }
    },
    {
      path: '/message-templates',
      name: 'messageTemplates',
      component: () => import('@/views/TemplateView.vue'),
      meta: {
        title: 'Message Templates',
        keepAlive: true
      }
    },
    {
      path: '/configs',
      name: 'Configs',
      component: () => import('@/views/ConfigView.vue'),
      meta: {
        title: 'System Settings',
        keepAlive: true
      }
    }
  ]
})

// 路由守卫
router.beforeEach(async (to, from, next) => {
  // 设置页面标题
  document.title = `${to.meta.title || to.name} - Orb System`
  
  // 如果是从其他页面跳转到列表页，需要重新加载数据
  if (to.meta.keepAlive && from.name && to.name !== from.name) {
    next()
    // 等待组件渲染完成后再调用reload
    await router.isReady()
    setTimeout(() => {
      const vm = router.currentRoute.value.matched[0].instances.default as ReloadableComponent
      if (vm?.reload) {
        console.log('触发组件reload方法')
        vm.reload()
      } else {
        console.warn('组件未实现reload方法')
      }
    }, 100)
  } else {
    next()
  }
})

export default router