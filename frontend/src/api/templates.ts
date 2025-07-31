import request from '@/utils/request'
import { Platform } from '@/types/common'
import type { ApiResponse } from '@/types/api'
import { ElMessage } from 'element-plus'

export interface TemplateResponse {
  id: number
  name: string
  content: string
  variables: string[]
  platform: Platform
  is_default: boolean
  is_active: boolean
  created_by?: string
  created_at: string
  updated_at: string
}

export interface TemplateCreate {
  name: string
  content: string
  variables: string[]
  platform: Platform
  is_default?: boolean
  is_active?: boolean
}

export interface TemplateUpdate {
  name?: string
  content?: string
  variables?: string[]
  platform?: Platform
  is_default?: boolean
  is_active?: boolean
}

export interface TemplateSearchParams {
  keyword?: string
  platform?: Platform
  page?: number
  pageSize?: number
}

export interface TemplateListResponse {
  data: TemplateResponse[]
  total: number
  page: number
  pageSize: number
}

interface RawTemplateResponse {
  id: number
  name: string
  content: string
  variables: string[] | null
  platform: Platform
  is_default: boolean
  is_active: boolean
  created_by?: string
  created_at: string | null
  updated_at: string | null
}

export interface TemplateApiResponse {
  code: number
  message: string
  data: TemplateResponse[]
}

// 获取模板列表
export const getMessageTemplates = async (params: TemplateSearchParams): Promise<TemplateApiResponse> => {
  try {
    console.log('[getMessageTemplates] 开始加载模板列表, 参数:', params)
    const response = await request.get('/api/templates', { params })
    console.log('[getMessageTemplates] 原始响应:', response)
    
    // 确保返回正确的数据结构
    let templates: TemplateResponse[] = []
    
    if (response?.data) {
      if (Array.isArray(response.data)) {
        templates = response.data.map((item: RawTemplateResponse) => ({
          id: item.id,
          name: item.name,
          content: item.content,
          variables: Array.isArray(item.variables) ? item.variables : [],
          platform: item.platform,
          is_default: !!item.is_default,
          is_active: !!item.is_active,
          created_by: item.created_by,
          created_at: item.created_at || '',
          updated_at: item.updated_at || ''
        }))
      } else if (Array.isArray(response.data.data)) {
        templates = response.data.data.map((item: RawTemplateResponse) => ({
          id: item.id,
          name: item.name,
          content: item.content,
          variables: Array.isArray(item.variables) ? item.variables : [],
          platform: item.platform,
          is_default: !!item.is_default,
          is_active: !!item.is_active,
          created_by: item.created_by,
          created_at: item.created_at || '',
          updated_at: item.updated_at || ''
        }))
      }
    }
    
    console.log('[getMessageTemplates] 处理后的数据:', {
      templatesCount: templates.length,
      firstTemplate: templates[0]
    })
    
    return {
      code: response?.code || 200,
      message: response?.message || '获取模板列表成功',
      data: templates
    }
  } catch (error) {
    console.error('[getMessageTemplates] 获取模板列表失败:', error)
    return {
      code: 500,
      message: '获取模板列表失败',
      data: []
    }
  }
}

// 获取单个模板
export const getMessageTemplate = async (id: number): Promise<TemplateResponse | null> => {
  try {
    const response = await request.get<TemplateResponse>(`/api/templates/${id}`)
    return response.data
  } catch (error) {
    console.error('获取模板详情失败:', error)
    ElMessage.error('获取模板详情失败')
    return null
  }
}

// 创建模板
export const createMessageTemplate = async (data: TemplateCreate): Promise<TemplateResponse | null> => {
  try {
    const response = await request.post<TemplateResponse>('/api/templates', data)
    ElMessage.success('创建模板成功')
    return response.data
  } catch (error) {
    console.error('创建模板失败:', error)
    ElMessage.error('创建模板失败')
    return null
  }
}

// 更新模板
export const updateMessageTemplate = async (id: number, data: TemplateUpdate): Promise<TemplateResponse | null> => {
  try {
    console.log('[updateMessageTemplate] 开始更新模板, id:', id, '数据:', data)
    const response = await request.put<{ data: TemplateResponse }>(`/api/templates/${id}`, {
      name: data.name,
      content: data.content,
      variables: data.variables || [],
      platform: data.platform,
      is_default: data.is_default,
      is_active: data.is_active
    })
    console.log('[updateMessageTemplate] 更新成功:', response.data)
    ElMessage.success('更新模板成功')
    return response.data?.data || null
  } catch (error) {
    console.error('更新模板失败:', error)
    ElMessage.error('更新模板失败')
    return null
  }
}

// 删除模板
export const deleteMessageTemplate = async (id: number): Promise<boolean> => {
  try {
    await request.delete(`/api/templates/${id}`)
    ElMessage.success('删除模板成功')
    return true
  } catch (error) {
    console.error('删除模板失败:', error)
    ElMessage.error('删除模板失败')
    return false
  }
}

// 设置默认模板
export const setDefaultTemplate = async (id: number): Promise<boolean> => {
  try {
    await request.post(`/api/templates/${id}/default`)
    ElMessage.success('设置默认模板成功')
    return true
  } catch (error) {
    console.error('设置默认模板失败:', error)
    ElMessage.error('设置默认模板失败')
    return false
  }
}

// 预览模板
export const previewTemplate = async (id: number, variables?: Record<string, any>): Promise<string> => {
  try {
    const response = await request.post<{ data: { preview: string } }>(
      `/api/templates/${id}/preview`,
      { variables }
    )
    return response.data?.data?.preview || ''
  } catch (error) {
    console.error('预览模板失败:', error)
    ElMessage.error('预览模板失败')
    return ''
  }
} 