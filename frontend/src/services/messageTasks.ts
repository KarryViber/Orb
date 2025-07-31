import request from '../utils/request'
import type { Template } from './templates'

export type MessageTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

export interface MessageTaskSettings {
  interval: number
  daily_limit: number
}

export interface MessageTaskVariables {
  sender_name?: string
  [key: string]: string | undefined
}

export interface MessageTask {
  id: number
  name: string
  template: Template
  total_users: number
  success_count: number
  failed_count: number
  status: MessageTaskStatus
  progress: number
  speed?: number
  created_at: string
  updated_at?: string
  started_at?: string
  completed_at?: string
}

export interface MessageTaskParams {
  name: string
  template_id: number
  user_ids?: number[]
  group_ids?: number[]
  settings: MessageTaskSettings
  variables?: MessageTaskVariables
}

export interface MessageTasksParams {
  keyword?: string
  page?: number
  pageSize?: number
}

export interface TaskStatusUpdate {
  id: number
  status: MessageTaskStatus
  progress: number
  success_count: number
  failed_count: number
  speed?: number
}

export class MessageTaskService {
  async getMessageTasks(params: MessageTasksParams) {
    try {
      console.log('=== [getMessageTasks] 开始请求 ===')
      console.log('请求参数:', params)
      
      const response = await request.get('/api/messages/message-tasks', { params })
      console.log('=== [getMessageTasks] 收到响应 ===')
      console.log('原始响应:', response)
      console.log('响应数据:', response.data)
      
      return response.data
    } catch (error: any) {
      console.error('=== [getMessageTasks] 发生错误 ===')
      console.error('错误详情:', error)
      throw new Error(error.message || '获取消息任务列表失败')
    }
  }

  async createMessageTask(data: MessageTaskParams) {
    try {
      console.log('[createMessageTask] 请求参数:', data)
      const response = await request.post('/api/messages/message-tasks', data)
      console.log('[createMessageTask] 响应数据:', response)
      return response
    } catch (error: any) {
      console.error('[createMessageTask] 错误:', error)
      throw new Error(error.message || '创建消息任务失败')
    }
  }

  async getTask(id: number) {
    try {
      console.log('[getTask] 请求参数:', { id })
      const response = await request.get(`/api/messages/message-tasks/${id}`)
      console.log('[getTask] 响应数据:', response)
      return response
    } catch (error: any) {
      console.error('[getTask] 错误:', error)
      throw new Error(error.message || '获取任务详情失败')
    }
  }

  async startTask(id: number) {
    try {
      console.log('[startTask] 请求参数:', { id })
      await request.post(`/api/messages/message-tasks/${id}/start`)
      console.log('[startTask] 任务启动成功')
    } catch (error: any) {
      console.error('[startTask] 错误:', error)
      throw new Error(error.message || '启动任务失败')
    }
  }

  async stopTask(id: number) {
    try {
      console.log('[stopTask] 请求参数:', { id })
      await request.post(`/api/messages/message-tasks/${id}/stop`)
      console.log('[stopTask] 任务停止成功')
    } catch (error: any) {
      console.error('[stopTask] 错误:', error)
      throw new Error(error.message || '停止任务失败')
    }
  }

  async deleteTask(id: number) {
    try {
      console.log('[deleteTask] 请求参数:', { id })
      await request.delete(`/api/messages/message-tasks/${id}`)
      console.log('[deleteTask] 任务删除成功')
    } catch (error: any) {
      console.error('[deleteTask] 错误:', error)
      throw new Error(error.message || '删除任务失败')
    }
  }

  async getTasksStatus(ids: number[]) {
    try {
      console.log('[getTasksStatus] 请求参数:', { ids })
      const response = await request.get('/api/messages/message-tasks/status', {
        params: { ids: ids.join(',') }
      })
      console.log('[getTasksStatus] 响应数据:', response)
      return response
    } catch (error: any) {
      console.error('[getTasksStatus] 错误:', error)
      throw new Error(error.message || '获取任务状态失败')
    }
  }
}

export default new MessageTaskService()