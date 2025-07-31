import { defineStore } from 'pinia'
import { ref } from 'vue'
import request from '@/utils/request'
import type { SearchTask } from '@/types/searchTask'

export const useSearchTaskStore = defineStore('searchTasks', () => {
  const tasks = ref<SearchTask[]>([])
  const pollingInterval = ref<number | null>(null)
  const retryCount = ref(0)
  const maxRetries = 3

  // 获取所有搜索任务
  const fetchTasks = async () => {
    try {
      console.log('[SearchTaskStore] 开始获取搜索任务列表')
      const response = await request.get('/api/search-tasks')
      console.log('[SearchTaskStore] 搜索任务响应:', response)

      // 检查响应数据格式
      if (response.data && typeof response.data === 'object') {
        // 如果响应是分页格式
        if ('data' in response.data && Array.isArray(response.data.data)) {
          console.log('[SearchTaskStore] 更新搜索任务列表:', response.data.data)
          tasks.value = response.data.data
          // 重置重试计数
          retryCount.value = 0
          return
        }
        
        // 如果响应直接是数组
        if (Array.isArray(response.data)) {
          console.log('[SearchTaskStore] 更新搜索任务列表(数组格式):', response.data)
          tasks.value = response.data
          // 重置重试计数
          retryCount.value = 0
          return
        }
      }

      // 如果数据格式不符合预期
      console.error('[SearchTaskStore] 搜索任务数据格式错误:', response.data)
      handleFetchError(new Error('Invalid response format'))
    } catch (error) {
      console.error('[SearchTaskStore] 获取搜索任务列表失败:', error)
      handleFetchError(error)
    }
  }

  // 处理获取失败的情况
  const handleFetchError = (error: any) => {
    if (retryCount.value < maxRetries) {
      retryCount.value++
      console.log(`[SearchTaskStore] 第${retryCount.value}次重试获取搜索任务列表`)
      // 5秒后重试
      setTimeout(fetchTasks, 5000)
    } else {
      console.error('[SearchTaskStore] 达到最大重试次数，停止重试')
      stopPolling()
    }
  }

  // 开始轮询搜索任务状态
  const startPolling = () => {
    if (pollingInterval.value === null) {
      console.log('[SearchTaskStore] 开始轮询搜索任务')
      // 立即执行一次
      fetchTasks()
      // 每30秒轮询一次
      pollingInterval.value = window.setInterval(fetchTasks, 30000)
    }
  }

  // 停止轮询
  const stopPolling = () => {
    if (pollingInterval.value !== null) {
      console.log('[SearchTaskStore] 停止轮询搜索任务')
      clearInterval(pollingInterval.value)
      pollingInterval.value = null
    }
  }

  return {
    tasks,
    fetchTasks,
    startPolling,
    stopPolling
  }
}) 