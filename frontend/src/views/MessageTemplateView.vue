<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Edit, Delete, Star } from '@element-plus/icons-vue'
import type { FormInstance, FormRules } from 'element-plus'
import templateService from '../services/templates'
import type { Template } from '../services/templates'

// 模板列表
const loading = ref(false)
const templates = ref<Template[]>([])

// 模板对话框
const dialogVisible = ref(false)
const dialogTitle = ref('')
const formRef = ref<FormInstance>()
const form = ref({
    id: 0,
    name: '',
    content: '',
    variables: [] as string[],
    is_default: false
})

// 表单验证规则
const rules: FormRules = {
    name: [
        { required: true, message: '请输入模板名称', trigger: 'blur' },
        { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
    ],
    content: [
        { required: true, message: '请输入模板内容', trigger: 'blur' },
        { min: 1, max: 1000, message: '长度在 1 到 1000 个字符', trigger: 'blur' }
    ]
}

// 加载模板列表
const loadTemplates = async () => {
    loading.value = true
    try {
        templates.value = await templateService.getTemplates()
    } catch (error) {
        console.error('加载模板失败:', error)
        ElMessage.error('加载模板失败')
    } finally {
        loading.value = false
    }
}

// 打开创建模板对话框
const handleCreate = () => {
    dialogTitle.value = '创建模板'
    form.value = {
        id: 0,
        name: '',
        content: '',
        variables: [],
        is_default: false
    }
    dialogVisible.value = true
}

// 打开编辑模板对话框
const handleEdit = (template: Template) => {
    dialogTitle.value = '编辑模板'
    form.value = { ...template }
    dialogVisible.value = true
}

// 删除模板
const handleDelete = async (template: Template) => {
    try {
        await ElMessageBox.confirm(
            '确定要删除这个模板吗？删除后无法恢复。',
            '删除确认',
            {
                confirmButtonText: '确定',
                cancelButtonText: '取消',
                type: 'warning'
            }
        )
        
        await templateService.deleteTemplate(template.id)
        ElMessage.success('删除成功')
        loadTemplates()
    } catch (error) {
        if (error !== 'cancel') {
            console.error('删除模板失败:', error)
            ElMessage.error('删除模板失败')
        }
    }
}

// 设置默认模板
const handleSetDefault = async (template: Template) => {
    try {
        await templateService.setDefaultTemplate(template.id)
        ElMessage.success('设置成功')
        loadTemplates()
    } catch (error) {
        console.error('设置默认模板失败:', error)
        ElMessage.error('设置默认模板失败')
    }
}

// 提交表单
const handleSubmit = async () => {
    if (!formRef.value) return
    
    try {
        await formRef.value.validate()
        
        if (form.value.id) {
            await templateService.updateTemplate(form.value.id, form.value)
            ElMessage.success('更新成功')
        } else {
            await templateService.createTemplate(form.value)
            ElMessage.success('创建成功')
        }
        
        dialogVisible.value = false
        loadTemplates()
    } catch (error) {
        console.error('保存模板失败:', error)
        ElMessage.error('保存模板失败')
    }
}

// 初始化
onMounted(() => {
    loadTemplates()
})
</script>

<template>
    <div class="template-view">
        <div class="header">
            <h2>私信模板管理</h2>
            <el-button type="primary" :icon="Plus" @click="handleCreate">
                创建模板
            </el-button>
        </div>

        <el-table
            v-loading="loading"
            :data="templates"
            style="width: 100%"
            :cell-style="{ padding: '12px 0' }"
            :header-cell-style="{
                backgroundColor: '#f5f7fa',
                color: '#606266',
                fontWeight: 600,
                padding: '12px 0'
            }"
        >
            <el-table-column prop="name" label="模板名称" min-width="200">
                <template #default="{ row }">
                    <div class="template-name">
                        {{ row.name }}
                        <el-tag
                            v-if="row.is_default"
                            type="success"
                            effect="light"
                            size="small"
                        >
                            默认
                        </el-tag>
                    </div>
                </template>
            </el-table-column>
            
            <el-table-column prop="content" label="模板内容" show-overflow-tooltip>
                <template #default="{ row }">
                    <div class="template-content">{{ row.content }}</div>
                </template>
            </el-table-column>
            
            <el-table-column prop="variables" label="变量" width="200">
                <template #default="{ row }">
                    <div class="template-variables">
                        <el-tag
                            v-for="variable in row.variables"
                            :key="variable"
                            size="small"
                            effect="plain"
                        >
                            {{ variable }}
                        </el-tag>
                    </div>
                </template>
            </el-table-column>
            
            <el-table-column label="操作" width="250" fixed="right">
                <template #default="{ row }">
                    <div class="operation-buttons">
                        <el-button
                            type="primary"
                            link
                            :icon="Edit"
                            @click="handleEdit(row)"
                        >
                            编辑
                        </el-button>
                        <el-button
                            type="danger"
                            link
                            :icon="Delete"
                            @click="handleDelete(row)"
                        >
                            删除
                        </el-button>
                        <el-button
                            v-if="!row.is_default"
                            type="success"
                            link
                            :icon="Star"
                            @click="handleSetDefault(row)"
                        >
                            设为默认
                        </el-button>
                    </div>
                </template>
            </el-table-column>
        </el-table>

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
                <el-form-item label="模板名称" prop="name">
                    <el-input v-model="form.name" placeholder="请输入模板名称" />
                </el-form-item>

                <el-form-item label="模板内容" prop="content">
                    <el-input
                        v-model="form.content"
                        type="textarea"
                        :rows="6"
                        placeholder="请输入模板内容，可使用以下变量：&#10;{username} - 用户名&#10;{display_name} - 显示名称&#10;{followers_count} - 粉丝数"
                    />
                </el-form-item>

                <el-form-item label="是否默认">
                    <el-switch v-model="form.is_default" />
                </el-form-item>
            </el-form>

            <template #footer>
                <el-button @click="dialogVisible = false">取消</el-button>
                <el-button type="primary" @click="handleSubmit">
                    确定
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>

<style scoped>
.template-view {
    padding: 20px;
}

.header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
}

.header h2 {
    margin: 0;
}

.template-name {
    display: flex;
    align-items: center;
    gap: 8px;
}

.template-content {
    color: #606266;
    font-size: 14px;
}

.template-variables {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.operation-buttons {
    display: flex;
    gap: 12px;
}
</style> 