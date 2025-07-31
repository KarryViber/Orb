import type { Platform } from './common'

export interface UserGroupBase {
  id: number
  name: string
  description?: string
  platform: Platform
  created_at: string
  updated_at: string
}

export interface UserGroupCreate {
  name: string
  description?: string
  platform: Platform
}

export interface UserGroupResponse extends UserGroupBase {
  user_count: number
  created_by?: string
}

export interface UserGroupSearchParams {
  keyword?: string
  platform?: Platform
  page?: number
  pageSize?: number
}

export interface UserGroupListResponse {
  items: UserGroupResponse[]
  total: number
  page: number
  pageSize: number
}

export interface UserGroupApiResponse {
  code: number
  message: string
  data: UserGroupListResponse | UserGroupResponse | null
}
