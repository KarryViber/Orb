<template>
  <div class="user-group-view">
    <!-- 工具栏 -->
    <data-table-toolbar
      v-model:search="searchKeyword"
      v-model:platform="selectedPlatform"
      :search-placeholder="t('userGroup.searchPlaceholder')"
      :create-button-text="t('userGroup.create')"
      :show-tag-select="false"
      :tag-options="[]"
      @search="handleSearch"
      @create="handleCreate"
    />

    <!-- 用户组列表 -->
    <data-table
      :data="groupList"
      :loading="loading"
      :total="total"
      :current-page="currentPage"
      :page-size="pageSize"
      @size-change="handleSizeChange"
      @current-change="handleCurrentChange"
      @edit="handleEdit"
      @delete="handleDelete"
    >
      <el-table-column prop="name" label="用户组名称" min-width="200" />
      
      <el-table-column prop="description" label="描述" show-overflow-tooltip />
      
      <el-table-column label="平台" width="120">
        <template #default="{ row }">
          <el-tag :type="getPlatformTagType(row.platform)">
            {{ row.platform }}
          </el-tag>
        </template>
      </el-table-column>
      
      <el-table-column prop="user_count" label="用户数" width="120" />
      
      <el-table-column prop="created_at" label="创建时间" width="180">
        <template #default="{ row }">
          {{ formatDate(row.created_at) }}
        </template>
      </el-table-column>

      <template #additional-actions="{ row }">
        <el-button type="primary" link @click="handleManageUsers(row)">
          管理用户
        </el-button>
      </template>
    </data-table>

    <!-- 添加/编辑用户组对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="500px"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
      >
        <el-form-item label="组名称" prop="name">
          <el-input v-model="form.name" />
        </el-form-item>
        
        <el-form-item label="描述" prop="description">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="3"
          />
        </el-form-item>
        
        <el-form-item label="平台" prop="platform">
          <el-select v-model="form.platform" style="width: 100%">
            <el-option label="Instagram" :value="Platform.INSTAGRAM" />
            <el-option label="Twitter" :value="Platform.TWITTER" />
            <el-option label="Facebook" :value="Platform.FACEBOOK" />
          </el-select>
        </el-form-item>
      </el-form>
      
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 管理用户对话框 -->
    <el-dialog
      v-model="manageUsersDialogVisible"
      :title="`管理用户 - ${selectedGroup?.name}`"
      width="800px"
    >
      <div class="dialog-content">
        <!-- 搜索和添加用户 -->
        <div class="add-users-section">
          <el-input
            v-model="userSearchKeyword"
            placeholder="搜索用户..."
            clearable
            @input="handleSearchUsers"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          
          <el-table
            v-if="searchResults.length"
            :data="searchResults"
            style="width: 100%; margin-top: 16px;"
            height="200"
          >
            <el-table-column type="selection" width="55" />
            <el-table-column prop="username" label="用户名" />
            <el-table-column prop="display_name" label="显示名称" />
            <el-table-column prop="platform" label="平台" width="100" />
          </el-table>
          
          <div class="text-right" style="margin-top: 16px;">
            <el-button
              type="primary"
              :disabled="!selectedUsers.length"
              @click="handleAddUsers"
            >
              添加选中用户
            </el-button>
          </div>
        </div>

        <!-- 当前用户列表 -->
        <div class="current-users-section">
          <h3>当前用户</h3>
          <el-table
            :data="groupUsers"
            style="width: 100%"
            height="300"
          >
            <el-table-column prop="username" label="用户名" />
            <el-table-column prop="display_name" label="显示名称" />
            <el-table-column prop="platform" label="平台" width="100" />
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button
                  type="danger"
                  link
                  @click="handleRemoveUser(row)"
                >
                  移除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Search, Plus } from '@element-plus/icons-vue'
import DataTableToolbar from '@/components/common/DataTableToolbar.vue'
import DataTable from '@/components/common/DataTable.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance } from 'element-plus'
import type { UserResponse } from '@/types/user'
import type { UserGroupResponse, UserGroupSearchParams } from '@/types/userGroup'
import { Platform } from '@/types/common'
import { getUserGroups, createUserGroup, updateUserGroup, deleteUserGroup, addUsersToGroup, getGroupUsers, removeUsersFromGroup } from '@/api/userGroups'
import { searchUsers } from '@/api/users'
import { formatDate } from '@/utils/date'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// 搜索条件
const searchKeyword = ref('')
const selectedPlatform = ref<Platform | ''>('')

// 表格数据
const loading = ref(false)
const groupList = ref<UserGroupResponse[]>([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

// 表单
const dialogVisible = ref(false)
const dialogTitle = ref('')
const formRef = ref<FormInstance>()
const form = ref({
  id: 0,
  name: '',
  description: '',
  platform: Platform.INSTAGRAM
})

// 表单验证规则
const rules = {
  name: [
    { required: true, message: '请输入用户组名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  platform: [
    { required: true, message: '请选择平台', trigger: 'change' }
  ]
}

// 用户选择相关
const manageUsersDialogVisible = ref(false)
const selectedGroup = ref<UserGroupResponse | null>(null)
const groupUsers = ref<UserResponse[]>([])
const selectedUsers = ref<UserResponse[]>([])
const userSearchKeyword = ref('')
const searchResults = ref<UserResponse[]>([])

// 加载用户组列表
const loadGroups = async () => {
  loading.value = true
  try {
    const params: UserGroupSearchParams = {
      keyword: searchKeyword.value,
      platform: selectedPlatform.value || undefined,
      page: currentPage.value,
      pageSize: pageSize.value
    }

    const response = await getUserGroups(params)
    
    if (response.code !== 200 || !response.data) {
      ElMessage.error(response.message || '加载用户组列表失败')
      groupList.value = []
      total.value = 0
      return
    }

    groupList.value = response.data.items
    total.value = response.data.total
    currentPage.value = response.data.page
    pageSize.value = response.data.pageSize
    
  } catch (error) {
    console.error('加载用户组列表失败:', error)
    ElMessage.error('加载用户组列表失败')
    groupList.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

// 搜索
const handleSearch = () => {
  currentPage.value = 1
  loadGroups()
}

// 分页
const handleSizeChange = (val: number) => {
  pageSize.value = val
  currentPage.value = 1
  loadGroups()
}

const handleCurrentChange = (val: number) => {
  currentPage.value = val
  loadGroups()
}

// 创建用户组
const handleCreate = () => {
  dialogTitle.value = '创建用户组'
  form.value = {
    id: 0,
    name: '',
    description: '',
    platform: Platform.INSTAGRAM
  }
  dialogVisible.value = true
}

// 编辑用户组
const handleEdit = (row: UserGroupResponse) => {
  dialogTitle.value = '编辑用户组'
  form.value = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    platform: row.platform
  }
  dialogVisible.value = true
}

// 删除用户组
const handleDelete = async (row: UserGroupResponse) => {
  try {
    await ElMessageBox.confirm(
      '确定要删除该用户组吗？删除后无法恢复。',
      '删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    await deleteUserGroup(row.id)
    ElMessage.success('删除成功')
    loadGroups()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除用户组失败:', error)
      ElMessage.error('删除用户组失败')
    }
  }
}

// 提交表单
const handleSubmit = async () => {
  if (!formRef.value) return
  
  try {
    await formRef.value.validate()
    
    const groupData = {
      name: form.value.name,
      description: form.value.description,
      platform: form.value.platform
    }

    console.log('准备提交用户组数据:', groupData)
    
    if (form.value.id) {
      await updateUserGroup(form.value.id, groupData)
      ElMessage.success('更新成功')
    } else {
      const result = await createUserGroup(groupData)
      console.log('创建用户组结果:', result)
      ElMessage.success('创建成功')
    }
    
    dialogVisible.value = false
    // 等待一小段时间再刷新列表，确保后端数据已更新
    setTimeout(() => {
      loadGroups()
    }, 100)
  } catch (error) {
    console.error('保存用户组失败:', error)
    ElMessage.error('保存用户组失败')
  }
}

// 管理用户
const handleManageUsers = async (row: UserGroupResponse) => {
  selectedGroup.value = row
  manageUsersDialogVisible.value = true
  
  try {
    await loadGroupUsers(row.id)
  } catch (error) {
    console.error('加载用户数据失败:', error)
    ElMessage.error('加载用户数据失败')
  }
}

// 加载用户组用户
const loadGroupUsers = async (groupId: number) => {
  try {
    const response = await getGroupUsers(groupId)
    if (response.code === 200 && response.data) {
      groupUsers.value = 'items' in response.data ? response.data.items : []
    } else {
      ElMessage.error(response.message || '加载用户组用户失败')
      groupUsers.value = []
    }
  } catch (error) {
    console.error('加载用户组用户失败:', error)
    ElMessage.error('加载用户组用户失败')
    groupUsers.value = []
  }
}

// 处理搜索用户
const handleSearchUsers = async (query: string) => {
  if (!query) {
    searchResults.value = []
    return
  }
  
  try {
    const response = await searchUsers({
      keyword: query,
      page: 1,
      pageSize: 10
    })
    if (response && response.data && 'items' in response.data) {
      searchResults.value = response.data.items as UserResponse[]
    }
  } catch (error) {
    console.error('搜索用户失败:', error)
    ElMessage.error('搜索用户失败')
  }
}

// 添加用户到组
const handleAddUsers = async () => {
  if (!selectedUsers.value.length) return
  
  try {
    await addUsersToGroup(selectedGroup.value!.id, selectedUsers.value.map(user => user.id))
    ElMessage.success('添加成功')
    
    // 刷新用户列表
    handleManageUsers(selectedGroup.value!)
    
    // 清空选择
    selectedUsers.value = []
  } catch (error) {
    console.error('添加用户失败:', error)
    ElMessage.error('添加用户失败')
  }
}

// 从组中移除用户
const handleRemoveUser = async (user: UserResponse) => {
  try {
    await removeUsersFromGroup(selectedGroup.value!.id, [user.id])
    ElMessage.success('移除成功')
    loadGroupUsers(selectedGroup.value!.id)
  } catch (error) {
    console.error('移除用户失败:', error)
    ElMessage.error('移除用户失败')
  }
}

// 辅助方法
const getPlatformTagType = (platform: string) => {
  const map: Record<string, string> = {
    instagram: 'danger',
    twitter: 'primary',
    facebook: 'success'
  }
  return map[platform] || 'info'
}

// 初始化
onMounted(() => {
  loadGroups()
})
</script>

<style scoped>
.user-group-view {
  padding: 20px;
}

.dialog-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.text-right {
  text-align: right;
}
</style>