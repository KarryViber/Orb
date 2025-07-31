<template>
  <div class="message-view">
    <div class="header">
      <h2>私信管理</h2>
      <el-button type="primary" :icon="Plus" @click="handleCreate">
        新建私信任务
      </el-button>
    </div>

    <!-- 搜索工具栏 -->
    <el-card class="search-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="关键词">
          <el-input
            v-model="searchForm.keyword"
            placeholder="任务名称"
            clearable
            @keyup.enter="handleSearch"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">搜索</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 任务列表 -->
    <el-table
      v-loading="loading"
      :data="taskList"
      style="width: 100%; margin-top: 20px"
    >
      <el-table-column prop="name" label="任务名称" min-width="200">
        <template #default="{ row }">
          <div class="task-name">
            <span>{{ row.name }}</span>
            <el-tag
              :type="getStatusTagType(row.status)"
              size="small"
              effect="plain"
            >
              {{ getStatusText(row.status) }}
            </el-tag>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="template.name" label="使用模板" min-width="150">
        <template #default="{ row }">
          <el-link type="primary" @click="handlePreviewTemplate(row)">
            {{ row.template.name }}
          </el-link>
        </template>
      </el-table-column>

      <el-table-column label="目标用户" min-width="200">
        <template #default="{ row }">
          <div class="target-info">
            <el-tag size="small" type="info">
              总数: {{ row.total_users }}
            </el-tag>
            <el-tag size="small" type="success">
              成功: {{ row.success_count }}
            </el-tag>
            <el-tag size="small" type="danger">
              失败: {{ row.failed_count }}
            </el-tag>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="进度" width="200">
        <template #default="{ row }">
          <div class="progress-info">
            <el-progress
              :percentage="row.progress"
              :status="getProgressStatus(row.status)"
            />
            <span class="speed" v-if="row.status === 'running'">
              速度: {{ row.speed || 0 }} 条/分钟
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column prop="created_at" label="创建时间" width="180">
        <template #default="{ row }">
          {{ formatDate(row.created_at) }}
        </template>
      </el-table-column>

      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button-group>
            <el-button
              size="small"
              type="primary"
              :disabled="!canViewResults(row.status)"
              @click="handleViewResults(row)"
            >
              查看结果
            </el-button>
            <el-button
              size="small"
              :type="row.status === 'running' ? 'danger' : 'success'"
              :disabled="!canToggleTask(row.status)"
              @click="handleToggleTask(row)"
            >
              {{ row.status === 'running' ? '停止' : '启动' }}
            </el-button>
            <el-button
              size="small"
              type="danger"
              :disabled="row.status === 'running'"
              @click="handleDelete(row)"
            >
              删除
            </el-button>
          </el-button-group>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <div class="pagination">
      <el-pagination
        v-model:currentPage="currentPage"
        v-model:pageSize="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        @size-change="handleSizeChange"
        @current-change="handleCurrentChange"
      />
    </div>

    <!-- 创建任务对话框 -->
    <el-dialog
      v-model="dialogVisible"
      title="新建私信任务"
      width="600px"
      @open="handleDialogOpen"
      @success="handleCreateSuccess"
    >
      <el-form
        ref="formRef"
        :model="taskForm"
        :rules="formRules"
        label-width="100px"
      >
        <el-form-item label="任务名称" prop="name">
          <el-input
            v-model="taskForm.name"
            placeholder="请输入任务名称"
          />
        </el-form-item>

        <el-form-item label="选择模板" prop="template_id">
          <el-select
            v-model="taskForm.template_id"
            placeholder="请选择消息模板"
            clearable
            :loading="loadingTemplates"
          >
            <el-option
              v-for="template in templateOptions"
              :key="template.id"
              :label="template.name"
              :value="template.id"
            >
              <span>{{ template.name }}</span>
              <el-tooltip
                effect="dark"
                :content="template.content"
                placement="right"
              >
                <el-icon class="ml-2"><InfoFilled /></el-icon>
              </el-tooltip>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="目标用户组" prop="group_ids">
          <el-select
            v-model="taskForm.group_ids"
            multiple
            clearable
            :loading="loadingUserGroups"
            placeholder="请选择目标用户组"
            style="width: 100%"
          >
            <el-option
              v-for="group in userGroupOptions"
              :key="group.id"
              :label="group.name"
              :value="group.id"
            >
              <div class="group-option">
                <span>{{ group.name }}</span>
                <el-tag size="small" type="info">
                  用户数: {{ group.user_count }}
                </el-tag>
              </div>
            </el-option>
          </el-select>
          <div class="form-help" v-if="taskForm.group_ids.length">
            已选择 {{ taskForm.group_ids.length }} 个用户组
          </div>
        </el-form-item>

        <el-form-item label="目标用户" prop="user_ids">
          <el-select
            v-model="taskForm.user_ids"
            multiple
            remote
            :remote-method="handleSearchUsers"
            :loading="searchingUsers"
            placeholder="可选：直接选择个别用户"
          >
            <el-option
              v-for="user in userOptions"
              :key="user.id"
              :label="user.username"
              :value="user.id"
            >
              <div class="user-option">
                <el-avatar :size="24" :src="user.profile_data?.avatar_url">
                  {{ user.username.charAt(0).toUpperCase() }}
                </el-avatar>
                <span>{{ user.username }}</span>
                <el-tag size="small" type="info">
                  {{ user.platform }}
                </el-tag>
              </div>
            </el-option>
          </el-select>
          <div class="form-help" v-if="taskForm.user_ids.length">
            已选择 {{ taskForm.user_ids.length }} 个用户
          </div>
        </el-form-item>

        <el-form-item label="发送设置">
          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="间隔时间" prop="interval">
                <el-input-number
                  v-model="taskForm.settings.interval"
                  :min="1"
                  :max="60"
                  placeholder="分钟"
                />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="每日上限" prop="daily_limit">
                <el-input-number
                  v-model="taskForm.settings.daily_limit"
                  :min="1"
                  :max="1000"
                  placeholder="条数"
                />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form-item>
      </el-form>

      <template #footer>
        <span class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="handleSubmit">
            确定
          </el-button>
        </span>
      </template>
    </el-dialog>

    <!-- 模板预览对话框 -->
    <el-dialog
      v-model="previewVisible"
      title="模板预览"
      width="500px"
    >
      <div class="preview-content">
        <div class="preview-title">原始内容：</div>
        <div class="preview-text">{{ previewData.content }}</div>
        <div class="preview-title">预览效果：</div>
        <div class="preview-text">{{ previewData.preview }}</div>
      </div>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="previewVisible = false">关闭</el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Search, Plus, InfoFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import messageTaskService from '@/services/messageTasks'
import templateService from '@/services/templates'
import { searchUsers } from '@/api/users'
import { getUserGroups } from '@/api/userGroups'
import type { MessageTask, MessageTaskSettings } from '@/services/messageTasks'
import type { Template } from '@/services/templates'
import type { Platform } from '@/types/common'
import type { UserResponse } from '@/api/users'
import type { UserGroup } from '@/api/userGroups'

// 搜索
const searchForm = ref({
  keyword: ''
})

// 表格数据
const loading = ref(false)
const taskList = ref<MessageTask[]>([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

// 添加监听器来追踪数据变化
watch(taskList, (newVal) => {
  console.log('=== [Debug] taskList 发生变化 ===')
  console.log('新的任务列表:', newVal)
  console.log('任务列表长度:', newVal.length)
}, { deep: true })

// 表单
const dialogVisible = ref(false)
const formRef = ref<FormInstance>()
const taskForm = ref({
  name: '',
  template_id: 0,
  user_ids: [] as number[],
  group_ids: [] as number[],
  settings: {
    interval: 60,
    daily_limit: 50
  } as MessageTaskSettings
})

// 模板选项
const templateOptions = ref<Template[]>([])

// 用户选项
const userOptions = ref<UserResponse[]>([])
const searchingUsers = ref(false)

// 用户组选项
const userGroupOptions = ref<UserGroup[]>([])
const loadingUserGroups = ref(false)

// 预览
const previewVisible = ref(false)
const previewData = ref({
  content: '',
  preview: ''
})

// 表单验证规则
const formRules: FormRules = {
  name: [
    { required: true, message: '请输入任务名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  template_id: [
    { required: true, message: '请选择消息模板', trigger: 'change' }
  ],
  user_ids: [
    { type: 'array', message: '请选择目标用户', trigger: 'change' }
  ],
  group_ids: [
    { type: 'array', message: '请选择目标用户组', trigger: 'change' }
  ]
}

// 状态轮询
let statusTimer: number | null = null

const startStatusPolling = () => {
  stopStatusPolling() // 先清除可能存在的定时器
  statusTimer = window.setInterval(() => {
    if (taskList.value && taskList.value.length > 0) {
      const runningTasks = taskList.value.filter(task => task.status === 'running')
      if (runningTasks.length > 0) {
        loadTasks()
      }
    }
  }, 3000)
}

const stopStatusPolling = () => {
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
}

// 加载任务列表
const loadTasks = async () => {
  console.log('=== [Debug] 开始加载任务列表 ===')
  loading.value = true
  
  try {
    const params = {
      keyword: searchForm.value.keyword,
      page: currentPage.value,
      pageSize: pageSize.value
    }
    console.log('[Debug] 请求参数:', params)
    
    const response = await messageTaskService.getMessageTasks(params)
    console.log('[Debug] 原始响应:', response)
    
    // 检查响应数据结构
    if (response && typeof response === 'object') {
      console.log('[Debug] response.data:', response.data)
      console.log('[Debug] response.total:', response.total)
      
      if (Array.isArray(response.data)) {
        taskList.value = response.data
        total.value = response.total || 0
        console.log('[Debug] 数据已更新 - taskList:', taskList.value.length, '条数据')
        console.log('[Debug] 第一条数据:', taskList.value[0])
      } else {
        console.warn('[Debug] response.data 不是数组:', response.data)
        taskList.value = []
        total.value = 0
      }
    } else {
      console.warn('[Debug] 响应格式不正确:', response)
      taskList.value = []
      total.value = 0
    }
  } catch (error) {
    console.error('[Debug] 加载失败:', error)
    ElMessage.error('加载任务列表失败')
    taskList.value = []
    total.value = 0
  } finally {
    loading.value = false
    console.log('[Debug] 最终状态 - taskList:', taskList.value.length, '条数据')
  }
}

// 加载状态
const loadingTemplates = ref(false)

// 加载模板列表
const loadTemplates = async () => {
  loadingTemplates.value = true
  try {
    const response = await templateService.getTemplates({
      platform: 'instagram' as Platform,
      page: 1,
      pageSize: 100
    })
    console.log('模板加载响应:', response)
    if (response?.data) {
      templateOptions.value = response.data.filter(template => template.is_active)
      if (templateOptions.value.length === 0) {
        ElMessage.warning('没有可用的消息模板')
      }
    } else {
      templateOptions.value = []
      ElMessage.warning('没有可用的消息模板')
    }
  } catch (error) {
    console.error('加载模板失败:', error)
    ElMessage.error('加载模板失败')
    templateOptions.value = []
  } finally {
    loadingTemplates.value = false
  }
}

// 加载用户组
const loadUserGroups = async () => {
  loadingUserGroups.value = true
  try {
    const response = await getUserGroups({
      platform: 'instagram' as Platform,
      page: 1,
      pageSize: 100
    })
    console.log('用户组加载响应:', response)
    if (response?.data) {
      // 处理不同的响应格式
      const groups = Array.isArray(response.data) ? response.data : 
                    'items' in response.data ? response.data.items : []
      userGroupOptions.value = groups
      if (groups.length === 0) {
        ElMessage.warning('没有可用的用户组')
      }
    } else {
      userGroupOptions.value = []
      ElMessage.warning('没有可用的用户组')
    }
  } catch (error) {
    console.error('加载用户组失败:', error)
    ElMessage.error('加载用户组失败')
    userGroupOptions.value = []
  } finally {
    loadingUserGroups.value = false
  }
}

// 搜索用户
const handleSearchUsers = async (query: string) => {
  if (query) {
    searchingUsers.value = true
    try {
      const response = await searchUsers({ keyword: query })
      if (response && Array.isArray(response.data)) {
        userOptions.value = response.data
      } else {
        userOptions.value = []
      }
    } catch (error) {
      console.error('搜索用户失败:', error)
    } finally {
      searchingUsers.value = false
    }
  } else {
    userOptions.value = []
  }
}

// 搜索
const handleSearch = () => {
  currentPage.value = 1
  loadTasks()
}

// 分页
const handleSizeChange = (val: number) => {
  pageSize.value = val
  loadTasks()
}

const handleCurrentChange = (val: number) => {
  currentPage.value = val
  loadTasks()
}

// 处理对话框打开
const handleDialogOpen = () => {
  // 重置表单
  taskForm.value = {
    name: '',
    template_id: 0,
    user_ids: [],
    group_ids: [],
    settings: {
      interval: 60,
      daily_limit: 50
    } as MessageTaskSettings
  }
  
  // 加载数据
  loadTemplates()
  loadUserGroups()
}

// 创建任务
const handleCreate = () => {
  dialogVisible.value = true
}

// 处理任务创建成功
const handleCreateSuccess = () => {
  console.log('[MessageView] 任务创建成功，刷新列表')
  loadTasks()
}

// 预览模板
const handlePreviewTemplate = (row: MessageTask) => {
  previewData.value = {
    content: row.template.content,
    preview: row.template.content // 这里可以添加变量替换逻辑
  }
  previewVisible.value = true
}

// 查看结果
const handleViewResults = (row: MessageTask) => {
  // TODO: 实现查看结果功能，可能需要跳转到结果页面
  console.log('查看结果:', row.id)
}

// 启动/停止任务
const handleToggleTask = async (row: MessageTask) => {
  try {
    if (row.status === 'running') {
      await messageTaskService.stopTask(row.id)
      ElMessage.success('任务已停止')
    } else {
      await messageTaskService.startTask(row.id)
      ElMessage.success('任务已启动')
    }
    loadTasks()
  } catch (error: any) {
    console.error('操作任务失败:', error)
    ElMessage.error(error.message || '操作任务失败')
  }
}

// 删除任务
const handleDelete = async (row: MessageTask) => {
  try {
    await ElMessageBox.confirm('确定要删除该任务吗？', '提示', {
      type: 'warning'
    })
    await messageTaskService.deleteTask(row.id)
    ElMessage.success('删除任务成功')
    loadTasks()
  } catch (error: any) {
    if (error !== 'cancel') {
      console.error('删除任务失败:', error)
      ElMessage.error(error.message || '删除任务失败')
    }
  }
}

// 提交表单
const handleSubmit = async () => {
  if (!formRef.value) return

  try {
    await formRef.value.validate()
    const response = await messageTaskService.createMessageTask(taskForm.value)
    ElMessage.success('创建任务成功')
    dialogVisible.value = false
    handleCreateSuccess()
  } catch (error: any) {
    console.error('创建任务失败:', error)
    ElMessage.error(error.message || '创建任务失败')
  }
}

// 辅助方法
const getStatusText = (status: string) => {
  const map: Record<string, string> = {
    pending: '待处理',
    running: '运行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败'
  }
  return map[status] || status
}

const getStatusTagType = (status: string) => {
  const map: Record<string, string> = {
    pending: 'info',
    running: 'success',
    paused: 'warning',
    completed: '',
    failed: 'danger'
  }
  return map[status] || 'info'
}

const getProgressStatus = (status: string) => {
  if (status === 'failed') return 'exception'
  if (status === 'completed') return 'success'
  return ''
}

const formatDate = (date: string) => {
  return new Date(date).toLocaleString()
}

const canViewResults = (status: string) => {
  return ['completed', 'failed'].includes(status)
}

const canToggleTask = (status: string) => {
  return ['pending', 'running', 'paused'].includes(status)
}

// 生命周期
onMounted(() => {
  loadTasks()
  loadTemplates()
  startStatusPolling()
})

onBeforeUnmount(() => {
  stopStatusPolling()
})
</script>

<style lang="scss" scoped>
.message-view {
  padding: 20px;

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;

    h2 {
      margin: 0;
    }
  }

  .search-card {
    margin-bottom: 20px;
  }

  .task-name {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .target-info {
    display: flex;
    gap: 10px;
  }

  .progress-info {
    .speed {
      display: block;
      margin-top: 5px;
      font-size: 12px;
      color: #909399;
    }
  }

  .user-option {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .group-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 0;
  }

  .form-help {
    margin-top: 5px;
    color: #909399;
    font-size: 12px;
  }

  .preview-content {
    .preview-title {
      font-weight: bold;
      margin: 10px 0;
    }

    .preview-text {
      background: #f5f7fa;
      padding: 10px;
      border-radius: 4px;
      margin-bottom: 20px;
      white-space: pre-wrap;
    }
  }

  .pagination {
    margin-top: 20px;
    display: flex;
    justify-content: flex-end;
  }
}
</style> 