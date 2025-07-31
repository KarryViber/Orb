import { Platform } from './common'

export interface SearchParams {
  keywords?: string[]
  location?: string[]
  min_followers?: number
  max_followers?: number
  min_following?: number
  max_following?: number
  min_posts?: number
  max_posts?: number
  is_verified?: boolean
  is_private?: boolean
  has_website?: boolean
  category?: string
}

export interface SearchTask {
  id: number
  name: string
  platform: Platform
  search_params: SearchParams
  status: string
  result_count: number
  results_limit: number
  is_completed: boolean
  error_message?: string
  created_at: string
  completed_at?: string
  type: 'search'
}

export interface SearchTaskListResponse {
  data: SearchTask[]
  total: number
  page: number
  page_size: number
} 