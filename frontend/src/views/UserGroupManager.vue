<template>
  <div class="user-group-manager">
    <!-- 工具栏 -->
    <div class="toolbar">
      <el-button type="primary" @click="handleCreateGroup">
        创建用户组
      </el-button>
      <el-input
        v-model="groupSearch.keyword"
        placeholder="搜索用户组名称"
        style="width: 200px; margin-left: 16px"
        clearable
        @clear="handleGroupSearch"
        @keyup.enter="handleGroupSearch"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select
        v-model="groupSearch.platform"
        placeholder="选择平台"
        clearable
        style="width: 150px; margin-left: 16px"
        @change="handleGroupSearch"
      >
        <el-option
          v-for="platform in platformOptions"
          :key="platform.value"
          :label="platform.label"
          :value="platform.value"
        />
      </el-select>
    </div>

    <!-- 用户组列表 -->
    <el-table
      v-loading="groupLoading"
      :data="groupList"
      style="width: 100%; margin-top: 16px"
    >
      <el-table-column prop="name" label="用户组名称" min-width="120" />
      <el-table-column prop="description" label="描述" min-width="200" />
      <el-table-column label="平台" width="120">
        <template #default="{ row }">
          <el-tag :type="getPlatformTagType(row.platform)">
            {{ row.platform }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="user_count" label="用户数量" width="100" align="center" />
      <el-table-column prop="created_at" label="创建时间" width="180">
        <template #default="{ row }">
          {{ formatDate(row.created_at) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link @click="handleEditGroup(row)">
            编辑
          </el-button>
          <el-button type="success" link @click="handleManageUsers(row)">
            管理用户
          </el-button>
          <el-button type="danger" link @click="handleDeleteGroup(row)">
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <div class="pagination" v-if="groupTotal > 0">
      <el-pagination
        v-model:current-page="groupCurrentPage"
        v-model:page-size="groupPageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="groupTotal"
        layout="total, sizes, prev, pager, next"
        @size-change="handleGroupSizeChange"
        @current-change="handleGroupPageChange"
      />
    </div>

    <!-- 用户组表单对话框 -->
    <el-dialog
      v-model="groupDialog.visible"
      :title="groupDialog.title"
      width="500px"
    >
      <el-form
        ref="groupFormRef"
        :model="groupForm"
        :rules="groupRules"
        label-width="100px"
      >
        <el-form-item label="组名称" prop="name">
          <el-input v-model="groupForm.name" />
        </el-form-item>
        
        <el-form-item label="描述" prop="description">
          <el-input
            v-model="groupForm.description"
            type="textarea"
            :rows="3"
          />
        </el-form-item>
        
        <el-form-item label="平台" prop="platform">
          <el-select v-model="groupForm.platform" style="width: 100%">
            <el-option
              v-for="platform in platformOptions"
              :key="platform.value"
              :label="platform.label"
              :value="platform.value"
            />
          </el-select>
        </el-form-item>
      </el-form>
      
      <template #footer>
        <el-button @click="groupDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="handleGroupSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 管理用户对话框 -->
    <el-dialog
      v-model="manageUsersDialog.visible"
      :title="'管理用户 - ' + manageUsersDialog.groupName"
      width="800px"
    >
      <div class="manage-users-content">
        <!-- 用户搜索 -->
        <el-input
          v-model="userSearchKeyword"
          placeholder="搜索用户"
          style="width: 300px; margin-bottom: 16px"
          clearable
          @clear="handleUserSearch"
          @keyup.enter="handleUserSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <!-- 用户列表 -->
        <el-table
          :data="userSearchResults"
          style="width: 100%"
          v-loading="userSearchLoading"
        >
          <el-table-column prop="username" label="用户名" />
          <el-table-column prop="display_name" label="显示名称" />
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button
                type="primary"
                link
                @click="handleAddUserToGroup(row)"
              >
                添加到组
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import type { FormInstance } from 'element-plus'
import { Platform } from '@/types/common'
import { getUserGroups, createUserGroup, updateUserGroup, deleteUserGroup, addUsersToGroup } from '@/api/userGroups'
import type { UserGroupResponse } from '@/api/userGroups'
import { searchUsers } from '@/api/users'
import type { UserResponse } from '@/api/users'
import { formatDate } from '@/utils/date'

// 用户组列表状态
const groupList = ref<UserGroupResponse[]>([])
const groupLoading = ref(false)
const groupTotal = ref(0)
const groupCurrentPage = ref(1)
const groupPageSize = ref(10)
const groupSearch = ref({
  keyword: '',
  platform: undefined as Platform | undefined
})

// 用户组表单对话框
const groupDialog = ref({
  visible: false,
  title: '',
  isEdit: false
})

const groupForm = ref({
  id: 0,
  name: '',
  description: '',
  platform: ''
})

const groupFormRef = ref<FormInstance>()

const groupRules = {
  name: [
    { required: true, message: '请输入组名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  platform: [
    { required: true, message: '请选择平台', trigger: 'change' }
  ]
}

// 管理用户对话框
const manageUsersDialog = ref({
  visible: false,
  groupId: 0,
  groupName: ''
})

const userSearchKeyword = ref('')
const userSearchResults = ref<UserResponse[]>([])
const userSearchLoading = ref(false)

// Platform选项
const platformOptions = [
  { value: Platform.INSTAGRAM, label: 'Instagram' },
  { value: Platform.TWITTER, label: 'Twitter' },
  { value: Platform.FACEBOOK, label: 'Facebook' }
]

// 加载用户组列表
const loadGroups = async () => {
  console.log('[loadGroups] 开始加载用户组列表')
  groupLoading.value = true
  try {
    const params = {
      keyword: groupSearch.value.keyword || undefined,
      platform: groupSearch.value.platform,
      page: groupCurrentPage.value,
      pageSize: groupPageSize.value
    }

    console.log('[loadGroups] 请求参数:', params)
    const response = await getUserGroups(params)
    console.log('[loadGroups] API响应:', response)

    if (response && Array.isArray(response.items)) {
      console.log('[loadGroups] 设置列表数据前:', {
        currentList: groupList.value,
        newItems: response.items
      })
      
      // 确保每个项都符合 UserGroupResponse 类型
      const validItems = response.items.map(item => ({
        id: item.id,
        name: item.name,
        description: item.description || '',
        platform: item.platform,
        user_count: item.user_count,
        created_by: item.created_by,
        created_at: item.created_at,
        updated_at: item.updated_at
      }))
      
      // 使用解构赋值更新列表
      groupList.value = [...validItems]
      groupTotal.value = response.total
      groupCurrentPage.value = response.page
      groupPageSize.value = response.page_size
      
      console.log('[loadGroups] 设置列表数据后:', {
        list: groupList.value,
        listLength: groupList.value.length,
        total: groupTotal.value,
        page: groupCurrentPage.value,
        pageSize: groupPageSize.value
      })
    } else {
      console.error('[loadGroups] API响应格式错误:', response)
      groupList.value = []
      groupTotal.value = 0
    }
  } catch (error) {
    console.error('[loadGroups] 加载失败:', error)
    ElMessage.error('加载用户组列表失败')
    groupList.value = []
    groupTotal.value = 0
  } finally {
    groupLoading.value = false
    console.log('[loadGroups] 加载完成，当前列表数据:', {
      list: groupList.value,
      length: groupList.value.length
    })
  }
}

// 搜索用户组
const handleGroupSearch = () => {
  groupCurrentPage.value = 1
  loadGroups()
}

// 创建用户组
const handleCreateGroup = () => {
  groupDialog.value = {
    visible: true,
    title: '创建用户组',
    isEdit: false
  }
  groupForm.value = {
    id: 0,
    name: '',
    description: '',
    platform: ''
  }
}

// 编辑用户组
const handleEditGroup = (group: any) => {
  groupDialog.value = {
    visible: true,
    title: '编辑用户组',
    isEdit: true
  }
  groupForm.value = {
    id: group.id,
    name: group.name,
    description: group.description || '',
    platform: group.platform
  }
}

// 删除用户组
const handleDeleteGroup = async (group: any) => {
  try {
    await ElMessageBox.confirm(
      '确定要删除这个用户组吗？删除后无法恢复。',
      '提示',
      {
        type: 'warning'
      }
    )
    await deleteUserGroup(group.id)
    ElMessage.success('删除成功')
    loadGroups()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除用户组失败:', error)
      ElMessage.error('删除用户组失败')
    }
  }
}

// 提交用户组表单
const handleGroupSubmit = async () => {
  if (!groupFormRef.value) return
  
  try {
    await groupFormRef.value.validate()
    if (groupDialog.value.isEdit) {
      await updateUserGroup(groupForm.value.id, {
        name: groupForm.value.name,
        description: groupForm.value.description,
        platform: groupForm.value.platform as Platform
      })
      ElMessage.success('更新成功')
    } else {
      await createUserGroup({
        name: groupForm.value.name,
        description: groupForm.value.description,
        platform: groupForm.value.platform as Platform
      })
      ElMessage.success('创建成功')
    }
    groupDialog.value.visible = false
    loadGroups()
  } catch (error) {
    console.error('保存用户组失败:', error)
    ElMessage.error('保存用户组失败')
  }
}

// 管理用户
const handleManageUsers = (group: any) => {
  manageUsersDialog.value = {
    visible: true,
    groupId: group.id,
    groupName: group.name
  }
  userSearchKeyword.value = ''
  userSearchResults.value = []
}

// 搜索用户
const handleUserSearch = async () => {
  if (!userSearchKeyword.value) {
    userSearchResults.value = []
    return
  }

  userSearchLoading.value = true
  try {
    const response = await searchUsers({ keyword: userSearchKeyword.value })
    userSearchResults.value = response.items || []
  } catch (error) {
    console.error('搜索用户失败:', error)
    ElMessage.error('搜索用户失败')
  } finally {
    userSearchLoading.value = false
  }
}

// 添加用户到组
const handleAddUserToGroup = async (user: UserResponse) => {
  try {
    await addUsersToGroup(manageUsersDialog.value.groupId, [user.id])
    ElMessage.success('添加用户成功')
    // 刷新用户组列表
    loadGroups()
  } catch (error) {
    console.error('添加用户到组失败:', error)
    ElMessage.error('添加用户到组失败')
  }
}

// 获取平台标签类型
const getPlatformTagType = (platform: Platform) => {
  const typeMap: Record<Platform, string> = {
    [Platform.INSTAGRAM]: 'success',
    [Platform.TWITTER]: 'primary',
    [Platform.FACEBOOK]: 'warning',
    [Platform.TIKTOK]: 'danger',
    [Platform.YOUTUBE]: 'info',
    [Platform.LINKEDIN]: ''
  }
  return typeMap[platform] || 'info'
}

// 页码变化处理
const handleGroupPageChange = (page: number) => {
  groupCurrentPage.value = page
  loadGroups()
}

// 每页条数变化处理
const handleGroupSizeChange = (size: number) => {
  groupPageSize.value = size
  groupCurrentPage.value = 1
  loadGroups()
}

// 组件挂载时加载数据
onMounted(() => {
  loadGroups()
})
</script>

<style scoped>
.user-group-manager {
  padding: 20px;
}

.toolbar {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
}

.pagination {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}

.manage-users-content {
  padding: 16px;
}
</style> 