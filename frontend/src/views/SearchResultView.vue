<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Download, Message, Star, ChatDotRound, User, Document, FolderAdd } from '@element-plus/icons-vue'
import type { FormInstance, FormRules } from 'element-plus'
import userService from '@/services/users'
import templateService from '@/services/templates'
import messageTaskService from '@/services/messageTasks'
import searchTaskService from '@/services/searchTasks'
import { getUserGroups, addUsersToGroup, getGroupUsers } from '@/api/userGroups'
import type { UserResponse, UserProfileData } from '@/types/user'
import type { UserGroupResponse } from '@/types/userGroup'
import type { Template } from '@/services/templates'
import type { MessageTaskParams } from '@/services/messageTasks'
import type { SearchTask } from '@/services/searchTasks'
import type { SearchTaskParams } from '@/services/searchTasks'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// 扩展用户资料类型
interface MatchedPost {
    url: string;
    caption: string;
    likes_count: number;
    comments_count: number;
    timestamp: string;
    hashtags?: string[];
}

interface ExtendedUserProfileData extends UserProfileData {
    matched_posts?: MatchedPost[];
    posts_count: number;
    matchedTweet?: {
        matched_keywords: string[];
        text: string;
        url: string;
        created_at: string;
    };
}

interface ExtendedUserResponse extends Omit<UserResponse, 'profile_data'> {
    profile_data?: ExtendedUserProfileData;
}

const route = useRoute()
const router = useRouter()
const taskId = Number(route.params.taskId)

// 搜索和过滤
const searchKeyword = ref('')
const filterForm = ref({
  platform: '',
  tags: [] as string[]
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
const userList = ref<ExtendedUserResponse[]>([])
const selectedUsers = ref<ExtendedUserResponse[]>([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

// 标签编辑
const tagDialogVisible = ref(false)
const tagFormRef = ref<FormInstance>()
const tagForm = ref({
  id: 0,
  tags: [] as string[],
  notes: ''
})

// 任务信息
const task = ref<SearchTask | null>(null)

// 私信相关
const messageDialogVisible = ref(false)
const messageFormRef = ref<FormInstance>()
const messageTemplates = ref<Template[]>([])
const sending = ref(false)

const messageForm = ref({
    templateId: 0,
    content: ''
})

const messageRules = {
    templateId: [
        { required: true, message: '请选择私信模板', trigger: 'change' }
    ]
}

// 匹配帖子对话框
const postsDialogVisible = ref(false)
const currentUser = ref<ExtendedUserResponse | null>(null)

// 添加到用户组对话框
const addToGroupDialog = ref({
  visible: false,
  loading: false,
  form: {
    groupId: null as number | null,
    userIds: [] as number[]
  }
})

// 用户组选项
const groupOptions = ref<{ label: string; value: number }[]>([])

// 加载用户组选项
const loadGroupOptions = async () => {
  try {
    const response = await getUserGroups({})
    if (response && response.code === 200 && response.data && 'items' in response.data) {
      groupOptions.value = response.data.items.map(group => ({
        label: group.name,
        value: group.id
      }))
    }
  } catch (error) {
    console.error('加载用户组选项失败:', error)
    ElMessage.error('加载用户组选项失败')
  }
}

// 处理搜索
const handleSearch = () => {
  loadTaskResults()
}

// 打开匹配帖子对话框
const openMatchedPosts = (user: ExtendedUserResponse) => {
  currentUser.value = user
  postsDialogVisible.value = true
}

// 加载任务信息和结果
const loadTaskResults = async () => {
  loading.value = true
  try {
    // 获取任务信息
    const taskData = await searchTaskService.getTask(taskId)
    if (!taskData) {
      ElMessage.error('任务不存在')
      return
    }
    task.value = taskData
    
    // 获取用户列表，添加分页参数和搜索关键词
    const response = await searchTaskService.getTaskResults(taskId, {
      page: currentPage.value,
      pageSize: pageSize.value,
      keyword: searchKeyword.value
    })

    if (response && Array.isArray(response.data)) {
      // 确保每个用户的profile_data和matched_posts存在
      userList.value = response.data.map(user => {
        const matchedPost = user.profile_data?.matched_posts?.[0] || null;
        return {
          ...user,
          profile_data: {
            ...user.profile_data,
            followers_count: user.profile_data?.followers_count || 0,
            following_count: user.profile_data?.following_count || 0,
            posts_count: user.profile_data?.posts_count || 0,
            is_verified: user.profile_data?.is_verified || false,
            is_private: user.profile_data?.is_private || false,
            is_business: user.profile_data?.is_business || false,
            matchedTweet: matchedPost ? {
              matched_keywords: matchedPost.matched_keywords || [],
              text: matchedPost.text || '',
              url: matchedPost.url || '',
              created_at: matchedPost.created_at || ''
            } : {
              matched_keywords: [],
              text: '',
              url: '',
              created_at: ''
            }
          }
        }
      })
      total.value = response.total || response.data.length
      currentPage.value = response.page || 1
      pageSize.value = response.pageSize || 10
      
      // 调试输出
      console.log('处理后的用户列表:', userList.value.map(user => ({
        username: user.username,
        matched_keywords: user.profile_data?.matchedTweet?.matched_keywords,
        matched_posts: user.profile_data?.matched_posts
      })))
    } else {
      userList.value = []
      total.value = 0
    }
  } catch (error) {
    ElMessage.error('加载搜索结果失败')
    console.error('Error loading search results:', error)
  } finally {
    loading.value = false
  }
}

// 处理标签提交
const handleTagSubmit = async () => {
  try {
    const updateData = {
      tags: tagForm.value.tags,
      profile_data: {}
    }
    await userService.updateUser(tagForm.value.id, updateData)
    ElMessage.success(t('common.updateSuccess'))
    tagDialogVisible.value = false
    loadTaskResults()
  } catch (error) {
    ElMessage.error(t('common.updateFailed'))
    console.error(t('common.updateFailed'), error)
  }
}

// 格式化数字
const formatNumber = (num: number) => {
  return new Intl.NumberFormat().format(num)
}

// 打开链接
const openUrl = (url: string) => {
  window.open(url, '_blank')
}

// 格式化帖子日期
const formatPostDate = (timestamp: string) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleDateString();
};

// 格式化粉丝数范围
const formatFollowerRange = (params: SearchTaskParams | undefined) => {
    if (!params) return t('search.noLimit');
    const min = params.min_followers !== undefined ? formatNumber(params.min_followers) : t('search.noLimit');
    const max = params.max_followers !== undefined ? formatNumber(params.max_followers) : t('search.noLimit');
    return `${min} - ${max}`;
};

// 获取平台类型
const getPlatformType = (platform: string): string => {
    const types: Record<string, string> = {
        instagram: 'danger',
        twitter: 'primary',
        facebook: 'success',
        linkedin: 'info'
    };
    return types[platform] || 'info';
};

// 获取平台标签
const getPlatformLabel = (platform: string): string => {
    const labels: Record<string, string> = {
        instagram: 'Instagram',
        twitter: 'Twitter',
        facebook: 'Facebook',
        linkedin: 'LinkedIn'
    };
    return labels[platform] || platform;
};

// 导出CSV
const exportToCSV = () => {
    if (!userList.value.length) {
        ElMessage.warning(t('search.noDataToExport'));
        return;
    }

    // 定义CSV列头
    const headers = [
        t('user.username'),
        t('user.displayName'),
        t('user.accountType'),
        t('search.keywords'),
        t('user.followers'),
        t('user.following'),
        t('user.posts'),
        t('user.bio'),
        t('user.isVerified'),
        t('user.isPrivate'),
        t('user.profileUrl')
    ];

    // 准备数据
    const rows = userList.value.map(user => {
        const accountTypes = [];
        const profile = user.profile_data || {
            followers_count: 0,
            following_count: 0,
            posts_count: 0,
            bio: '',
            is_verified: false,
            is_private: false,
            is_business: false,
            profile_url: '',
            avatar_url: '',
            website: '',
            category: ''
        };
        
        if (profile.is_verified) accountTypes.push('Verified');
        if (profile.is_private) accountTypes.push('Private');
        if (profile.is_business) accountTypes.push('Business');
        if (!profile.is_verified && !profile.is_private && !profile.is_business) accountTypes.push('Normal');

        // 获取匹配的关键词
        const matchedKeywords = user.profile_data?.matchedTweet?.matched_keywords?.join(', ') || '';

        return [
            user.username,
            user.display_name || '',
            accountTypes.join(', '),
            matchedKeywords,
            profile.followers_count,
            profile.following_count,
            profile.posts_count,
            profile.bio?.replace(/,/g, ';').replace(/\n/g, ' ') || '',
            profile.is_verified ? 'Yes' : 'No',
            profile.is_private ? 'Yes' : 'No',
            profile.profile_url || ''
        ];
    });

    // 生成CSV内容
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');

    // 创建Blob对象
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);

    // 创建下载链接
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `search_results_task_${taskId}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// 选中的用户
const handleSelectionChange = (users: ExtendedUserResponse[]) => {
    selectedUsers.value = users
}

// 打开私信对话框
const handleSendMessage = (users: ExtendedUserResponse[]) => {
    selectedUsers.value = users
    messageDialogVisible.value = true
    loadTemplates()
}

// 加载模板
const loadTemplates = async () => {
    try {
        const response = await templateService.getTemplates()
        if (response && response.data) {
            messageTemplates.value = response.data
        }
    } catch (error) {
        console.error('Error loading templates:', error)
        ElMessage.error(t('template.loadFailed'))
    }
}

// 模板变更
const handleTemplateChange = async (templateId: number) => {
    if (!templateId) return
    try {
        console.log('[handleTemplateChange] 开始加载模板内容, templateId:', templateId)
        const template = await templateService.getTemplate(templateId)
        if (template) {
            console.log('[handleTemplateChange] 加载模板内容成功:', template)
            messageForm.value.content = template.content
        } else {
            ElMessage.warning(t('template.notFound'))
            messageForm.value.content = ''
        }
    } catch (error) {
        console.error('[handleTemplateChange] 加载模板内容失败:', error)
        ElMessage.error(t('template.loadContentFailed'))
        messageForm.value.content = ''
    }
}

// 获取预览内容
const getPreviewContent = (user: ExtendedUserResponse) => {
    if (!messageForm.value.content) return ''
    let content = messageForm.value.content
    
    // 替换变量
    content = content.replace(/{username}/g, user.username)
    content = content.replace(/{display_name}/g, user.display_name || user.username)
    if (user.profile_data) {
        content = content.replace(/{followers_count}/g, formatNumber(user.profile_data.followers_count))
    }
    
    return content
}

// 发送私信
const handleSendMessageSubmit = async () => {
    if (!messageFormRef.value) return
    
    try {
        await messageFormRef.value.validate()
        
        sending.value = true
        const messageTask: MessageTaskParams = {
            name: t('message.taskNameWithCount', { count: selectedUsers.value.length }),
            template_id: messageForm.value.templateId,
            user_ids: selectedUsers.value.map(user => user.id),
            settings: {
                interval: 60,
                daily_limit: 50
            }
        }
        
        await messageTaskService.createMessageTask(messageTask)
        ElMessage.success(t('message.taskCreated'))
        messageDialogVisible.value = false
        
    } catch (error) {
        console.error(t('message.sendFailed'), error)
        ElMessage.error(t('message.sendFailed'))
    } finally {
        sending.value = false
    }
}

// 跳转到模板管理
const goToTemplates = () => {
    router.push('/templates')
}

// 打开用户主页
const openProfile = (url?: string) => {
    if (url) {
        window.open(url, '_blank')
    }
}

// 添加到用户组
const handleAddToGroup = async () => {
  if (!selectedUsers.value.length) {
    ElMessage.warning('请选择要添加的用户')
    return
  }
  
  console.log('[handleAddToGroup] 开始处理添加到组:', {
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

// 添加到用户组表单引用和规则
const addToGroupFormRef = ref<FormInstance>()
const addToGroupRules = {
  groupId: [
    { required: true, message: '请选择用户组', trigger: 'change' }
  ]
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
      await loadTaskResults()
    }
  } catch (error) {
    console.error('[handleAddToGroupSubmit] 添加用户到组失败:', error)
    ElMessage.error('添加用户到组失败')
  } finally {
    addToGroupDialog.value.loading = false
  }
}

// 添加头像处理函数
const getProxiedAvatarUrl = (url: string | undefined) => {
  if (!url) return '';
  // 使用本地代理服务器处理图片请求
  return `${import.meta.env.VITE_API_BASE_URL}/api/proxy/image?url=${encodeURIComponent(url)}`;
}

// 处理页码变化
const handleCurrentChange = (page: number) => {
    currentPage.value = page
    loadTaskResults()
}

// 处理每页条数变化
const handleSizeChange = (size: number) => {
    pageSize.value = size
    currentPage.value = 1  // 重置到第一页
    loadTaskResults()
}

// 初始化
onMounted(() => {
  loadTaskResults()
})
</script>

<template>
    <div class="search-result-view">
        <!-- 头部信息卡片 -->
        <el-card class="header-card">
            <div class="task-info">
                <div class="task-header">
                    <h2>{{ t('search.searchResults') }}</h2>
                    <el-button @click="$router.back()">{{ t('common.back') }}</el-button>
                </div>
                <div class="task-details" v-if="task">
                    <el-descriptions :column="4" border>
                        <el-descriptions-item :label="t('task.taskId')">{{ task.id }}</el-descriptions-item>
                        <el-descriptions-item :label="t('task.taskName')">{{ task.name }}</el-descriptions-item>
                        <el-descriptions-item :label="t('task.platform')">
                            <el-tag :type="getPlatformType(task.platform)">
                                {{ task.platform }}
                            </el-tag>
                        </el-descriptions-item>
                        <el-descriptions-item :label="t('search.keywords')">
                            <el-tag
                                v-for="keyword in task.search_params?.keywords"
                                :key="keyword"
                                class="mx-1"
                                type="info"
                            >
                                {{ keyword }}
                            </el-tag>
                        </el-descriptions-item>
                        <el-descriptions-item :label="t('search.followerRange')">
                            {{ formatFollowerRange(task?.search_params) }}
                        </el-descriptions-item>
                        <el-descriptions-item :label="t('search.resultCount')">{{ task.result_count }}</el-descriptions-item>
                    </el-descriptions>
                </div>
            </div>
        </el-card>

        <!-- 工具栏 -->
        <el-card class="toolbar-card">
            <el-row :gutter="20">
                <el-col :span="6">
                    <el-input
                        v-model="searchKeyword"
                        :placeholder="t('search.searchPlaceholder')"
                        clearable
                        @keyup.enter="handleSearch"
                    >
                        <template #prefix>
                            <el-icon><Search /></el-icon>
                        </template>
                    </el-input>
                </el-col>
                <el-col :span="18" class="text-right">
                    <el-button-group>
                        <el-button type="primary" @click="exportToCSV">
                            <el-icon><Download /></el-icon>{{ t('common.exportCSV') }}
                        </el-button>
                        <el-button 
                            type="warning"
                            :disabled="!selectedUsers.length"
                            @click="handleAddToGroup"
                        >
                            <el-icon><FolderAdd /></el-icon>{{ t('user.addToGroup') }}
                        </el-button>
                        <el-button 
                            type="success" 
                            :disabled="!selectedUsers.length"
                            @click="handleSendMessage(selectedUsers)"
                        >
                            <el-icon><Message /></el-icon>{{ t('message.sendMessage') }}
                        </el-button>
                    </el-button-group>
                </el-col>
            </el-row>
        </el-card>

        <!-- 用户列表 -->
        <el-card class="result-card" v-loading="loading">
            <el-table
                :data="userList"
                style="width: 100%"
                @selection-change="handleSelectionChange"
                border
            >
                <el-table-column type="selection" width="55" />
                <el-table-column :label="t('user.avatar')" width="60" align="center">
                    <template #default="{ row }">
                        <el-avatar
                            :size="40"
                            :src="getProxiedAvatarUrl(row.profile_data?.avatar_url)"
                            @click="openProfile(row.profile_data?.profile_url)"
                        />
                    </template>
                </el-table-column>
                <el-table-column :label="t('user.username')" prop="username" width="200" align="left">
                    <template #default="{ row }">
                        <div class="username-cell">
                            <div class="user-info">
                                <el-link type="primary" @click="openProfile(row.profile_data?.profile_url)" class="username-link">
                                    {{ row.username }}
                                </el-link>
                                <div class="display-name" v-if="row.display_name">
                                    {{ row.display_name }}
                                </div>
                            </div>
                        </div>
                    </template>
                </el-table-column>

                <el-table-column :label="t('search.keywords')" min-width="150">
                    <template #default="{ row }">
                        <div class="keywords-cell">
                            <el-tag
                                v-for="keyword in row.profile_data?.matchedTweet?.matched_keywords || []"
                                :key="keyword"
                                size="small"
                                type="info"
                                class="keyword-tag"
                            >
                                {{ keyword }}
                            </el-tag>
                        </div>
                    </template>
                </el-table-column>

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

                <el-table-column :label="t('user.stats')" width="300">
                    <template #default="{ row }">
                        <div class="stats-info">
                            <div class="stat-item">
                                <span class="label">{{ t('user.followers') }}</span>
                                <span class="value">{{ formatNumber(row.profile_data?.followers_count || 0) }}</span>
                            </div>
                            <div class="stat-item">
                                <span class="label">{{ t('user.following') }}</span>
                                <span class="value">{{ formatNumber(row.profile_data?.following_count || 0) }}</span>
                            </div>
                            <div class="stat-item">
                                <span class="label">{{ t('user.posts') }}</span>
                                <span class="value">{{ formatNumber(row.profile_data?.posts_count || 0) }}</span>
                            </div>
                        </div>
                    </template>
                </el-table-column>

                <el-table-column :label="t('user.bio')" min-width="200" show-overflow-tooltip>
                    <template #default="{ row }">
                        <div class="bio-content">{{ row.profile_data?.bio || '-' }}</div>
                    </template>
                </el-table-column>

                <el-table-column :label="t('search.matchedPosts')" min-width="200">
                    <template #default="{ row }">
                        <div v-if="row.profile_data?.matched_posts?.length" class="matched-posts-cell">
                            <div class="posts-links">
                                <el-link
                                    v-for="(post, index) in row.profile_data.matched_posts.slice(0, 2)"
                                    :key="post.url"
                                    type="primary"
                                    @click="openUrl(post.url)"
                                    class="post-link"
                                >
                                    {{ t('search.post', { index: index + 1 }) }}
                                </el-link>
                                <el-link
                                    v-if="row.profile_data.matched_posts.length > 2"
                                    type="info"
                                    @click="openMatchedPosts(row)"
                                >
                                    {{ t('search.viewAll', { count: row.profile_data.matched_posts.length }) }}
                                </el-link>
                            </div>
                        </div>
                        <span v-else>-</span>
                    </template>
                </el-table-column>

                <el-table-column :label="t('common.actions')" width="150" fixed="right">
                    <template #default="{ row }">
                        <el-button-group>
                            <el-button
                                type="primary"
                                link
                                @click="openProfile(row.profile_data?.profile_url)"
                            >
                                {{ t('user.viewProfile') }}
                            </el-button>
                            <el-button
                                type="success"
                                link
                                @click="handleSendMessage([row])"
                            >
                                {{ t('message.send') }}
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

        <!-- 发送私信对话框 -->
        <el-dialog
            v-model="messageDialogVisible"
            :title="t('message.sendMessage') + (selectedUsers.length > 1 ? t('message.multipleUsers', { count: selectedUsers.length }) : '')"
            width="600px"
        >
            <el-form ref="messageFormRef" :model="messageForm" :rules="messageRules">
                <el-form-item :label="t('message.template')" prop="templateId">
                    <el-select
                        v-model="messageForm.templateId"
                        :placeholder="t('message.selectTemplate')"
                        @change="handleTemplateChange"
                    >
                        <el-option
                            v-for="template in messageTemplates"
                            :key="template.id"
                            :label="template.name"
                            :value="template.id"
                        />
                    </el-select>
                    <el-link type="primary" @click="goToTemplates" style="margin-left: 10px">
                        {{ t('template.manage') }}
                    </el-link>
                </el-form-item>

                <el-form-item :label="t('message.preview')" v-if="messageForm.templateId">
                    <el-card class="preview-card">
                        <div v-for="(user, index) in selectedUsers.slice(0, 3)" :key="user.id">
                            <div class="preview-item">
                                <span class="preview-label">{{ t('message.sendTo', { username: user.username }) }}</span>
                                <div class="preview-content">
                                    {{ getPreviewContent(user) }}
                                </div>
                            </div>
                            <el-divider v-if="index < selectedUsers.slice(0, 3).length - 1" />
                        </div>
                        <div v-if="selectedUsers.length > 3" class="preview-more">
                            {{ t('message.andMoreUsers', { count: selectedUsers.length - 3 }) }}
                        </div>
                    </el-card>
                </el-form-item>
            </el-form>

            <template #footer>
                <el-button @click="messageDialogVisible = false">{{ t('common.cancel') }}</el-button>
                <el-button
                    type="primary"
                    @click="handleSendMessageSubmit"
                    :loading="sending"
                >
                    {{ t('message.send') }}
                </el-button>
            </template>
        </el-dialog>

        <!-- 匹配帖子对话框 -->
        <el-dialog
            v-model="postsDialogVisible"
            :title="t('search.matchedPosts')"
            width="800px"
        >
            <div class="matched-posts" v-if="currentUser">
                <div
                    v-for="post in currentUser.profile_data?.matched_posts"
                    :key="post.url"
                    class="post-item"
                >
                    <div class="post-header">
                        <span class="post-date">{{ formatPostDate(post.timestamp) }}</span>
                        <el-link type="primary" :href="post.url" target="_blank">
                            {{ t('search.viewOriginal') }}
                        </el-link>
                    </div>
                    <div class="post-content">{{ post.caption }}</div>
                    <div class="post-stats">
                        <span class="stat" :title="t('search.likes')">
                            <el-icon><Star /></el-icon>
                            {{ formatNumber(post.likes_count) }}
                        </span>
                        <span class="stat" :title="t('search.comments')">
                            <el-icon><ChatDotRound /></el-icon>
                            {{ formatNumber(post.comments_count) }}
                        </span>
                    </div>
                    <div class="post-tags" v-if="post.hashtags?.length">
                        <el-tag
                            v-for="tag in post.hashtags"
                            :key="tag"
                            size="small"
                            effect="plain"
                        >
                            #{{ tag }}
                        </el-tag>
                    </div>
                </div>
            </div>
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
    </div>
</template>

<style lang="scss" scoped>
.search-result-view {
    padding: 20px;
}

// 添加文字省略的mixin
@mixin text-ellipsis {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

// 基础样式
.search-result-view {
    .header-card {
        margin-bottom: 20px;

        .task-info {
            .task-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;

                h2 {
                    margin: 0;
                }
            }
        }
    }

    .toolbar-card {
        margin-bottom: 20px;

        .text-right {
            text-align: right;
        }
    }

    .result-card {
        .user-info {
            display: flex;
            align-items: center;
            gap: 12px;

            :deep(.el-avatar) {
                flex-shrink: 0;
                border-radius: 50%;
                object-fit: cover;
                width: 40px;
                height: 40px;
            }

            .user-details {
                flex: 1;
                min-width: 0;
                
                .username {
                    font-weight: 500;
                    font-size: 14px;
                    color: #303133;
                    margin-bottom: 4px;
                    @include text-ellipsis;
                }

                .display-name {
                    color: #909399;
                    font-size: 13px;
                    @include text-ellipsis;
                }
            }
        }

        .stats-info {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            width: 100%;
            max-width: 300px;

            .stat-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 4px;
                background: #f5f7fa;
                border-radius: 4px;

                .label {
                    font-size: 12px;
                    color: #909399;
                    margin-bottom: 2px;
                }

                .value {
                    font-size: 14px;
                    color: #303133;
                    font-weight: 500;
                }
            }
        }

        .bio-content {
            color: #606266;
            font-size: 13px;
            line-height: 1.4;
            @include text-ellipsis;
        }

        .matched-posts-cell {
            .posts-links {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                
                .post-link {
                    font-size: 13px;
                    white-space: nowrap;
                }
            }
        }

        :deep(.el-table) {
            .el-table__header-wrapper {
                th {
                    background-color: #f5f7fa;
                    
                    &.is-leaf {
                        border-bottom: 1px solid #ebeef5;
                    }
                }
            }

            .el-table__row {
                td {
                    vertical-align: middle;
                }

                // 用户名列
                td:nth-child(2) {
                    min-width: 200px;
                    max-width: 250px;
                }

                // 账号类型列
                td:nth-child(3) {
                    width: 120px;
                }

                // 统计信息列
                td:nth-child(4) {
                    width: 300px;
                }

                // 简介列
                td:nth-child(5) {
                    min-width: 200px;
                }

                // 匹配帖子列
                td:nth-child(6) {
                    width: 180px;
                }

                // 操作列
                td:nth-child(7) {
                    width: 120px;

                    .el-button-group {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        
                        .el-button {
                            margin-left: 0 !important;
                        }
                    }
                }
            }
        }
    }

    .matched-posts {
        .post-item {
            padding: 16px;
            border-bottom: 1px solid #ebeef5;

            &:last-child {
                border-bottom: none;
            }

            .post-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;

                .post-date {
                    color: #909399;
                    font-size: 13px;
                }
            }

            .post-content {
                margin: 12px 0;
                color: #303133;
                line-height: 1.6;
            }

            .post-stats {
                display: flex;
                gap: 16px;
                margin: 8px 0;

                .stat {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    color: #606266;
                    font-size: 13px;

                    .el-icon {
                        font-size: 16px;
                    }
                }
            }

            .post-tags {
                margin-top: 8px;
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
            }
        }
    }

    .preview-card {
        .preview-item {
            padding: 12px 0;

            .preview-label {
                font-weight: 500;
                margin-bottom: 8px;
                display: block;
            }

            .preview-content {
                background: #f5f7fa;
                padding: 12px;
                border-radius: 4px;
                color: #606266;
            }
        }

        .preview-more {
            text-align: center;
            color: #909399;
            font-size: 13px;
            margin-top: 8px;
        }
    }

    .pagination-container {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid #ebeef5;
        display: flex;
        justify-content: flex-end;
        
        :deep(.el-pagination) {
            padding: 0;
            margin: 0;
        }
    }
}

// 全局样式覆盖
.el-tag {
    :deep(&--small) {
        height: 22px;
        padding: 0 8px;
        
        & + & {
            margin-left: 4px;
        }
    }
}

.el-button-group {
    :deep(.el-button--link) {
        height: 28px;
        padding: 0 8px;
    }
}

.keywords-cell {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    
    .keyword-tag {
        margin: 2px;
    }
}

.username-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-left: -12px;

    .user-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding-left: 12px;

        .username-link {
            font-size: 14px;
            font-weight: 500;
            padding: 0;
            margin: 0;
            text-align: left;
            display: block;

            &:hover {
                text-decoration: underline;
            }
        }

        .display-name {
            font-size: 12px;
            color: #666;
            line-height: 1.2;
            text-align: left;
            display: block;
        }
    }
}

:deep(.el-table) {
    .el-table__cell {
        .cell {
            white-space: normal;
            padding: 0 12px !important;
        }
    }

    .el-button.el-button--primary.is-link {
        padding: 0;
        height: auto;
        line-height: inherit;
    }
}
</style>
