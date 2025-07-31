import type { Platform } from './common'

export interface UserProfileData {
    avatar_url?: string
    followers_count: number
    following_count: number
    posts_count: number
    bio?: string
    description?: string
    location?: string
    website?: string
    category?: string
    profile_url?: string
    is_verified: boolean
    is_private: boolean
    is_business: boolean
    matched_posts?: any[]
    matchedTweet?: {
        matched_keywords: string[];
        text: string;
        url: string;
        created_at: string;
    }
}

export interface UserResponse {
    id: number
    platform: Platform
    username: string
    display_name?: string
    profile_data?: UserProfileData
    tags?: string[]
    contacted: boolean
    created_at: string
    updated_at: string
}

export interface UserListResponse {
    items: UserResponse[]
    total: number
    page: number
    pageSize: number
}

export interface UserApiResponse {
    code: number
    message: string
    data: UserListResponse | UserResponse | null
}

export interface UserGroup {
    id: number
    name: string
    description?: string
    created_at: string
    updated_at: string
    user_count?: number
}

export interface UserSearchParams {
  keyword?: string
  platform?: Platform
  tags?: string[]
  tagLogic?: 'or' | 'and'
  contacted?: boolean
  page?: number
  pageSize?: number
} 