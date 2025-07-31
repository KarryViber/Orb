<template>
  <div class="message-task-container">
    <el-tabs v-model="activeTab">
      <!-- 私信任务标签页 -->
      <el-tab-pane :label="t('menu.message')" name="tasks">
        <div class="task-header">
          <el-button type="primary" @click="showCreateTaskDialog">{{ t('task.createTask') }}</el-button>
          <el-input
            v-model="searchKeyword"
            :placeholder="t('search.keywords')"
            style="width: 200px; margin-left: 16px"
            clearable
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
        </div>

        <el-table :data="tasks" style="width: 100%; margin-top: 16px">
          <el-table-column prop="name" :label="t('task.taskName')" min-width="120" />
          
          <el-table-column :label="t('common.platform')" width="150" align="center">
            <template #default="{ row }">
              <el-tag :type="getPlatformTagType(row.template?.platform)" size="small" class="platform-tag">
                {{ row.template?.platform === 'instagram' ? 'Instagram' : row.template?.platform }}
              </el-tag>
            </template>
          </el-table-column>
          
          <el-table-column prop="template.name" :label="t('template.templateName')" min-width="120" />
          <el-table-column :label="t('user.targetUsers')" min-width="120">
            <template #default="{ row }">
              <span>{{ row.total_users }}{{ t('user.peopleUnit') }}</span>
              <el-button link type="primary" @click="showTargetUsers(row)">{{ t('common.view') }}</el-button>
            </template>
          </el-table-column>
          <el-table-column :label="t('task.taskProgress')" min-width="200">
            <template #default="{ row }">
              <div style="display: flex; align-items: center;">
                <el-progress
                  :percentage="row.progress"
                  :status="getProgressStatus(row)"
                  style="flex: 1; margin-right: 10px"
                />
                <span style="white-space: nowrap;">
                  {{ row.success_count }}/{{ row.total_users }}
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.status')" min-width="100">
            <template #default="{ row }">
              <el-tag :type="getStatusType(row.status)">
                {{ t(`task.status.${row.status}`) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.actions')" width="200" fixed="right">
            <template #default="{ row }">
              <div class="operation-tags">
                <el-tag
                  v-if="row.status === 'pending'"
                  type="success"
                  class="operation-tag"
                  effect="plain"
                  @click="startTask(row)"
                >
                  <el-icon><CaretRight /></el-icon>
                  {{ t('task.start') }}
                </el-tag>
                <el-tag
                  v-if="row.status === 'running'"
                  type="warning"
                  class="operation-tag"
                  effect="plain"
                  @click="stopTask(row)"
                >
                  <el-icon><VideoPause /></el-icon>
                  {{ t('task.stop') }}
                </el-tag>
                <el-tag
                  v-if="!['running'].includes(row.status)"
                  type="danger"
                  class="operation-tag"
                  effect="plain"
                  @click="deleteTask(row)"
                >
                  <el-icon><Delete /></el-icon>
                  {{ t('common.delete') }}
                </el-tag>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <div class="pagination">
          <el-pagination
            v-model:currentPage="currentPage"
            v-model:pageSize="pageSize"
            :page-sizes="[10, 20, 50, 100]"
            :layout="total > 0 ? 'total, sizes, prev, pager, next' : 'prev, pager, next'"
            :total="total"
            @size-change="handleSizeChange"
            @current-change="handleCurrentChange"
          />
        </div>
      </el-tab-pane>

      <!-- 消息模板标签页 -->
      <el-tab-pane :label="t('template.messageTemplates')" name="templates">
        <TemplateView />
      </el-tab-pane>
    </el-tabs>

    <!-- 创建任务对话框 -->
    <CreateTaskDialog
      v-model="showCreateTask"
      @success="handleTaskCreated"
    />

    <!-- 目标用户对话框 -->
    <el-dialog
      v-model="showTargetUsersDialog"
      :title="t('user.targetUsers')"
      width="600px"
    >
      <el-table 
        v-loading="loadingTargetUsers"
        :data="targetUsers" 
        style="width: 100%"
      >
        <el-table-column prop="username" :label="t('user.userName')" min-width="120" />
        <el-table-column prop="display_name" :label="t('user.displayName')" min-width="120" />
        <el-table-column :label="t('common.status')" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'success' ? 'success' : 'danger'" effect="light">
              {{ row.status === 'success' ? t('common.success') : t('common.error') }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="showTargetUsersDialog = false">{{ t('common.close') }}</el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, CaretRight, VideoPause, Delete } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'
import CreateTaskDialog from '@/components/CreateTaskDialog.vue'
import TemplateView from '@/views/TemplateView.vue'
import { getMessageTasks, startMessageTask, stopMessageTask, deleteMessageTask, getTaskUsers } from '@/api/messages'
import { Platform } from '@/types/common'

const { t } = useI18n()

// 数据定义
const activeTab = ref('tasks')
const tasks = ref<any[]>([])
const loading = ref(false)
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)
const searchKeyword = ref('')
const showCreateTask = ref(false)

// 目标用户相关
const showTargetUsersDialog = ref(false)
const targetUsers = ref<any[]>([])
const loadingTargetUsers = ref(false)

// 状态更新定时器
let statusTimer: number | null = null

// 加载任务列表
const loadTasks = async () => {
  try {
    console.log('[Debug] 开始加载任务列表，参数:', {
      keyword: searchKeyword.value,
      page: currentPage.value,
      pageSize: pageSize.value
    })
    
    const response = await getMessageTasks({
      keyword: searchKeyword.value,
      page: currentPage.value,
      pageSize: pageSize.value
    })
    
    console.log('[Debug] 获取到的响应:', response)
    
    if (Array.isArray(response)) {
      // 如果直接返回数组，就直接使用
      tasks.value = response
      total.value = response.length
      console.log('[Debug] 更新后的任务列表:', tasks.value)
      console.log('[Debug] 总数:', total.value)
    } else if (response && response.data) {
      // 如果返回的是对象格式，使用其中的 data 和 total
      tasks.value = response.data
      total.value = response.total
      console.log('[Debug] 更新后的任务列表:', tasks.value)
      console.log('[Debug] 总数:', total.value)
    } else {
      console.warn('[Debug] 响应数据格式不正确:', response)
      tasks.value = []
      total.value = 0
    }
  } catch (error) {
    console.error('[Debug] 加载任务列表失败:', error)
    ElMessage.error('加载任务列表失败')
    tasks.value = []
    total.value = 0
  }
}

const handleSearch = () => {
  currentPage.value = 1
  loadTasks()
}

const handleSizeChange = (val: number) => {
  pageSize.value = val
  loadTasks()
}

const handleCurrentChange = (val: number) => {
  currentPage.value = val
  loadTasks()
}

const showCreateTaskDialog = () => {
  showCreateTask.value = true
}

const handleTaskCreated = () => {
  loadTasks()
}

const startTask = async (row: any) => {
  try {
    await startMessageTask(row.id)
    ElMessage.success(t('message.taskStarted'))
    loadTasks()
  } catch (error: any) {
    ElMessage.error(error.message || t('message.taskStartFailed'))
  }
}

const stopTask = async (row: any) => {
  try {
    await stopMessageTask(row.id)
    ElMessage.success(t('message.taskStopped'))
    loadTasks()
  } catch (error: any) {
    ElMessage.error(error.message || t('message.taskStopFailed'))
  }
}

const deleteTask = async (row: any) => {
  try {
    await ElMessageBox.confirm(t('message.deleteTaskConfirm'), t('common.confirm'), {
      type: 'warning'
    })
    await deleteMessageTask(row.id)
    ElMessage.success(t('message.taskDeleted'))
    loadTasks()
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error.message || t('message.taskDeleteFailed'))
    }
  }
}

// 目标用户相关方法
const showTargetUsers = async (row: any) => {
  try {
    loadingTargetUsers.value = true
    console.log('[Debug] 开始获取目标用户，任务ID:', row.id)
    
    const response = await getTaskUsers(row.id)
    console.log('[Debug] 获取到的目标用户响应:', response)
    
    if (response && Array.isArray(response.data)) {
      targetUsers.value = response.data.map(user => ({
        ...user,
        status: user.status || 'pending'  // 确保有状态值
      }))
      console.log('[Debug] 更新后的目标用户列表:', targetUsers.value)
    } else if (Array.isArray(response)) {
      // 如果直接返回数组
      targetUsers.value = response.map(user => ({
        ...user,
        status: user.status || 'pending'  // 确保有状态值
      }))
      console.log('[Debug] 更新后的目标用户列表(数组):', targetUsers.value)
    } else {
      console.warn('[Debug] 目标用户数据格式不正确:', response)
      targetUsers.value = []
      ElMessage.warning(t('message.noTargetUsers'))
    }
    
    showTargetUsersDialog.value = true
  } catch (error) {
    console.error('[Debug] 获取目标用户失败:', error)
    ElMessage.error(t('message.loadTargetUsersFailed'))
    targetUsers.value = []
  } finally {
    loadingTargetUsers.value = false
  }
}

// 状态轮询
const startStatusPolling = () => {
  statusTimer = window.setInterval(() => {
    if (tasks.value.some((task: any) => task.status === 'running')) {
      loadTasks()
    }
  }, 3000)
}

const stopStatusPolling = () => {
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
}

// 辅助方法
const getStatusType = (status: string) => {
  const statusMap: Record<string, string> = {
    pending: 'info',
    running: 'primary',
    completed: 'success',
    failed: 'danger',
    stopped: 'warning'
  }
  return statusMap[status] || 'info'
}

const getProgressStatus = (row: any) => {
  if (row.status === 'failed') return 'exception'
  if (row.status === 'completed') return 'success'
  return ''
}

const getPlatformTagType = (platform: string | undefined) => {
  switch (platform) {
    case Platform.INSTAGRAM:
      return ''  // 使用默认类型,配合自定义样式
    case Platform.TWITTER:
      return 'primary'
    case Platform.FACEBOOK:
      return 'warning'
    case Platform.TIKTOK:
      return 'danger'
    default:
      return 'info'
  }
}

// 生命周期钩子
onMounted(() => {
  loadTasks()
  startStatusPolling()
})

onBeforeUnmount(() => {
  stopStatusPolling()
})

// 暴露reload方法给父组件
defineExpose({ reload: loadTasks })
</script>

<style scoped>
.message-task-container {
  padding: 20px;
}

.task-header {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
}

.pagination {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}

.operation-tags {
  display: flex;
  gap: 8px;
}

.operation-tag {
  cursor: pointer;
  transition: all 0.3s;
  display: flex;
  align-items: center;
  gap: 4px;
}

.operation-tag:hover {
  opacity: 0.8;
}

.platform-tag {
  min-width: 90px;
  text-align: center;
  padding: 4px 12px;
  font-weight: 500;
  
  &:deep(.el-tag) {
    background-color: #E1BEE7 !important;
    border-color: #CE93D8 !important;
    color: #7B1FA2 !important;
  }
}
</style>