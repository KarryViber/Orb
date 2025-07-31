<template>
  <div class="tasks-container">
    <!-- 任务列表 -->
    <el-card class="task-card">
      <template #header>
        <div class="card-header">
          <span>搜索任务</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>新建任务
          </el-button>
        </div>
      </template>

      <el-table
        v-loading="loading"
        :data="taskList"
        style="width: 100%"
      >
        <el-table-column prop="id" label="任务ID" width="80" />
        <el-table-column prop="platform" label="平台" width="120">
          <template #default="{ row }">
            <el-tag :type="getPlatformTagType(row.platform)">
              {{ row.platform }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="keywords" label="关键词">
          <template #default="{ row }">
            <el-tag
              v-for="keyword in row.keywords"
              :key="keyword"
              size="small"
              class="mx-1"
            >
              {{ keyword }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="filters" label="过滤条件" width="200">
          <template #default="{ row }">
            <el-tooltip
              :content="getFiltersTooltip(row.filters)"
              placement="top"
            >
              <el-tag type="info">{{ row.filters.length }}个条件</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="progress" label="进度" width="200">
          <template #default="{ row }">
            <el-progress
              :percentage="row.progress"
              :status="getProgressStatus(row.progress)"
            />
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180" />
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button-group>
              <el-button
                size="small"
                :disabled="!canPause(row.status)"
                @click="handlePause(row)"
              >
                暂停
              </el-button>
              <el-button
                size="small"
                type="primary"
                :disabled="!canResume(row.status)"
                @click="handleResume(row)"
              >
                继续
              </el-button>
              <el-button
                size="small"
                type="danger"
                @click="handleCancel(row)"
              >
                取消
              </el-button>
            </el-button-group>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建任务对话框 -->
    <el-dialog
      v-model="dialogVisible"
      title="新建搜索任务"
      width="600px"
    >
      <el-form
        ref="formRef"
        :model="taskForm"
        :rules="rules"
        label-width="100px"
      >
        <el-form-item label="平台" prop="platform">
          <el-select v-model="taskForm.platform" placeholder="选择平台">
            <el-option label="Twitter" value="twitter" />
            <el-option label="Instagram" value="instagram" />
            <el-option label="Facebook" value="facebook" />
            <el-option label="LinkedIn" value="linkedin" />
          </el-select>
        </el-form-item>
        
        <el-form-item label="关键词" prop="keywords">
          <el-select
            v-model="taskForm.keywords"
            multiple
            allow-create
            filterable
            default-first-option
            placeholder="输入关键词并回车"
          />
        </el-form-item>
        
        <el-form-item label="过滤条件">
          <el-form-item prop="minFollowers">
            <el-input-number
              v-model="taskForm.minFollowers"
              :min="0"
              placeholder="最小粉丝数"
            />
          </el-form-item>
          <el-form-item prop="minPosts">
            <el-input-number
              v-model="taskForm.minPosts"
              :min="0"
              placeholder="最小发帖数"
            />
          </el-form-item>
          <el-form-item prop="location">
            <el-input
              v-model="taskForm.location"
              placeholder="地理位置"
            />
          </el-form-item>
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
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

// 任务列表数据
const loading = ref(false)
const taskList = ref([
  {
    id: 1,
    platform: 'twitter',
    keywords: ['digital marketing', 'SEO'],
    filters: [
      { type: 'followers', value: 1000 },
      { type: 'location', value: 'United States' }
    ],
    progress: 45,
    status: 'running',
    createdAt: '2023-11-20 10:00:00'
  },
  // 更多模拟数据...
])

// 新建任务表单
const dialogVisible = ref(false)
const formRef = ref<FormInstance>()
const taskForm = ref({
  platform: '',
  keywords: [],
  minFollowers: 1000,
  minPosts: 100,
  location: ''
})

// 表单校验规则
const rules = ref<FormRules>({
  platform: [
    { required: true, message: '请选择平台', trigger: 'change' }
  ],
  keywords: [
    { required: true, message: '请输入至少一个关键词', trigger: 'change' },
    { type: 'array', min: 1, message: '至少需要一个关键词', trigger: 'change' }
  ]
})

// 方法
const handleCreate = () => {
  dialogVisible.value = true
  taskForm.value = {
    platform: '',
    keywords: [],
    minFollowers: 1000,
    minPosts: 100,
    location: ''
  }
}

const handleSubmit = async () => {
  if (!formRef.value) return
  
  await formRef.value.validate((valid, fields) => {
    if (valid) {
      // TODO: 实现创建任务逻辑
      ElMessage.success('创建任务成功')
      dialogVisible.value = false
    }
  })
}

const handlePause = (row) => {
  // TODO: 实现暂停任务逻辑
  ElMessage.success('任务已暂停')
}

const handleResume = (row) => {
  // TODO: 实现继续任务逻辑
  ElMessage.success('任务已继续')
}

const handleCancel = (row) => {
  ElMessageBox.confirm(
    '确定要取消该任务吗？',
    '警告',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }
  ).then(() => {
    // TODO: 实现取消任务逻辑
    ElMessage.success('任务已取消')
  })
}

// 辅助方法
const getPlatformTagType = (platform: string) => {
  const types = {
    twitter: 'primary',
    instagram: 'success',
    facebook: 'info',
    linkedin: 'warning'
  }
  return types[platform] || 'info'
}

const getProgressStatus = (progress: number) => {
  if (progress === 100) return 'success'
  return ''
}

const getStatusType = (status: string) => {
  const types = {
    running: 'success',
    paused: 'warning',
    completed: 'info',
    cancelled: 'danger'
  }
  return types[status] || 'info'
}

const canPause = (status: string) => status === 'running'
const canResume = (status: string) => status === 'paused'

const getFiltersTooltip = (filters: any[]) => {
  return filters.map(f => `${f.type}: ${f.value}`).join('\n')
}
</script>

<style lang="scss" scoped>
.tasks-container {
  .task-card {
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  }
  
  .el-tag {
    margin-right: 5px;
  }
  
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
}
</style> 