import axios from 'axios'
import request from '../utils/request'
import type { UserApiResponse } from '@/types/user'

export interface ProfileData {
  avatar_url?: string
  followers_count: number
  following_count: number
  post_count: number
  bio?: string
  is_verified: boolean
  is_private: boolean
  notes?: string
  [key: string]: any
}

export interface User {
  id: number
  platform_id: string
  platform: string
  username: string
  display_name: string
  tags: string[]
  created_at: string
  profile_data: ProfileData
}

export interface UserSearchParams {
  keyword?: string
  page?: number
  pageSize?: number
  platform?: string
  tags?: string[]
  tagLogic?: 'and' | 'or'
}

export interface UserCreateParams {
  platform_id: string
  platform: string
  username: string
  display_name?: string
  profile_data?: Partial<ProfileData>
  tags?: string[]
}

export interface UserUpdateParams {
  tags?: string[]
  profile_data?: Partial<ProfileData>
}

export class UserService {
  private baseURL = '/api/users'

  async getUsers(params: UserSearchParams = {}): Promise<User[]> {
    const { data } = await axios.get(this.baseURL, { 
      params: {
        ...params,
        tags: params.tags?.join(',')
      }
    })
    return data
  }

  async getUser(id: number): Promise<User> {
    const { data } = await axios.get(`${this.baseURL}/${id}`)
    return data
  }

  async createUser(userData: UserCreateParams): Promise<User> {
    const { data } = await axios.post(this.baseURL, userData)
    return data
  }

  async updateUser(id: number, userData: UserUpdateParams): Promise<User> {
    const { data } = await axios.put(`${this.baseURL}/${id}`, userData)
    return data
  }

  async deleteUser(id: number): Promise<void> {
    await axios.delete(`${this.baseURL}/${id}`)
  }

  async updateUserTags(userId: number, tags: string[]): Promise<User> {
    const { data } = await axios.patch(`${this.baseURL}/${userId}/tags`, { tags })
    return data
  }

  async exportUsers(params: UserSearchParams = {}): Promise<Blob> {
    const { data } = await axios.get(`${this.baseURL}/export`, {
      params: {
        ...params,
        tags: params.tags?.join(',')
      },
      responseType: 'blob'
    })
    return data
  }

  async searchUsers(params: UserSearchParams): Promise<UserApiResponse> {
    try {
      console.log('[searchUsers] 请求参数:', params)
      const response = await request.get('/api/users', { params })
      console.log('[searchUsers] 响应数据:', response)
      return response.data
    } catch (error: any) {
      console.error('[searchUsers] 错误:', error)
      throw new Error(error.message || '搜索用户失败')
    }
  }
}

export default new UserService() 