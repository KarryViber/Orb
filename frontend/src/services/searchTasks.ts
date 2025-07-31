import request from '../utils/request'
import type { Platform } from '../types/common'
import type { UserResponse } from '@/types/user'
import { ElMessage } from 'element-plus'
import configManager from '@/utils/config'

export type SearchTaskStatus = 'pending' | 'running' | 'processing' | 'completed' | 'failed' | 'stopped'

export interface SearchParams {
    keywords: string[]
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

export interface SearchTaskCreate {
    name: string
    platform: Platform
    search_params: SearchParams
    results_limit?: number
}

export interface SearchTask {
    id: number
    name: string
    platform: Platform
    search_params: SearchParams
    status: SearchTaskStatus
    result_count: number
    results_limit: number  // 每个hashtag获取的帖子数量限制
    is_completed: boolean
    error_message?: string
    created_at: string
    completed_at?: string
}

export interface TaskStatusUpdate {
    id: number
    status: SearchTaskStatus
    result_count: number
    is_completed: boolean
    error_message?: string
}

export interface SearchTaskListResponse {
    data: SearchTask[]
    total: number
    page: number
    pageSize: number
}

export interface SearchTaskParams {
    keywords: string[]
    location?: string[]
    min_followers?: number
    max_followers?: number
    min_following?: number
    max_following?: number
    min_posts?: number
    max_posts?: number
    is_verified?: boolean
    is_private?: boolean
    category?: string
}

export interface SearchTaskResultResponse {
    data: UserResponse[]
    total: number
    page: number
    pageSize: number
}

export interface SearchTaskResultParams {
    page?: number
    pageSize?: number
    keyword?: string
}

export class SearchTaskService {
    private baseURL = '/api/search-tasks'

    async getTasks(params?: { platform?: Platform; page?: number; pageSize?: number }): Promise<SearchTaskListResponse> {
        try {
            const response = await request.get(this.baseURL, { params })
            return {
                data: response.data || [],
                total: response.total || 0,
                page: response.page || 1,
                pageSize: response.pageSize || 10
            }
        } catch (error: any) {
            console.error('[getTasks] 错误:', error)
            throw new Error(error.message || '获取任务列表失败')
        }
    }

    async createTask(data: SearchTaskCreate): Promise<SearchTask> {
        try {
            const apiToken = configManager.getApiToken()
            if (!apiToken) {
                ElMessage.warning('请先配置API Token')
                throw new Error('请先配置API Token')
            }

            console.log('[createTask] 请求参数:', data)
            const response = await request.post(this.baseURL, data)
            console.log('[createTask] 响应数据:', response)
            return response
        } catch (error: any) {
            console.error('[createTask] 错误:', error)
            throw new Error(error.message || '创建搜索任务失败')
        }
    }

    async getTask(taskId: number): Promise<SearchTask> {
        try {
            const response = await request.get(`${this.baseURL}/${taskId}`)
            const task: SearchTask = {
                id: response.data.id,
                name: response.data.name,
                platform: response.data.platform,
                search_params: response.data.search_params,
                status: response.data.status,
                result_count: response.data.result_count,
                results_limit: response.data.results_limit,
                is_completed: response.data.is_completed,
                error_message: response.data.error_message,
                created_at: response.data.created_at,
                completed_at: response.data.completed_at
            }
            return task
        } catch (error: any) {
            console.error('[getTask] 错误:', error)
            throw new Error(error.message || '获取任务详情失败')
        }
    }

    async deleteTask(id: number): Promise<void> {
        try {
            console.log('[deleteTask] 请求参数:', { id })
            await request.delete(`${this.baseURL}/${id}`)
            console.log('[deleteTask] 删除成功')
        } catch (error: any) {
            console.error('[deleteTask] 错误:', error)
            throw new Error(error.message || '删除搜索任务失败')
        }
    }

    async getTasksStatus(taskIds: number[]): Promise<TaskStatusUpdate[]> {
        try {
            const response = await request.get(`${this.baseURL}/status`, {
                params: { ids: taskIds.join(',') }
            })
            return response.data || []
        } catch (error: any) {
            console.error('[getTasksStatus] 错误:', error)
            throw new Error(error.message || '获取任务状态失败')
        }
    }

    async getTaskResults(taskId: number, params?: SearchTaskResultParams): Promise<SearchTaskResultResponse> {
        try {
            console.log('[getTaskResults] 请求参数:', { taskId, params })
            const response = await request.get(`${this.baseURL}/${taskId}/results`, { params })
            console.log('[getTaskResults] 响应数据:', response)
            
            // 确保返回的数据符合SearchTaskResultResponse接口
            const result: SearchTaskResultResponse = {
                data: response.data || [],
                total: response.total || 0,
                page: response.page || 1,
                pageSize: response.pageSize || 10
            }
            return result
        } catch (error: any) {
            console.error('[getTaskResults] 错误:', error)
            throw new Error(error.message || '获取任务结果失败')
        }
    }
}

export default new SearchTaskService()