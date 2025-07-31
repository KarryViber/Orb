<template>
  <div class="users-container">
    <!-- 搜索和过滤 -->
    <el-card class="filter-card">
      <el-form :inline="true" :model="searchForm">
        <el-form-item label="平台">
          <el-select v-model="searchForm.platform" placeholder="选择平台">
            <el-option label="Twitter" value="twitter" />
            <el-option label="Instagram" value="instagram" />
            <el-option label="Facebook" value="facebook" />
            <el-option label="LinkedIn" value="linkedin" />
          </el-select>
        </el-form-item>
        
        <el-form-item label="关键词">
          <el-input v-model="searchForm.keyword" placeholder="用户名/昵称" />
        </el-form-item>
        
        <el-form-item label="标签">
          <el-select
            v-model="searchForm.tags"
            multiple
            collapse-tags
            placeholder="选择标签"
          >
            <el-option
              v-for="tag in tagOptions"
              :key="tag.value"
              :label="tag.label"
              :value="tag.value"
            />
          </el-select>
        </el-form-item>
        
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>搜索
          </el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 用户列表 -->
    <el-card class="list-card">
      <template #header>
        <div class="card-header">
          <span>用户列表</span>
          <div class="header-actions">
            <el-button type="success" @click="handleExport">
              <el-icon><Download /></el-icon>导出
            </el-button>
            <el-button type="primary" @click="handleBatchMessage">
              <el-icon><Message /></el-icon>批量私信
            </el-button>
          </div>
        </div>
      </template>

      <el-table
        v-loading="loading"
        :data="userList"
        style="width: 100%"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="55" />
        <el-table-column prop="username" label="用户名" />
        <el-table-column prop="displayName" label="显示名称" />
        <el-table-column prop="platform" label="平台">
          <template #default="{ row }">
            <el-tag :type="getPlatformTagType(row.platform)">
              {{ row.platform }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="tags" label="标签">
          <template #default="{ row }">
            <el-tag
              v-for="tag in row.tags"
              :key="tag"
              size="small"
              class="mx-1"
            >
              {{ tag }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="添加时间" width="180" />
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button-group>
              <el-button size="small" @click="handleEdit(row)">
                编辑
              </el-button>
              <el-button
                size="small"
                type="primary"
                @click="handleMessage(row)"
              >
                私信
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

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Search, Download, Message } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import userService from '../services/users'
import type { User, UserSearchParams } from '../services/users'

// 搜索表单
const searchForm = ref({
  platform: '',
  keyword: '',
  tags: []
})

// 标签选项
const tagOptions = ref([
  { label: '潜在客户', value: 'potential' },
  { label: '活跃用户', value: 'active' },
  { label: '已转化', value: 'converted' },
  { label: '高价值', value: 'high-value' }
])

// 表格数据
const loading = ref(false)
const userList = ref<User[]>([])

// 分页
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

// 选中的用户
const selectedUsers = ref<User[]>([])

// 加载用户数据
const loadUsers = async () => {
  loading.value = true
  try {
    const params: UserSearchParams = {
      platform: searchForm.value.platform || undefined,
      keyword: searchForm.value.keyword || undefined,
      tags: searchForm.value.tags.length > 0 ? searchForm.value.tags : undefined,
      skip: (currentPage.value - 1) * pageSize.value,
      limit: pageSize.value
    }
    const data = await userService.getUsers(params)
    userList.value = data
    total.value = data.length // 实际项目中应该从后端获取总数
  } catch (error) {
    ElMessage.error('加载用户数据失败')
    console.error('加载用户数据失败:', error)
  } finally {
    loading.value = false
  }
}

// 方法
const handleSearch = () => {
  currentPage.value = 1
  loadUsers()
}

const handleReset = () => {
  searchForm.value = {
    platform: '',
    keyword: '',
    tags: []
  }
  handleSearch()
}

const handleExport = () => {
  // TODO: 实现导出功能
  ElMessage.success('开始导出用户数据')
}

const handleBatchMessage = () => {
  if (selectedUsers.value.length === 0) {
    ElMessage.warning('请选择要发送私信的用户')
    return
  }
  // TODO: 实现批量发送私信逻辑
}

const handleSelectionChange = (selection: User[]) => {
  selectedUsers.value = selection
}

const handleEdit = (row: User) => {
  // TODO: 实现编辑用户逻辑
}

const handleMessage = (row: User) => {
  // TODO: 实现发送私信逻辑
}

const handleDelete = async (row: User) => {
  try {
    await ElMessageBox.confirm(
      '确定要删除该用户吗？',
      '警告',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    await userService.deleteUser(row.id)
    ElMessage.success('删除成功')
    loadUsers()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除用户失败')
      console.error('删除用户失败:', error)
    }
  }
}

const handleSizeChange = (val: number) => {
  pageSize.value = val
  loadUsers()
}

const handleCurrentChange = (val: number) => {
  currentPage.value = val
  loadUsers()
}

const getPlatformTagType = (platform: string) => {
  const types = {
    twitter: 'primary',
    instagram: 'success',
    facebook: 'info',
    linkedin: 'warning'
  }
  return types[platform as keyof typeof types] || 'info'
}

// 初始化
onMounted(() => {
  loadUsers()
})
</script>

<style lang="scss" scoped>
.users-container {
  .filter-card {
    margin-bottom: 20px;
  }
  
  .list-card {
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .header-actions {
      display: flex;
      gap: 10px;
    }
  }
  
  .pagination-container {
    margin-top: 20px;
    display: flex;
    justify-content: flex-end;
  }
  
  .el-tag {
    margin-right: 5px;
  }
}
</style> 