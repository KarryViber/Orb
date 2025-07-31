<template>
  <el-dialog
    v-model="dialogVisible"
    :title="t('template.editTemplate')"
    width="600px"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
    >
      <el-form-item :label="t('template.templateName')" prop="name">
        <el-input v-model="form.name" :placeholder="t('template.namePlaceholder')" />
      </el-form-item>

      <el-form-item :label="t('common.platform')" prop="platform">
        <el-select v-model="form.platform" :placeholder="t('template.platformSelect')">
          <el-option label="Instagram" :value="Platform.INSTAGRAM" />
          <el-option label="Twitter" :value="Platform.TWITTER" />
          <el-option label="Facebook" :value="Platform.FACEBOOK" />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('template.templateContent')" prop="content">
        <div class="template-input-section">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="6"
            :placeholder="t('template.contentPlaceholder')"
          />
          <div class="variables-section">
            <div class="variables-list">
              <el-tag
                v-for="variable in availableVariables"
                :key="variable.value"
                class="clickable-tag"
                @click="insertVariable(variable.value)"
              >
                {{ t(`template.variableLabels.${variable.value}`) }}
              </el-tag>
            </div>
          </div>
        </div>
      </el-form-item>

      <el-form-item :label="t('template.isDefault')">
        <el-switch v-model="form.is_default" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="handleCancel">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" @click="handleSubmit" :loading="submitting">
        {{ t('common.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { updateMessageTemplate } from '@/api/templates'
import { Platform } from '@/types/common'
import type { TemplateResponse } from '@/api/templates'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  template: TemplateResponse | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'success'): void
}>()

const dialogVisible = ref(false)
watch(() => props.modelValue, val => {
  dialogVisible.value = val
  if (val && props.template) {
    form.value = {
      name: props.template.name,
      platform: props.template.platform,
      content: props.template.content,
      variables: props.template.variables,
      is_default: props.template.is_default
    }
  }
})
watch(dialogVisible, val => {
  emit('update:modelValue', val)
})

const formRef = ref<FormInstance>()
const form = ref({
  name: '',
  platform: Platform.INSTAGRAM,
  content: '',
  variables: [] as string[],
  is_default: false
})

const rules: FormRules = {
  name: [
    { required: true, message: t('template.nameRule'), trigger: 'blur' },
    { min: 2, max: 50, message: t('common.lengthLimit', { min: 2, max: 50 }), trigger: 'blur' }
  ],
  platform: [
    { required: true, message: t('template.platformRule'), trigger: 'change' }
  ],
  content: [
    { required: true, message: t('template.contentRule'), trigger: 'blur' },
    { min: 1, max: 1000, message: t('common.lengthLimit', { min: 1, max: 1000 }), trigger: 'blur' }
  ]
}

// 可用变量列表
const availableVariables = [
  { label: t('template.variableLabels.username'), value: 'username', description: t('template.variableDescriptions.username') },
  { label: t('template.variableLabels.display_name'), value: 'display_name', description: t('template.variableDescriptions.display_name') },
  { label: t('template.variableLabels.followers_count'), value: 'followers_count', description: t('template.variableDescriptions.followers_count') },
  { label: t('template.variableLabels.following_count'), value: 'following_count', description: t('template.variableDescriptions.following_count') },
  { label: t('template.variableLabels.post_count'), value: 'post_count', description: t('template.variableDescriptions.post_count') },
  { label: t('template.variableLabels.bio'), value: 'bio', description: t('template.variableDescriptions.bio') },
  { label: t('template.variableLabels.website'), value: 'website', description: t('template.variableDescriptions.website') },
  { label: t('template.variableLabels.category'), value: 'category', description: t('template.variableDescriptions.category') }
]

// 插入变量
const insertVariable = (variable: string) => {
  const textarea = document.querySelector('.template-input-section textarea') as HTMLTextAreaElement
  if (!textarea) return

  const start = textarea.selectionStart || 0
  const end = textarea.selectionEnd || 0
  
  const content = form.value.content
  const newContent = content.substring(0, start) + `{${variable}}` + content.substring(end)
  form.value.content = newContent
  
  // 更新变量列表
  if (!form.value.variables.includes(variable)) {
    form.value.variables.push(variable)
  }

  // 设置光标位置
  setTimeout(() => {
    textarea.focus()
    const newPosition = start + variable.length + 2
    textarea.setSelectionRange(newPosition, newPosition)
  })
}

// 提交相关
const submitting = ref(false)

const handleSubmit = async () => {
  if (!formRef.value || !props.template) return
  
  try {
    await formRef.value.validate()
    submitting.value = true
    
    await updateMessageTemplate(props.template.id, form.value)
    ElMessage.success(t('message.saveSuccess'))
    handleCancel()
    emit('success')
  } catch (error: any) {
    console.error('更新模板失败:', error)
    ElMessage.error(error.message || t('message.saveFailed'))
  } finally {
    submitting.value = false
  }
}

const handleCancel = () => {
  dialogVisible.value = false
  if (formRef.value) {
    formRef.value.resetFields()
  }
}
</script>

<style scoped>
.template-input-section {
  .variables-section {
    margin-top: 12px;
    padding: 12px;
    background-color: #f5f7fa;
    border-radius: 4px;

    .variables-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;

      .clickable-tag {
        cursor: pointer;
        transition: all 0.2s;

        &:hover {
          background-color: #409eff;
          color: white;
          transform: translateY(-1px);
        }
      }
    }
  }
}
</style> 