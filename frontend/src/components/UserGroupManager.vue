<template>
  <div class="user-group-manager">
    <!-- 工具栏 -->
    <div class="toolbar">
      <el-button type="primary" @click="handleCreateGroup">
        {{ t('userGroup.createGroup') }}
      </el-button>
      <el-input
        v-model="groupSearch.keyword"
        :placeholder="t('userGroup.searchGroupPlaceholder')"
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
        :placeholder="t('userGroup.selectPlatform')"
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
      <el-table-column prop="name" :label="t('userGroup.groupName')" min-width="150" />
      <el-table-column prop="description" :label="t('userGroup.description')" min-width="150" show-overflow-tooltip />
      <el-table-column :label="t('common.platform')" width="180">
        <template #default="{ row }">
          <el-tag :type="getPlatformTagType(row.platform)">
            {{ row.platform }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="user_count" :label="t('userGroup.userCount')" width="120" align="center" />
      <el-table-column prop="created_at" :label="t('common.createTime')" width="200">
        <template #default="{ row }">
          {{ formatDate(row.created_at) }}
        </template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="280" fixed="right">
        <template #default="{ row }">
          <div class="operation-tags">
            <el-tag
              type="primary"
              class="operation-tag"
              effect="plain"
              @click="handleEditGroup(row)"
            >
              <el-icon><Edit /></el-icon>
              {{ t('common.edit') }}
            </el-tag>
            <el-tag
              type="success"
              class="operation-tag"
              effect="plain"
              @click="handleManageUsers(row)"
            >
              <el-icon><User /></el-icon>
              {{ t('userGroup.manageUsers') }}
            </el-tag>
            <el-tag
              type="danger"
              class="operation-tag"
              effect="plain"
              @click="handleDeleteGroup(row.id)"
            >
              <el-icon><Delete /></el-icon>
              {{ t('common.delete') }}
            </el-tag>
          </div>
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
        <el-form-item :label="t('userGroup.groupName')" prop="name">
          <el-input 
            v-model="groupForm.name"
            :placeholder="t('userGroup.form.namePlaceholder')"
          />
        </el-form-item>
        
        <el-form-item :label="t('userGroup.description')" prop="description">
          <el-input
            v-model="groupForm.description"
            type="textarea"
            :rows="3"
            :placeholder="t('userGroup.form.descriptionPlaceholder')"
          />
        </el-form-item>
        
        <el-form-item :label="t('common.platform')" prop="platform">
          <el-select 
            v-model="groupForm.platform" 
            :placeholder="t('userGroup.form.platformPlaceholder')"
            style="width: 100%"
          >
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
        <el-button @click="groupDialog.visible = false">
          {{ t('common.cancel') }}
        </el-button>
        <el-button type="primary" @click="handleGroupSubmit">
          {{ t('common.submit') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 管理用户对话框 -->
    <el-dialog
      v-model="manageUsersDialog.visible"
      :title="t('userGroup.manageUsers') + ' - ' + manageUsersDialog.groupName"
      width="800px"
    >
      <div class="manage-users-content">
        <!-- 当前用户列表 -->
        <div class="current-users-section">
          <h3>{{ t('userGroup.currentUsers') }}</h3>
          <el-table
            :data="manageUsersDialog.groupUsers"
            style="width: 100%"
            v-loading="manageUsersDialog.loading"
          >
            <el-table-column prop="username" :label="t('user.userName')" />
            <el-table-column prop="display_name" :label="t('user.displayName')" />
            <el-table-column :label="t('common.actions')" width="120">
              <template #default="{ row }">
                <el-button
                  type="danger"
                  link
                  @click="handleRemoveUserFromGroup(row)"
                >
                  {{ t('userGroup.removeFromGroup') }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 搜索和添加用户 -->
        <div class="add-users-section">
          <h3>{{ t('userGroup.addUsers') }}</h3>
          <el-input
            v-model="userSearchKeyword"
            :placeholder="t('userGroup.searchUsers')"
            style="width: 300px; margin-bottom: 16px"
            clearable
            @clear="handleUserSearch"
            @keyup.enter="handleUserSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>

          <el-table
            :data="userSearchResults"
            style="width: 100%"
            v-loading="userSearchLoading"
          >
            <el-table-column prop="username" :label="t('user.userName')" />
            <el-table-column prop="display_name" :label="t('user.displayName')" />
            <el-table-column :label="t('common.actions')" width="120">
              <template #default="{ row }">
                <el-button
                  type="primary"
                  link
                  @click="handleAddUserToGroup(row)"
                >
                  {{ t('userGroup.addToGroup') }}
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
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Edit, User, Delete } from '@element-plus/icons-vue'
import type { FormInstance } from 'element-plus'
import { Platform } from '@/types/common'
import { getUserGroups, createUserGroup, updateUserGroup, deleteUserGroup, addUsersToGroup, getGroupUsers, removeUsersFromGroup } from '@/api/userGroups'
import type { UserGroupResponse, UserGroupCreate, UserGroupListResponse, UserGroupApiResponse } from '@/types/userGroup'
import { searchUsers } from '@/api/users'
import type { UserResponse } from '@/types/user'
import { formatDate } from '@/utils/date'
import { useI18n } from 'vue-i18n'
import type { ApiResponse, UserGroupSearchParams } from '@/types/api'

const { t } = useI18n()

// Props和Emits
const props = defineProps<{
    selectedUsers?: UserResponse[]
}>()

const emit = defineEmits<{
    (e: 'close'): void
    (e: 'success'): void
}>()

// 用户组列表状态
const groupList = ref<UserGroupResponse[]>([])
const groupLoading = ref(false)
const groupTotal = ref(0)
const groupCurrentPage = ref(1)
const groupPageSize = ref(10)
const selectedGroup = ref<UserGroupResponse | null>(null)

// 搜索参数
const groupSearch = ref<{
    keyword: string
    platform: Platform | undefined
}>({
    keyword: '',
    platform: undefined
})

// 用户组表单对话框
const groupDialog = ref({
    visible: false,
    title: '',
    isEdit: false
})

const groupForm = ref<UserGroupCreate>({
    name: '',
    description: '',
    platform: Platform.INSTAGRAM
})

const groupFormRef = ref<FormInstance>()

const groupRules = {
    name: [
        { required: true, message: t('userGroup.form.nameRule'), trigger: 'blur' },
        { min: 2, max: 50, message: t('common.lengthLimit', { min: 2, max: 50 }), trigger: 'blur' }
    ],
    platform: [
        { required: true, message: t('userGroup.form.platformRule'), trigger: 'change' }
    ]
}

// 管理用户对话框
const manageUsersDialog = ref({
    visible: false,
    loading: false,
    groupId: 0,
    groupName: '',
    groupUsers: [] as UserResponse[]
})

const userSearchKeyword = ref('')
const userSearchResults = ref<UserResponse[]>([])
const userSearchLoading = ref(false)

// Platform选项
const platformOptions = [
    { value: Platform.TWITTER, label: 'Twitter' },
    { value: Platform.FACEBOOK, label: 'Facebook' },
    { value: Platform.INSTAGRAM, label: 'Instagram' }
]

// 获取用户组列表
const fetchUserGroups = async () => {
    try {
        groupLoading.value = true
        const params: UserGroupSearchParams = {
            keyword: groupSearch.value.keyword,
            platform: groupSearch.value.platform,
            page: groupCurrentPage.value,
            page_size: groupPageSize.value
        }
        const response = await getUserGroups(params)
        console.log('User groups response:', response)
        
        if (response.code === 200) {
            if (Array.isArray(response.data)) {
                groupList.value = response.data
                groupTotal.value = response.data.length
            } else if (response.data && typeof response.data === 'object' && 'items' in response.data) {
                groupList.value = response.data.items
                groupTotal.value = response.data.total
            } else {
                groupList.value = []
                groupTotal.value = 0
            }
        } else {
            groupList.value = []
            groupTotal.value = 0
            console.warn('No data received from API')
        }
    } catch (error) {
        console.error('获取用户组列表失败:', error)
        ElMessage.error(t('userGroup.fetchError'))
        groupList.value = []
        groupTotal.value = 0
    } finally {
        groupLoading.value = false
    }
}

// 搜索处理
const handleGroupSearch = () => {
    groupCurrentPage.value = 1
    fetchUserGroups()
}

// 分页处理
const handleGroupSizeChange = (val: number) => {
    groupPageSize.value = val
    fetchUserGroups()
}

const handleGroupPageChange = (val: number) => {
    groupCurrentPage.value = val
    fetchUserGroups()
}

// 组件挂载时获取数据
onMounted(() => {
    fetchUserGroups()
})

// 创建用户组
const handleCreateGroup = () => {
    groupDialog.value = {
        visible: true,
        title: t('userGroup.createGroup'),
        isEdit: false
    }
    groupForm.value = {
        name: '',
        description: '',
        platform: Platform.INSTAGRAM
    }
}

// 编辑用户组
const handleEditGroup = (group: UserGroupResponse) => {
    groupDialog.value = {
        visible: true,
        title: t('userGroup.editGroup'),
        isEdit: true
    }
    groupForm.value = {
        name: group.name,
        description: group.description || '',
        platform: group.platform || Platform.INSTAGRAM
    }
}

// 删除用户组
const handleDeleteGroup = async (id: number) => {
    try {
        await ElMessageBox.confirm(
            t('userGroup.deleteConfirm'),
            t('common.warning'),
            {
                confirmButtonText: t('common.confirm'),
                cancelButtonText: t('common.cancel'),
                type: 'warning'
            }
        )
        
        await deleteUserGroup(id)
        ElMessage.success(t('message.deleteSuccess'))
        fetchUserGroups()
    } catch (error) {
        if (error !== 'cancel') {
            console.error('删除用户组失败:', error)
            ElMessage.error(t('message.deleteFailed'))
        }
    }
}

// 提交用户组表单
const handleGroupSubmit = async () => {
    if (!groupFormRef.value) return
    
    try {
        await groupFormRef.value.validate()
        if (groupDialog.value.isEdit && selectedGroup.value) {
            await updateUserGroup(selectedGroup.value.id, {
                name: groupForm.value.name,
                description: groupForm.value.description,
                platform: groupForm.value.platform
            })
            ElMessage.success('更新成功')
        } else {
            await createUserGroup({
                name: groupForm.value.name,
                description: groupForm.value.description,
                platform: groupForm.value.platform
            })
            ElMessage.success('创建成功')
        }
        groupDialog.value.visible = false
        fetchUserGroups()
    } catch (error) {
        console.error('保存用户组失败:', error)
        ElMessage.error('保存用户组失败')
    }
}

// 管理用户
const handleManageUsers = async (group: UserGroupResponse) => {
    manageUsersDialog.value = {
        visible: true,
        loading: true,
        groupId: group.id,
        groupName: group.name,
        groupUsers: []
    }
    
    try {
        await loadGroupUsers(group.id)
    } catch (error) {
        console.error('加载用户组成员失败:', error)
        ElMessage.error('加载用户组成员失败')
    } finally {
        manageUsersDialog.value.loading = false
    }
}

// 从用户组移除用户
const handleRemoveUserFromGroup = async (user: UserResponse) => {
    try {
        await removeUsersFromGroup(manageUsersDialog.value.groupId, [user.id])
        ElMessage.success('移除成功')
        
        // 从列表中移除用户
        manageUsersDialog.value.groupUsers = manageUsersDialog.value.groupUsers.filter(
            u => u.id !== user.id
        )
        
        // 重新加载用户组列表
        fetchUserGroups()
    } catch (error) {
        console.error('移除用户失败:', error)
        ElMessage.error('移除用户失败')
    }
}

// 修改handleAddUserToGroup函数
const handleAddUserToGroup = async (users: UserResponse | UserResponse[]) => {
    if (!selectedGroup.value) {
        ElMessage.warning(t('userGroup.noGroupSelected'))
        return
    }
    
    try {
        const userList = Array.isArray(users) ? users : [users]
        await addUsersToGroup(
            selectedGroup.value.id,
            userList.map(u => u.id)
        )
        ElMessage.success(t('userGroup.addSuccess'))
        emit('success')
    } catch (error) {
        console.error('添加用户到用户组失败:', error)
        ElMessage.error(t('userGroup.addFailed'))
    }
}

// 添加批量添加用户的方法
const handleBatchAddUsers = async () => {
    if (!props.selectedUsers?.length) {
        ElMessage.warning(t('userGroup.noUsersSelected'))
        return
    }
    
    if (!selectedGroup.value) {
        ElMessage.warning(t('userGroup.noGroupSelected'))
        return
    }
    
    try {
        await ElMessageBox.confirm(
            t('userGroup.confirmAdd', {
                count: props.selectedUsers.length,
                groupName: selectedGroup.value.name
            }),
            t('common.confirm'),
            {
                confirmButtonText: t('common.confirm'),
                cancelButtonText: t('common.cancel'),
                type: 'warning'
            }
        )
        
        await handleAddUserToGroup(props.selectedUsers)
    } catch (error) {
        if (error !== 'cancel') {
            console.error('批量添加用户失败:', error)
            ElMessage.error(t('userGroup.addFailed'))
        }
    }
}

// 搜索用户
const handleUserSearch = async () => {
    if (!userSearchKeyword.value) {
        userSearchResults.value = []
        return
    }

    try {
        userSearchLoading.value = true
        const response = await searchUsers({ keyword: userSearchKeyword.value })
        console.log('Search users response:', response)
        
        if (response.code === 200) {
            userSearchResults.value = response.data
        } else {
            userSearchResults.value = []
            console.warn('No search results received from API')
        }
    } catch (error) {
        console.error('Failed to search users:', error)
        ElMessage.error(t('userGroup.error.searchUsersFailed'))
        userSearchResults.value = []
    } finally {
        userSearchLoading.value = false
    }
}

// 选择用户组
const handleSelectGroup = (group: UserGroupResponse) => {
    selectedGroup.value = group
}

// 获取平台标签类型
const getPlatformTagType = (platform: Platform) => {
    const typeMap: Record<Platform, string> = {
        [Platform.TWITTER]: 'primary',
        [Platform.FACEBOOK]: 'success',
        [Platform.INSTAGRAM]: 'warning',
        [Platform.TIKTOK]: 'danger',
        [Platform.YOUTUBE]: 'info',
        [Platform.LINKEDIN]: 'info'
    }
    return typeMap[platform] || 'info'
}

// 加载用户组成员
const loadGroupUsers = async (groupId: number) => {
    try {
        manageUsersDialog.value.loading = true
        const response = await getGroupUsers(groupId)
        
        if (response.code === 200 && response.data) {
            if ('items' in response.data) {
                manageUsersDialog.value.groupUsers = response.data.items
            } else if (Array.isArray(response.data)) {
                manageUsersDialog.value.groupUsers = response.data
            } else {
                manageUsersDialog.value.groupUsers = [response.data]
            }
        } else {
            ElMessage.error(response.message || t('common.error.unknown'))
        }
    } catch (error) {
        console.error('Failed to load group users:', error)
        ElMessage.error(t('userGroup.error.loadUsersFailed'))
    } finally {
        manageUsersDialog.value.loading = false
    }
}
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
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.current-users-section,
.add-users-section {
  h3 {
    margin: 0 0 16px;
    font-size: 16px;
    color: #606266;
  }
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
}

.operation-tag:hover {
  opacity: 0.8;
}

:deep(.platform-tag) {
  &.el-tag--default {
    background-color: #E1BEE7;
    border-color: #CE93D8;
    color: #7B1FA2;
  }
}
</style>

