import request from '@/utils/request'
import type { Template } from '@/services/templates'

export interface MessageTaskSettings {
  interval: number
  daily_limit: number
}

export interface MessageTaskCreate {
  name: string
  template_id: number
  user_ids: number[]
  settings: MessageTaskSettings
  variables?: {
    sender_name: string
    [key: string]: string
  }
}

export interface MessageTaskResponse {
  id: number
  name: string
  template: Template
  total_users: number
  success_count: number
  failed_count: number
  status: string
  progress: number
  speed?: number
  created_at: string
  updated_at?: string
  started_at?: string
  completed_at?: string
}

// 创建消息任务
export async function createMessageTask(data: MessageTaskCreate): Promise<MessageTaskResponse> {
  console.log('发送消息任务创建请求:', JSON.stringify(data, null, 2))
  const response = await request.post<MessageTaskResponse>('/api/messages/message-tasks', data)
  console.log('收到消息任务创建响应:', response.data)
  return response.data
}

// 获取消息任务列表
export async function getMessageTasks(params: {
  keyword?: string
  page?: number
  pageSize?: number
}): Promise<{ data: MessageTaskResponse[]; total: number }> {
  const response = await request.get('/api/messages/message-tasks', { params })
  return response.data
}

// 启动消息任务
export async function startMessageTask(id: number): Promise<void> {
  await request.post(`/api/messages/message-tasks/${id}/start`)
}

// 停止消息任务
export async function stopMessageTask(id: number): Promise<void> {
  await request.post(`/api/messages/message-tasks/${id}/stop`)
}

// 删除消息任务
export async function deleteMessageTask(id: number): Promise<void> {
  await request.delete(`/api/messages/message-tasks/${id}`)
}

// 获取任务状态
export async function getTasksStatus(ids: number[]): Promise<{
  id: number
  status: string
  progress: number
  success_count: number
  failed_count: number
  speed?: number
}[]> {
  const response = await request.get('/api/messages/message-tasks/status', {
    params: { ids: ids.join(',') }
  })
  return response.data
}