<template>
  <div class="messages-container">
    <el-card class="message-card">
      <template #header>
        <div class="card-header">
          <h2>批量发送消息</h2>
        </div>
      </template>

      <!-- 消息内容输入 -->
      <el-form :model="messageForm" label-width="120px">
        <el-form-item label="选择用户">
          <el-select
            v-model="messageForm.selectedUsers"
            multiple
            filterable
            placeholder="请选择要发送消息的用户"
            style="width: 100%"
          >
            <el-option
              v-for="user in userList"
              :key="user.username"
              :label="user.display_name || user.username"
              :value="user.username"
            >
              <div class="user-option">
                <el-avatar :size="24" :src="user.profile_data?.avatar_url" />
                <span class="username">{{ user.username }}</span>
                <span class="followers" v-if="user.profile_data?.followers_count">
                  ({{ user.profile_data.followers_count }}粉丝)
                </span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="消息模板">
          <el-select
            v-model="messageForm.selectedTemplate"
            placeholder="选择消息模板（可选）"
            clearable
            style="width: 100%"
            @change="handleTemplateChange"
          >
            <el-option
              v-for="template in templates"
              :key="template.id"
              :label="template.name"
              :value="template.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="消息内容">
          <el-input
            v-model="messageForm.message"
            type="textarea"
            :rows="4"
            placeholder="请输入要发送的消息内容"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" @click="startSendMessages" :loading="isSending">
            {{ isSending ? '发送中...' : '开始发送' }}
          </el-button>
        </el-form-item>
      </el-form>

      <!-- 发送进度 -->
      <div v-if="sendingProgress.total > 0" class="progress-section">
        <h3>发送进度</h3>
        <el-progress 
          :percentage="sendingProgress.percentage" 
          :status="sendingProgress.status"
        />
        <div class="progress-stats">
          <span>总计: {{ sendingProgress.total }}</span>
          <span>成功: {{ sendingProgress.success }}</span>
          <span>失败: {{ sendingProgress.failed }}</span>
        </div>
      </div>

      <!-- 发送结果列表 -->
      <div v-if="sendResults.length > 0" class="results-section">
        <h3>发送结果</h3>
        <el-table :data="sendResults" style="width: 100%">
          <el-table-column prop="username" label="用户名" width="180" />
          <el-table-column prop="status" label="状态" width="100">
            <template #default="scope">
              <el-tag :type="scope.row.success ? 'success' : 'danger'">
                {{ scope.row.success ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="error" label="错误信息" />
          <el-table-column prop="sendTime" label="发送时间" width="180" />
        </el-table>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { User } from '@/types/user'
import type { Template } from '@/types/template'
import { useUserStore } from '@/stores/user'
import { useTemplateStore } from '@/stores/template'
import { sendBulkMessages } from '@/api/messages'
import type { MessageResponse } from '@/api/messages'

// 状态定义
const userStore = useUserStore()
const templateStore = useTemplateStore()
const userList = ref<User[]>([])
const templates = ref<Template[]>([])
const isSending = ref(false)

// 表单数据
const messageForm = reactive({
  selectedUsers: [] as string[],
  selectedTemplate: '',
  message: ''
})

// 发送进度
const sendingProgress = reactive({
  total: 0,
  success: 0,
  failed: 0,
  percentage: 0,
  status: 'success' as 'success' | 'exception'
})

// 发送结果
const sendResults = ref<Array<{
  username: string
  success: boolean
  error?: string
  sendTime: string
}>>([])

// 初始化数据
onMounted(async () => {
  try {
    // 加载用户列表
    const users = await userStore.fetchUsers()
    userList.value = users
    
    // 加载消息模板
    const templateList = await templateStore.fetchTemplates()
    templates.value = templateList
  } catch (error) {
    ElMessage.error('加载数据失败')
  }
})

// 处理模板选择
const handleTemplateChange = (templateId: string) => {
  if (!templateId) {
    messageForm.message = ''
    return
  }
  const template = templates.value.find((t: Template) => t.id === templateId)
  if (template) {
    messageForm.message = template.content
  }
}

// 开始发送消息
const startSendMessages = async () => {
  if (!messageForm.selectedUsers.length) {
    ElMessage.warning('请选择至少一个用户')
    return
  }
  if (!messageForm.message.trim()) {
    ElMessage.warning('请输入消息内容')
    return
  }

  try {
    isSending.value = true
    sendingProgress.total = messageForm.selectedUsers.length
    sendingProgress.success = 0
    sendingProgress.failed = 0
    sendResults.value = []

    const messages = messageForm.selectedUsers.map(username => ({
      username,
      message: messageForm.message
    }))

    const results = await sendBulkMessages(messages)
    
    // 处理结果
    results.forEach((result: MessageResponse) => {
      if (result.success) {
        sendingProgress.success++
      } else {
        sendingProgress.failed++
      }
      
      sendResults.value.push({
        username: result.username,
        success: result.success,
        error: result.error,
        sendTime: new Date().toLocaleString()
      })
    })

    // 更新进度
    sendingProgress.percentage = Math.round(
      ((sendingProgress.success + sendingProgress.failed) / sendingProgress.total) * 100
    )
    sendingProgress.status = sendingProgress.failed > 0 ? 'exception' : 'success'

    if (sendingProgress.failed === 0) {
      ElMessage.success('所有消息发送成功')
    } else {
      ElMessage.warning(`发送完成，成功${sendingProgress.success}条，失败${sendingProgress.failed}条`)
    }

  } catch (error) {
    ElMessage.error('发送消息失败')
  } finally {
    isSending.value = false
  }
}
</script>

<style scoped>
.messages-container {
  padding: 20px;
}

.message-card {
  max-width: 1000px;
  margin: 0 auto;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.user-option {
  display: flex;
  align-items: center;
  gap: 8px;
}

.username {
  font-weight: bold;
}

.followers {
  color: #666;
  font-size: 0.9em;
}

.progress-section {
  margin-top: 20px;
  padding: 20px;
  background-color: #f8f9fa;
  border-radius: 4px;
}

.progress-stats {
  margin-top: 10px;
  display: flex;
  gap: 20px;
  color: #666;
}

.results-section {
  margin-top: 20px;
}
</style> 