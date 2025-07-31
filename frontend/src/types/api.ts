import { Platform } from './common'
import type { AxiosResponseHeaders, AxiosHeaders, InternalAxiosRequestConfig, AxiosHeaderValue } from 'axios'

export interface PaginationParams {
    page: number
    page_size: number
}

export interface SearchParams extends PaginationParams {
    keyword: string
}

export interface UserGroupSearchParams extends SearchParams {
    platform?: Platform
}

export interface UserSearchParams extends SearchParams {
    platform?: Platform
    tags?: string[]
    tag_logic?: 'or' | 'and'
}

export interface PaginatedData<T> {
    data: T[]
    total: number
    page: number
    page_size: number
}

export interface ApiResponse<T> {
    code: number
    message: string
    data: T
    total?: number
    page?: number
    pageSize?: number
}

export interface ApiListResponse<T> {
    data: T[]
    total: number
    page: number
    page_size: number
}

export interface ApiErrorResponse {
    code: number
    message: string
    data: null
}

export interface ApiSuccessResponse<T> {
    code: 200
    message: string
    data: T
}

export type ApiResult<T> = ApiSuccessResponse<T> | ApiErrorResponse

// 扩展Axios响应类型
declare module 'axios' {
    interface AxiosResponse<T = any, D = any> {
        data: T
        status: number
        statusText: string
        headers: Partial<AxiosHeaders & {
            Server: AxiosHeaderValue
            'Content-Type': AxiosHeaderValue
            'Content-Length': AxiosHeaderValue
            'Cache-Control': AxiosHeaderValue
            'Content-Encoding': AxiosHeaderValue
        }> | AxiosResponseHeaders
        config: InternalAxiosRequestConfig<D>
        request?: any
    }
} 