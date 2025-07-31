import request from '../utils/request'

export interface DashboardStats {
  totalUsers: number
  activeUsers: number
  totalMessages: number
  deliveredMessages: number
  totalTemplates: number
  activeTemplates: number
  totalTasks: number
  runningTasks: number
}

export interface Activity {
  id: number
  time: string
  type: string
  content: string
  related_id?: number
  related_type?: string
}

/**
 * 获取仪表盘统计数据
 */
export const getDashboardStats = async (): Promise<DashboardStats> => {
  return await request.get('/api/dashboard/stats')
}

/**
 * 获取最近活动记录
 * @param limit 获取记录数量
 */
export const getRecentActivities = async (limit: number = 10): Promise<Activity[]> => {
  return await request.get('/api/activities', {
    params: { limit }
  })
}
