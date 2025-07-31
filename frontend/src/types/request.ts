import type { AxiosResponse } from 'axios'

declare module 'axios' {
    export interface AxiosResponse<T = any> {
        data: T extends { data: any } ? T['data'] : T
        total?: number
        page?: number
        pageSize?: number
        message?: string
        code?: number
    }
} 