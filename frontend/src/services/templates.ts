import request from '../utils/request'
import { Platform } from '@/types/common'
import { ElMessage } from 'element-plus'
import type { ApiResponse } from '../utils/request'

export interface Template {
  id: number
  name: string
  content: string
  variables: string[]
  platform: Platform
  is_default: boolean
  is_active: boolean
  created_at: string
  updated_at: string
  created_by?: string
}

export interface TemplateSearchParams {
  page?: number
  pageSize?: number
  keyword?: string
  platform?: Platform
}

export interface TemplateListResponse {
  data: Template[]
  total: number
  page: number
  pageSize: number
}

export interface TemplateDetailResponse {
  data: Template
}

export class TemplateService {
  private baseURL = '/api/templates'

  async getTemplates(params: TemplateSearchParams = {}): Promise<TemplateListResponse> {
    try {
      const response = await request.get<Template[]>(this.baseURL, { params })
      return {
        data: response.data || [],
        total: response.total || 0,
        page: response.page || params.page || 1,
        pageSize: response.pageSize || params.pageSize || 10
      }
    } catch (error: any) {
      console.error('获取模板列表失败:', error)
      ElMessage.error('获取模板列表失败')
      return {
        data: [],
        total: 0,
        page: params.page || 1,
        pageSize: params.pageSize || 10
      }
    }
  }

  async getTemplate(id: number): Promise<Template | null> {
    try {
      const response = await request.get<Template>(`${this.baseURL}/${id}`)
      return response.data || null
    } catch (error: any) {
      console.error('获取模板详情失败:', error)
      ElMessage.error('获取模板详情失败')
      return null
    }
  }

  async createTemplate(data: Omit<Template, 'id' | 'created_at' | 'updated_at' | 'created_by'>): Promise<Template | null> {
    try {
      const response = await request.post<Template>(this.baseURL, data)
      return response.data || null
    } catch (error: any) {
      console.error('创建模板失败:', error)
      ElMessage.error('创建模板失败')
      return null
    }
  }

  async updateTemplate(id: number, data: Partial<Template>): Promise<Template | null> {
    try {
      const response = await request.put<Template>(`${this.baseURL}/${id}`, data)
      return response.data || null
    } catch (error: any) {
      console.error('更新模板失败:', error)
      ElMessage.error('更新模板失败')
      return null
    }
  }

  async deleteTemplate(id: number): Promise<boolean> {
    try {
      await request.delete(`${this.baseURL}/${id}`)
      return true
    } catch (error: any) {
      console.error('删除模板失败:', error)
      ElMessage.error('删除模板失败')
      return false
    }
  }
}

// 创建并导出单例实例
export const templateService = new TemplateService()

// 为了向后兼容，也导出默认实例
export default templateService