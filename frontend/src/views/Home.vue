<template>
  <div class="home-container">
    <!-- 统计卡片 -->
    <el-row :gutter="20">
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>
            <div class="card-header">
              <span>总用户数</span>
              <el-icon><User /></el-icon>
            </div>
          </template>
          <div class="card-content">
            <h2>{{ stats.totalUsers }}</h2>
            <p>活跃用户: {{ stats.activeUsers }}</p>
          </div>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>
            <div class="card-header">
              <span>私信总数</span>
              <el-icon><Message /></el-icon>
            </div>
          </template>
          <div class="card-content">
            <h2>{{ stats.totalMessages }}</h2>
            <p>成功发送: {{ stats.deliveredMessages }}</p>
          </div>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>
            <div class="card-header">
              <span>模板数量</span>
              <el-icon><Document /></el-icon>
            </div>
          </template>
          <div class="card-content">
            <h2>{{ stats.totalTemplates }}</h2>
            <p>使用中: {{ stats.activeTemplates }}</p>
          </div>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <template #header>
            <div class="card-header">
              <span>搜索任务</span>
              <el-icon><List /></el-icon>
            </div>
          </template>
          <div class="card-content">
            <h2>{{ stats.totalTasks }}</h2>
            <p>进行中: {{ stats.runningTasks }}</p>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 最近活动 -->
    <el-card class="activity-card">
      <template #header>
        <div class="card-header">
          <span>最近活动</span>
        </div>
      </template>
      <el-timeline>
        <el-timeline-item
          v-for="activity in recentActivities"
          :key="activity.id"
          :timestamp="activity.time"
          :type="activity.type"
        >
          {{ activity.content }}
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { User, Message, Document, List } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getDashboardStats, getRecentActivities } from '@/api/dashboard'
import type { DashboardStats, Activity } from '@/api/dashboard'

// 初始化统计数据
const stats = ref<DashboardStats>({
  totalUsers: 0,
  activeUsers: 0,
  totalMessages: 0,
  deliveredMessages: 0,
  totalTemplates: 0,
  activeTemplates: 0,
  totalTasks: 0,
  runningTasks: 0
})

// 获取统计数据
const fetchStats = async () => {
  try {
    const response = await getDashboardStats()
    if (response && typeof response === 'object') {
      stats.value = {
        totalUsers: response.totalUsers || 0,
        activeUsers: response.activeUsers || 0,
        totalMessages: response.totalMessages || 0,
        deliveredMessages: response.deliveredMessages || 0,
        totalTemplates: response.totalTemplates || 0,
        activeTemplates: response.activeTemplates || 0,
        totalTasks: response.totalTasks || 0,
        runningTasks: response.runningTasks || 0
      }
    } else {
      throw new Error('返回数据格式错误')
    }
  } catch (error: any) {
    console.error('获取统计数据失败:', error)
    ElMessage.error(error.response?.data?.detail || error.message || '获取统计数据失败')
  }
}

// 获取最近活动
const recentActivities = ref<Activity[]>([])
const fetchActivities = async () => {
  try {
    recentActivities.value = await getRecentActivities(10)
  } catch (error: any) {
    ElMessage.error(error.response?.data?.detail || '获取活动数据失败')
  }
}

// 定时更新数据
let statsTimer: number
let activitiesTimer: number

onMounted(() => {
  // 初始加载数据
  fetchStats()
  fetchActivities()
  
  // 设置定时更新
  statsTimer = setInterval(fetchStats, 30000) // 每30秒更新统计数据
  activitiesTimer = setInterval(fetchActivities, 60000) // 每60秒更新活动数据
})

onUnmounted(() => {
  // 清理定时器
  clearInterval(statsTimer)
  clearInterval(activitiesTimer)
})
</script>

<style lang="scss" scoped>
.home-container {
  .stat-card {
    margin-bottom: 20px;
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .card-content {
      text-align: center;
      
      h2 {
        margin: 10px 0;
        color: #303133;
        font-size: 24px;
      }
      
      p {
        margin: 0;
        color: #909399;
        font-size: 14px;
      }
    }
  }
  
  .activity-card {
    margin-top: 20px;
  }
}
</style>