import request from '../utils/request'

export interface UserTag {
  id: number
  name: string
  description?: string
  user_count: number
  created_at: string
  updated_at?: string
}

export interface UserTagParams {
  keyword?: string
  page?: number
  pageSize?: number
}

export interface UserTagResponse {
  data: UserTag[]
  total: number
  page: number
  pageSize: number
}

export class UserTagService {
  private baseURL = '/api/users/tags'

  async getTags(params: UserTagParams = {}): Promise<UserTagResponse> {
    try {
      console.log('[getTags] 请求参数:', params)
      const response = await request.get(this.baseURL, { params })
      console.log('[getTags] 响应数据:', response)
      return response
    } catch (error: any) {
      console.error('[getTags] 错误:', error)
      throw new Error(error.message || '获取标签列表失败')
    }
  }

  async createTag(data: Omit<UserTag, 'id' | 'user_count' | 'created_at' | 'updated_at'>): Promise<UserTag> {
    try {
      console.log('[createTag] 请求参数:', data)
      const response = await request.post(this.baseURL, data)
      console.log('[createTag] 响应数据:', response)
      return response
    } catch (error: any) {
      console.error('[createTag] 错误:', error)
      throw new Error(error.message || '创建标签失败')
    }
  }

  async updateTag(id: number, data: Partial<UserTag>): Promise<UserTag> {
    try {
      console.log('[updateTag] 请求参数:', { id, data })
      const response = await request.put(`${this.baseURL}/${id}`, data)
      console.log('[updateTag] 响应数据:', response)
      return response
    } catch (error: any) {
      console.error('[updateTag] 错误:', error)
      throw new Error(error.message || '更新标签失败')
    }
  }

  async deleteTag(id: number): Promise<void> {
    try {
      console.log('[deleteTag] 请求参数:', { id })
      await request.delete(`${this.baseURL}/${id}`)
      console.log('[deleteTag] 删除成功')
    } catch (error: any) {
      console.error('[deleteTag] 错误:', error)
      throw new Error(error.message || '删除标签失败')
    }
  }

  async addUsersToTag(tagId: number, userIds: number[]): Promise<void> {
    try {
      console.log('[addUsersToTag] 请求参数:', { tagId, userIds })
      await request.post(`${this.baseURL}/${tagId}/users`, { user_ids: userIds })
      console.log('[addUsersToTag] 添加用户成功')
    } catch (error: any) {
      console.error('[addUsersToTag] 错误:', error)
      throw new Error(error.message || '添加用户到标签失败')
    }
  }

  async removeUsersFromTag(tagId: number, userIds: number[]): Promise<void> {
    try {
      console.log('[removeUsersFromTag] 请求参数:', { tagId, userIds })
      await request.delete(`${this.baseURL}/${tagId}/users`, { data: { user_ids: userIds } })
      console.log('[removeUsersFromTag] 移除用户成功')
    } catch (error: any) {
      console.error('[removeUsersFromTag] 错误:', error)
      throw new Error(error.message || '从标签中移除用户失败')
    }
  }
}

export default new UserTagService()
