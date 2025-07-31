// 社交平台枚举
export enum Platform {
  INSTAGRAM = 'instagram',
  FACEBOOK = 'facebook',
  TWITTER = 'twitter',
  TIKTOK = 'tiktok',
  YOUTUBE = 'youtube',
  LINKEDIN = 'linkedin'
}

// 分页请求参数
export interface PaginationParams {
  page?: number
  pageSize?: number
}

// 分页响应
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

// 标签
export interface Tag {
  label: string
  value: string
}

// 用户资料数据
export interface ProfileData {
  avatar_url?: string
  followers_count: number
  following_count: number
  post_count: number
  bio?: string
  is_verified: boolean
  is_private: boolean
  is_business: boolean
  website?: string
  category?: string
  profile_url?: string
  matched_posts?: any[]
}

// 用户基本信息
export interface UserBase {
  platform: Platform
  username: string
  display_name: string
  profile_data: ProfileData
  tags?: Tag[]
}

// 用户响应
export interface UserResponse {
  id: number
  platform: Platform
  username: string
  display_name?: string
  profile_data?: ProfileData
  tags?: string[]
  created_at: string
  updated_at: string
}