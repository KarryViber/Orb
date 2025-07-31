import request from '@/utils/request'
import type { UserGroupApiResponse, UserGroupSearchParams, UserGroupListResponse, UserGroupResponse } from '@/types/userGroup'
import type { UserApiResponse } from '@/types/user'
import type { Platform } from '@/types/common'

export interface UserGroup {
  id: number
  name: string
  description?: string
  platform: Platform
  user_count: number
  created_at: string
  updated_at?: string
}

export interface UserGroupCreate {
  name: string
  description?: string
  platform: Platform
}

interface ApiParams {
  keyword?: string
  platform?: Platform
  page: number
  page_size: number
  [key: string]: string | number | Platform | undefined
}

// 获取用户组列表
export const getUserGroups = async (params: UserGroupSearchParams): Promise<UserGroupApiResponse> => {
  try {
    // 转换参数名称以匹配后端API
    const apiParams: ApiParams = {
      keyword: params.keyword || undefined,
      platform: params.platform || undefined,
      page: params.page || 1,
      page_size: params.pageSize || 10
    }
    
    // 移除undefined的参数
    Object.keys(apiParams).forEach(key => {
      if (apiParams[key] === undefined) {
        delete apiParams[key]
      }
    })
    
    console.log('Requesting user groups with params:', apiParams)
    const response = await request.get('/api/user-groups', { params: apiParams })
    return response
  } catch (error) {
    console.error('获取用户组列表失败:', error)
    throw error
  }
}

// 获取用户组成员
export const getGroupUsers = async (groupId: number): Promise<UserApiResponse> => {
  try {
    const response = await request.get(`/api/user-groups/${groupId}/users`)
    return response
  } catch (error) {
    console.error('获取用户组成员失败:', error)
    throw error
  }
}

// 创建用户组
export const createUserGroup = async (data: UserGroupCreate): Promise<UserGroupApiResponse> => {
  try {
    const response = await request.post('/api/user-groups', data)
    return response
  } catch (error) {
    console.error('创建用户组失败:', error)
    throw error
  }
}

// 更新用户组
export const updateUserGroup = async (id: number, data: Partial<UserGroup>): Promise<UserGroupApiResponse> => {
  try {
    const response = await request.put(`/api/user-groups/${id}`, data)
    return response
  } catch (error) {
    console.error('更新用户组失败:', error)
    throw error
  }
}

// 删除用户组
export const deleteUserGroup = async (id: number): Promise<UserGroupApiResponse> => {
  try {
    const response = await request.delete(`/api/user-groups/${id}`)
    return response
  } catch (error) {
    console.error('删除用户组失败:', error)
    throw error
  }
}

// 添加用户到用户组
export const addUsersToGroup = async (groupId: number, userIds: number[]): Promise<UserGroupApiResponse> => {
  try {
    const response = await request.post(`/api/user-groups/${groupId}/users`, userIds)
    return response
  } catch (error) {
    console.error('添加用户到用户组失败:', error)
    throw error
  }
}

// 从用户组移除用户
export const removeUsersFromGroup = async (groupId: number, userIds: number[]): Promise<UserGroupApiResponse> => {
  try {
    const response = await request.delete(`/api/user-groups/${groupId}/users`, { data: { user_ids: userIds } })
    return response
  } catch (error) {
    console.error('从用户组移除用户失败:', error)
    throw error
  }
}