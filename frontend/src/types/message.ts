import { Platform } from './common'
import type { UserResponse } from './user'

export interface MessageTaskParams {
  templateId: number
  userIds: number[]
  content: string
  platform: Platform
}

export interface MessageTask {
  id: number
  template_id: number
  user_ids: number[]
  content: string
  platform: Platform
  status: 'pending' | 'running' | 'completed' | 'failed'
  total_count: number
  success_count: number
  failed_count: number
  created_at: string
  updated_at: string
}

export interface MessageTaskResponse {
  code: number
  message: string
  data: {
    items: MessageTask[]
    total: number
    page: number
    pageSize: number
  } | MessageTask | null
} 