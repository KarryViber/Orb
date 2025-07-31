export interface ApiResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

export interface ApiError {
  code: string
  message: string
  details?: any
}

export const handleApiResponse = <T>(response: any): ApiResponse<T> => {
  if (!response || typeof response !== 'object') {
    throw new Error('Invalid API response')
  }

  return {
    data: response.data || [],
    total: response.total || 0,
    page: response.page || 1,
    pageSize: response.pageSize || 10
  }
}

export const isApiError = (error: any): error is ApiError => {
  return error && typeof error === 'object' && 'code' in error && 'message' in error
}

export const getErrorMessage = (error: any): string => {
  if (isApiError(error)) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return '操作失败，请稍后重试'
} 