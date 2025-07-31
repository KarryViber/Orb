<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { User, Document, Message, Search, UserFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
import type { DashboardStats } from '@/api/dashboard'

const router = useRouter()
const { t } = useI18n()

// 统计数据
const stats = ref({
  userCount: 0,
  templateCount: 0,
  runningTasks: 0,
  todayMessages: 0
})

// 最近任务
const recentTasks = ref([])

// 处理快捷操作
const handleAction = (type: string) => {
  const routeMap: Record<string, string> = {
    users: '/users',
    templates: '/message-templates',
    messages: '/message-tasks',
    search: '/search-tasks'
  }
  router.push(routeMap[type] || '/')
}

// 查看所有任务
const handleViewAllTasks = () => {
  router.push('/message-tasks')
}

// 辅助方法
const getTaskTypeTag = (type: string) => {
  const map: Record<string, string> = {
    'message': 'primary',  // 私信任务使用蓝色
    'search': 'success'    // 搜索任务使用绿色
  }
  return map[type] || 'info'
}

const getTaskTypeText = (type: string) => {
  const map: Record<string, string> = {
    'message': t('message.messageTask'),
    'search': t('search.searchTask')
  }
  return map[type] || type
}

const getStatusTag = (status: string) => {
  const map: Record<string, string> = {
    pending: 'info',
    running: 'success',
    completed: '',
    failed: 'danger'
  }
  return map[status] || ''
}

const getStatusText = (status: string) => {
  const map: Record<string, string> = {
    pending: t('common.pending'),
    running: t('common.running'),
    completed: t('common.completed'),
    failed: t('common.failed')
  }
  return map[status] || status
}

const formatDate = (date: string) => {
  return new Date(date).toLocaleString()
}

// 加载数据
const loadData = async () => {
  try {
    // 获取统计数据
    const statsData = await request.get<DashboardStats>('/api/dashboard/stats')
    console.log('统计数据原始响应:', statsData)
    
    // 直接使用响应数据
    stats.value = {
      userCount: statsData.totalUsers || 0,
      templateCount: statsData.totalTemplates || 0,
      runningTasks: statsData.runningTasks || 0,
      todayMessages: statsData.deliveredMessages || 0
    }

    // 获取最近任务
    const tasksData = await request.get('/api/messages/message-tasks', {
      params: {
        page: 1,
        pageSize: 5
      }
    })
    console.log('任务数据原始响应:', tasksData)
    // 直接使用分页数据中的data字段
    recentTasks.value = tasksData.data
  } catch (error) {
    console.error('加载数据失败:', error)
    ElMessage.error('加载数据失败，请稍后重试')
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="home-view">
    <el-row :gutter="20">
      <!-- 统计卡片 -->
      <el-col :span="6">
        <el-card class="stat-card">
          <template #header>
            <div class="card-header">
              <span>{{ t('dashboard.totalUsers') }}</span>
            </div>
          </template>
          <div class="stat-value">
            <span class="number">{{ stats.userCount }}</span>
            <span class="label">{{ t('dashboard.unit.person') }}</span>
          </div>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card class="stat-card">
          <template #header>
            <div class="card-header">
              <span>{{ t('dashboard.totalTemplates') }}</span>
            </div>
          </template>
          <div class="stat-value">
            <span class="number">{{ stats.templateCount }}</span>
            <span class="label">{{ t('dashboard.unit.template') }}</span>
          </div>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card class="stat-card">
          <template #header>
            <div class="card-header">
              <span>{{ t('dashboard.runningTasks') }}</span>
            </div>
          </template>
          <div class="stat-value">
            <span class="number">{{ stats.runningTasks }}</span>
            <span class="label">{{ t('dashboard.unit.task') }}</span>
          </div>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card class="stat-card">
          <template #header>
            <div class="card-header">
              <span>{{ t('dashboard.todaySent') }}</span>
            </div>
          </template>
          <div class="stat-value">
            <span class="number">{{ stats.todayMessages }}</span>
            <span class="label">{{ t('dashboard.unit.message') }}</span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 快捷操作 -->
    <el-row :gutter="20" class="quick-actions">
      <el-col :span="6">
        <el-card class="action-card" @click="handleAction('users')">
          <el-icon><User /></el-icon>
          <span>{{ t('user.userManagement') }}</span>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card class="action-card" @click="handleAction('templates')">
          <el-icon><Document /></el-icon>
          <span>{{ t('template.templateManagement') }}</span>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card class="action-card" @click="handleAction('messages')">
          <el-icon><Message /></el-icon>
          <span>{{ t('message.messageTask') }}</span>
        </el-card>
      </el-col>
      
      <el-col :span="6">
        <el-card class="action-card" @click="handleAction('search')">
          <el-icon><Search /></el-icon>
          <span>{{ t('search.searchTask') }}</span>
        </el-card>
      </el-col>
    </el-row>

    <!-- 最近任务 -->
    <el-card class="recent-tasks">
      <template #header>
        <div class="card-header">
          <span>{{ t('dashboard.recentTasks') }}</span>
          <el-button text @click="handleViewAllTasks">{{ t('common.viewAll') }}</el-button>
        </div>
      </template>
      
      <el-table :data="recentTasks" style="width: 100%">
        <el-table-column prop="name" :label="t('common.taskName')" />
        <el-table-column prop="type" :label="t('common.type')" width="120">
          <template #default="{ row }">
            <el-tag
              :type="getTaskTypeTag(row.type)"
              effect="plain"
              size="small"
            >
              {{ getTaskTypeText(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" :label="t('common.status')" width="120">
          <template #default="{ row }">
            <el-tag :type="getStatusTag(row.status)">
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" :label="t('common.createdAt')" width="180">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style lang="scss" scoped>
.home-view {
  padding: 20px;

  .stat-card {
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .stat-value {
      text-align: center;
      padding: 10px 0;

      .number {
        font-size: 24px;
        font-weight: bold;
        color: #409EFF;
      }

      .label {
        margin-left: 4px;
        color: #909399;
      }
    }
  }

  .quick-actions {
    margin-top: 20px;

    .action-card {
      cursor: pointer;
      text-align: center;
      padding: 20px;
      transition: all 0.3s;

      &:hover {
        transform: translateY(-5px);
        box-shadow: 0 2px 12px 0 rgba(0,0,0,.1);
      }

      .el-icon {
        font-size: 24px;
        color: #409EFF;
        margin-bottom: 10px;
      }

      span {
        display: block;
        color: #606266;
      }
    }
  }

  .recent-tasks {
    margin-top: 20px;

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  }
}
</style>