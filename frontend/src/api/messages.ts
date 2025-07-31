import request from '@/utils/request'
import { ElMessage } from 'element-plus'
import configManager from '@/utils/config'

export interface MessageTaskParams {
  page?: number
  pageSize?: number
  keyword?: string
}

export interface MessageTaskResponse {
  data: any[]
  total: number
  page: number
  pageSize: number
}

export interface TaskUser {
  username: string
  display_name?: string
  status: 'success' | 'failed'
}

export interface TaskUserResponse {
  data: TaskUser[]
  total: number
}

export const getMessageTasks = async (params: MessageTaskParams): Promise<MessageTaskResponse> => {
  const response = await request({
    url: '/api/messages/message-tasks',
    method: 'get',
    params
  })
  return response.data
}

export const startMessageTask = (taskId: number) => {
  return request({
    url: `/api/messages/message-tasks/${taskId}/start`,
    method: 'post'
  })
}

export const stopMessageTask = (taskId: number) => {
  return request({
    url: `/api/messages/message-tasks/${taskId}/stop`,
    method: 'post'
  })
}

export const deleteMessageTask = (taskId: number) => {
  return request({
    url: `/api/messages/message-tasks/${taskId}`,
    method: 'delete'
  })
}

export const getTaskUsers = async (taskId: number): Promise<TaskUserResponse> => {
  const response = await request({
    url: `/api/messages/message-tasks/${taskId}/users`,
    method: 'get'
  })
  return response.data
}

// 创建消息任务
export interface CreateMessageTaskRequest {
  name: string
  template_id: number
  group_ids?: number[]
  user_ids?: number[]
  settings: {
    interval: number
    daily_limit: number
  }
  variables?: Record<string, string>
}

export async function createMessageTask(data: CreateMessageTaskRequest): Promise<boolean> {
  try {
    console.log('[createMessageTask] 开始创建任务，请求参数:', data)
    
    const response = await request.post('/api/messages/message-tasks', data)
    
    console.log('[createMessageTask] 响应数据:', response)
    ElMessage.success('创建任务成功')
    return true
  } catch (error) {
    console.error('[createMessageTask] 创建任务失败:', error)
    ElMessage.error('创建任务失败')
    return false
  }
} 