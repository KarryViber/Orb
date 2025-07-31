<template>
  <div class="templates-container">
    <!-- 模板列表 -->
    <el-card class="template-card">
      <template #header>
        <div class="card-header">
          <span>私信模板</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>新建模板
          </el-button>
        </div>
      </template>

      <el-table
        v-loading="loading"
        :data="templateList"
        style="width: 100%"
      >
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="模板名称" />
        <el-table-column prop="platform" label="适用平台" width="120">
          <template #default="{ row }">
            <el-tag :type="getPlatformTagType(row.platform)">
              {{ row.platform }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="usage" label="使用次数" width="100" />
        <el-table-column prop="successRate" label="成功率" width="120">
          <template #default="{ row }">
            <el-progress
              :percentage="row.successRate"
              :status="getSuccessStatus(row.successRate)"
            />
          </template>
        </el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" width="180" />
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button-group>
              <el-button
                size="small"
                @click="handlePreview(row)"
              >
                预览
              </el-button>
              <el-button
                size="small"
                type="primary"
                @click="handleEdit(row)"
              >
                编辑
              </el-button>
              <el-button
                size="small"
                type="danger"
                @click="handleDelete(row)"
              >
                删除
              </el-button>
            </el-button-group>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 模板编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑模板' : '新建模板'"
      width="800px"
    >
      <el-form
        ref="formRef"
        :model="templateForm"
        :rules="rules"
        label-width="100px"
      >
        <el-form-item label="模板名称" prop="name">
          <el-input v-model="templateForm.name" placeholder="请输入模板名称" />
        </el-form-item>
        
        <el-form-item label="适用平台" prop="platform">
          <el-select v-model="templateForm.platform" placeholder="选择平台">
            <el-option label="Twitter" value="twitter" />
            <el-option label="Instagram" value="instagram" />
            <el-option label="Facebook" value="facebook" />
            <el-option label="LinkedIn" value="linkedin" />
          </el-select>
        </el-form-item>
        
        <el-form-item label="模板内容" prop="content">
          <el-input
            v-model="templateForm.content"
            type="textarea"
            :rows="6"
            placeholder="请输入模板内容，支持变量: {username}, {nickname}, {platform}"
          />
        </el-form-item>
        
        <el-form-item label="变量说明">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="{username}">用户名</el-descriptions-item>
            <el-descriptions-item label="{nickname}">昵称</el-descriptions-item>
            <el-descriptions-item label="{platform}">平台名称</el-descriptions-item>
          </el-descriptions>
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

    <!-- 预览对话框 -->
    <el-dialog
      v-model="previewVisible"
      title="模板预览"
      width="500px"
    >
      <div class="preview-content">
        <h4>模板原文：</h4>
        <p>{{ previewData.template }}</p>
        
        <h4>预览效果：</h4>
        <p>{{ previewData.preview }}</p>
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
import { ref } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

// 模板列表数据
const loading = ref(false)
const templateList = ref([
  {
    id: 1,
    name: '欢迎模板',
    platform: 'twitter',
    usage: 1234,
    successRate: 95,
    updatedAt: '2023-11-20 10:00:00',
    content: '你好 {username}，很高兴在 {platform} 上遇见你！'
  },
  // 更多模拟数据...
])

// 编辑表单
const dialogVisible = ref(false)
const isEdit = ref(false)
const formRef = ref<FormInstance>()
const templateForm = ref({
  name: '',
  platform: '',
  content: ''
})

// 表单校验规则
const rules = ref<FormRules>({
  name: [
    { required: true, message: '请输入模板名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  platform: [
    { required: true, message: '请选择适用平台', trigger: 'change' }
  ],
  content: [
    { required: true, message: '请输入模板内容', trigger: 'blur' },
    { min: 10, max: 500, message: '长度在 10 到 500 个字符', trigger: 'blur' }
  ]
})

// 预览数据
const previewVisible = ref(false)
const previewData = ref({
  template: '',
  preview: ''
})

// 方法
const handleCreate = () => {
  isEdit.value = false
  dialogVisible.value = true
  templateForm.value = {
    name: '',
    platform: '',
    content: ''
  }
}

const handleEdit = (row) => {
  isEdit.value = true
  dialogVisible.value = true
  templateForm.value = {
    ...row
  }
}

const handlePreview = (row) => {
  previewVisible.value = true
  previewData.value = {
    template: row.content,
    preview: row.content
      .replace('{username}', 'example_user')
      .replace('{nickname}', 'Example User')
      .replace('{platform}', row.platform)
  }
}

const handleSubmit = async () => {
  if (!formRef.value) return
  
  await formRef.value.validate((valid, fields) => {
    if (valid) {
      // TODO: 实现保存模板逻辑
      ElMessage.success(isEdit.value ? '更新成功' : '创建成功')
      dialogVisible.value = false
    }
  })
}

const handleDelete = (row) => {
  ElMessageBox.confirm(
    '确定要删除该模板吗？',
    '警告',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }
  ).then(() => {
    // TODO: 实现删除模板逻辑
    ElMessage.success('删除成功')
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

const getSuccessStatus = (rate: number) => {
  if (rate >= 90) return 'success'
  if (rate >= 70) return 'warning'
  return 'exception'
}
</script>

<style lang="scss" scoped>
.templates-container {
  .template-card {
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  }
  
  .preview-content {
    h4 {
      margin: 10px 0;
      color: #606266;
    }
    
    p {
      margin: 10px 0;
      padding: 10px;
      background-color: #f5f7fa;
      border-radius: 4px;
      color: #303133;
    }
  }
  
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
}
</style> 