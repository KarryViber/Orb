<template>
  <el-dialog
    v-model="dialogVisible"
    :title="t('template.createTemplate')"
    width="800px"
    class="template-dialog"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="220px"
      class="template-form"
    >
      <el-form-item :label="t('template.templateName')" prop="name" class="form-item">
        <el-input v-model="form.name" :placeholder="t('template.namePlaceholder')" />
      </el-form-item>

      <el-form-item :label="t('common.platform')" prop="platform" class="form-item">
        <el-select v-model="form.platform" :placeholder="t('template.platformSelect')" style="width: 100%">
          <el-option label="Instagram" :value="Platform.INSTAGRAM" />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('template.templateContent')" prop="content" class="form-item">
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

      <el-form-item :label="t('template.isDefault')" class="form-item">
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
import { createMessageTemplate } from '@/api/templates'
import { Platform } from '@/types/common'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'success'): void
}>()

const dialogVisible = ref(false)
watch(() => props.modelValue, val => {
  dialogVisible.value = val
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
  { value: 'username', description: t('template.variableDescriptions.username') },
  { value: 'display_name', description: t('template.variableDescriptions.display_name') },
  { value: 'followers_count', description: t('template.variableDescriptions.followers_count') },
  { value: 'following_count', description: t('template.variableDescriptions.following_count') },
  { value: 'post_count', description: t('template.variableDescriptions.post_count') },
  { value: 'bio', description: t('template.variableDescriptions.bio') },
  { value: 'website', description: t('template.variableDescriptions.website') },
  { value: 'category', description: t('template.variableDescriptions.category') }
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
  if (!formRef.value) return
  
  try {
    await formRef.value.validate()
    submitting.value = true
    
    await createMessageTemplate(form.value)
    ElMessage.success(t('message.createSuccess'))
    handleCancel()
    emit('success')
  } catch (error: any) {
    console.error('创建模板失败:', error)
    ElMessage.error(error.message || t('message.createFailed'))
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
.template-dialog {
  :deep(.el-dialog__body) {
    padding: 0;
  }
}

.template-form {
    padding: 30px 20px;
    
    :deep(.el-form-item) {
        margin-bottom: 24px;
        
        .el-form-item__label {
            font-size: 14px;
            font-weight: 500;
            color: #606266;
            padding-right: 20px;
            line-height: 1.4;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .el-form-item__content {
            margin-left: 220px !important;
            min-width: 0;
        }
    }

    .form-item {
        display: flex;
        align-items: flex-start;
        
        :deep(.el-form-item__label) {
            flex-shrink: 0;
        }
        
        :deep(.el-form-item__content) {
            flex: 1;
            min-width: 0;
        }
    }
}

.template-input-section {
    .variables-section {
        margin-top: 12px;
        padding: 16px;
        background-color: #f5f7fa;
        border-radius: 4px;

        .variables-list {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;

            .clickable-tag {
                cursor: pointer;
                transition: all 0.2s;
                padding: 6px 14px;
                height: 32px;
                display: flex;
                align-items: center;
                font-size: 13px;

                &:hover {
                    background-color: #409eff;
                    color: white;
                    transform: translateY(-1px);
                }
            }
        }
    }
}

:deep(.el-select) {
    width: 100%;
}

:deep(.el-input__wrapper),
:deep(.el-textarea__inner) {
    box-shadow: none;
    border: 1px solid #dcdfe6;
    
    &:hover,
    &:focus {
        border-color: #409eff;
    }
}

:deep(.el-dialog__footer) {
    padding: 20px;
    border-top: 1px solid #dcdfe6;
}
</style> 