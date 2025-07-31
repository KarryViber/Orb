import request from '@/utils/request'
import { Platform } from '@/types/common'
import type { ApiResponse, PaginatedData } from '@/types/api'
import { ElMessage } from 'element-plus'
import type { UserProfileData, UserResponse as UserResponseType } from '@/types/user'

export interface UserProfile extends UserProfileData {
  // 继承自UserProfileData，确保类型一致
}

export interface UserResponse extends UserResponseType {
  // 继承自UserResponseType，确保类型一致
}

export interface UserSearchParams {
  keyword?: string
  platform?: Platform
  tags?: string[]
  tagLogic?: 'or' | 'and'
  page?: number
  pageSize?: number
  contacted?: boolean
}

export interface CreateUserRequest {
  platform: Platform
  username: string
  display_name?: string
  tags?: string[]
}

export interface UpdateUserRequest {
  username?: string
  display_name?: string
  platform?: Platform
  tags?: string[]
  profile_data?: Record<string, any>
  contacted?: boolean
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

// 定义标签响应类型
export interface TagResponse {
  value: string
  label: string
}

// 获取用户列表
export async function getUsers(params: UserSearchParams): Promise<ApiResponse<UserResponse[]>> {
  try {
    // 构造请求参数
    const validParams: Record<string, any> = {
      page: params.page || 1,
      page_size: params.pageSize || 10
    };
    
    // 处理关键词
    if (params.keyword) {
      validParams.keyword = params.keyword;
    }
    
    // 处理平台
    if (params.platform) {
      validParams.platform = params.platform;
    }
    
    // 处理标签和标签逻辑
    if (Array.isArray(params.tags) && params.tags.length > 0) {
      validParams.tags = Array.from(params.tags);
      if (params.tagLogic) {
        validParams.tag_logic = params.tagLogic;
      }
    }
    
    // 处理联系状态
    if (params.contacted !== undefined) {
      validParams.contacted = params.contacted;
    }
    
    console.log('[getUsers] 发送请求参数:', validParams)
    const responseData = await request.get('/api/users', { params: validParams })
    
    // 详细记录响应信息
    console.log('[getUsers] 收到后端响应:', responseData)
    
    // 标准化返回结果
    let result: ApiResponse<UserResponse[]>

    // 检查responseData的结构
    if (responseData && typeof responseData === 'object') {
      // 如果后端返回的是分页格式
      if ('data' in responseData && 'total' in responseData) {
        result = {
          code: 200,
          message: '获取用户列表成功',
          data: Array.isArray(responseData.data) ? responseData.data : [],
          total: Number(responseData.total),
          page: responseData.page || validParams.page,
          pageSize: responseData.pageSize || validParams.page_size
        }
        console.log('[getUsers] 处理分页数据:', {
          dataLength: result.data.length,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize
        })
      } else {
        // 如果后端直接返回了数组
        const data = Array.isArray(responseData) ? responseData : []
        result = {
          code: 200,
          message: '获取用户列表成功',
          data: data,
          total: data.length,
          page: validParams.page,
          pageSize: validParams.page_size
        }
        console.log('[getUsers] 处理数组数据:', {
          dataLength: result.data.length,
          total: result.total
        })
      }
    } else {
      // 处理异常情况
      console.warn('[getUsers] 无效的响应数据:', responseData)
      result = {
        code: 200,
        message: '获取用户列表成功',
        data: [],
        total: 0,
        page: validParams.page,
        pageSize: validParams.page_size
      }
    }

    console.log('[getUsers] 最终返回结果:', {
      dataLength: result.data.length,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize
    })
    return result
  } catch (error) {
    console.error('[getUsers] 获取用户列表失败:', error)
    ElMessage.error('获取用户列表失败')
    return {
      code: 500,
      message: '获取用户列表失败',
      data: [],
      total: 0,
      page: params.page || 1,
      pageSize: params.pageSize || 10
    }
  }
}

// 获取单个用户
export async function getUser(id: number): Promise<UserResponse | null> {
  try {
    const response = await request.get<UserResponse>(`/api/users/${id}`)
    return response.data
  } catch (error) {
    console.error('获取用户详情失败:', error)
    ElMessage.error('获取用户详情失败')
    return null
  }
}

// 创建用户
export async function createUser(data: CreateUserRequest): Promise<UserResponse | null> {
  try {
    console.log('[createUser] 开始创建用户:', data)
    const response = await request.post<UserResponse>('/api/users', data)
    console.log('[createUser] 创建用户成功:', response.data)
    ElMessage.success('创建用户成功')
    return response.data
  } catch (error: any) {
    console.error('[createUser] 创建用户失败:', error)
    if (error.response?.data?.detail) {
      ElMessage.error(`创建用户失败: ${error.response.data.detail}`)
    } else {
      ElMessage.error('创建用户失败')
    }
    return null
  }
}

// 更新用户
export async function updateUser(id: number, data: UpdateUserRequest): Promise<UserResponse | null> {
  try {
    console.log('[updateUser] 开始更新用户:', { id, data })
    const response = await request.put<UserResponse>(`/api/users/${id}`, data)
    console.log('[updateUser] 原始响应:', response)
    
    // 检查响应对象
    if (!response || typeof response !== 'object') {
      console.error('[updateUser] 无效的响应:', response)
      ElMessage.error('更新用户失败：响应无效')
      return null
    }
    
    // 获取响应数据
    const userData = response.data || response
    console.log('[updateUser] 处理后的用户数据:', userData)
    
    // 验证数据格式
    if (!userData || typeof userData !== 'object') {
      console.error('[updateUser] 无效的用户数据:', userData)
      ElMessage.error('更新用户失败：数据格式错误')
      return null
    }
    
    // 如果contacted字段在请求中，确保响应中也有这个字段
    if ('contacted' in data && typeof userData.contacted !== 'boolean') {
      userData.contacted = Boolean(data.contacted)
      console.log('[updateUser] 补充contacted字段:', userData.contacted)
    }
    
    console.log('[updateUser] 更新成功，返回数据:', userData)
    ElMessage.success('更新用户成功')
    return userData as UserResponse
  } catch (error) {
    console.error('[updateUser] 更新用户失败:', error)
    ElMessage.error('更新用户失败')
    return null
  }
}

// 删除用户
export async function deleteUser(id: number): Promise<boolean> {
  try {
    await request.delete(`/api/users/${id}`)
    ElMessage.success('删除用户成功')
    return true
  } catch (error) {
    console.error('删除用户失败:', error)
    ElMessage.error('删除用户失败')
    return false
  }
}

// 搜索用户
export async function searchUsers(params: { keyword: string }): Promise<ApiResponse<UserResponse[]>> {
  try {
    const response = await request.get('/api/users/search', { 
      params: {
        keyword: params.keyword,
        page: 1,
        page_size: 20
      }
    })
    
    // 如果是数组，直接返回
    if (Array.isArray(response.data)) {
      return {
        code: 200,
        message: '搜索用户成功',
        data: response.data
      }
    }
    
    // 如果是分页数据，返回items数组
    if (response.data && typeof response.data === 'object' && 'data' in response.data) {
      return {
        code: 200,
        message: '搜索用户成功',
        data: response.data.data || []
      }
    }
    
    // 默认返回空数组
    return {
      code: 200,
      message: '搜索用户成功',
      data: []
    }
  } catch (error) {
    console.error('搜索用户失败:', error)
    ElMessage.error('搜索用户失败')
    return {
      code: 500,
      message: '搜索用户失败',
      data: []
    }
  }
}

// 获取所有标签
export const getAllTags = async (): Promise<TagResponse[]> => {
  try {
    console.log('开始请求标签列表...')
    const response = await request.get('/api/users/tags')
    console.log('标签列表响应:', response)
    
    // API直接返回了正确格式的标签数组
    if (Array.isArray(response) && response.length > 0) {
      console.log('获取到标签列表:', response)
      return response
    }
    
    console.warn('未获取到标签数据')
    return []
  } catch (error) {
    console.error('获取标签列表失败:', error)
    return []
  }
} 