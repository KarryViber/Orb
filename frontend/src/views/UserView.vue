<template>
  <div class="user-view">
    <el-tabs v-model="activeTab">
      <!-- 用户管理标签页 -->
      <el-tab-pane :label="t('user.management')" name="users">
        <!-- 用户管理工具栏 -->
        <div class="toolbar">
          <div class="left-section">
            <!-- 搜索框 -->
            <el-input
              v-model="userSearch.keyword"
              :placeholder="t('user.searchPlaceholder')"
              class="search-input"
              @input="handleUserSearch"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>

            <!-- 平台选择 -->
            <el-select
              v-model="userSearch.platform"
              :placeholder="t('common.platform')"
              clearable
              class="filter-item"
              @change="handleUserSearch"
            >
              <el-option
                v-for="platform in platformOptions"
                :key="platform.value"
                :label="platform.label"
                :value="platform.value"
              />
            </el-select>

            <!-- 标签选择 -->
            <el-select
              v-model="userSearch.tags"
              multiple
              collapse-tags
              collapse-tags-tooltip
              :placeholder="t('common.tags')"
              class="filter-item tag-select"
              @change="handleUserSearch"
            >
              <el-option
                v-for="tag in tagOptions"
                :key="tag.value"
                :label="tag.label"
                :value="tag.value"
              />
            </el-select>

            <!-- 标签逻辑选择 -->
            <el-select
              v-model="userSearch.tagLogic"
              class="filter-item tag-logic-select"
              @change="handleUserSearch"
            >
              <el-option :label="t('user.filter.includeAnyTag')" value="or" />
              <el-option :label="t('user.filter.includeAllTags')" value="and" />
            </el-select>

            <!-- 联系状态筛选 -->
            <el-select
              v-model="userSearch.contacted"
              :placeholder="t('user.filter.contactStatus')"
              clearable
              class="filter-item"
              @change="handleUserSearch"
            >
              <el-option :label="t('user.filter.contacted')" :value="true" />
              <el-option :label="t('user.filter.notContacted')" :value="false" />
            </el-select>
          </div>

          <div class="right-section">
            <!-- 创建按钮 -->
            <el-button type="primary" @click="handleUserCreate">
              <el-icon><Plus /></el-icon>
              {{ t('user.createUser') }}
            </el-button>

            <!-- 导入按钮 -->
            <el-button type="success" @click="handleImport">
              <el-icon><Upload /></el-icon>
              {{ t('user.batchImport') }}
            </el-button>

            <!-- 批量添加到用户组按钮 -->
            <el-button 
              type="warning" 
              :disabled="!selectedUsers.length"
              @click="handleBatchAddToGroup"
            >
              <el-icon><FolderAdd /></el-icon>
              {{ t('user.batchAddToGroup') }}
            </el-button>
          </div>
        </div>

        <!-- 用户列表 -->
        <data-table
          :data="userList"
          :loading="userLoading"
          :total="userTotal"
          :current-page="userCurrentPage"
          :page-size="userPageSize"
          :show-selection="true"
          @selection-change="handleUserSelectionChange"
          @current-change="handleUserCurrentChange"
          @size-change="handleUserSizeChange"
          :show-actions="false"
          style="width: 100%"
          border
        >
          <!-- 头像和用户名列 -->
          <el-table-column :label="t('user.avatar')" width="80" align="center">
            <template #default="{ row }">
              <el-avatar
                :size="50"
                :src="getProxiedAvatarUrl(row.profile_data?.avatar_url)"
                :alt="row.username"
              />
            </template>
          </el-table-column>

          <el-table-column :label="t('user.username')" min-width="120">
            <template #default="{ row }">
              <div class="user-info">
                <div class="username">
                  <el-link 
                    type="primary" 
                    :underline="false"
                    @click="openProfile(row.profile_data?.profile_url)"
                    class="primary-text"
                  >
                    {{ row.username }}
                  </el-link>
                  <div class="user-badges">
                    <el-tag v-if="row.profile_data?.is_verified" size="small" type="success">
                      {{ t('user.verified') }}
                    </el-tag>
                    <el-tag v-if="row.profile_data?.is_private" size="small" type="warning">
                      {{ t('user.private') }}
                    </el-tag>
                    <el-tag v-if="row.profile_data?.account_type" size="small" type="info">
                      {{ row.profile_data.account_type }}
                    </el-tag>
                  </div>
                </div>
                <div class="display-name text-secondary">{{ row.display_name }}</div>
              </div>
            </template>
          </el-table-column>

          <!-- 账号类型列 -->
          <el-table-column :label="t('user.accountType')" width="120">
            <template #default="{ row }">
              <el-tag
                v-if="row.profile_data?.is_verified"
                type="success"
                effect="plain"
                size="small"
              >
                {{ t('user.verified') }}
              </el-tag>
              <el-tag
                v-if="row.profile_data?.is_private"
                type="warning"
                effect="plain"
                size="small"
              >
                {{ t('user.private') }}
              </el-tag>
              <el-tag
                v-if="row.profile_data?.is_business"
                type="primary"
                effect="plain"
                size="small"
              >
                {{ t('user.business') }}
              </el-tag>
              <el-tag
                v-if="!row.profile_data?.is_verified && !row.profile_data?.is_private && !row.profile_data?.is_business"
                type="info"
                effect="plain"
                size="small"
              >
                {{ t('user.normal') }}
              </el-tag>
            </template>
          </el-table-column>

          <!-- 统计信息列 -->
          <el-table-column :label="t('user.stats')" width="320">
            <template #default="{ row }">
              <div class="user-stats">
                <div class="stat-item">
                  <div class="stat-content">
                    <span class="stat-value">{{ formatNumber(row.profile_data?.followers_count || 0) }}</span>
                    <span class="stat-label">{{ t('user.followers') }}</span>
                  </div>
                </div>
                <div class="stat-divider"></div>
                <div class="stat-item">
                  <div class="stat-content">
                    <span class="stat-value">{{ formatNumber(row.profile_data?.following_count || 0) }}</span>
                    <span class="stat-label">{{ t('user.following') }}</span>
                  </div>
                </div>
                <div class="stat-divider"></div>
                <div class="stat-item">
                  <div class="stat-content">
                    <span class="stat-value">{{ formatNumber(row.profile_data?.posts_count || 0) }}</span>
                    <span class="stat-label">{{ t('user.posts') }}</span>
                  </div>
                </div>
              </div>
            </template>
          </el-table-column>

          <!-- 平台列 -->
          <el-table-column :label="t('common.platform')" width="100">
            <template #default="{ row }">
              <el-tag :type="getPlatformTagType(row.platform)" class="platform-tag">
                {{ row.platform }}
              </el-tag>
            </template>
          </el-table-column>

          <!-- 标签列 -->
          <el-table-column :label="t('user.tags')" min-width="100">
            <template #default="{ row }">
              <div class="tags-wrapper">
                <div class="tags-list">
                  <template v-if="row.tags && row.tags.length">
                    <el-tag
                      v-for="tag in row.tags"
                      :key="tag"
                      size="small"
                      class="tag-item"
                      closable
                      @close="handleRemoveTag(row, tag)"
                    >
                      {{ tag }}
                    </el-tag>
                  </template>
                </div>
                <el-link
                  type="primary"
                  :underline="false"
                  class="add-tag-link"
                  @click="handleAddTag(row)"
                >
                  <el-icon><Plus /></el-icon>
                  {{ t('user.addTag') }}
                </el-link>
              </div>
            </template>
          </el-table-column>

          <!-- 联系状态列 -->
          <el-table-column :label="t('user.contactStatus')" width="100">
            <template #default="{ row }">
              <el-tag
                :type="row.contacted ? 'success' : 'info'"
                effect="plain"
                size="small"
                @click="handleToggleContactStatus(row)"
                style="cursor: pointer"
              >
                {{ row.contacted ? t('user.filter.contacted') : t('user.filter.notContacted') }}
              </el-tag>
            </template>
          </el-table-column>

          <!-- 操作列 -->
          <el-table-column :label="t('user.operation')" width="120" fixed="right">
            <template #default="{ row }">
              <div class="operation-buttons">
                <el-link
                  type="primary"
                  :underline="false"
                  class="operation-link"
                  @click="handleUserEdit(row)"
                >
                  <el-icon><Edit /></el-icon>
                  {{ t('common.edit') }}
                </el-link>
                <el-link
                  type="success"
                  :underline="false"
                  class="operation-link"
                  @click="handleAddToGroup(row)"
                >
                  <el-icon><Plus /></el-icon>
                  {{ t('user.addToGroup') }}
                </el-link>
                <el-link
                  type="danger"
                  :underline="false"
                  class="operation-link"
                  @click="handleUserDelete(row)"
                >
                  <el-icon><Delete /></el-icon>
                  {{ t('common.delete') }}
                </el-link>
              </div>
            </template>
          </el-table-column>
        </data-table>
      </el-tab-pane>

      <!-- 用户组管理标签页 -->
      <el-tab-pane :label="t('user.groupManagement')" name="groups">
        <UserGroupManager />
      </el-tab-pane>
    </el-tabs>

    <!-- 用户表单对话框 -->
    <el-dialog
      v-model="userDialog.visible"
      :title="userDialog.title"
      width="500px"
    >
      <el-form
        ref="userFormRef"
        :model="userForm"
        :rules="userRules"
        label-width="100px"
      >
        <el-form-item :label="t('user.userName')" prop="username">
          <el-input 
            v-model="userForm.username"
            :placeholder="t('user.userForm.username')"
          />
        </el-form-item>
        
        <el-form-item :label="t('user.displayName')" prop="display_name">
          <el-input 
            v-model="userForm.display_name"
            :placeholder="t('user.userForm.displayName')"
          />
        </el-form-item>
        
        <el-form-item :label="t('common.platform')" prop="platform">
          <el-select 
            v-model="userForm.platform" 
            :placeholder="t('user.userForm.platform')"
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
        
        <el-form-item :label="t('user.tags')">
          <el-select
            v-model="userForm.tags"
            multiple
            :placeholder="t('user.userForm.tags')"
            style="width: 100%"
          >
            <el-option
              v-for="tag in tagOptions"
              :key="tag.value"
              :label="tag.label"
              :value="tag.value"
            />
          </el-select>
        </el-form-item>
      </el-form>
      
      <template #footer>
        <el-button @click="userDialog.visible = false">
          {{ t('common.cancel') }}
        </el-button>
        <el-button type="primary" @click="handleUserSubmit">
          {{ t('common.submit') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 批量导入对话框 -->
    <el-dialog
      v-model="importDialog.visible"
      :title="t('user.importUsers')"
      width="500px"
    >
      <el-upload
        class="upload-demo"
        drag
        action="#"
        :auto-upload="false"
        :show-file-list="true"
        :limit="1"
        accept=".xlsx,.xls,.csv"
        @change="handleFileChange"
      >
        <el-icon class="el-icon--upload"><upload-filled /></el-icon>
        <div class="el-upload__text">
          {{ t('user.dragFileHere') }}<em>{{ t('user.clickToUpload') }}</em>
        </div>
        <template #tip>
          <div class="el-upload__tip">
            {{ t('user.fileTypeTip') }}
          </div>
        </template>
      </el-upload>
      
      <template #footer>
        <el-button @click="importDialog.visible = false">
          {{ t('common.cancel') }}
        </el-button>
        <el-button
          type="primary"
          :loading="importDialog.loading"
          @click="handleImportSubmit"
        >
          {{ t('common.submit') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 添加到用户组对话框 -->
    <el-dialog
      v-model="addToGroupDialog.visible"
      :title="t('user.addToGroup')"
      width="500px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <el-form
        ref="addToGroupFormRef"
        :model="addToGroupDialog.form"
        :rules="addToGroupRules"
        label-width="100px"
      >
        <el-form-item :label="t('user.userGroup')" prop="groupId">
          <el-select
            v-model="addToGroupDialog.form.groupId"
            :placeholder="t('user.selectGroup')"
            style="width: 100%"
            clearable
          >
            <el-option
              v-for="group in groupOptions"
              :key="group.value"
              :label="group.label"
              :value="group.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="t('user.targetUsers')">
          <div class="selected-users-info">
            {{ t('user.selectedUsers', { count: addToGroupDialog.form.userIds.length }) }}
          </div>
        </el-form-item>
      </el-form>
      
      <template #footer>
        <el-button @click="addToGroupDialog.visible = false">
          {{ t('common.cancel') }}
        </el-button>
        <el-button type="primary" @click="handleAddToGroupSubmit">
          {{ t('common.submit') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 添加标签对话框 -->
    <el-dialog
      v-model="tagDialog.visible"
      :title="t('user.addTag')"
      width="500px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <el-select
        v-model="tagDialog.selectedTags"
        multiple
        filterable
        allow-create
        :placeholder="t('user.selectOrInputTags')"
        style="width: 100%"
      >
        <el-option
          v-for="tag in tagOptions"
          :key="tag.value"
          :label="tag.label"
          :value="tag.value"
        />
      </el-select>
      
      <template #footer>
        <el-button @click="tagDialog.visible = false">
          {{ t('common.cancel') }}
        </el-button>
        <el-button type="primary" @click="handleTagDialogConfirm">
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, defineExpose, watch, h } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { Upload, Download, FolderAdd, Plus, UploadFilled, Edit, Delete, Search } from '@element-plus/icons-vue'
import type { FormInstance } from 'element-plus'
import type { UserResponse } from '@/types/user'
import { Platform } from '@/types/common'
import { getUsers, createUser, updateUser, deleteUser, getAllTags } from '@/api/users'
import { formatDate } from '@/utils/date'
import UserGroupManager from '@/components/UserGroupManager.vue'
import DataTable from '@/components/common/DataTable.vue'
import DataTableToolbar from '@/components/common/DataTableToolbar.vue'
import { addUsersToGroup, getUserGroups } from '@/api/userGroups'
import { useSearchTaskStore } from '@/stores/searchTasks'

const { t } = useI18n()
const searchTaskStore = useSearchTaskStore()

// 当前活动标签页
const activeTab = ref('users')

interface UserSearchParams {
  keyword: string
  platform?: Platform
  tags: string[]
  tagLogic: 'or' | 'and'
  contacted?: boolean
  page: number
  pageSize: number
}

const userSearch = ref<UserSearchParams>({
  keyword: '',
  platform: undefined,
  tags: [],
  tagLogic: 'or',
  contacted: undefined,
  page: 1,
  pageSize: 10
})

const userList = ref<UserResponse[]>([])
const userLoading = ref(false)
const userTotal = ref(0)
const userCurrentPage = ref(1)
const userPageSize = ref(10)
const selectedUsers = ref<UserResponse[]>([])
const newTag = ref('')  // 新增标签输入框的值

// 用户表单对话框
const userDialog = ref({
  visible: false,
  title: '',
  isEdit: false
})

const userForm = ref({
  id: 0,
  username: '',
  display_name: '',
  platform: '',
  tags: [] as string[]
})

const userFormRef = ref<FormInstance>()

const userRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  platform: [
    { required: true, message: '请选择平台', trigger: 'change' }
  ]
}

// 标签选项
const tagOptions = ref<{ value: string; label: string }[]>([])

// 加载标签列表
const loadTagOptions = async () => {
  try {
    console.log('开始加载标签列表')
    const tags = await getAllTags()
    console.log('获取到的标签列表:', tags)
    
    // 确保tags是数组
    if (Array.isArray(tags)) {
      // 直接使用API返回的格式化后的标签数据
      tagOptions.value = tags
      console.log('更新后的标签选项:', tagOptions.value)
    } else {
      console.error('标签数据格式错误:', tags)
      tagOptions.value = []
    }
  } catch (error) {
    console.error('加载标签列表失败:', error)
    ElMessage.error(t('message.loadTagsFailed'))
    tagOptions.value = []
  }
}

// Platform选项
const platformOptions = [
  { value: Platform.TWITTER, label: 'Twitter' },
  { value: Platform.INSTAGRAM, label: 'Instagram' }
]

// 批量导入对话框
const importDialog = ref({
  visible: false,
  file: null as File | null,
  loading: false
})

// 添加到用户组对话框
const addToGroupDialog = ref({
  visible: false,
  loading: false,
  form: {
    groupId: null as number | null,
    userIds: [] as number[]
  }
})

// 获取用户组选项
const groupOptions = ref<{ label: string; value: number }[]>([])
const loadGroupOptions = async () => {
  try {
    console.log('开始加载用户组选项...')
    const response = await getUserGroups({
      page: 1,
      pageSize: 100
    })
    console.log('用户组响应:', response)

    // 检查响应数据
    if (response && 'data' in response) {
      let groups: { id: number; name: string }[] = []
      
      // 如果data是数组，直接使用
      if (Array.isArray(response.data)) {
        groups = response.data
      } 
      // 如果data包含items字段
      else if (response.data && typeof response.data === 'object' && 'items' in response.data) {
        groups = response.data.items || []
      }
      
      // 转换为选项格式
      if (groups.length > 0) {
        console.log('处理用户组数据:', groups)
        groupOptions.value = groups.map(group => ({
          label: group.name,
          value: group.id
        }))
        console.log('用户组选项:', groupOptions.value)
      } else {
        console.warn('没有找到用户组数据')
        groupOptions.value = []
      }
    } else {
      console.warn('无效的用户组响应:', response)
      groupOptions.value = []
    }
  } catch (error) {
    console.error('加载用户组选项失败:', error)
    ElMessage.error(t('message.loadGroupsFailed'))
    groupOptions.value = []
  }
}

// 加载用户列表
const loadUsers = async () => {
  console.log('=== 开始加载用户列表 ===')
  console.log('当前搜索参数:', userSearch.value)
  
  userLoading.value = true
  try {
    const params = {
      keyword: userSearch.value.keyword || undefined,
      platform: userSearch.value.platform ? userSearch.value.platform as Platform : undefined,
      tags: userSearch.value.tags && userSearch.value.tags.length > 0 ? userSearch.value.tags : undefined,
      tagLogic: userSearch.value.tags && userSearch.value.tags.length > 0 ? userSearch.value.tagLogic : undefined,
      contacted: userSearch.value.contacted,
      page: userCurrentPage.value,
      pageSize: userPageSize.value
    }
    
    console.log('发送请求参数:', params)
    
    const response = await getUsers(params)
    console.log('收到服务器响应:', response)
    
    if (response && response.data) {
      console.log('更新前的列表数据:', userList.value)
      userList.value = response.data
      console.log('更新后的列表数据:', userList.value)
      
      userTotal.value = response.total || 0
      userCurrentPage.value = response.page || userCurrentPage.value
      userPageSize.value = response.pageSize || userPageSize.value
      
      console.log('更新后的分页信息:', {
        total: userTotal.value,
        currentPage: userCurrentPage.value,
        pageSize: userPageSize.value
      })
    }
  } catch (error) {
    console.error('加载用户列表失败:', error)
    ElMessage.error('加载用户列表失败')
    userList.value = []
    userTotal.value = 0
  } finally {
    userLoading.value = false
    console.log('=== 加载用户列表完成 ===')
  }
}

// 监听筛选条件变化
watch(userSearch, (newVal) => {
  console.log('筛选条件变更:', {
    keyword: newVal.keyword,
    platform: newVal.platform,
    tags: newVal.tags,
    tagLogic: newVal.tagLogic
  })
  userCurrentPage.value = 1  // 重置页码
  loadUsers()  // 重新加载数据
}, { deep: true, immediate: true })

// 监听分页变化
watch([userCurrentPage, userPageSize], () => {
  loadUsers()
})

// 用户相关操作处理器
const handleUserSearch = () => {
  userCurrentPage.value = 1
  loadUsers()
}

// 处理页码变化
const handleUserCurrentChange = (page: number) => {
  console.log('[UserView] 页码变化:', page)
  userCurrentPage.value = page
  loadUsers()
}

// 处理每页数量变化
const handleUserSizeChange = (size: number) => {
  console.log('[UserView] 每页数量变化:', size)
  userPageSize.value = size
  userCurrentPage.value = 1  // 重置到第一页
  loadUsers()
}

const handleUserSelectionChange = (selection: UserResponse[]) => {
  selectedUsers.value = selection
}

const handleUserCreate = () => {
  userDialog.value = {
    visible: true,
    title: '创建用户',
    isEdit: false
  }
  userForm.value = {
    id: 0,
    username: '',
    display_name: '',
    platform: '',
    tags: []
  }
}

const handleUserEdit = (user: UserResponse) => {
  userDialog.value = {
    visible: true,
    title: '编辑用户',
    isEdit: true
  }
  userForm.value = {
    id: user.id,
    username: user.username,
    display_name: user.display_name || '',
    platform: user.platform,
    tags: user.tags || []
  }
}

const handleUserSubmit = async () => {
  if (!userFormRef.value) return
  
  try {
    await userFormRef.value.validate()
    if (userDialog.value.isEdit) {
      await updateUser(userForm.value.id, {
        username: userForm.value.username,
        display_name: userForm.value.display_name,
        platform: userForm.value.platform as Platform,
        tags: userForm.value.tags
      })
      ElMessage.success('更新成功')
    } else {
      await createUser({
        username: userForm.value.username,
        display_name: userForm.value.display_name,
        platform: userForm.value.platform as Platform,
        tags: userForm.value.tags
      })
      ElMessage.success('创建成功')
    }
    userDialog.value.visible = false
    loadUsers()
  } catch (error) {
    console.error('保存用户失败:', error)
    ElMessage.error('保存用户失败')
  }
}

const handleUserDelete = async (user: UserResponse) => {
  try {
    await ElMessageBox.confirm(
      '确定要删除这个用户吗？删除后无法恢复。',
      '提示',
      {
        type: 'warning'
      }
    )
    await deleteUser(user.id)
    ElMessage.success('删除成功')
    loadUsers()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除用户失败:', error)
      ElMessage.error('删除用户失败')
    }
  }
}

const handleRemoveTag = async (user: UserResponse, tag: string) => {
  try {
    console.log('移除标签，当前用户:', user)
    console.log('要移除的标签:', tag)
    console.log('当前标签列表:', user.tags)
    
    // 创建新的标签数组，排除要删除的标签
    const newTags = (user.tags || []).filter(t => t !== tag)
    console.log('更新后的标签列表:', newTags)
    
    // 构造更新数据
    const updateData = {
      tags: newTags,
      profile_data: user.profile_data || {}  // 保持其他数据不变
    }
    
    // 调用更新用户API
    const updatedUser = await updateUser(user.id, updateData)
    if (updatedUser) {
      // 重新加载用户列表和标签列表
      await Promise.all([
        loadUsers(),
        loadTagOptions()
      ])
      ElMessage.success('标签删除成功')
    }
  } catch (error) {
    console.error('移除标签失败:', error)
    ElMessage.error('移除标签失败')
  }
}

const handleAddCustomTag = async (user: UserResponse) => {
  if (!newTag.value) return
  
  try {
    console.log('添加自定义标签，当前用户:', user)
    console.log('要添加的标签:', newTag.value)
    console.log('当前标签列表:', user.tags)
    
    // 移除开头的#号(如果有)
    const tagContent = newTag.value.startsWith('#') ? newTag.value.slice(1) : newTag.value
    
    // 创建新的标签数组
    const newTags = [...(user.tags || []), tagContent]
    console.log('更新后的标签列表:', newTags)
    
    // 构造更新数据
    const updateData = {
      tags: newTags,
      profile_data: user.profile_data || {}  // 保持其他数据不变
    }
    console.log('发送更新请求数据:', updateData)
    
    // 调用更新用户API
    await updateUser(user.id, updateData)
    
    // 重新加载用户列表
    await loadUsers()
    ElMessage.success('标签添加成功')
    
    // 清空输入
    newTag.value = ''
  } catch (error) {
    console.error('添加标签失败:', error)
    ElMessage.error('添加标签失败')
  }
}

const tagDialog = ref({
  visible: false,
  selectedTags: [] as string[],
  currentUser: null as UserResponse | null
})

const handleAddTag = async (user: UserResponse) => {
  tagDialog.value.currentUser = user
  tagDialog.value.selectedTags = []
  tagDialog.value.visible = true
}

const handleTagDialogConfirm = async () => {
  try {
    if (!tagDialog.value.currentUser) return
    if (!tagDialog.value.selectedTags.length) {
      ElMessage.warning(t('user.pleaseSelectTags'))
      return
    }

    const user = tagDialog.value.currentUser
    const currentTags = user.tags || []
    
    // 过滤掉已存在的标签
    const newTags = tagDialog.value.selectedTags.filter(tag => !currentTags.includes(tag))
    
    if (newTags.length === 0) {
      ElMessage.warning(t('user.tagsAlreadyExist'))
      return
    }
    
    // 合并新标签和现有标签
    const updatedTags = [...currentTags, ...newTags]
    
    // 构造更新数据
    const updateData = {
      tags: updatedTags,
      profile_data: user.profile_data || {}
    }
    
    // 调用更新用户API
    const updatedUser = await updateUser(user.id, updateData)
    if (updatedUser) {
      // 重新加载用户列表和标签列表
      await Promise.all([
        loadUsers(),
        loadTagOptions()
      ])
      ElMessage.success(t('message.saveSuccess'))
      tagDialog.value.visible = false
    }
  } catch (error) {
    console.error('添加标签失败:', error)
    ElMessage.error(t('message.saveFailed'))
  }
}

// 处理批量导入
const handleImport = () => {
  importDialog.value.visible = true
}

// 处理文件上传
const handleFileChange = (e: Event) => {
  const target = e.target as HTMLInputElement
  if (target.files) {
    importDialog.value.file = target.files[0]
  }
}

// 提交导入
const handleImportSubmit = async () => {
  if (!importDialog.value.file) {
    ElMessage.warning('请选择要导入的文件')
    return
  }

  importDialog.value.loading = true
  try {
    const formData = new FormData()
    formData.append('file', importDialog.value.file)
    
    // TODO: 实现文件上传API
    // const response = await request.post('/api/users/import', formData)
    ElMessage.success('导入成功')
    importDialog.value.visible = false
    loadUsers()
  } catch (error) {
    console.error('导入失败:', error)
    ElMessage.error('导入失败')
  } finally {
    importDialog.value.loading = false
  }
}

// 处理单个用户添加到用户组
const handleAddToGroup = async (user: UserResponse) => {
  console.log('[handleAddToGroup] 开始处理单个用户添加到组:', {
    user,
    userId: user.id
  })
  
  // 加载用户组选项
  await loadGroupOptions()
  
  // 设置对话框数据
  addToGroupDialog.value.form = {
    groupId: null,
    userIds: [user.id]
  }
  addToGroupDialog.value.visible = true
  addToGroupDialog.value.loading = false
}

// 处理批量添加到用户组
const handleBatchAddToGroup = async () => {
  if (!selectedUsers.value.length) {
    ElMessage.warning('请选择要添加的用户')
    return
  }
  
  console.log('[handleBatchAddToGroup] 开始处理批量添加到组:', {
    selectedUsers: selectedUsers.value,
    userIds: selectedUsers.value.map(user => user.id)
  })
  
  // 加载用户组选项
  await loadGroupOptions()
  
  // 设置对话框数据
  addToGroupDialog.value.form = {
    groupId: null,
    userIds: selectedUsers.value.map(user => user.id)
  }
  addToGroupDialog.value.visible = true
  addToGroupDialog.value.loading = false
}

// 处理添加到用户组的提交
const handleAddToGroupSubmit = async () => {
  if (!addToGroupDialog.value.form.groupId) {
    ElMessage.warning('请选择用户组')
    return
  }

  console.log('[handleAddToGroupSubmit] 开始添加用户到组:', {
    groupId: addToGroupDialog.value.form.groupId,
    userIds: addToGroupDialog.value.form.userIds
  })

  addToGroupDialog.value.loading = true
  try {
    const success = await addUsersToGroup(
      addToGroupDialog.value.form.groupId,
      addToGroupDialog.value.form.userIds
    )

    if (success) {
      addToGroupDialog.value.visible = false
      addToGroupDialog.value.form = {
        groupId: null,
        userIds: []
      }
      ElMessage.success('添加用户到用户组成功')
      
      // 重新加载用户列表
      await loadUsers()
    }
  } catch (error) {
    console.error('[handleAddToGroupSubmit] 添加用户到组失败:', error)
    ElMessage.error('添加用户到组失败')
  } finally {
    addToGroupDialog.value.loading = false
  }
}

// 获取平台标签类型
const getPlatformTagType = (platform: Platform) => {
  switch (platform) {
    case Platform.INSTAGRAM:
      return 'info'  // 返回一个有效的type值
    case Platform.TWITTER:
      return 'primary'
    case Platform.FACEBOOK:
      return 'warning'
    case Platform.TIKTOK:
      return 'danger'
    default:
      return 'info'
  }
}

// 获取账号类型标签样式
const getAccountTypeTagType = (accountType: string | undefined) => {
  if (!accountType) return 'info'
  
  const type = accountType.toLowerCase()
  if (type.includes('business')) return 'success'
  if (type.includes('creator')) return 'warning'
  if (type.includes('professional')) return 'primary'
  return 'info'
}

// 获取账号类型显示文本
const getAccountTypeDisplay = (accountType: string | undefined) => {
  if (!accountType) return t('user.normalAccount')
  
  const type = accountType.toLowerCase()
  if (type.includes('business')) return 'Business'
  if (type.includes('creator')) return 'Creator'
  if (type.includes('professional')) return 'Professional'
  return t('user.normalAccount')
}

// 重新加载数据的方法
const reload = async () => {
  console.log('UserView reload')
  userCurrentPage.value = 1
  await loadUsers()
}

// 暴露reload方法给父组件
defineExpose({ reload })

// 添加到用户组表单引用和规则
const addToGroupFormRef = ref<FormInstance>()
const addToGroupRules = {
  groupId: [
    { required: true, message: '请选择用户组', trigger: 'change' }
  ]
}

// 打开用户主页
const openProfile = (url?: string) => {
  if (url) {
    window.open(url, '_blank')
  }
}

// 格式化数字
const formatNumber = (num: number) => {
  return new Intl.NumberFormat().format(num)
}

// 添加头像处理函数
const getProxiedAvatarUrl = (url: string | undefined) => {
  if (!url) return '';
  // 使用本地代理服务器处理图片请求
  return `/api/proxy/image?url=${encodeURIComponent(url)}`;
}

// 监听搜索任务状态变化
watch(
  () => searchTaskStore.tasks,
  (newTasks, oldTasks) => {
    console.log('[UserView] 搜索任务状态变化:', {
      newTasks,
      oldTasks
    })
    
    // 检查是否有新完成的任务
    const newCompletedTasks = newTasks.filter(newTask => {
      // 找到对应的旧任务
      const oldTask = oldTasks?.find(old => old.id === newTask.id)
      // 如果是新完成的任务（之前未完成，现在完成）
      return newTask.is_completed && 
             !newTask.error_message && 
             (!oldTask || !oldTask.is_completed)
    })

    if (newCompletedTasks.length > 0) {
      console.log('[UserView] 检测到新完成的搜索任务:', newCompletedTasks)
      
      // 延迟一秒后刷新，确保后端数据已经准备好
      setTimeout(() => {
        console.log('[UserView] 开始刷新用户列表')
        // 重置筛选条件
        userSearch.value = {
          keyword: '',
          platform: undefined,
          tags: [],
          tagLogic: 'or',
          contacted: undefined,
          page: 1,
          pageSize: 10
        }
        // 重置页码和每页数量
        userCurrentPage.value = 1
        userPageSize.value = 10
        // 刷新用户列表
        loadUsers()
      }, 1000)
    }
  },
  { deep: true }
)

// 在组件挂载时开始监听搜索任务
onMounted(() => {
  searchTaskStore.startPolling()
})

// 组件挂载时初始化数据
onMounted(async () => {
  console.log('组件挂载，开始加载数据')
  await Promise.all([
    loadUsers(),
    loadTagOptions()
  ])
})

// 刷新用户列表
const refreshUserList = () => {
  handleUserSearch()
}

// 切换联系状态
const handleToggleContactStatus = async (user: UserResponse) => {
  try {
    console.log('=== 开始更新联系状态 ===')
    console.log('当前用户数据:', {
      id: user.id,
      username: user.username,
      contacted: user.contacted
    })
    
    // 调用API更新服务器
    const updatedUser = await updateUser(user.id, {
      contacted: !user.contacted
    })
    
    if (!updatedUser) {
      console.error('更新失败')
      ElMessage.error('更新联系状态失败')
      return
    }
    
    console.log('服务器返回的更新后数据:', updatedUser)
    
    // 更新成功后重新加载用户列表
    await loadUsers()
    ElMessage.success('更新联系状态成功')
  } catch (error) {
    console.error('更新联系状态失败:', error)
    ElMessage.error('更新联系状态失败')
  }
}
</script>

<style scoped>
.user-view {
  padding: 20px;
}

.mx-1 {
  margin: 0 4px;
}

.selected-users-info {
  color: #606266;
  font-size: 14px;
  line-height: 32px;
}

.operation-buttons {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.operation-link {
  display: flex !important;
  align-items: center;
  font-size: 12px !important;
  height: 20px;
  padding: 0 !important;
}

.operation-link .el-icon {
  margin-right: 4px;
  font-size: 12px;
}

.tags-wrapper {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 32px;
  justify-content: center;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.tag-item {
  margin: 0;
  font-size: 11px;
  height: 20px;
  line-height: 18px;
  padding: 0 6px;
}

.add-tag-link {
  display: flex !important;
  align-items: center;
  font-size: 12px !important;
  height: 20px;
  padding: 0 !important;
  margin-top: 2px;
}

.add-tag-link .el-icon {
  margin-right: 4px;
  font-size: 12px;
}

:deep(.el-table td) {
  padding: 6px 0;
}

:deep(.el-table .cell) {
  padding: 0 8px;
  display: flex;
  align-items: center;
}

:deep(.el-tabs__header) {
  margin-bottom: 16px;
}

:deep(.el-tabs__nav-wrap::after) {
  height: 1px;
}

:deep(.el-tabs__active-bar) {
  height: 2px;
}

:deep(.el-tabs__item) {
  font-size: 14px;
  padding: 0 20px;
  height: 40px;
  line-height: 40px;
}

:deep(.el-tabs__item.is-active) {
  font-weight: 500;
}

:deep(.platform-tag) {
  &.el-tag--default {
    background-color: #E1BEE7;
    border-color: #CE93D8;
    color: #7B1FA2;
  }
}

.user-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 0;
}

.username {
  display: flex;
  align-items: center;
  gap: 8px;
}

.primary-text {
  font-weight: 500;
  color: #303133;
  
  &.el-link {
    font-size: 14px;
    
    &:hover {
      color: var(--el-color-primary);
    }
  }
}

.text-secondary {
  color: #909399;
  font-size: 13px;
}

.user-badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  
  .el-tag {
    margin: 0;
    
    &--info {
      background-color: #f4f4f5;
      border-color: #e9e9eb;
      color: #909399;
    }
  }
}

.user-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 24px;
  background: #f5f7fa;
  border-radius: 8px;
  min-width: 280px;
}

.stat-item {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 4px 0;
}

.stat-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.stat-value {
  font-weight: 600;
  color: #303133;
  font-size: 15px;
}

.stat-label {
  color: #909399;
  font-size: 12px;
}

.stat-divider {
  width: 1px;
  height: 28px;
  background-color: #dcdfe6;
  margin: 0 12px;
}

:deep(.el-table) {
  --el-table-border-color: #EBEEF5;
  --el-table-header-bg-color: #F5F7FA;
  --el-table-row-hover-bg-color: #F5F7FA;
}

:deep(.el-table th) {
  background-color: var(--el-table-header-bg-color);
  font-weight: 600;
  color: #606266;
  height: 50px;
}

:deep(.el-avatar) {
  border: 1px solid #EBEEF5;
}

:deep(.el-button--small) {
  font-size: 12px;
}

.filter-item {
  margin-right: 10px;
  width: 120px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 16px;
}

.left-section {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.right-section {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-input {
  width: 240px;
}

.tag-select {
  width: 240px;
}

.tag-logic-select {
  width: 140px;
}
</style>
