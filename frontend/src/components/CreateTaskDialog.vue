<template>
  <el-dialog
    v-model="dialogVisible"
    :title="t('message.createTask')"
    width="600px"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
    >
      <el-form-item :label="t('message.template')" prop="template_id">
        <el-select
          v-model="form.template_id"
          :placeholder="t('message.form.templatePlaceholder')"
          style="width: 100%"
          @change="handleTemplateChange"
        >
          <el-option
            v-for="template in templates"
            :key="template.id"
            :label="template.name"
            :value="template.id"
          >
            <div class="template-option">
              <span>{{ template.name }}</span>
              <el-tag size="small" type="info">{{ template.platform }}</el-tag>
            </div>
          </el-option>
        </el-select>
      </el-form-item>

      <el-form-item v-if="selectedTemplate" :label="t('common.platform')" prop="platform">
        <el-select 
          v-model="selectedPlatform" 
          disabled
          style="width: 100%"
        >
          <el-option label="Instagram" :value="Platform.INSTAGRAM" />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('task.taskName')" prop="name">
        <el-input v-model="form.name" :placeholder="t('message.form.namePlaceholder')" />
      </el-form-item>

      <el-form-item :label="t('message.targetGroups')" prop="group_ids">
        <el-select
          v-model="form.group_ids"
          multiple
          :placeholder="t('message.form.groupsPlaceholder')"
          style="width: 100%"
          @change="handleGroupsChange"
        >
          <el-option
            v-for="group in groups"
            :key="group.id"
            :label="group.name"
            :value="group.id"
          >
            <div class="group-option">
              <span>{{ group.name }}</span>
              <el-tag size="small" type="info">
                {{ group.user_count }} {{ t('user.peopleUnit') }}
              </el-tag>
            </div>
          </el-option>
        </el-select>
      </el-form-item>

      <el-form-item :label="t('message.sendSettings')">
        <el-form-item :label="t('message.sendInterval')" prop="settings.interval">
          <el-input-number
            v-model="form.settings.interval"
            :min="30"
            :max="3600"
            :step="30"
          />
          <span class="form-help-text">{{ t('message.secondUnit') }}</span>
        </el-form-item>
        
        <el-form-item :label="t('message.dailyLimit')" prop="settings.daily_limit">
          <el-input-number
            v-model="form.settings.daily_limit"
            :min="1"
            :max="1000"
            :step="10"
          />
          <span class="form-help-text">{{ t('message.messageUnit') }}</span>
        </el-form-item>
      </el-form-item>

      <el-form-item v-if="selectedTemplate?.variables?.length" :label="t('message.variableSettings')">
        <div v-for="variable in selectedTemplate.variables" :key="variable" class="variable-item">
          <el-form-item :label="variable" :prop="'variables.' + variable">
            <el-input
              v-model="form.variables[variable]"
              :placeholder="t('message.form.variablePlaceholder', { name: variable })"
            />
          </el-form-item>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="loading" @click="handleSubmit">
        {{ t('common.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance } from 'element-plus'
import { getMessageTemplates } from '@/api/templates'
import type { TemplateResponse } from '@/api/templates'
import { getUserGroups } from '@/api/userGroups'
import type { UserGroupResponse, UserGroupListResponse } from '@/types/userGroup'
import { createMessageTask } from '@/api/messages'
import { useI18n } from 'vue-i18n'
import { Platform } from '@/types/common'
import type { PaginatedData } from '@/types/api'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'success'): void
}>()

// 对话框状态
const dialogVisible = ref(props.modelValue)
const loading = ref(false)

// 表单数据
const formRef = ref<FormInstance>()
const form = ref({
  name: '',
  template_id: null as number | null,
  group_ids: [] as number[],
  settings: {
    interval: 60,
    daily_limit: 50
  },
  variables: {} as Record<string, string>
})

// 添加平台显示变量
const selectedPlatform = ref<Platform>(Platform.INSTAGRAM)

// 表单验证规则
const rules = {
  name: [
    { required: true, message: t('message.form.nameRule'), trigger: 'blur' },
    { min: 2, max: 50, message: t('common.lengthLimit', { min: 2, max: 50 }), trigger: 'blur' }
  ],
  template_id: [
    { required: true, message: t('message.form.templateRule'), trigger: 'change' }
  ],
  group_ids: [
    { required: true, message: t('message.form.groupRule'), trigger: 'change' }
  ]
}

// 选项数据
const templates = ref<TemplateResponse[]>([])
const selectedTemplate = ref<TemplateResponse | null>(null)
const groups = ref<UserGroupResponse[]>([])

// 加载模板列表
const loadTemplates = async () => {
  try {
    console.log('[CreateTaskDialog] 开始加载模板列表')
    const response = await getMessageTemplates({ platform: Platform.INSTAGRAM })
    console.log('[CreateTaskDialog] 模板列表响应:', response)
    
    if (response.code === 200 && Array.isArray(response.data)) {
      // 只显示激活的模板
      templates.value = response.data.filter(template => template.is_active)
      
      if (templates.value.length === 0) {
        console.warn('[CreateTaskDialog] 没有可用的模板')
        ElMessage.warning('没有可用的消息模板')
      } else {
        console.log('[CreateTaskDialog] 加载到', templates.value.length, '个可用模板')
      }
    } else {
      console.warn('[CreateTaskDialog] 模板列表为空')
      templates.value = []
      ElMessage.warning('没有可用的消息模板')
    }
  } catch (error) {
    console.error('[CreateTaskDialog] 加载模板列表失败:', error)
    templates.value = []
    ElMessage.error('加载模板列表失败')
  }
}

// 加载用户组列表
const loadGroups = async () => {
  try {
    console.log('[CreateTaskDialog] 开始加载用户组列表')
    const response = await getUserGroups({ platform: Platform.INSTAGRAM })
    console.log('[CreateTaskDialog] 用户组列表响应:', response)
    
    if (response.data && typeof response.data === 'object' && 'items' in response.data) {
      const userGroups = response.data.items as UserGroupResponse[]
      groups.value = userGroups
      
      if (groups.value.length === 0) {
        console.warn('[CreateTaskDialog] 没有可用的用户组')
        ElMessage.warning('没有可用的用户组')
      }
    } else {
      console.warn('[CreateTaskDialog] 用户组列表为空')
      groups.value = []
      ElMessage.warning('没有可用的用户组')
    }
  } catch (error) {
    console.error('[CreateTaskDialog] 加载用户组列表失败:', error)
    groups.value = []
    ElMessage.error('加载用户组列表失败')
  }
}

// 处理模板变更
const handleTemplateChange = (templateId: number) => {
  console.log('[CreateTaskDialog] 模板变更:', templateId)
  selectedTemplate.value = templates.value.find(t => t.id === templateId) || null
  
  // 更新平台信息
  if (selectedTemplate.value?.platform) {
    selectedPlatform.value = selectedTemplate.value.platform as Platform
  }
  
  // 重置变量
  form.value.variables = {}
  if (selectedTemplate.value?.variables) {
    selectedTemplate.value.variables.forEach(variable => {
      form.value.variables[variable] = ''
    })
  }
}

// 处理用户组变更
const handleGroupsChange = (groupIds: number[]) => {
  console.log('[CreateTaskDialog] 用户组变更:', groupIds)
}

// 提交表单
const handleSubmit = async () => {
  if (!formRef.value) return
  
  try {
    await formRef.value.validate()
    loading.value = true
    console.log('[CreateTaskDialog] 提交表单数据:', form.value)
    
    const success = await createMessageTask({
      name: form.value.name,
      template_id: form.value.template_id!,
      group_ids: form.value.group_ids,
      settings: {
        interval: form.value.settings.interval,
        daily_limit: form.value.settings.daily_limit
      },
      variables: form.value.variables
    })
    
    if (success) {
      ElMessage.success(t('message.createSuccess'))
      dialogVisible.value = false
      emit('success')
    }
  } catch (error) {
    console.error('[CreateTaskDialog] 提交表单失败:', error)
    ElMessage.error(t('message.createFailed'))
  } finally {
    loading.value = false
  }
}

// 监听对话框可见性
watch(() => props.modelValue, (newVal: boolean) => {
  dialogVisible.value = newVal
})

watch(() => dialogVisible.value, (newVal: boolean) => {
  emit('update:modelValue', newVal)
})

// 组件挂载时加载数据
onMounted(() => {
  loadTemplates()
  loadGroups()
})
</script>

<style scoped>
.form-help-text {
  margin-left: 8px;
  color: #909399;
}

.variable-item {
  margin-bottom: 16px;
  
  &:last-child {
    margin-bottom: 0;
  }
}

.group-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.template-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
</style> 