<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Delete, View } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';
import { Platform } from '@/types/common';
import type { SearchTask, SearchTaskStatus } from '@/services/searchTasks';
import { SearchTaskService } from '@/services/searchTasks';
import CreateSearchTaskDialog from '@/components/CreateSearchTaskDialog.vue';
import { useI18n } from 'vue-i18n';

const router = useRouter();
const searchTaskService = new SearchTaskService();
const { t } = useI18n();

// 数据定义
const taskList = ref<SearchTask[]>([]);
const loading = ref(false);
const currentPage = ref(1);
const pageSize = ref(10);
const total = ref(0);
const searchKeywords = ref('');
const showCreateDialog = ref(false);
const selectedPlatform = ref<Platform | ''>('');

// 状态更新定时器
let statusUpdateTimer: number;

// 加载任务列表
const loadTasks = async () => {
    try {
        loading.value = true;
        const response = await searchTaskService.getTasks({
            platform: selectedPlatform.value || undefined,
            keyword: searchKeywords.value || undefined,
            page: currentPage.value,
            pageSize: pageSize.value
        });
        taskList.value = response.data;
        total.value = response.total;
    } catch (error: any) {
        console.error('加载任务列表失败:', error);
        ElMessage.error(error.message || '加载任务列表失败，请稍后重试');
        taskList.value = [];
        total.value = 0;
    } finally {
        loading.value = false;
    }
};

// 定时更新任务状态
const startStatusUpdate = () => {
    statusUpdateTimer = window.setInterval(async () => {
        const runningTasks = taskList.value.filter(task => task.status === 'running');
        if (runningTasks.length === 0) return;
        
        try {
            const updates = await searchTaskService.getTasksStatus(
                runningTasks.map(task => task.id)
            );
            
            taskList.value = taskList.value.map(task => {
                const update = updates.find(u => u.id === task.id);
                return update ? { ...task, ...update } : task;
            });
        } catch (error) {
            console.error('更新任务状态失败:', error);
        }
    }, 5000);
};

// 删除任务
const handleDelete = async (taskId: number) => {
    try {
        await ElMessageBox.confirm('确定要删除这个任务吗？', '提示', {
            type: 'warning'
        });
        
        await searchTaskService.deleteTask(taskId);
        ElMessage.success('任务已删除');
        loadTasks();
    } catch (error) {
        if (error !== 'cancel') {
            ElMessage.error('删除任务失败');
            console.error('Error deleting task:', error);
        }
    }
};

// 查看任务结果
const handleViewResults = (taskId: number) => {
    router.push(`/search-tasks/${taskId}/results`);
};

// 处理任务创建成功
const handleTaskCreated = () => {
    loadTasks();
};

// 页面加载时获取任务列表
onMounted(() => {
    loadTasks();
    startStatusUpdate();
});

onBeforeUnmount(() => {
    if (statusUpdateTimer) {
        clearInterval(statusUpdateTimer);
    }
});

// 获取任务状态标签类型
const getStatusType = (status: SearchTaskStatus): string => {
    const types: Record<SearchTaskStatus, string> = {
        pending: 'info',
        running: 'primary',
        processing: 'warning',
        completed: 'success',
        failed: 'danger',
        stopped: 'info'
    };
    return types[status] || 'info';
};

const getStatusLabel = (status: SearchTaskStatus): string => {
    return t(`task.status.${status}`);
};

// 分页处理
const handleSizeChange = (val: number) => {
    pageSize.value = val;
    currentPage.value = 1;
    loadTasks();
};

const handleCurrentChange = (val: number) => {
    currentPage.value = val;
    loadTasks();
};

// 搜索处理
const handleSearch = () => {
    currentPage.value = 1;
    loadTasks();
};

// 获取平台类型
const getPlatformType = (platform: Platform): string => {
    const types: Record<string, string> = {
        instagram: 'info',
        facebook: 'primary',
        twitter: 'warning',
        tiktok: 'success',
        other: 'danger'
    };
    return types[platform] || 'info';
};
</script>

<template>
  <div class="search-task-view">
    <div class="header">
      <div class="header-left">
        <el-button type="primary" @click="showCreateDialog = true">
          {{ t('task.createTask') }}
        </el-button>
        <el-select
          v-model="selectedPlatform"
          :placeholder="t('common.platformRule')"
          style="width: 120px; margin-left: 16px"
          clearable
          @change="handleSearch"
        >
          <el-option label="Instagram" :value="Platform.INSTAGRAM" />
          <el-option label="Twitter" :value="Platform.TWITTER" />
        </el-select>
        <el-input
          v-model="searchKeywords"
          :placeholder="t('search.keywords')"
          style="width: 200px; margin-left: 16px"
          clearable
          @clear="handleSearch"
          @keyup.enter="handleSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
      </div>
    </div>

    <!-- 任务列表 -->
    <el-card class="task-table-card">
      <el-table
        v-loading="loading"
        :data="taskList"
        style="width: 100%"
      >
        <el-table-column prop="name" :label="t('task.taskName')" min-width="150" />
        
        <el-table-column :label="t('common.platform')" width="180">
          <template #default="{ row }">
            <el-tag :type="getPlatformType(row.platform)" size="small">
              {{ row.platform }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column prop="keywords" :label="t('search.keywords')" min-width="160">
          <template #default="{ row }">
            <el-tag
              v-for="keyword in row.search_params.keywords"
              :key="keyword"
              style="margin-right: 4px; margin-bottom: 4px"
              size="small"
            >
              {{ keyword }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column :label="t('common.status')" width="120">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)" size="small">
              {{ getStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        
        <el-table-column prop="result_count" :label="t('search.searchResult')" width="120" align="center" />
        
        <el-table-column prop="created_at" :label="t('common.createTime')" width="180">
          <template #default="{ row }">
            {{ new Date(row.created_at).toLocaleString() }}
          </template>
        </el-table-column>
        
        <el-table-column :label="t('common.actions')" width="200" fixed="right">
          <template #default="{ row }">
            <div class="operation-tags">
              <el-tag
                v-if="row.is_completed"
                type="primary"
                size="small"
                @click="handleViewResults(row.id)"
              >
                <el-icon><View /></el-icon>
                {{ t('search.searchResult') }}
              </el-tag>
              <el-tag
                v-else
                type="info"
                size="small"
                effect="plain"
              >
                <el-icon><View /></el-icon>
                {{ t('search.searchResult') }}
              </el-tag>
              
              <el-tag
                v-if="row.status !== 'running'"
                type="danger"
                size="small"
                @click="handleDelete(row.id)"
              >
                <el-icon><Delete /></el-icon>
                {{ t('common.delete') }}
              </el-tag>
              <el-tag
                v-else
                type="info"
                size="small"
                effect="plain"
              >
                <el-icon><Delete /></el-icon>
                {{ t('common.delete') }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div class="pagination">
        <el-pagination
          :current-page="currentPage"
          :page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :layout="total > 0 ? 'total, sizes, prev, pager, next' : 'prev, pager, next'"
          :total="total"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </el-card>

    <!-- 创建任务对话框 -->
    <CreateSearchTaskDialog
      v-model="showCreateDialog"
      @success="handleTaskCreated"
    />
  </div>
</template>

<style scoped>
.search-task-view {
  padding: 20px;
}

.header {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  margin-bottom: 20px;
}

.header-left {
  display: flex;
  align-items: center;
}

.task-table-card {
  margin-bottom: 20px;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}

.pagination {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  padding: 0 20px;
}

.operation-tags {
  display: flex;
  gap: 8px;
}

.operation-tags .el-tag {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.3s;
}

.operation-tags .el-tag:not(.el-tag--plain):hover {
  opacity: 0.8;
  transform: translateY(-1px);
}
</style> 