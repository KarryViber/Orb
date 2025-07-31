<script setup lang="ts">
import { ref, onMounted, nextTick, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Edit, Delete, Star } from '@element-plus/icons-vue'
import type { FormInstance, FormRules } from 'element-plus'
import type { InputInstance } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { TemplateService } from '../services/templates'
import { templateService } from '../services/templates'
import type { Template } from '../services/templates'
import { Platform } from '@/types/common'
import { useDataLoading } from '@/hooks/useDataLoading'
import { formRules } from '@/utils/formRules'
import request from '@/utils/request'

const { t } = useI18n()

// 模板列表
const { loading, withLoading } = useDataLoading()
const templates = ref<Template[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)

// 模板对话框
const dialogVisible = ref(false)
const dialogTitle = ref('')
const formRef = ref<FormInstance>()
const form = ref({
    id: 0,
    name: '',
    content: '',
    variables: [] as string[],
    platform: Platform.INSTAGRAM,
    is_default: false,
    updated_at: new Date().toISOString()
})

// 表单验证规则
const rules = {
    name: [
        formRules.required(t('template.nameRule')),
        formRules.length(2, 50)
    ],
    content: [
        formRules.required(t('template.contentRule')),
        formRules.length(1, 1000)
    ],
    platform: [
        formRules.required(t('template.platformRule'))
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

// 修改contentInputRef的类型定义
const contentInputRef = ref()
const textareaRef = ref<HTMLTextAreaElement>()
const cursorPosition = ref<number>(0)

// 修改insertVariable函数
const insertVariable = (variable: string) => {
    // 获取textarea元素
    const textarea = contentInputRef.value?.$el.querySelector('textarea')
    if (!textarea) return

    // 缓存textarea引用
    textareaRef.value = textarea

    // 获取当前选择范围
    const start = textarea.selectionStart || 0
    const end = textarea.selectionEnd || 0
    
    // 插入变量
    const content = form.value.content
    const newContent = content.substring(0, start) + `{${variable}}` + content.substring(end)
    form.value.content = newContent
    
    // 更新变量列表
    if (!form.value.variables) {
        form.value.variables = []
    }
    if (!form.value.variables.includes(variable)) {
        form.value.variables.push(variable)
    }

    // 设置光标位置
    nextTick(() => {
        if (textarea) {
            textarea.focus()
            const newPosition = start + variable.length + 2
            textarea.setSelectionRange(newPosition, newPosition)
            cursorPosition.value = newPosition
        }
    })
}

// 预览模板
const previewContent = ref('')
const previewDialogVisible = ref(false)

const handlePreview = async () => {
  if (!form.value.id) {
    ElMessage.warning('请先保存模板')
    return
  }

  try {
    const content = await previewTemplate(form.value.id, sampleData)
    previewContent.value = content
    previewDialogVisible.value = true
  } catch (error) {
    console.error('预览失败:', error)
    ElMessage.error('预览失败')
  }
}

// 加载模板列表
const loadTemplates = async () => {
  await withLoading(async () => {
    const response = await templateService.getTemplates({
      page: currentPage.value,
      pageSize: pageSize.value
    })
    templates.value = response.data
    total.value = response.total
  })
}

// 处理页码变化
const handlePageChange = (page: number) => {
    currentPage.value = page
    loadTemplates()
}

// 处理每页条数变化
const handleSizeChange = (size: number) => {
    pageSize.value = size
    currentPage.value = 1
    loadTemplates()
}

// 打开创建模板对话框
const handleCreate = () => {
    dialogTitle.value = t('template.createTemplate')
    form.value = {
        id: 0,
        name: '',
        content: '',
        variables: [],
        platform: Platform.INSTAGRAM,
        is_default: false,
        updated_at: new Date().toISOString()
    }
    dialogVisible.value = true
}

// 打开编辑模板对话框
const handleEdit = (template: Template) => {
    dialogTitle.value = t('template.editTemplate')
    form.value = {
        id: template.id,
        name: template.name,
        content: template.content,
        variables: template.variables,
        platform: template.platform as Platform,
        is_default: template.is_default,
        updated_at: template.updated_at
    }
    dialogVisible.value = true
}

// 删除模板
const handleDelete = async (template: Template) => {
  try {
    await ElMessageBox.confirm('确认删除该模板吗？', '提示', {
      type: 'warning'
    })
    
    await withLoading(async () => {
      await templateService.deleteTemplate(template.id)
      await loadTemplates()
    })
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除失败:', error)
      ElMessage.error('删除失败')
    }
  }
}

// 设置默认模板
const handleSetDefault = async (template: Template) => {
  await withLoading(async () => {
    await setDefaultTemplate(template.id)
    await loadTemplates()
  })
}

// 添加示例数据
const sampleData = {
  username: 'example_user',
  display_name: 'Example User',
  followers_count: 1234,
  following_count: 567,
  post_count: 89,
  bio: '这是一个示例简介',
  website: 'https://example.com',
  category: '个人博主'
}

// 提交表单
const handleSubmit = async () => {
  if (!formRef.value) return
  
  try {
    await formRef.value.validate()
    
    const templateData = {
      name: form.value.name,
      content: form.value.content,
      variables: form.value.variables,
      platform: form.value.platform,
      is_default: form.value.is_default,
      is_active: true  // 默认设置为激活状态
    }
    
    await withLoading(async () => {
      if (form.value.id) {
        await templateService.updateTemplate(form.value.id, templateData)
      } else {
        await templateService.createTemplate(templateData)
      }
      
      dialogVisible.value = false
      await loadTemplates()
    })
  } catch (error) {
    console.error('保存失败:', error)
    ElMessage.error('保存失败')
  }
}

// 修改监听光标位置变化的函数
const handleCursorChange = (event: Event) => {
    const textarea = event.target as HTMLTextAreaElement
    cursorPosition.value = textarea.selectionStart || 0
}

// 修改onMounted中的事件监听
onMounted(() => {
    loadTemplates()
    nextTick(() => {
        const textarea = contentInputRef.value?.$el.querySelector('textarea')
        if (textarea) {
            textareaRef.value = textarea
            textarea.addEventListener('click', handleCursorChange)
            textarea.addEventListener('keyup', handleCursorChange)
            // 添加focus事件监听
            textarea.addEventListener('focus', handleCursorChange)
        }
    })
})

// 修改onBeforeUnmount中的事件监听清理
onBeforeUnmount(() => {
    const textarea = textareaRef.value
    if (textarea) {
        textarea.removeEventListener('click', handleCursorChange)
        textarea.removeEventListener('keyup', handleCursorChange)
        textarea.removeEventListener('focus', handleCursorChange)
    }
})

interface TemplateRow {
  id: number
  name: string
  content: string
  variables: string[]
  platform: Platform
  is_default: boolean
  updated_at: string
}

// 添加预览模板方法
const previewTemplate = async (id: number, sampleData: any) => {
  try {
    const response = await request.post(`/api/templates/${id}/preview`, sampleData)
    return response.data
  } catch (error) {
    console.error('预览模板失败:', error)
    ElMessage.error('预览模板失败')
    return null
  }
}

// 添加设置默认模板方法
const setDefaultTemplate = async (id: number) => {
  try {
    await request.put(`/api/templates/${id}/default`)
    return true
  } catch (error) {
    console.error('设置默认模板失败:', error)
    ElMessage.error('设置默认模板失败')
    return false
  }
}
</script>

<template>
    <div class="template-view">
        <div class="header">
            <div class="header-left">
                <el-button type="primary" @click="handleCreate">
                    <el-icon><Plus /></el-icon>
                    {{ t('template.createTemplate') }}
                </el-button>
            </div>
        </div>

        <el-card class="template-table-card">
            <el-table
                v-loading="loading"
                :data="templates"
                style="width: 100%"
                :cell-style="{ padding: '16px 0' }"
                :header-cell-style="{
                    backgroundColor: '#f5f7fa',
                    color: '#606266',
                    fontWeight: 600,
                    padding: '12px 0'
                }"
            >
                <el-table-column prop="name" :label="t('template.templateName')" min-width="180">
                    <template #default="{ row }">
                        <div class="template-name">
                            <span class="name-text">{{ row.name }}</span>
                            <el-tag
                                v-if="row.is_default"
                                type="success"
                                effect="light"
                                size="small"
                            >
                                {{ t('common.yes') }}
                            </el-tag>
                        </div>
                    </template>
                </el-table-column>
                
                <el-table-column prop="content" :label="t('template.templateContent')" min-width="300" show-overflow-tooltip>
                    <template #default="{ row }">
                        <div class="template-content">{{ row.content }}</div>
                    </template>
                </el-table-column>
                
                <el-table-column :label="t('template.variables')" min-width="220">
                    <template #default="{ row }">
                        <div class="template-variables">
                            <el-tag
                                v-for="variable in row.variables"
                                :key="variable"
                                size="small"
                                effect="plain"
                                class="variable-tag"
                            >
                                {{ variable }}
                            </el-tag>
                        </div>
                    </template>
                </el-table-column>
                
                <el-table-column :label="t('common.updateTime')" width="180">
                    <template #default="{ row }">
                        {{ new Date(row.updated_at).toLocaleString() }}
                    </template>
                </el-table-column>
                
                <el-table-column :label="t('common.actions')" width="200" fixed="right">
                    <template #default="scope">
                        <div class="operation-tags">
                            <el-tag
                                type="primary"
                                size="small"
                                @click="handleEdit(scope.row)"
                            >
                                <el-icon><Edit /></el-icon>
                                {{ t('common.edit') }}
                            </el-tag>
                            <el-tag
                                v-if="!scope.row.is_default"
                                type="success"
                                size="small"
                                @click="handleSetDefault(scope.row)"
                            >
                                <el-icon><Star /></el-icon>
                                {{ t('template.setDefault') }}
                            </el-tag>
                            <el-tag
                                type="danger"
                                size="small"
                                @click="handleDelete(scope.row)"
                            >
                                <el-icon><Delete /></el-icon>
                                {{ t('common.delete') }}
                            </el-tag>
                        </div>
                    </template>
                </el-table-column>
            </el-table>

            <!-- 分页 -->
            <div class="pagination-container">
                <el-pagination
                    v-model:current-page="currentPage"
                    v-model:page-size="pageSize"
                    :page-sizes="[10, 20, 50, 100]"
                    :total="total"
                    layout="total, sizes, prev, pager, next"
                    @size-change="handleSizeChange"
                    @current-change="handlePageChange"
                />
            </div>
        </el-card>

        <!-- 创建/编辑模板对话框 -->
        <el-dialog
            v-model="dialogVisible"
            :title="dialogTitle"
            width="600px"
            destroy-on-close
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

                <el-form-item :label="t('template.templateContent')" prop="content">
                    <div class="template-input-section">
                        <el-input
                            ref="contentInputRef"
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
                                    size="small"
                                    effect="plain"
                                    @click="insertVariable(variable.value)"
                                >
                                    {{ variable.label }}
                                </el-tag>
                            </div>
                        </div>
                    </div>
                </el-form-item>

                <el-form-item :label="t('common.platform')" prop="platform">
                    <el-select v-model="form.platform" :placeholder="t('template.platformSelect')">
                        <el-option label="Instagram" :value="Platform.INSTAGRAM" />
                        <el-option label="Twitter" :value="Platform.TWITTER" />
                        <el-option label="Facebook" :value="Platform.FACEBOOK" />
                    </el-select>
                </el-form-item>

                <el-form-item :label="t('template.isDefault')">
                    <el-switch v-model="form.is_default" />
                </el-form-item>

                <el-form-item>
                    <div class="preview-button">
                        <el-button type="primary" link @click="handlePreview">
                            {{ t('template.previewEffect') }}
                        </el-button>
                    </div>
                </el-form-item>
            </el-form>

            <template #footer>
                <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
                <el-button type="primary" @click="handleSubmit">
                    {{ t('common.confirm') }}
                </el-button>
            </template>
        </el-dialog>

        <!-- 预览对话框 -->
        <el-dialog
            v-model="previewDialogVisible"
            :title="t('template.previewTitle')"
            width="500px"
        >
            <div class="preview-content">
                <div class="preview-title">{{ t('template.previewData') }}</div>
                <div class="preview-text">{{ previewContent }}</div>
            </div>
        </el-dialog>
    </div>
</template>

<style scoped>
.template-view {
    padding: 20px;
}

.header {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    margin-bottom: 20px;
}

.template-table-card {
    margin-bottom: 20px;
    box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}

.template-name {
    display: flex;
    align-items: center;
    gap: 8px;
}

.name-text {
    font-weight: 500;
    color: #303133;
}

.template-content {
    color: #606266;
    font-size: 14px;
    line-height: 1.6;
}

.template-variables {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.variable-tag {
    border-radius: 4px;
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
    padding: 0 10px;
    height: 28px;
    border-radius: 4px;
}

.operation-tag:hover {
    opacity: 0.8;
    transform: translateY(-1px);
}

.pagination-container {
    margin-top: 20px;
    display: flex;
    justify-content: flex-end;
    padding: 0 20px;
}

.template-input-section {
    .el-input {
        margin-bottom: 12px;
    }

    .variables-section {
        background-color: #f5f7fa;
        border-radius: 4px;
        padding: 12px;

        .variables-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;

            .clickable-tag {
                cursor: pointer;
                transition: all 0.2s;
                padding: 0 12px;
                height: 32px;
                display: flex;
                align-items: center;

                &:hover {
                    background-color: #409eff;
                    color: white;
                    transform: translateY(-1px);
                }
            }
        }
    }
}

.preview-button {
    text-align: right;
    margin-top: 12px;
}

.preview-content {
    .preview-title {
        font-weight: 500;
        margin-bottom: 16px;
        color: #606266;
    }

    .preview-text {
        background: #f5f7fa;
        padding: 16px;
        border-radius: 4px;
        color: #303133;
        line-height: 1.6;
    }
}
</style> 